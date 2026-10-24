import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import {
  CURSOR_KEYCHAIN_ACCESS,
  CURSOR_KEYCHAIN_ACCOUNT,
  CURSOR_KEYCHAIN_REFRESH,
  buildCursorRunEnv,
  classifyCursorFailure,
  connectErrorFrame,
  cursorAffinityKey,
  cursorCliNotFoundMessage,
  cursorCredentials,
  h2cFrontServer,
  h2cSniffer,
  isCursorAgentPath,
  loginCursorBrowser,
  parseCursorAuthFile,
  parseCursorUsage,
  peekConnectFrame,
  readCursorLocalLogin,
  resolveCursorBin,
  startCursorLogin,
} from '../src/cursor.js';

const jwt = payload => `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
const TOKEN = jwt({ sub: 'google-oauth2|user_1', exp: 2_000_000_000, type: 'session' });

function frame(flags, payload) {
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

test('a Cursor session token is both tokens; expiry and identity come from the JWT', () => {
  assert.deepEqual(cursorCredentials(TOKEN), {
    accessToken: TOKEN, refreshToken: TOKEN, expiresAt: 2_000_000_000_000, accountUuid: 'google-oauth2|user_1',
  });
  assert.equal(cursorCredentials(TOKEN, 'other').refreshToken, 'other');
  assert.equal(cursorCredentials('opaque').expiresAt, null);
  assert.throws(() => cursorCredentials(''), /no access token/);
});

test('the login page carries a PKCE challenge of the polled verifier', () => {
  const login = startCursorLogin({ websiteUrl: 'https://cursor.example' });
  const url = new URL(login.loginUrl);
  assert.equal(url.origin + url.pathname, 'https://cursor.example/loginDeepControl');
  assert.equal(url.searchParams.get('uuid'), login.uuid);
  assert.equal(url.searchParams.get('mode'), 'login');
  assert.equal(url.searchParams.get('redirectTarget'), 'cli');
  assert.equal(url.searchParams.get('challenge'), createHash('sha256').update(login.verifier).digest('base64url'));
  assert.notEqual(startCursorLogin().verifier, login.verifier);
});

test('login polls /auth/poll: 404 keeps waiting, 200 is the token, a device-policy 403 and three failures stop', async () => {
  const start = () => ({ uuid: 'u-1', verifier: 'v-1', loginUrl: 'https://cursor.example/loginDeepControl?x=1' });
  const opened = [];
  const sleeps = [];
  const reply = (status, body) => new Response(body == null ? null : JSON.stringify(body), { status });
  let answers = [reply(404), reply(404), reply(200, { accessToken: TOKEN, refreshToken: TOKEN })];
  const urls = [];
  const creds = await loginCursorBrowser({
    apiUrl: 'https://api.example/', start, open: url => opened.push(url), sleep: async ms => { sleeps.push(ms); },
    fetchImpl: async url => { urls.push(url); return answers.shift(); },
  });
  assert.equal(creds.accessToken, TOKEN);
  assert.deepEqual(opened, ['https://cursor.example/loginDeepControl?x=1']);
  assert.deepEqual(urls, Array(3).fill('https://api.example/auth/poll?uuid=u-1&verifier=v-1'));
  assert.deepEqual(sleeps, [1000, 1200]);

  answers = [reply(403, { error: 'sign_in_policy_violation' })];
  await assert.rejects(loginCursorBrowser({ start, open() {}, sleep: async () => {}, fetchImpl: async () => answers.shift() }),
    /OAuth error: sign_in_policy_violation/);

  let calls = 0;
  await assert.rejects(loginCursorBrowser({
    start, open() {}, sleep: async () => {}, fetchImpl: async () => { calls++; throw new Error('offline'); },
  }), /Cursor login failed \(network error\)/);
  assert.equal(calls, 3);

  // A pending answer resets the failure count; 150 polls without a token is a timeout.
  await assert.rejects(loginCursorBrowser({ start, open() {}, sleep: async () => {}, fetchImpl: async () => reply(404) }),
    /timed out/);
});

test('usage: the fullest of spend/limit and the auto/API percents, cycle end, plan name', () => {
  const usage = parseCursorUsage({
    billingCycleEnd: '1794850584000',
    planUsage: { totalSpend: 4000, limit: 40000, autoPercentUsed: 25, apiPercentUsed: 0.21, totalPercentUsed: 0.0067 },
  }, { planInfo: { planName: 'Ultra' } });
  assert.deepEqual(usage, {
    planName: 'Ultra', spend: 4000, limit: 40000, autoPercentUsed: 25, apiPercentUsed: 0.21, totalPercentUsed: 0.0067,
    cycleEnd: 1794850584000, utilization: 0.25,
  });
  assert.equal(parseCursorUsage({ planUsage: { totalSpend: 50000, limit: 40000 } }).utilization, 1);
  assert.equal(parseCursorUsage({}).utilization, null);
  assert.equal(parseCursorUsage({}, { planInfo: { billingCycleEnd: '5' } }).cycleEnd, 5);
});

test('the first Connect frame says data, a clean end, or an end with its error code (gzip too)', () => {
  assert.equal(peekConnectFrame(Buffer.from([0, 0, 0])), null);
  assert.deepEqual(peekConnectFrame(frame(0, Buffer.from('xx'))), { endStream: false });
  assert.deepEqual(peekConnectFrame(frame(0, Buffer.from('x')).subarray(0, 5)), { endStream: false });
  const end = frame(2, Buffer.from(JSON.stringify({ error: { code: 'resource_exhausted', message: 'spent' } })));
  assert.equal(peekConnectFrame(end.subarray(0, end.length - 1)), null, 'an end frame is read whole');
  assert.deepEqual(peekConnectFrame(end), { endStream: true, code: 'resource_exhausted' });
  assert.deepEqual(peekConnectFrame(frame(2, Buffer.from('{}'))), { endStream: true, code: null });
  const zipped = frame(3, gzipSync(JSON.stringify({ error: { code: 'unauthenticated' } })));
  assert.deepEqual(peekConnectFrame(zipped), { endStream: true, code: 'unauthenticated' });
  assert.deepEqual(peekConnectFrame(frame(2, Buffer.from('not json'))), { endStream: true, code: null });
  assert.deepEqual(peekConnectFrame(connectErrorFrame('resource_exhausted', 'm')), { endStream: true, code: 'resource_exhausted' });
});

test('failure classes: 429 / resource_exhausted spend the account, 401 / unauthenticated refuse it', () => {
  assert.equal(classifyCursorFailure(429), 'exhausted');
  assert.equal(classifyCursorFailure(200, 'resource_exhausted'), 'exhausted');
  assert.equal(classifyCursorFailure(401), 'auth');
  assert.equal(classifyCursorFailure(200, 'unauthenticated'), 'auth');
  assert.equal(classifyCursorFailure(200, 'internal'), null);
  assert.equal(classifyCursorFailure(500), null);
  assert.equal(isCursorAgentPath('/agent.v1.AgentService/Run'), true);
  assert.equal(isCursorAgentPath('/aiserver.v1.DashboardService/GetMe'), false);
});

test('affinity: one key per chat from x-blob-encryption-key, never the raw secret', () => {
  const secret = 'a'.repeat(64);
  const key = cursorAffinityKey({ 'x-blob-encryption-key': secret });
  assert.match(key, /^chat:[0-9a-f]{24}$/);
  assert.ok(!key.includes(secret.slice(0, 8)));
  assert.equal(cursorAffinityKey({ 'x-blob-encryption-key': secret }), key);
  assert.notEqual(cursorAffinityKey({ 'x-blob-encryption-key': 'b'.repeat(64) }), key);
  assert.equal(cursorAffinityKey({}), null);
});

test('local login: macOS keychain items (read only), else the auth.json; errors never quote a token', async () => {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    const service = args[args.indexOf('-s') + 1];
    if (service === CURSOR_KEYCHAIN_ACCESS) return `${TOKEN}\n`;
    if (service === CURSOR_KEYCHAIN_REFRESH) return `${TOKEN}\n`;
    throw new Error('not found');
  };
  const creds = readCursorLocalLogin({ platform: 'darwin', exec });
  assert.equal(creds.accessToken, TOKEN);
  assert.deepEqual(calls[0], ['security', 'find-generic-password', '-a', CURSOR_KEYCHAIN_ACCOUNT, '-s', CURSOR_KEYCHAIN_ACCESS, '-w']);
  assert.ok(calls.every(call => call[1] === 'find-generic-password'), 'only reads');

  const dir = await mkdtemp(join(tmpdir(), 'teamcursor-auth-'));
  try {
    const file = join(dir, 'auth.json');
    await writeFile(file, JSON.stringify({ accessToken: TOKEN, refreshToken: TOKEN }));
    const fromFile = readCursorLocalLogin({ file, platform: 'darwin', exec: () => { throw new Error('keychain not used'); } });
    assert.equal(fromFile.expiresAt, 2_000_000_000_000);
    // Linux: $XDG_CONFIG_HOME/cursor/auth.json, never the keychain.
    await assert.rejects(async () => readCursorLocalLogin({ platform: 'linux', env: { HOME: dir, XDG_CONFIG_HOME: dir }, exec }),
      new RegExp(`No cursor-agent login found at ${join(dir, 'cursor', 'auth.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  assert.throws(() => parseCursorAuthFile(`{"accessToken": "${TOKEN}"`), err => !err.message.includes(TOKEN.slice(0, 12)));
  assert.throws(() => parseCursorAuthFile('{}'), /no accessToken/);
  assert.throws(() => readCursorLocalLogin({ platform: 'darwin', exec: () => { throw new Error('none'); }, env: { HOME: '/nonexistent-home' } }),
    /keychain or/);
});

