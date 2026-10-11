import { existsSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CODEX_ACTOR_AUTHORIZATION_HEADER } from './codex-recovery.js';
import { announceAuthUrl, machine } from './app-json.js';

const CODEX_REFRESH_ENDPOINT = 'https://auth.openai.com/oauth/token';
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth';
const OPENAI_PROFILE_CLAIM = 'https://api.openai.com/profile';
const TOKEN_REFRESH_TIMEOUT_MS = 30_000;
// Server-side revocation endpoint used by `codex logout` and by `codex login`
// before it re-authenticates (codex-rs login/src/auth/revoke.rs). TeamCodex logs
// in from a throwaway CODEX_HOME, so the CLI's own "revoke before login" never
// sees the pool's previous grant — without this, every re-login leaves one more
// live session on chatgpt.com.
const CODEX_REVOKE_ENDPOINT = 'https://auth.openai.com/oauth/revoke';
const TOKEN_REVOKE_TIMEOUT_MS = 10_000;
const UNSAFE_CODEX_RESUME_OPTIONS = new Set([
  '--local-provider',
  '--oss',
  '--remote',
  '--remote-auth-token-env',
]);
const CODEX_RESUME_SELECTORS = new Set(['--all', '--last']);

export function decodeJwtPayload(token) {
  if (typeof token !== 'string') return {};
  const parts = token.split('.');
  if (parts.length < 2) return {};
  try {
    const value = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function parseCodexTokens(raw) {
  const tokens = raw?.tokens;
  if (!tokens || typeof tokens !== 'object') {
    throw new Error('Codex auth.json must contain a "tokens" object');
  }
  if (typeof tokens.access_token !== 'string' || !tokens.access_token) {
    throw new Error('Codex auth.json is missing tokens.access_token');
  }
  if (typeof tokens.refresh_token !== 'string' || !tokens.refresh_token) {
    throw new Error('Codex auth.json is missing tokens.refresh_token');
  }

  const idClaims = decodeJwtPayload(tokens.id_token);
  const accessClaims = decodeJwtPayload(tokens.access_token);
  const authClaims = idClaims[OPENAI_AUTH_CLAIM] || accessClaims[OPENAI_AUTH_CLAIM] || {};
  const profileClaims = accessClaims[OPENAI_PROFILE_CLAIM] || {};
  const accountId = tokens.account_id || authClaims.chatgpt_account_id || null;
  if (!accountId) {
    throw new Error('Codex auth.json is missing the ChatGPT account id');
  }

  const exp = Number(accessClaims.exp);
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    idToken: typeof tokens.id_token === 'string' ? tokens.id_token : null,
    accountId,
    accountUuid: accountId,
    email: idClaims.email || profileClaims.email || null,
    planType: authClaims.chatgpt_plan_type || null,
    expiresAt: Number.isFinite(exp) ? exp * 1000 : null,
  };
}

export async function importCodexCredentials(filePath = '~/.codex/auth.json') {
  const resolvedPath = filePath.replace(/^~/, homedir());
  const raw = JSON.parse(await readFile(resolvedPath, 'utf-8'));
  return parseCodexTokens(raw);
}

export function parseCodexCredentialsJson(raw) {
  return parseCodexTokens(raw);
}

export async function refreshCodexAccessToken(
  refreshToken,
  endpoint = CODEX_REFRESH_ENDPOINT,
) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: CODEX_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
    signal: AbortSignal.timeout(TOKEN_REFRESH_TIMEOUT_MS),
  });

  if (!response.ok) {
    let terminalAuthentication = response.status === 401;
    if (response.status === 400) {
      const raw = await response.text().catch(() => '');
      try {
        terminalAuthentication = JSON.parse(raw)?.error === 'invalid_grant';
      } catch {
        terminalAuthentication = false;
      }
    } else {
      await response.body?.cancel();
    }
    const error = new Error(`Codex token refresh failed (${response.status})`);
    error.terminalAuthentication = terminalAuthentication;
    throw error;
  }

  const data = await response.json();
  if (typeof data.access_token !== 'string' || !data.access_token) {
    throw new Error('Codex token refresh response is missing access_token');
  }

  const idClaims = decodeJwtPayload(data.id_token);
  const accessClaims = decodeJwtPayload(data.access_token);
  const authClaims = idClaims[OPENAI_AUTH_CLAIM] || accessClaims[OPENAI_AUTH_CLAIM] || {};
  const profileClaims = accessClaims[OPENAI_PROFILE_CLAIM] || {};
  const exp = Number(accessClaims.exp);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    idToken: typeof data.id_token === 'string' ? data.id_token : null,
    accountId: authClaims.chatgpt_account_id || null,
    email: idClaims.email || profileClaims.email || null,
    planType: authClaims.chatgpt_plan_type || null,
    expiresAt: Number.isFinite(exp)
      ? exp * 1000
      : Date.now() + (Number(data.expires_in) || 3600) * 1000,
  };
}

