import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { decodeJwtPayload } from './codex.js';
import { createPkce, openBrowser, raceWithStdinCode, startCallbackServer } from './oauth.js';

// Antigravity (agy) mode helpers. No proxy state here — pure functions plus the
// few stateless network calls (token refresh, login, loadCodeAssist). Facts and
// rationale: docs/specs/2026-10-10-agy-mode.md.

export const AGY_DEFAULT_UPSTREAM = 'https://daily-cloudcode-pa.googleapis.com';
// Shared consumer project every consumer account's requests carry.
export const AGY_DEFAULT_PROJECT = 'aicode-consumers';
// Used for proxy-originated calls until a real agy request has been seen.
export const AGY_DEFAULT_USER_AGENT = 'antigravity/cli/1.3.3 (aidev_client; os_type=darwin; arch=arm64; cl=996823801; auth_method=consumer)';
export const AGY_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const AGY_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const AGY_SCOPES = [
  'openid',
  'email',
  'profile',
  ...['aicode', 'cclog', 'cloud-platform', 'experimentsandconfigs', 'userinfo.email', 'userinfo.profile']
    .map(scope => `https://www.googleapis.com/auth/${scope}`),
];
// Fallback (account, group) block after an exhaustion 429 that carries no
// usable reset (no exhausted bucket in the summary, no RetryInfo).
export const AGY_EXHAUSTED_FALLBACK_MS = 5 * 60 * 1000;

// The agy OAuth client lives in the agy binary. The repository is public with
// push protection, so only these public prefixes are code; the full id and the
// secret are resolved at runtime (config override → binary scan + token
// endpoint probe) and cached in the 0600 config file.
const AGY_CLIENT_ID_PREFIX = '1071006060591-';
const AGY_CLIENT_ID_SUFFIX = '.apps.googleusercontent.com';
const AGY_SECRET_PREFIX = ['GOCSPX', ''].join('-');
const AGY_SECRET_BODY_LENGTH = 28;
const KEYRING_PREFIX = 'go-keyring-base64:';
const NETWORK_TIMEOUT_MS = 30_000;

/**
 * agy's stored login: the keychain value `go-keyring-base64:<base64 JSON>` or
 * the same JSON as plain text (a `--file` export). Returns the parsed object.
 */
export function parseAgyStoredLogin(raw) {
  if (raw && typeof raw === 'object' && !Buffer.isBuffer(raw)) return raw;
  let text = String(raw ?? '').trim();
  if (text.startsWith(KEYRING_PREFIX)) {
    text = Buffer.from(text.slice(KEYRING_PREFIX.length), 'base64').toString('utf8');
  }
  return JSON.parse(text);
}

function claimString(value) {
  if (Array.isArray(value)) value = value[0];
  return typeof value === 'string' && value ? value : null;
}

/**
 * `{token:{access_token, refresh_token, expiry}, id_token}` → pool credentials.
 * Identity is the id_token `sub` (re-import updates in place); `aud` is the
 * OAuth client id the login was issued to.
 */
export function parseAgyCredentials(stored) {
  const token = stored?.token;
  if (!token || typeof token !== 'object') {
    throw new Error('agy login must contain a "token" object');
  }
  if (typeof token.access_token !== 'string' || !token.access_token) {
    throw new Error('agy login is missing token.access_token');
  }
  if (typeof token.refresh_token !== 'string' || !token.refresh_token) {
    throw new Error('agy login is missing token.refresh_token');
  }
  const claims = decodeJwtPayload(stored.id_token);
  const sub = claimString(claims.sub);
  if (!sub) throw new Error('agy login id_token has no subject (sub)');
  const expiry = Date.parse(token.expiry);
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    idToken: typeof stored.id_token === 'string' ? stored.id_token : null,
    expiresAt: Number.isFinite(expiry) ? expiry : null,
    accountUuid: sub,
    email: claimString(claims.email),
    clientId: claimString(claims.aud),
  };
}