test('cursor run: binary resolution and the child env (localhost endpoint, pool selectors dropped)', () => {
  assert.equal(resolveCursorBin({ env: { TEAMCURSOR_CURSOR_BIN: '/x/agent' } }), '/x/agent');
  assert.equal(resolveCursorBin({ env: { HOME: '/h' }, exists: path => path === '/h/.local/bin/cursor-agent' }), '/h/.local/bin/cursor-agent');
  assert.equal(resolveCursorBin({ env: { HOME: '/h' }, exists: () => false }), 'cursor-agent');
  assert.match(cursorCliNotFoundMessage('cursor-agent'), /not found in PATH/);
  assert.match(cursorCliNotFoundMessage('/x/agent', { TEAMCURSOR_CURSOR_BIN: '/x/agent' }), /check TEAMCURSOR_CURSOR_BIN/);
  const env = buildCursorRunEnv({ PATH: '/bin', TEAMCLAUDE_PROVIDER: 'cursor', TEAMCLAUDE_CONFIG: '/c', CURSOR_API_ENDPOINT: 'x' }, 3460);
  assert.deepEqual(env, { PATH: '/bin', CURSOR_API_ENDPOINT: 'http://localhost:3460' });
});

test('h2cSniffer: HTTP/1.1 goes to the HTTP server, an h2 preface is tunnelled byte for byte, no target → closed', async () => {
  const h1 = http.createServer((req, res) => res.end(`h1 ${req.url}`));
  const h2 = http2.createServer();
  h2.on('stream', (stream, headers) => {
    stream.respond({ ':status': 200 });
    stream.end(`h2 ${headers[':path']}`);
  });
  await new Promise(resolve => h2.listen(0, '127.0.0.1', resolve));
  let target = h2.address().port;
  const sniffer = h2cSniffer(h1, () => target);
  const front = net.createServer(sniffer);
  await new Promise(resolve => front.listen(0, '127.0.0.1', resolve));
  const port = front.address().port;
  try {
    const viaH1 = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/one`, { agent: false }, res => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve(body));
      }).on('error', reject);
    });
    assert.equal(viaH1, 'h1 /one');
    const session = http2.connect(`http://127.0.0.1:${port}`);
    const viaH2 = await new Promise((resolve, reject) => {
      const req = session.request({ ':path': '/two' });
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => resolve(body));
      req.on('error', reject);
      req.end();
    });
    assert.equal(viaH2, 'h2 /two');
    sniffer.destroyTunnels();
    session.destroy();
    target = null;
    const refused = http2.connect(`http://127.0.0.1:${port}`);
    await new Promise(resolve => {
      refused.on('error', resolve);
      refused.on('close', resolve);
    });
    refused.destroy();
  } finally {
    await new Promise(resolve => front.close(resolve));
    await new Promise(resolve => h2.close(resolve));
  }
});

