import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { decodeJwtPayload } from './codex.js';
import { openBrowser } from './oauth.js';
import { announceAuthUrl, machine } from './app-json.js';

// Grok (xAI Grok Build CLI) mode helpers. No proxy state here — pure functions
// plus the few stateless network calls (device login, token refresh, user
// lookup). Facts and rationale: docs/specs/2026-10-15-grok-mode.md.

export const GROK_DEFAULT_UPSTREAM = 'https://cli-chat-proxy.grok.com';
// grok's public OIDC client (the JWT `aud`, `oidc_client_id` in ~/.grok/auth.json). No secret.
export const GROK_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
export const GROK_ISSUER = 'https://auth.x.ai';
export const GROK_TOKEN_URL = `${GROK_ISSUER}/oauth2/token`;
export const GROK_DEVICE_URL = `${GROK_ISSUER}/oauth2/device/code`;
export const GROK_SCOPES = [
  'openid', 'profile', 'email', 'offline_access', 'grok-cli:access', 'api:access',
  'conversations:read', 'conversations:write', 'workspaces:read', 'workspaces:write',
];
// Sent for clients that are not grok until a real grok request has been seen
// (upstream answers 426 to a request without it).
export const GROK_DEFAULT_CLIENT_VERSION = '1.0.46';
// Throttle after an inference 429 that carries no usable retry-after.
export const GROK_EXHAUSTED_FALLBACK_MS = 5 * 60 * 1000;
// Identity headers of grok's local login, rewritten to the pool account's.
export const GROK_IDENTITY_HEADERS = ['x-userid', 'x-grok-user-id', 'x-email', 'x-teamid'];

const NETWORK_TIMEOUT_MS = 30_000;
const nonEmpty = value => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** Access-token expiry in ms: the JWT `exp`, else `fallbackMs`. */
function tokenExpiry(accessToken, fallbackMs) {
  const exp = Number(decodeJwtPayload(accessToken).exp);
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : fallbackMs;
}

function expiryValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Token-endpoint JSON → pool credentials (identity from the JWT; `/v1/user` refines it). */
export function parseGrokTokenResponse(data, previousRefreshToken = null) {
  if (typeof data?.access_token !== 'string' || !data.access_token) {
    throw new Error('xAI token response is missing access_token');
  }
  // Refresh-token rotation is not verified: keep a returned one, else the old one.
  const refreshToken = nonEmpty(data.refresh_token) || previousRefreshToken;
  if (!refreshToken) throw new Error('xAI token response is missing refresh_token');
  const claims = decodeJwtPayload(data.access_token);
  return {
    accessToken: data.access_token,
    refreshToken,
    idToken: typeof data.id_token === 'string' ? data.id_token : null,
    expiresAt: tokenExpiry(data.access_token, Date.now() + (Number(data.expires_in) || 21600) * 1000),
    accountUuid: nonEmpty(claims.sub) || nonEmpty(claims.principal_id),
    email: nonEmpty(claims.email),
    teamId: nonEmpty(claims.team_id),
  };
}

/**
 * grok's own login (`~/.grok/auth.json`): `{"<issuer>::<client_id>": {key, refresh_token, expires_at, user_id,
 * email, team_id, oidc_client_id, …}}`. Takes the entry of `clientId`, else the only OIDC entry.
 */
export function parseGrokAuthFile(raw, clientId = GROK_CLIENT_ID) {
  let data = raw;
  if (typeof raw === 'string' || Buffer.isBuffer(raw)) {
    // Fixed wording: a parse error message would quote the start of the file (a token).
    try { data = JSON.parse(String(raw)); } catch { throw new Error('grok auth.json is not valid JSON'); }
  }
  if (!data || typeof data !== 'object') throw new Error('grok auth.json is not a JSON object');
  const entries = Object.entries(data).filter(([, v]) => v && typeof v === 'object' && nonEmpty(v.key));
  const entry = entries.find(([k, v]) => k.endsWith(`::${clientId}`) || v.oidc_client_id === clientId)
    ?? (entries.length === 1 ? entries[0] : null);
  if (!entry) throw new Error(`grok auth.json has no login for client ${clientId}`);
  const login = entry[1];
  // The lone-entry fallback must not pick a login issued to another client: its refresh token would not
  // refresh with ours.
  const keyClient = entry[0].includes('::') ? entry[0].split('::').at(-1) : null;
  const otherClient = [login.oidc_client_id, keyClient].map(nonEmpty).find(id => id && id !== clientId);
  if (otherClient) {
    throw new Error(`grok auth.json holds a login for OAuth client ${otherClient}, not ${clientId}; `
      + 'its refresh token cannot be used here (set grokOAuthClientId, or use teamgrok login)');
  }
  if (!nonEmpty(login.refresh_token)) throw new Error('grok auth.json login has no refresh_token');
  const claims = decodeJwtPayload(login.key);
  return {
    accessToken: login.key,
    refreshToken: login.refresh_token,
    idToken: null,
    expiresAt: tokenExpiry(login.key, expiryValue(login.expires_at)),
    accountUuid: nonEmpty(login.user_id) || nonEmpty(claims.sub),
    email: nonEmpty(login.email) || nonEmpty(claims.email),
    teamId: nonEmpty(login.team_id) || nonEmpty(claims.team_id),
    clientId: nonEmpty(login.oidc_client_id) || clientId,
  };
}