/** Read agy's keychain login (macOS). go-keyring writes it via `security`, so reading prompts nothing. */
export function readAgyKeychain({ securityBin = '/usr/bin/security', run = execFileSync } = {}) {
  try {
    return String(run(securityBin, ['find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })).trim();
  } catch (err) {
    if (err?.code === 'ENOENT') throw new Error(`security not found at ${securityBin}`);
    throw new Error('No agy login in the macOS keychain (service "gemini", account "antigravity"). '
      + 'Sign in with `agy` once, or import a file with --file.');
  }
}

const isSecretByte = b => (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a)
  || (b >= 0x61 && b <= 0x7a) || b === 0x5f || b === 0x2d;
const isLowerAlnum = b => (b >= 0x30 && b <= 0x39) || (b >= 0x61 && b <= 0x7a);

/**
 * Every OAuth client candidate in agy binary bytes: each `1071006060591-…`
 * id and each `GOCSPX-` followed by 28 `[A-Za-z0-9_-]` bytes. A Go binary
 * stores its strings back to back with no separator, so a candidate may be
 * the head of a longer run (agy 1.3.3: the right secret is the first 35 bytes
 * of a 70-byte run, and a free-standing 35-byte secret belongs to another
 * client) — the bytes cannot tell them apart; `resolveAgyOAuthClient` asks the
 * token endpoint. Byte scanning keeps a ~100 MB binary cheap.
 */
export function extractAgyOAuthClient(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const clientIds = new Set();
  for (let i = buf.indexOf(AGY_CLIENT_ID_PREFIX); i !== -1; i = buf.indexOf(AGY_CLIENT_ID_PREFIX, i + 1)) {
    let end = i + AGY_CLIENT_ID_PREFIX.length;
    while (end < buf.length && isLowerAlnum(buf[end])) end++;
    if (end > i + AGY_CLIENT_ID_PREFIX.length
        && buf.toString('latin1', end, end + AGY_CLIENT_ID_SUFFIX.length) === AGY_CLIENT_ID_SUFFIX) {
      clientIds.add(buf.toString('latin1', i, end + AGY_CLIENT_ID_SUFFIX.length));
    }
  }
  const clientSecrets = new Set();
  for (let i = buf.indexOf(AGY_SECRET_PREFIX); i !== -1; i = buf.indexOf(AGY_SECRET_PREFIX, i + 1)) {
    const end = i + AGY_SECRET_PREFIX.length + AGY_SECRET_BODY_LENGTH;
    if (end > buf.length) break;
    let ok = true;
    for (let j = i + AGY_SECRET_PREFIX.length; j < end && ok; j++) ok = isSecretByte(buf[j]);
    if (ok) clientSecrets.add(buf.toString('latin1', i, end));
  }
  return { clientIds: [...clientIds], clientSecrets: [...clientSecrets] };
}

// A refresh token no account owns: the probe never mints anything.
const PROBE_REFRESH_TOKEN = 'teamagy-oauth-client-probe';

/**
 * Ask the token endpoint whether (id, secret) is a real client, side-effect
 * free: a refresh with a bogus token answers `400 invalid_grant` for a valid
 * client and `401 invalid_client` for a wrong one (both measured 2026-10-10).
 * Returns 'valid' | 'invalid' | 'unknown'.
 */
export async function probeAgyOAuthClient({ clientId, clientSecret, tokenUrl = AGY_TOKEN_URL }) {
  try {
    const response = await fetch(tokenUrl || AGY_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: PROBE_REFRESH_TOKEN,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    });
    const raw = await response.text().catch(() => '');
    let code = null;
    try { code = JSON.parse(raw)?.error ?? null; } catch { /* non-JSON body */ }
    if (response.status === 400 && code === 'invalid_grant') return 'valid';
    if (code === 'invalid_client') return 'invalid';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

const nonEmpty = value => (typeof value === 'string' && value.trim() ? value.trim() : null);

/**
 * Resolve the OAuth client. Config `agyOAuthClientId` + `agyOAuthClientSecret`
 * win (unless that secret is `rejectedSecret`, the one the token endpoint just
 * refused). Otherwise every candidate pair — configured or id_token `aud` id,
 * else scanned ids, × configured or scanned secrets — is probed, and exactly
 * one accepted pair is taken (`source: 'probe'`, to be cached). None, several,
 * or an unanswered probe is an error asking for the config values: never a
 * guess.
 */
export async function resolveAgyOAuthClient({
  config = {},
  clientIdHint = null,
  binaryPath = null,
  readBinary = readFileSync,
  tokenUrl = AGY_TOKEN_URL,
  rejectedSecret = null,
} = {}) {
  const configuredId = nonEmpty(config?.agyOAuthClientId);
  let configuredSecret = nonEmpty(config?.agyOAuthClientSecret);
  if (configuredSecret && configuredSecret === rejectedSecret) configuredSecret = null;
  if (configuredId && configuredSecret) {
    return { clientId: configuredId, clientSecret: configuredSecret, source: 'config' };
  }
  const fix = 'set agyOAuthClientId and agyOAuthClientSecret in the TeamAgy config.';
  let scanned = { clientIds: [], clientSecrets: [] };
  if (binaryPath) {
    try {
      scanned = extractAgyOAuthClient(readBinary(binaryPath));
    } catch (err) {
      throw new Error(`Could not read the agy binary at ${binaryPath}: ${err.message}`);
    }
  }
  const hint = nonEmpty(clientIdHint);
  const ids = configuredId ? [configuredId] : hint ? [hint] : scanned.clientIds;
  const secrets = (configuredSecret ? [configuredSecret] : scanned.clientSecrets)
    .filter(secret => secret !== rejectedSecret);
  if (!ids.length || !secrets.length) {
    throw new Error(`Could not find the agy OAuth client${binaryPath ? ` in ${binaryPath}` : ' (agy binary not found)'}; ${fix}`);
  }
  const accepted = [];
  for (const clientId of ids) {
    for (const clientSecret of secrets) {
      const verdict = await probeAgyOAuthClient({ clientId, clientSecret, tokenUrl });
      if (verdict === 'unknown') {
        throw new Error(`Could not verify the agy OAuth client (the token endpoint gave no clear answer); ${fix}`);
      }
      if (verdict === 'valid') accepted.push({ clientId, clientSecret });
    }
  }
  if (accepted.length !== 1) {
    throw new Error(`${accepted.length === 0 ? 'None' : accepted.length} of ${ids.length * secrets.length} candidate `
      + `OAuth client pairs${binaryPath ? ` in ${binaryPath}` : ''} were accepted by the token endpoint; not guessing — ${fix}`);
  }
  return { ...accepted[0], source: 'probe' };
}

/** Google OAuth refresh (form body). `invalid_grant` is the terminal verdict. */
export async function refreshAgyAccessToken(refreshToken, {
  clientId,
  clientSecret,
  tokenUrl = AGY_TOKEN_URL,
} = {}) {
  if (!clientId || !clientSecret) {
    throw new Error('Antigravity OAuth client is not configured (agyOAuthClientId / agyOAuthClientSecret)');
  }
  const response = await fetch(tokenUrl || AGY_TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  });
  if (!response.ok) {
    const raw = await response.text().catch(() => '');
    let code = null;
    try { code = JSON.parse(raw)?.error ?? null; } catch { /* non-JSON error body */ }
    const error = new Error(`Antigravity token refresh failed (${response.status}${typeof code === 'string' ? ` ${code}` : ''})`);
    error.terminalAuthentication = code === 'invalid_grant';
    // The OAuth client (not the account) was refused: re-resolve the client.
    error.invalidClient = code === 'invalid_client';
    throw error;
  }
  const data = await response.json();
  if (typeof data.access_token !== 'string' || !data.access_token) {
    throw new Error('Antigravity token refresh response is missing access_token');
  }
  return {
    accessToken: data.access_token,
    // Google refresh tokens do not rotate; keep ours unless a new one arrives.
    refreshToken: data.refresh_token || refreshToken,
    idToken: typeof data.id_token === 'string' ? data.id_token : null,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  };
}

/** Installed-app authorization URL (PKCE, offline access, forced consent so a refresh token is issued). */
export function buildAgyAuthUrl({ clientId, redirectUri, state, codeChallenge, authUrl = AGY_AUTH_URL }) {
  const url = new URL(authUrl || AGY_AUTH_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', AGY_SCOPES.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  return url.toString();
}

/** Token-endpoint JSON (code exchange) → the same credential shape as an import. */
export function parseAgyTokenResponse(data) {
  return parseAgyCredentials({
    token: {
      access_token: data?.access_token,
      refresh_token: data?.refresh_token,
      expiry: new Date(Date.now() + (Number(data?.expires_in) || 3600) * 1000).toISOString(),
    },
    id_token: data?.id_token,
  });
}

/**
 * Google sign-in for one more pool account without touching agy's own keychain
 * login: loopback redirect on 127.0.0.1, PKCE, offline access.
 */
export async function loginAgyCredentials({
  clientId,
  clientSecret,
  authUrl = AGY_AUTH_URL,
  tokenUrl = AGY_TOKEN_URL,
  open = openBrowser,
} = {}) {
  const { codeVerifier, codeChallenge } = createPkce();
  const state = randomBytes(32).toString('base64url');
  const { port, codePromise, server } = await startCallbackServer(state, {
    host: '127.0.0.1',
    successLocation: null,
  });
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const url = buildAgyAuthUrl({ clientId, redirectUri, state, codeChallenge, authUrl });
  console.log('Opening browser for Google sign-in (Antigravity)...');
  console.log(`If it doesn't open, visit:\n  ${url}\n`);
  open(url);
  let code;
  try {
    code = await raceWithStdinCode(codePromise, state);
  } finally {
    server.close();
  }
  const response = await fetch(tokenUrl || AGY_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }).toString(),
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Google token exchange failed (${response.status}): ${text.slice(0, 200)}`);
  }
  return parseAgyTokenResponse(await response.json());
}

/** `loadCodeAssist` once per import/login: tier (paid first) and the account's project. */
export async function loadAgyCodeAssist(accessToken, {
  upstream = AGY_DEFAULT_UPSTREAM,
  userAgent = AGY_DEFAULT_USER_AGENT,
} = {}) {
  const response = await fetch(`${String(upstream || AGY_DEFAULT_UPSTREAM).replace(/\/$/, '')}/v1internal:loadCodeAssist`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      'user-agent': userAgent,
    },
    body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`loadCodeAssist failed (HTTP ${response.status})`);
  }
  const data = await response.json();
  const project = typeof data?.cloudaicompanionProject === 'string'
    ? data.cloudaicompanionProject
    : data?.cloudaicompanionProject?.id;
  return {
    tierId: data?.paidTier?.id ?? data?.currentTier?.id ?? null,
    projectId: nonEmpty(project),
    paid: Boolean(data?.paidTier?.id),
  };
}

/** Quota group of a request: `claude-*`/`gpt-*` share the "3p" limits, everything else "gemini". No model → no group. */
export function agyModelGroup(model) {
  if (typeof model !== 'string' || !model) return null;
  return /^(?:claude|gpt)-/i.test(model) ? '3p' : 'gemini';
}

export function isAgyInferencePath(url) {
  return /^\/v1internal:(?:streamGenerateContent|generateContent)(?:\?|$)/.test(String(url || ''));
}

/**
 * Token usage of one agy response object, counted once: only the frame whose
 * candidate carries `finishReason` (the final one) — `usageMetadata` may ride
 * on earlier frames too. `totalTokenCount` is the total; prompt tokens are the
 * input share. Null when the frame is not final or has no usage.
 */
export function agyUsageFromResponse(response) {
  const usage = response?.usageMetadata;
  if (!usage || typeof usage !== 'object') return null;
  if (!Array.isArray(response.candidates) || !response.candidates.some(c => c?.finishReason)) return null;
  const total = Number(usage.totalTokenCount);
  if (!Number.isFinite(total) || total <= 0) return null;
  const input = Math.min(total, Math.max(0, Number(usage.promptTokenCount) || 0));
  return { input, output: total - input };
}

function bucketGroup(bucket, group) {
  const id = String(bucket?.bucketId || '');
  if (id.startsWith('gemini-')) return 'gemini';
  if (id.startsWith('3p-')) return '3p';
  const text = `${group?.displayName || ''} ${group?.description || ''}`;
  if (/claude|gpt/i.test(text)) return '3p';
  if (/gemini/i.test(text)) return 'gemini';
  return null;
}

/**
 * `retrieveUserQuotaSummary` → `{ gemini|3p: { fiveHour, weekly } }`, each
 * window `{ utilization: 0-1 | null, reset: ms | null }`. A bucket without
 * `remainingFraction` reads as unknown (null) here; the post-429 path treats
 * the same omission as exhausted (proto3 drops a zero value).
 */
export function parseAgyQuotaSummary(payload) {
  const empty = () => ({ utilization: null, reset: null });
  const groups = {
    gemini: { fiveHour: empty(), weekly: empty() },
    '3p': { fiveHour: empty(), weekly: empty() },
  };
  for (const group of Array.isArray(payload?.groups) ? payload.groups : []) {
    for (const bucket of Array.isArray(group?.buckets) ? group.buckets : []) {
      const name = bucketGroup(bucket, group);
      const window = bucket?.window || String(bucket?.bucketId || '').split('-').pop();
      const kind = window === '5h' ? 'fiveHour' : window === 'weekly' ? 'weekly' : null;
      if (!name || !kind) continue;
      const remaining = bucket.remainingFraction == null ? NaN : Number(bucket.remainingFraction);
      const reset = Date.parse(bucket.resetTime);
      groups[name][kind] = {
        utilization: Number.isFinite(remaining) ? Math.min(1, Math.max(0, 1 - remaining)) : null,
        reset: Number.isFinite(reset) ? reset : null,
      };
    }
  }
  return groups;
}

function parseDurationMs(value) {
  const match = /^(\d+(?:\.\d+)?)s$/.exec(String(value ?? '').trim());
  return match ? Math.round(Number(match[1]) * 1000) : null;
}

/**
 * Google RPC 429 → `{ capacity, reason, retryDelayMs }`. `MODEL_CAPACITY_*`
 * is Google-side capacity (no account throttle); anything else on an inference
 * call means this account's group is exhausted.
 */
export function classifyAgy429(body) {
  let root = null;
  try {
    root = JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : String(body ?? ''));
  } catch { /* not JSON — treated as a plain exhaustion */ }
  if (Array.isArray(root)) root = root[0];
  const details = Array.isArray(root?.error?.details) ? root.error.details : [];
  let reason = null;
  let retryDelayMs = null;
  for (const detail of details) {
    const type = String(detail?.['@type'] || '');
    if (reason == null && type.endsWith('google.rpc.ErrorInfo') && typeof detail.reason === 'string') {
      reason = detail.reason;
    }
    if (retryDelayMs == null && type.endsWith('google.rpc.RetryInfo')) {
      retryDelayMs = parseDurationMs(detail.retryDelay);
    }
  }
  return {
    capacity: typeof reason === 'string' && reason.startsWith('MODEL_CAPACITY'),
    reason,
    retryDelayMs,
  };
}

/** Google RPC shaped 429 for a pool dead end with no upstream 429 to replay. */
export function agyExhaustedBody(retryAfterSeconds) {
  return {
    error: {
      code: 429,
      message: `TeamAgy pool exhausted: no account can serve this model now. Retry in ${retryAfterSeconds}s.`,
      status: 'RESOURCE_EXHAUSTED',
      details: [{
        '@type': 'type.googleapis.com/google.rpc.RetryInfo',
        retryDelay: `${retryAfterSeconds}s`,
      }],
    },
  };
}

/**
 * Point the request at the selected account's own project: rewrite a
 * top-level string `project` that differs from it. With `fill` (inference
 * calls), a missing or empty `project` becomes the account's project, else the
 * shared consumer one — so a client that knows no project still works.
 * Anything else returns the original buffer untouched (byte-identical).
 */
export function rewriteAgyProject(body, projectId, fill = false) {
  const target = typeof projectId === 'string' && projectId ? projectId : null;
  if ((!target && !fill) || !body?.length) return body;
  let json;
  try {
    json = JSON.parse(body.toString('utf8'));
  } catch {
    return body;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return body;
  if (fill && (json.project == null || json.project === '')) json.project = target || AGY_DEFAULT_PROJECT;
  else if (target && typeof json.project === 'string' && json.project !== target) json.project = target;
  else return body;
  return Buffer.from(JSON.stringify(json));
}

/**
 * Session key for connection-independent stickiness: a trajectory's ACL write
 * and its inference share the trajectory id (`writeTrajectoryAcls.trajectoryId`,
 * `requestId = agent/<conversation>/<ms>/<trajectory>/<n>`), else the request's
 * `sessionId`. Other calls return null (socket affinity applies).
 */
export function agyAffinityKey(url, body) {
  const method = /^\/v1internal:([A-Za-z]+)/.exec(String(url || '').split('?')[0])?.[1];
  if (method !== 'writeTrajectoryAcls' && method !== 'streamGenerateContent'
      && method !== 'generateContent') return null;
  let json;
  try {
    json = JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof json?.trajectoryId === 'string' && json.trajectoryId) return `trajectory:${json.trajectoryId}`;
  const parts = typeof json?.requestId === 'string' ? json.requestId.split('/') : [];
  if (parts[0] === 'agent' && parts.length >= 4 && parts[3]) return `trajectory:${parts[3]}`;
  const sessionId = json?.request?.sessionId;
  return typeof sessionId === 'string' && sessionId ? `session:${sessionId}` : null;
}

/** agy binary: TEAMAGY_AGY_BIN → next to node → ~/.local/bin/agy → bare `agy` (PATH). */
export function resolveAgyBin({
  env = process.env,
  execPath = process.execPath,
  exists = existsSync,
  home = homedir(),
} = {}) {
  if (env.TEAMAGY_AGY_BIN) return env.TEAMAGY_AGY_BIN;
  const sibling = join(dirname(execPath), 'agy');
  if (exists(sibling)) return sibling;
  const local = join(env.HOME || home, '.local', 'bin', 'agy');
  if (exists(local)) return local;
  return 'agy';
}

/** File to scan for the OAuth client: the resolved binary, with a PATH lookup for a bare name. */
export function locateAgyBinary({ env = process.env, exists = existsSync, ...rest } = {}) {
  const bin = resolveAgyBin({ env, exists, ...rest });
  if (bin.includes('/')) return exists(bin) ? bin : null;
  for (const dir of String(env.PATH || '').split(delimiter)) {
    if (dir && exists(join(dir, bin))) return join(dir, bin);
  }
  return null;
}

export function agyCliNotFoundMessage(agyBin, env = process.env) {
  if (agyBin === 'agy') return 'Antigravity CLI (agy) not found in PATH. Install it first.';
  return env.TEAMAGY_AGY_BIN
    ? `Antigravity CLI not found at ${agyBin} — check TEAMAGY_AGY_BIN.`
    : `Antigravity CLI not found at ${agyBin}. Install it first.`;
}

/**
 * Environment for `agy run`: the user's own environment (agy keeps its login,
 * settings and MCP) with Cloud Code pointed at the proxy. The pool selectors
 * are dropped so a `teamcodex`/`teamclaude` that agy spawns is not silently
 * pointed at the TeamAgy config.
 */
export function buildAgyRunEnv(env, port) {
  const child = { ...env, CLOUD_CODE_URL: `http://127.0.0.1:${port}` };
  delete child.TEAMCLAUDE_PROVIDER;
  delete child.TEAMCLAUDE_CONFIG;
  return child;
}

/**
 * A server started before the OAuth client existed (no agy installed yet, or no accounts) keeps an empty
 * client forever; a login later caches the client in the config. Adopt it on the account reload.
 */
export function adoptAgyClientFromConfig(accountManager, diskConfig) {
  const clientId = nonEmpty(diskConfig?.agyOAuthClientId);
  const clientSecret = nonEmpty(diskConfig?.agyOAuthClientSecret);
  const current = accountManager.agyOAuth || {};
  if (!clientId || !clientSecret || (current.clientId && current.clientSecret)) return false;
  accountManager.agyOAuth = { clientId, clientSecret, tokenUrl: current.tokenUrl };
  return true;
}