/**
 * Best-effort server-side revoke of a Codex refresh token (JSON body, same
 * shape as codex-rs revoke_auth_tokens). Never throws on an HTTP error —
 * callers log and move on, exactly like the CLI.
 */
export async function revokeCodexRefreshToken(
  refreshToken,
  endpoint = CODEX_REVOKE_ENDPOINT,
) {
  if (typeof refreshToken !== 'string' || !refreshToken) {
    return { ok: false, skipped: true, status: 0, message: 'no refresh token' };
  }
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      token: refreshToken,
      token_type_hint: 'refresh_token',
      client_id: CODEX_CLIENT_ID,
    }),
    signal: AbortSignal.timeout(TOKEN_REVOKE_TIMEOUT_MS),
  });
  const text = await response.text().catch(() => '');
  let message = text.slice(0, 200);
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.error?.message === 'string') message = parsed.error.message;
    else if (typeof parsed?.error === 'string') message = parsed.error;
  } catch {
    // plain-text or empty body
  }
  return { ok: response.ok, skipped: false, status: response.status, message };
}

export function resolveCodexCliBin({
  env = process.env,
  execPath = process.execPath,
  exists = existsSync,
  platform = process.platform,
} = {}) {
  // A bare PATH lookup of `codex` can be shadowed by a shell wrapper/symlink
  // (e.g. an agent router that ships sessions to a remote host) — that breaks
  // `login`, whose throwaway CODEX_HOME must be written on THIS machine
  // (2026-08-04 incident). Prefer the CLI co-installed with the running Node;
  // TEAMCODEX_CODEX_BIN stays as the explicit escape hatch in both directions.
  if (env.TEAMCODEX_CODEX_BIN) return env.TEAMCODEX_CODEX_BIN;
  if (platform !== 'win32') {
    // win32: the extension-less `codex` next to node.exe is npm's POSIX shim,
    // which CreateProcess can't run — the bare lookup resolving codex.exe wins.
    const sibling = join(dirname(execPath), 'codex');
    if (exists(sibling)) return sibling;
  }
  return 'codex';
}

export function codexCliNotFoundMessage(codexBin, env = process.env) {
  if (codexBin === 'codex') return 'Codex CLI not found in PATH. Install it first.';
  return env.TEAMCODEX_CODEX_BIN
    ? `Codex CLI not found at ${codexBin} — check TEAMCODEX_CODEX_BIN.`
    : `Codex CLI not found at ${codexBin}. Install it first.`;
}

export async function loginCodexCredentials({
  codexBin = resolveCodexCliBin(),
  deviceAuth = false,
  env = process.env,
  run = spawnSync,
} = {}) {
  const codexHome = await mkdtemp(join(tmpdir(), 'teamcodex-login-'));
  const loginArgs = ['login', '-c', 'cli_auth_credentials_store="file"'];
  if (deviceAuth) loginArgs.push('--device-auth');

  if (machine.json) return loginCodexMachine({ codexBin, loginArgs, codexHome, deviceAuth, env });
  try {
    const result = run(codexBin, loginArgs, {
      stdio: 'inherit',
      env: { ...env, CODEX_HOME: codexHome },
    });
    if (result?.error) {
      if (result.error.code === 'ENOENT') {
        throw new Error(codexCliNotFoundMessage(codexBin, env));
      }
      throw new Error(`Failed to start Codex login: ${result.error.message}`);
    }
    if (result?.status !== 0) {
      const status = result?.status ?? 1;
      const error = new Error(`Codex login exited with status ${status}`);
      error.exitCode = status;
      throw error;
    }
    return await importCodexCredentials(join(codexHome, 'auth.json'));
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
}

// App mode (`login --json`): the official `codex login` prints its authorize URL; relay it as an event.
// On macOS the Codex CLI opens the browser itself (not suppressible), so browser_opened tells the app not to.
async function loginCodexMachine({ codexBin, loginArgs, codexHome, deviceAuth, env }) {
  const child = spawn(codexBin, loginArgs, { env: { ...env, CODEX_HOME: codexHome }, stdio: ['ignore', 'pipe', 'pipe'] });
  const cleanup = async () => {
    child.kill('SIGTERM');
    await rm(codexHome, { recursive: true, force: true });
  };
  machine.cleanups.push(cleanup);
  let announced = false;
  let text = '';
  const onData = chunk => {
    text += chunk;
    const url = text.match(/https:\/\/\S+/)?.[0];
    if (announced || !url) return;
    const userCode = deviceAuth ? text.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,}\b/)?.[0] : null;
    if (deviceAuth && !userCode) return; // the code is printed after the URL
    announced = true;
    announceAuthUrl(url, deviceAuth
      ? { user_code: userCode, browser_opened: false }
      : { browser_opened: process.platform === 'darwin' });
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  try {
    const status = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    if (status !== 0) {
      const error = new Error(`Codex login exited with status ${status}`);
      error.exitCode = status;
      throw error;
    }
    return await importCodexCredentials(join(codexHome, 'auth.json'));
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(codexCliNotFoundMessage(codexBin, env));
    throw err;
  } finally {
    machine.cleanups = machine.cleanups.filter(fn => fn !== cleanup);
    await rm(codexHome, { recursive: true, force: true });
  }
}

