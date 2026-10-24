import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import net from 'node:net';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { decodeJwtPayload } from './codex.js';
import { openBrowser } from './oauth.js';
import { announceAuthUrl, machine } from './app-json.js';

// Cursor (cursor-agent CLI) mode helpers. No proxy state here — pure functions plus
// the few stateless network calls (browser login poll, GetMe, usage). Facts and
// rationale: docs/specs/2026-10-24-cursor-mode.md.

export const CURSOR_DEFAULT_UPSTREAM = 'https://api2.cursor.sh';
// Inference backend (GetServerConfig agentUrlConfig) — cursor-agent only sends it to
// the endpoint itself when that endpoint string contains "localhost".
export const CURSOR_DEFAULT_AGENT_UPSTREAM = 'https://agentn.global.api5.cursor.sh';
export const CURSOR_WEBSITE_URL = 'https://cursor.com';
// Throttle after an exhaustion answer that carries no usable retry hint.
export const CURSOR_EXHAUSTED_FALLBACK_MS = 5 * 60 * 1000;
// cursor-agent's macOS keychain items (generic passwords).
export const CURSOR_KEYCHAIN_ACCOUNT = 'cursor-user';
export const CURSOR_KEYCHAIN_ACCESS = 'cursor-access-token';
export const CURSOR_KEYCHAIN_REFRESH = 'cursor-refresh-token';

const NETWORK_TIMEOUT_MS = 30_000;
const nonEmpty = value => (typeof value === 'string' && value.trim() ? value.trim() : null);
const base64url = buf => Buffer.from(buf).toString('base64url');

/** Session JWT → `{accessToken, refreshToken, expiresAt, accountUuid}`. Cursor stores the same string twice. */
export function cursorCredentials(accessToken, refreshToken = null) {
  if (!nonEmpty(accessToken)) throw new Error('Cursor login has no access token');
  const claims = decodeJwtPayload(accessToken);
  const exp = Number(claims.exp);
  return {
    accessToken,
    refreshToken: nonEmpty(refreshToken) || accessToken,
    expiresAt: Number.isFinite(exp) && exp > 0 ? exp * 1000 : null,
    accountUuid: nonEmpty(claims.sub),
  };
}