export function grokAuthFilePath(env = process.env, home = homedir()) {
  return join(env.GROK_HOME || join(env.HOME || home, '.grok'), 'auth.json');
}

async function postForm(url, form) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  });
  const raw = await response.text().catch(() => '');
  let data = null;
  try { data = JSON.parse(raw); } catch { /* non-JSON body */ }
  return { status: response.status, ok: response.ok, data };
}

/** xAI refresh (public client, no secret). `invalid_grant` is the terminal verdict. */
export async function refreshGrokAccessToken(refreshToken, { clientId = GROK_CLIENT_ID, tokenUrl = GROK_TOKEN_URL } = {}) {
  const { status, ok, data } = await postForm(tokenUrl || GROK_TOKEN_URL, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId || GROK_CLIENT_ID,
  });
  if (!ok) {
    const code = typeof data?.error === 'string' ? data.error : null;
    const error = new Error(`xAI token refresh failed (${status}${code ? ` ${code}` : ''})`);
    error.terminalAuthentication = code === 'invalid_grant';
    throw error;
  }
  const creds = parseGrokTokenResponse(data, refreshToken);
  return { accessToken: creds.accessToken, refreshToken: creds.refreshToken, idToken: creds.idToken, expiresAt: creds.expiresAt };
}

const realSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * OAuth device flow (RFC 8628): show `verification_uri_complete` + `user_code`, open the browser
 * (app mode: an `auth_url` event with `user_code` instead), poll at `interval`
 * (`authorization_pending` → keep going, `slow_down` → +5 s, `expired_token`/`access_denied` → fail).
 */
export async function loginGrokDevice({
  clientId = GROK_CLIENT_ID,
  deviceUrl = GROK_DEVICE_URL,
  tokenUrl = GROK_TOKEN_URL,
  open = openBrowser,
  sleep = realSleep,
  now = Date.now,
} = {}) {
  const start = await postForm(deviceUrl || GROK_DEVICE_URL, { client_id: clientId, scope: GROK_SCOPES.join(' ') });
  const device = start.data;
  if (!start.ok || !nonEmpty(device?.device_code) || !nonEmpty(device?.user_code)) {
    throw new Error(`xAI device authorization failed (${start.status}${device?.error ? ` ${device.error}` : ''})`);
  }
  const url = device.verification_uri_complete || device.verification_uri;
  if (machine.json) {
    announceAuthUrl(url, { user_code: device.user_code, browser_opened: false });
  } else {
    console.log('Sign in to xAI (Grok) in the browser and confirm this code:');
    console.log(`  ${device.user_code}`);
    console.log(`If the browser doesn't open, visit:\n  ${url}\n`);
    open(url);
  }
  const interval = Number(device.interval);
  let intervalMs = (Number.isFinite(interval) ? Math.max(0, interval) : 5) * 1000;
  const deadline = now() + (Number(device.expires_in) || 1800) * 1000;
  for (;;) {
    if (now() >= deadline) throw new Error('xAI device login timed out (expired_token)');
    await sleep(intervalMs);
    let poll;
    try {
      poll = await postForm(tokenUrl || GROK_TOKEN_URL, {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: device.device_code,
        client_id: clientId,
      });
    } catch {
      continue; // network blip: try again at the next interval until the deadline
    }
    if (poll.ok) return parseGrokTokenResponse(poll.data);
    if (poll.status >= 500) continue;
    const code = poll.data?.error;
    if (code === 'authorization_pending') continue;
    if (code === 'slow_down') { intervalMs += 5000; continue; }
    if (code === 'expired_token') throw new Error('xAI device login timed out (expired_token)');
    if (code === 'access_denied') throw new Error('OAuth error: access_denied (the sign-in was refused)');
    throw new Error(`xAI device login failed (${poll.status}${code ? ` ${code}` : ''})`);
  }
}

/** `GET /v1/user?include=subscription` → identity and tier. */
export async function fetchGrokUser(accessToken, {
  upstream = GROK_DEFAULT_UPSTREAM,
  clientVersion = GROK_DEFAULT_CLIENT_VERSION,
} = {}) {
  const response = await fetch(`${String(upstream || GROK_DEFAULT_UPSTREAM).replace(/\/$/, '')}/v1/user?include=subscription`, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
      'x-grok-client-version': clientVersion || GROK_DEFAULT_CLIENT_VERSION,
    },
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`xAI user lookup failed (HTTP ${response.status})`);
  }
  const data = await response.json();
  return {
    userId: nonEmpty(data?.userId),
    email: nonEmpty(data?.email),
    teamId: nonEmpty(data?.teamId),
    tier: nonEmpty(data?.subscriptionTier),
    hasGrokCodeAccess: data?.hasGrokCodeAccess,
  };
}