const DEFAULT_CODEX_ROUTER_CALLER_KEY_FILE = join(homedir(), '.codex', 'codex-router', 'caller-secret');

/**
 * Optional local codex-router in front of this pool. Off unless `codexRouter`
 * is configured (or TEAMCODEX_CODEX_ROUTER_URL is set):
 *
 *   "codexRouter": { "enabled": true, "baseUrl": "http://127.0.0.1:4202/v1",
 *                    "callerKeyFile": "~/.codex/codex-router/caller-secret" }
 *
 * Codex authenticates to the router with the router's own caller key (its
 * `caller-secret` file) carried in the base_url path
 * (`/_codex-router/<key>/v1`, the same capability form as `codex-router panel`),
 * never with the ChatGPT session: the router only accepts a session token that
 * matches the one CODEX_HOME it was installed for, so a Codex launched from
 * another CODEX_HOME (an Orca account, a throwaway login) gets a 401. A bearer
 * via `env_key` is not enough either — a ChatGPT-signed-in Codex still sends
 * its own session token for native GPT models (measured: external models
 * passed, gpt-* got the same 401). With the key in the path the router admits
 * the request whatever bearer Codex adds, relays that bearer to this proxy,
 * and the pool strips it and injects its account exactly as before.
 *
 * Only loopback http origins are accepted, because the launched Codex sends
 * that key to whatever this returns. The key also appears in the child's argv
 * (`ps`), which is the same exposure as the panel URL — single-user machines.
 *
 * Returns null when off, else { baseUrl, callerKey } where baseUrl already
 * embeds the key.
 */
export function resolveCodexRouter(config, env = process.env, readSecret = readCodexRouterCallerSecret) {
  const fromEnv = env.TEAMCODEX_CODEX_ROUTER_URL;
  let candidate;
  const router = config?.codexRouter;
  if (typeof fromEnv === 'string') {
    if (fromEnv.trim() === '' || fromEnv.trim().toLowerCase() === 'off') return null;
    candidate = fromEnv.trim();
  } else {
    if (!router) return null;
    if (typeof router === 'string') candidate = router;
    else if (router.enabled === false || typeof router.baseUrl !== 'string') return null;
    else candidate = router.baseUrl;
  }
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`codexRouter.baseUrl is not a valid URL: ${candidate}`);
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (url.protocol !== 'http:' || !loopback || url.username || url.password) {
    throw new Error(`codexRouter.baseUrl must be a loopback http:// origin: ${candidate}`);
  }
  const presetKey = typeof env.TEAMCODEX_ROUTER_KEY === 'string' ? env.TEAMCODEX_ROUTER_KEY.trim() : '';
  if (presetKey) return { baseUrl: codexRouterCallerBaseUrl(url, presetKey), callerKey: presetKey };
  const keyFile = typeof router === 'object' && router !== null && typeof router.callerKeyFile === 'string'
    ? router.callerKeyFile.replace(/^~(?=\/|$)/, homedir())
    : DEFAULT_CODEX_ROUTER_CALLER_KEY_FILE;
  const callerKey = readSecret(keyFile);
  if (!callerKey) {
    throw new Error(
      `codex-router caller key not found at ${keyFile}; is codex-router installed? `
      + 'Set codexRouter.callerKeyFile, TEAMCODEX_ROUTER_KEY, or turn codexRouter off.',
    );
  }
  return { baseUrl: codexRouterCallerBaseUrl(url, callerKey), callerKey };
}