/** The CLI's browser login: PKCE verifier/challenge and the cursor.com page to open. */
export function startCursorLogin({ websiteUrl = CURSOR_WEBSITE_URL, bytes = randomBytes, uuid = randomUUID } = {}) {
  const verifier = base64url(bytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const id = uuid();
  const url = new URL('/loginDeepControl', websiteUrl || CURSOR_WEBSITE_URL);
  url.searchParams.set('challenge', challenge);
  url.searchParams.set('uuid', id);
  url.searchParams.set('mode', 'login');
  url.searchParams.set('redirectTarget', 'cli');
  return { uuid: id, verifier, challenge, loginUrl: url.toString() };
}

const realSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Open the login page (app mode: an `auth_url` event) and poll `GET <api>/auth/poll?uuid&verifier`:
 * 404 = still waiting (1 s × 1.2^n, max 10 s, 150 tries — the CLI's own schedule), 200 = tokens,
 * 403 `sign_in_policy_violation` = refused; three other failures in a row give up.
 */
export async function loginCursorBrowser({
  apiUrl = CURSOR_DEFAULT_UPSTREAM,
  websiteUrl = CURSOR_WEBSITE_URL,
  open = openBrowser,
  sleep = realSleep,
  fetchImpl = fetch,
  start = startCursorLogin,
} = {}) {
  const { uuid, verifier, loginUrl } = start({ websiteUrl });
  if (machine.json) {
    announceAuthUrl(loginUrl, { browser_opened: false });
  } else {
    console.log('Sign in to Cursor in the browser.');
    console.log(`If the browser doesn't open, visit:\n  ${loginUrl}\n`);
    open(loginUrl);
  }
  const pollUrl = `${String(apiUrl || CURSOR_DEFAULT_UPSTREAM).replace(/\/$/, '')}/auth/poll`
    + `?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`;
  let failures = 0;
  for (let attempt = 0; attempt < 150; attempt++) {
    let response = null;
    try {
      response = await fetchImpl(pollUrl, { signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) });
    } catch { /* network blip: counts as a failure below */ }
    if (response?.status === 200) {
      const data = await response.json().catch(() => null);
      if (!nonEmpty(data?.accessToken)) throw new Error('Cursor login answered without a token');
      return cursorCredentials(data.accessToken, data.refreshToken);
    }
    if (response?.status === 403) {
      const data = await response.json().catch(() => null);
      if (data?.error === 'sign_in_policy_violation') {
        throw new Error('OAuth error: sign_in_policy_violation (sign-in refused by device policy)');
      }
    } else {
      await response?.body?.cancel().catch(() => {});
    }
    if (response?.status === 404) failures = 0;
    else if (++failures >= 3) throw new Error(`Cursor login failed (${response ? `HTTP ${response.status}` : 'network error'})`);
    await sleep(Math.min(1000 * 1.2 ** attempt, 10_000));
  }
  throw new Error('Cursor login timed out');
}

/** Connect unary call in JSON (the RPCs accept `application/json` beside protobuf). */
async function cursorRpc(token, path, { upstream = CURSOR_DEFAULT_UPSTREAM, fetchImpl = fetch, signal = null } = {}) {
  const response = await fetchImpl(`${String(upstream || CURSOR_DEFAULT_UPSTREAM).replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'connect-protocol-version': '1',
    },
    body: '{}',
    signal: signal || AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const error = new Error(`Cursor ${path.split('/').at(-1)} failed (HTTP ${response.status})`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

/** `DashboardService/GetMe` → identity. */
export async function fetchCursorMe(token, options = {}) {
  const data = await cursorRpc(token, '/aiserver.v1.DashboardService/GetMe', options);
  const id = data?.userId;
  return {
    userId: id != null && String(id).trim() ? String(id) : null,
    email: nonEmpty(data?.email),
  };
}

const num = value => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * `GetCurrentPeriodUsage` (+ `GetPlanInfo`) → `{planName, spend, limit, autoPercentUsed, apiPercentUsed,
 * totalPercentUsed, cycleEnd, utilization}`. utilization = the fullest of spend/limit and the two percents (0–1).
 */
export function parseCursorUsage(usage, plan = null) {
  const p = usage?.planUsage || {};
  const spend = num(p.totalSpend);
  const limit = num(p.limit);
  const autoPercentUsed = num(p.autoPercentUsed);
  const apiPercentUsed = num(p.apiPercentUsed);
  const parts = [
    limit > 0 && spend != null ? spend / limit : null,
    autoPercentUsed != null ? autoPercentUsed / 100 : null,
    apiPercentUsed != null ? apiPercentUsed / 100 : null,
  ].filter(v => v != null);
  const cycleEnd = num(usage?.billingCycleEnd) ?? num(plan?.planInfo?.billingCycleEnd);
  return {
    planName: nonEmpty(plan?.planInfo?.planName),
    spend,
    limit,
    autoPercentUsed,
    apiPercentUsed,
    totalPercentUsed: num(p.totalPercentUsed),
    cycleEnd: cycleEnd > 0 ? cycleEnd : null,
    utilization: parts.length ? Math.min(1, Math.max(0, ...parts)) : null,
  };
}

export async function fetchCursorUsage(token, options = {}) {
  const [usage, plan] = await Promise.all([
    cursorRpc(token, '/aiserver.v1.DashboardService/GetCurrentPeriodUsage', options),
    cursorRpc(token, '/aiserver.v1.DashboardService/GetPlanInfo', options).catch(() => null),
  ]);
  return parseCursorUsage(usage, plan);
}

/** Agent (inference) RPCs live on the agent upstream. */
export function isCursorAgentPath(path) {
  return String(path || '').startsWith('/agent.v1.');
}

/** One key per chat: a hash of `x-blob-encryption-key` (a secret — never kept or logged raw); null → session. */
export function cursorAffinityKey(headers = {}) {
  const key = nonEmpty(headers['x-blob-encryption-key']);
  return key ? `chat:${createHash('sha256').update(key).digest('hex').slice(0, 24)}` : null;
}

/**
 * Look at the first Connect streaming envelope of a response (5-byte header: flags, uint32 BE length).
 * → null while incomplete; `{endStream: false}` for a data message; `{endStream: true, code}` for an
 * end-of-stream frame (code = its error code, null for a clean end). `encoding` is the response's
 * `connect-content-encoding` (gzip or br) for a compressed frame.
 */
export function peekConnectFrame(buf, encoding = 'gzip') {
  if (buf.length < 5) return null;
  const flags = buf[0];
  const length = buf.readUInt32BE(1);
  if (!(flags & 0x02)) return { endStream: false };
  if (buf.length < 5 + length) return null;
  let payload = buf.subarray(5, 5 + length);
  try {
    if (flags & 0x01) payload = encoding === 'br' ? brotliDecompressSync(payload) : gunzipSync(payload);
    const code = JSON.parse(payload.toString('utf8'))?.error?.code;
    return { endStream: true, code: typeof code === 'string' ? code : null };
  } catch {
    return { endStream: true, code: null };
  }
}

/** Why an agent attempt should move to another account: 'exhausted', 'auth', or null (pass it through). */
export function classifyCursorFailure(status, endStreamCode = null) {
  if (status === 429 || endStreamCode === 'resource_exhausted') return 'exhausted';
  if (status === 401 || endStreamCode === 'unauthenticated') return 'auth';
  return null;
}

/** A Connect end-of-stream error frame (the proxy's own dead-end answer on an agent stream). */
export function connectErrorFrame(code, message) {
  const payload = Buffer.from(JSON.stringify({ error: { code, message } }));
  const header = Buffer.alloc(5);
  header[0] = 0x02;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

export function cursorExhaustedMessage(retryAfterSeconds) {
  return `TeamCursor pool exhausted: every account is rate limited. Retry in ${retryAfterSeconds}s.`;
}

/** cursor-agent's own login: macOS keychain, else `$XDG_CONFIG_HOME/cursor/auth.json`. */
export function cursorAuthFilePath(env = process.env, home = homedir(), platform = process.platform) {
  const userHome = env.HOME || home;
  if (platform === 'win32') return join(env.APPDATA || join(userHome, 'AppData', 'Roaming'), 'Cursor', 'auth.json');
  if (platform === 'darwin') return join(userHome, '.cursor', 'auth.json');
  return join(env.XDG_CONFIG_HOME || join(userHome, '.config'), 'cursor', 'auth.json');
}

export function parseCursorAuthFile(raw) {
  let data;
  // Fixed wording: a parse error message would quote the start of the file (a token).
  try { data = JSON.parse(String(raw)); } catch { throw new Error('Cursor auth.json is not valid JSON'); }
  if (!nonEmpty(data?.accessToken)) throw new Error('Cursor auth.json has no accessToken');
  return cursorCredentials(data.accessToken, data.refreshToken);
}

function readKeychain(service, exec) {
  try {
    return nonEmpty(exec('security', ['find-generic-password', '-a', CURSOR_KEYCHAIN_ACCOUNT, '-s', service, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 }));
  } catch {
    return null;
  }
}

/** Read (never write) cursor-agent's local login: `--file`, else the keychain on macOS, else its auth.json. */
export function readCursorLocalLogin({ file = null, platform = process.platform, exec = execFileSync, env = process.env } = {}) {
  if (!file && platform === 'darwin') {
    const access = readKeychain(CURSOR_KEYCHAIN_ACCESS, exec);
    if (access) return cursorCredentials(access, readKeychain(CURSOR_KEYCHAIN_REFRESH, exec));
  }
  const path = file || cursorAuthFilePath(env, homedir(), platform);
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw new Error(`No cursor-agent login found${platform === 'darwin' && !file ? ' in the keychain or' : ' at'} ${path}. `
        + 'Sign in with `cursor-agent login` once, or use teamcursor login.');
    }
    throw err;
  }
  return parseCursorAuthFile(raw);
}

/** cursor-agent binary: TEAMCURSOR_CURSOR_BIN → ~/.local/bin/cursor-agent → bare `cursor-agent`. */
export function resolveCursorBin({ env = process.env, exists = existsSync, home = homedir() } = {}) {
  if (env.TEAMCURSOR_CURSOR_BIN) return env.TEAMCURSOR_CURSOR_BIN;
  const local = join(env.HOME || home, '.local', 'bin', 'cursor-agent');
  if (exists(local)) return local;
  return 'cursor-agent';
}

export function cursorCliNotFoundMessage(bin, env = process.env) {
  if (bin === 'cursor-agent') return 'Cursor CLI (cursor-agent) not found in PATH. Install it first.';
  return env.TEAMCURSOR_CURSOR_BIN
    ? `Cursor CLI not found at ${bin} — check TEAMCURSOR_CURSOR_BIN.`
    : `Cursor CLI not found at ${bin}. Install it first.`;
}

/**
 * `cursor run` env: the user's own (cursor-agent keeps its login and settings), backend pointed at the
 * proxy. The host must be `localhost` — with an IP, cursor-agent sends inference straight to Cursor.
 */
export function buildCursorRunEnv(env, port) {
  const child = { ...env, CURSOR_API_ENDPOINT: `http://localhost:${port}` };
  delete child.TEAMCLAUDE_PROVIDER;
  delete child.TEAMCLAUDE_CONFIG;
  return child;
}

const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Public-port connection handler in cursor mode. An HTTP/2 prior-knowledge connection (cursor-agent's
 * agent stream, h2c) is tunnelled byte for byte to `h2Port()` — the worker's h2c listener; anything else
 * goes to the HTTP/1.1 `h1Server`. h2 carries no per-request proxy key, so only loopback peers may open one.
 */
export function h2cSniffer(h1Server, h2Port) {
  const tunnels = new Set();
  const onConnection = socket => {
    socket.on('error', () => { /* the owner of the socket below reports what matters */ });
    socket.setTimeout(30_000, () => socket.destroy()); // a peer that never says anything
    // Decide on the first four bytes (`PRI ` or an HTTP/1.1 method), however the peer splits them.
    let head = Buffer.alloc(0);
    const onData = chunk => {
      head = Buffer.concat([head, chunk]);
      if (head.length < 4) return;
      socket.removeListener('data', onData);
      route(head);
    };
    socket.on('data', onData);
    const route = first => {
      socket.setTimeout(0);
      if (first.subarray(0, 4).toString('latin1') !== 'PRI ') {
        socket.pause();
        socket.unshift(first);
        h1Server.emit('connection', socket);
        socket.resume();
        return;
      }
      const port = h2Port();
      if (!port || !LOOPBACK_PEERS.has(socket.remoteAddress)) {
        socket.destroy(); // no worker yet: cursor-agent reconnects by itself
        return;
      }
      const inner = net.connect(port, '127.0.0.1');
      inner.on('error', () => { /* closes below */ });
      tunnels.add(socket);
      const done = () => {
        tunnels.delete(socket);
        socket.destroy();
        inner.destroy();
      };
      socket.once('close', done);
      inner.once('close', done);
      inner.write(first);
      socket.pipe(inner).pipe(socket);
    };
  };
  onConnection.destroyTunnels = () => { for (const socket of tunnels) socket.destroy(); };
  return onConnection;
}

/**
 * The public listener in cursor mode: a `net` server running `onConnection` (h2cSniffer). The HTTP/1.1
 * server only ever receives sockets from it, so it never listens itself — its 'listening' is emitted here,
 * which is what starts its connection tracking (headersTimeout / requestTimeout, closeAllConnections).
 */
export function h2cFrontServer(h1Server, onConnection) {
  const front = net.createServer(onConnection);
  front.once('listening', () => h1Server.emit('listening'));
  return front;
}