/** Inference paths whose 429 means "this account is spent". */
export function isGrokInferencePath(url) {
  return /^\/v1\/(?:responses|chat\/completions|messages)(?:[/?]|$)/.test(String(url || ''));
}

/** Session key: x-grok-session-id, else x-grok-conv-id, else `/v1/sessions/<id>/…`; null → socket affinity. */
export function grokAffinityKey(url, headers = {}) {
  const session = nonEmpty(headers['x-grok-session-id']);
  if (session) return `session:${session}`;
  const conv = nonEmpty(headers['x-grok-conv-id']);
  if (conv) return `conv:${conv}`;
  const path = /^\/v1\/sessions\/([^/?]+)/.exec(String(url || ''))?.[1];
  if (!path) return null;
  try {
    return `session:${decodeURIComponent(path)}`;
  } catch {
    return `session:${path}`; // malformed %-escape: the raw id still keys the session
  }
}

/**
 * `x-ratelimit-{limit,remaining}-{requests,tokens}` → `{requestsLimit, requestsRemaining, tokensLimit,
 * tokensRemaining, utilization}`; utilization = max(1 − remaining/limit). Null when none is present.
 */
export function parseGrokRateLimit(headers) {
  const get = name => {
    const value = typeof headers?.get === 'function' ? headers.get(name) : headers?.[name];
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : null;
  };
  const meter = {
    requestsLimit: get('x-ratelimit-limit-requests'),
    requestsRemaining: get('x-ratelimit-remaining-requests'),
    tokensLimit: get('x-ratelimit-limit-tokens'),
    tokensRemaining: get('x-ratelimit-remaining-tokens'),
  };
  if (Object.values(meter).every(v => v == null)) return null;
  const used = [[meter.requestsLimit, meter.requestsRemaining], [meter.tokensLimit, meter.tokensRemaining]]
    .filter(([limit, remaining]) => limit > 0 && remaining != null)
    .map(([limit, remaining]) => Math.min(1, Math.max(0, 1 - remaining / limit)));
  return { ...meter, utilization: used.length ? Math.max(...used) : null };
}

/**
 * Rewrite the local login's identity headers to `account`'s (only those the request carries). A header
 * the account has no value for is dropped, never left pointing at the local login.
 */
export function rewriteGrokIdentityHeaders(headers, account) {
  const value = {
    'x-userid': account?.accountUuid,
    'x-grok-user-id': account?.accountUuid,
    'x-email': account?.email,
    'x-teamid': account?.teamId,
  };
  for (const key of Object.keys(headers)) {
    const lk = key.toLowerCase();
    if (!GROK_IDENTITY_HEADERS.includes(lk)) continue;
    delete headers[key];
    if (nonEmpty(value[lk])) headers[lk] = value[lk];
  }
  return headers;
}

/** Body of a pool dead end with no upstream 429 to replay (xAI's own `{"error": "…"}` shape). */
export function grokExhaustedBody(retryAfterSeconds) {
  return { error: `TeamGrok pool exhausted: every account is rate limited. Retry in ${retryAfterSeconds}s.` };
}

/** grok binary: TEAMGROK_GROK_BIN → $GROK_HOME/bin/grok (~/.grok/bin/grok) → ~/.local/bin/grok → bare `grok`. */
export function resolveGrokBin({ env = process.env, exists = existsSync, home = homedir() } = {}) {
  if (env.TEAMGROK_GROK_BIN) return env.TEAMGROK_GROK_BIN;
  const userHome = env.HOME || home;
  const grokHome = join(env.GROK_HOME || join(userHome, '.grok'), 'bin', 'grok');
  if (exists(grokHome)) return grokHome;
  const local = join(userHome, '.local', 'bin', 'grok');
  if (exists(local)) return local;
  return 'grok';
}

export function grokCliNotFoundMessage(grokBin, env = process.env) {
  if (grokBin === 'grok') return 'Grok CLI (grok) not found in PATH. Install it first.';
  return env.TEAMGROK_GROK_BIN
    ? `Grok CLI not found at ${grokBin} — check TEAMGROK_GROK_BIN.`
    : `Grok CLI not found at ${grokBin}. Install it first.`;
}

/** `grok run` env: the user's own (grok keeps its login and settings), backend pointed at the proxy. */
export function buildGrokRunEnv(env, port) {
  const child = { ...env, GROK_CLI_CHAT_PROXY_BASE_URL: `http://127.0.0.1:${port}/v1` };
  delete child.TEAMCLAUDE_PROVIDER;
  delete child.TEAMCLAUDE_CONFIG;
  return child;
}

/** Read grok's auth file (default `$GROK_HOME/auth.json`). */
export function readGrokAuthFile(path = grokAuthFilePath(), clientId = GROK_CLIENT_ID) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') throw new Error(`No grok login at ${path}. Sign in with \`grok\` once, or use teamgrok login.`);
    throw err;
  }
  return parseGrokAuthFile(raw, clientId);
}