test('a brotli-compressed end frame is read with the response\'s connect-content-encoding', () => {
  const payload = brotliCompressSync(JSON.stringify({ error: { code: 'resource_exhausted' } }));
  assert.deepEqual(peekConnectFrame(frame(3, payload), 'br'), { endStream: true, code: 'resource_exhausted' });
});

test('h2cSniffer waits for four bytes: an h2 preface split across packets is still tunnelled', async () => {
  const h1 = http.createServer((req, res) => res.end('h1'));
  const h2 = http2.createServer();
  await new Promise(resolve => h2.listen(0, '127.0.0.1', resolve));
  const front = net.createServer(h2cSniffer(h1, () => h2.address().port));
  await new Promise(resolve => front.listen(0, '127.0.0.1', resolve));
  try {
    const first = await new Promise((resolve, reject) => {
      const socket = net.connect(front.address().port, '127.0.0.1', () => {
        socket.write('PR');
        setTimeout(() => socket.write(Buffer.concat([
          Buffer.from('I * HTTP/2.0\r\n\r\nSM\r\n\r\n'), Buffer.from([0, 0, 0, 4, 0, 0, 0, 0, 0]),
        ])), 50);
      });
      socket.once('data', chunk => { socket.destroy(); resolve(chunk); });
      socket.on('error', reject);
    });
    assert.notEqual(first.subarray(0, 8).toString('latin1'), 'HTTP/1.1', 'not answered by the HTTP/1.1 server');
    assert.equal(first[3], 4, 'an h2 SETTINGS frame');
  } finally {
    await new Promise(resolve => front.close(resolve));
    await new Promise(resolve => h2.close(resolve));
  }
});

test('h2cFrontServer starts the HTTP/1.1 server\'s connection tracking: a slow header gets 408', async () => {
  const h1 = http.createServer({ headersTimeout: 600, requestTimeout: 800, connectionsCheckingInterval: 100 }, (req, res) => res.end('ok'));
  const front = h2cFrontServer(h1, h2cSniffer(h1, () => null));
  await new Promise(resolve => front.listen(0, '127.0.0.1', resolve));
  try {
    const started = Date.now();
    const answer = await new Promise(resolve => {
      const socket = net.connect(front.address().port, '127.0.0.1', () => socket.write('GET / HTTP/1.1\r\nHost: x\r\n'));
      let text = '';
      socket.on('data', chunk => { text += chunk; });
      socket.on('close', () => resolve(text));
      setTimeout(() => { socket.destroy(); resolve('still open'); }, 4000);
    });
    assert.match(answer, /^HTTP\/1\.1 408/);
    assert.ok(Date.now() - started < 3000);
  } finally {
    h1.close();
    await new Promise(resolve => front.close(resolve));
  }
});