// http://127.0.0.1:4202/v1 + key -> http://127.0.0.1:4202/_codex-router/<key>/v1
function codexRouterCallerBaseUrl(url, callerKey) {
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}/_codex-router/${encodeURIComponent(callerKey)}${path}`;
}

function readCodexRouterCallerSecret(path) {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch (err) {
    if (err?.code === 'ENOENT') return '';
    throw err;
  }
}

// Sent only to the local router, which relays it to this proxy; never upstream.
const CODEX_POOL_PLACEHOLDER_BEARER = 'teamcodex-pool';

export function buildCodexProxyArgs(port, userArgs, { routerBaseUrl = null } = {}) {
  // requires_openai_auth stays false: the proxy strips the client's
  // authorization/chatgpt-account-id and injects the pool account's, so a
  // local ~/.codex login adds nothing upstream — but requiring it lets a
  // revoked local grant block `codex run` with the sign-in screen while the
  // pool is healthy (2026-08-03 incident).
  //
  // Router mode keeps requires_openai_auth = false for the same reason; the
  // router's caller key rides in the base_url path (see resolveCodexRouter), so
  // whatever bearer Codex adds is relayed to this proxy and replaced as usual.
  //
  // The actor-authorization placeholder switches on Codex's image_gen tool,
  // which a login-free provider otherwise never gets; image requests go to
  // <base_url>/images/* and ride the pool like any other request. The router
  // refuses a native image route that carries no bearer at all
  // (native_session_required) instead of lending its own session, so router
  // mode also sends a placeholder bearer; the router relays it and this proxy
  // replaces it with the pool account's like any other client bearer.
  const imageHeaders = [
    `"${CODEX_ACTOR_AUTHORIZATION_HEADER}" = "teamcodex"`,
    ...(routerBaseUrl ? [`"authorization" = "Bearer ${CODEX_POOL_PLACEHOLDER_BEARER}"`] : []),
  ].join(', ');
  const provider = [
    routerBaseUrl ? 'name = "TeamCodex via Codex Router"' : 'name = "TeamCodex"',
    routerBaseUrl
      ? `base_url = "${routerBaseUrl}"`
      : `base_url = "http://127.0.0.1:${port}/codex"`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    'supports_websockets = false',
    `http_headers = { ${imageHeaders} }`,
    'env_http_headers = { "X-TeamCodex-Invocation" = "TEAMCODEX_INVOCATION_ID" }',
  ].join(', ');
  const overrides = [
    '-c',
    'model_provider="teamcodex_proxy"',
    '-c',
    `model_providers.teamcodex_proxy={ ${provider} }`,
  ];
  if (userArgs[0] === 'resume') {
    return [...userArgs, ...overrides];
  }
  return [...overrides, ...userArgs];
}

export function assertSafeCodexArgs(userArgs) {
  for (let index = 0; index < userArgs.length; index++) {
    const arg = userArgs[index];
    if (arg === '--') break;
    const option = arg.split('=', 1)[0];
    if (CODEX_RESUME_SELECTORS.has(option)) {
      throw new Error(`Codex resume selector ${option} is not an exact session selector.`);
    }
    if (UNSAFE_CODEX_RESUME_OPTIONS.has(option)) {
      throw new Error(
        `Codex option ${option} bypasses TeamCodex provider routing.`,
      );
    }
    const compactConfig = arg.startsWith('-c') && arg !== '-c'
      ? arg.slice(2).replace(/^=/, '')
      : null;
    if (compactConfig == null && option !== '-c' && option !== '--config') continue;
    const config = compactConfig ?? (arg.includes('=')
      ? arg.slice(arg.indexOf('=') + 1)
      : userArgs[index + 1]);
    const separator = typeof config === 'string' ? config.indexOf('=') : -1;
    const key = separator >= 0 ? config.slice(0, separator).trim() : '';
    if (key === 'model_provider' || key === 'chatgpt_base_url'
      || key === 'model_providers' || key.startsWith('model_providers.')) {
      throw new Error(
        `Codex config ${key} bypasses TeamCodex provider routing.`,
      );
    }
  }
}
