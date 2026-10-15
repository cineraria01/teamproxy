import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CLI = fileURLToPath(new URL('../src/index.js', import.meta.url));
let t;

const freePort = () => new Promise(done => {
  const s = http.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); });
});

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'teamproxy-json-'));
  const port = await freePort();
  const configPath = join(dir, 'config.json');
  const config = {
    provider: 'anthropic',
    proxy: { port, apiKey: 'tc-test', host: '127.0.0.1', allowNoAccounts: true },
    upstream: 'http://127.0.0.1:9',
    activeWarmup: false,
    accounts: [
      { name: 'api-1', type: 'apikey', apiKey: 'sk-ant-SECRET-KEY' },
      { name: 'main', type: 'oauth', email: 'alice@example.com', accessToken: 'AT-SECRET', refreshToken: 'RT-SECRET', expiresAt: Date.now() + 3_600_000, priority: 2 },
    ],
  };
  writeFileSync(configPath, JSON.stringify(config));
  // The token endpoint is faked; every other fetch (e.g. to the local server) passes through.
  writeFileSync(join(dir, 'mock-fetch.mjs'), `
const real = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('/v1/oauth/token')) {
    if (process.env.RACE_NAME) { // a concurrent login saved this name between the pre-check and our save
      const fs = await import('node:fs');
      const c = JSON.parse(fs.readFileSync(process.env.TEAMCLAUDE_CONFIG, 'utf8'));
      c.accounts.push({ name: process.env.RACE_NAME, type: 'apikey', apiKey: 'other' });
      fs.writeFileSync(process.env.TEAMCLAUDE_CONFIG, JSON.stringify(c));
    }
  }
  if (u.includes('/v1/oauth/token')) return Promise.resolve(Response.json({ access_token: 'new-at', refresh_token: 'new-rt', expires_in: 3600 }));
  if (u.includes('/oauth/profile')) return Promise.resolve(Response.json({ error: 'no' }, { status: 500 }));
  return real(url, init);
};
`);
  t = { dir, port, configPath, config, env: { ...process.env, LC_ALL: 'C', TEAMCLAUDE_PROVIDER: 'anthropic', TEAMCLAUDE_CONFIG: configPath, NODE_OPTIONS: `--import=${pathToFileURL(join(dir, 'mock-fetch.mjs')).href}` }, servers: [] };
});

afterEach(async () => {
  for (const child of t.servers) { child.kill('SIGTERM'); await once(child, 'exit').catch(() => {}); }
  rmSync(t.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

const cli = (args, env = {}) => new Promise(done => {
  execFile(process.execPath, [CLI, ...args], { env: { ...t.env, ...env }, timeout: 30_000 }, (error, stdout, stderr) => {
    done({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
  });
});
const json = async (args, expectCode = 0) => {
  const r = await cli(args);
  assert.equal(r.code, expectCode, r.stdout + r.stderr);
  return JSON.parse(r.stdout); // exactly one JSON object on stdout
};
const readConfig = () => JSON.parse(readFileSync(t.configPath, 'utf8'));

async function startServer() {
  const child = spawn(process.execPath, [CLI, 'server'], { env: t.env, stdio: 'ignore' });
  t.servers.push(child);
  for (let i = 0; i < 100; i += 1) {
    const ok = await fetch(`http://127.0.0.1:${t.port}/teamclaude/status`).then(r => r.ok, () => false);
    if (ok) return;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.fail('server did not start');
}

test('accounts --json without a server: one object, no secrets, masked email', async () => {
  const r = await cli(['accounts', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /SECRET|alice@/);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.running, false);
  assert.deepEqual(out.accounts.map(a => [a.name, a.type, a.enabled, a.usable, a.priority, a.email]),
    [['api-1', 'api', true, null, null, null], ['main', 'oauth', true, null, 2, 'a***@example.com']]);
});

test('with a server: usable flags, live-applied changes, status counts', async () => {
  await startServer();
  const accounts = await json(['accounts', '--json']);
  assert.equal(accounts.running, true);
  assert.equal(accounts.accounts.find(a => a.name === 'api-1').usable, true);
  for (const key of ['fiveHour', 'sevenDay', 'rateLimitedUntil', 'error']) assert.ok(key in accounts.accounts[0], key);

  assert.deepEqual(await json(['disable', 'api-1', '--json']), { ok: true, account: 'api-1', enabled: false, applied: 'live' });
  assert.equal(readConfig().accounts[0].enabled, false);
  let status = await json(['status', '--json']);
  for (let i = 0; i < 50 && status.accounts[0].usable; i += 1) { // the SIGHUP sync is asynchronous
    await new Promise(r => setTimeout(r, 100));
    status = await json(['status', '--json']);
  }
  assert.equal(status.accounts[0].enabled, false);
  assert.equal(status.accounts[0].usable, false);
  assert.equal(status.totalCount, 2);
  assert.equal(status.port, t.port);

  assert.equal((await json(['enable', 'api-1', '--json'])).enabled, true);
  assert.deepEqual(await json(['priority', 'api-1', '5', '--json']), { ok: true, account: 'api-1', priority: 5, applied: 'live' });
  assert.equal((await json(['priority', 'api-1', 'auto', '--json'])).priority, null);
  assert.equal(readConfig().accounts[0].priority, undefined);
  assert.equal((await json(['remove', 'api-1', '--json'])).applied, 'live');
  assert.deepEqual(readConfig().accounts.map(a => a.name), ['main']);
  // no request has flowed yet, so there is nothing to re-measure with: a coded JSON failure
  const reload = await json(['reload', '--json'], 1);
  assert.deepEqual([reload.ok, reload.error], [false, 'reload_failed']);
});

test('changes without a server are config_only; errors are JSON with exit 1', async () => {
  assert.deepEqual(await json(['disable', 'main', '--json']), { ok: true, account: 'main', enabled: false, applied: 'config_only' });
  const missing = await json(['enable', 'nobody', '--json'], 1);
  assert.deepEqual([missing.ok, missing.error], [false, 'account_not_found']);
  assert.equal((await json(['reload', '--json'], 1)).error, 'not_running');
  assert.equal((await json(['priority', 'main', 'abc', '--json'], 1)).error, 'usage');
});

// ── login events ──

function login(args = ['login', '--name', 'app-1', '--json'], env = {}, stdin = 'pipe') {
  const child = spawn(process.execPath, [CLI, ...args], { env: { ...t.env, ...env }, stdio: [stdin, 'pipe', 'pipe'] });
  const events = [];
  const waiters = [];
  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      events.push(JSON.parse(line)); // every stdout line is JSON
      waiters.splice(0).forEach(w => w());
    }
  });
  const next = async predicate => {
    for (;;) {
      const found = events.find(predicate);
      if (found) return found;
      await Promise.race([new Promise(r => waiters.push(r)), new Promise(r => setTimeout(r, 15_000)).then(() => assert.fail(`no event: ${JSON.stringify(events)}`))]);
    }
  };
  return { child, events, next, exit: once(child, 'exit') };
}

const callback = (authUrl, code = 'the-code') => {
  const u = new URL(authUrl);
  const redirect = new URL(u.searchParams.get('redirect_uri'));
  redirect.pathname = '/callback';
  redirect.searchParams.set('code', code);
  redirect.searchParams.set('state', u.searchParams.get('state'));
  return fetch(redirect, { redirect: 'manual' }).then(r => r.text()); // never follow the 302 out to the internet
};

test('claude login --json: auth_url, waiting, callback, done', async () => {
  const run = login();
  const auth = await run.next(e => e.event === 'auth_url');
  assert.match(auth.url, /^https:\/\/claude\.ai\/oauth\/authorize\?/);
  await run.next(e => e.event === 'waiting');
  await callback(auth.url);
  const [code] = await run.exit;
  assert.equal(code, 0);
  assert.deepEqual(run.events.map(e => e.event ?? 'done'), ['auth_url', 'waiting', 'done']);
  assert.deepEqual(run.events.at(-1), { done: true, ok: true, account: 'app-1', applied: 'config_only' });
  const saved = readConfig().accounts.find(a => a.name === 'app-1');
  assert.equal(saved.accessToken, 'new-at');
});

test('claude login --json: need_code, then a pasted callback URL on stdin finishes it', async () => {
  const run = login(undefined, { TEAMPROXY_NEED_CODE_MS: '200' });
  const auth = await run.next(e => e.event === 'auth_url');
  await run.next(e => e.event === 'need_code');
  const u = new URL(auth.url);
  run.child.stdin.write(`http://localhost:1/callback?code=pasted&state=${u.searchParams.get('state')}\n`);
  const [code] = await run.exit;
  assert.equal(code, 0);
  assert.deepEqual(run.events.at(-1), { done: true, ok: true, account: 'app-1', applied: 'config_only' });
});

test('a wrong state is a coded failure, not a hang', async () => {
  const run = login(undefined, { TEAMPROXY_NEED_CODE_MS: '100000' });
  await run.next(e => e.event === 'auth_url');
  run.child.stdin.write('http://localhost:1/callback?code=x&state=WRONG\n');
  const [code] = await run.exit;
  assert.equal(code, 1);
  assert.deepEqual([run.events.at(-1).ok, run.events.at(-1).error], [false, 'state_mismatch']);
});

test('SIGTERM cancels with a done line', async () => {
  const run = login();
  await run.next(e => e.event === 'waiting');
  run.child.kill('SIGTERM');
  const [code] = await run.exit;
  assert.equal(code, 1);
  assert.deepEqual(run.events.at(-1), { done: true, ok: false, error: 'cancelled' });
});

const FAKE_CODEX = `#!/bin/sh
echo "Starting local login server on http://localhost:1455."
echo "If your browser did not open, navigate to this URL to authenticate:"
echo "https://auth.example.test/oauth/authorize?state=abc"
if [ -n "$FAKE_CODEX_HANG" ]; then echo "$CODEX_HOME" > "$FAKE_CODEX_HOME_FILE"; echo $$ > "$FAKE_CODEX_PID_FILE"; exec sleep 60; fi
sleep 0.3
ID=$(printf '{"email":"bob@example.com"}' | base64 | tr '+/' '-_' | tr -d '=')
printf '{"tokens":{"access_token":"e30.e30.x","refresh_token":"rt","id_token":"e30.%s.x","account_id":"acct-1"}}' "$ID" > "$CODEX_HOME/auth.json"
`;

function fakeCodex() {
  const bin = join(t.dir, 'codex');
  writeFileSync(bin, FAKE_CODEX);
  chmodSync(bin, 0o755);
  return bin;
}

test('codex login --json relays the URL printed by the official CLI and saves the account', async () => {
  const run = login(['codex', 'login', '--name', 'codex-1', '--json'], { TEAMCODEX_CODEX_BIN: fakeCodex() });
  const auth = await run.next(e => e.event === 'auth_url');
  assert.equal(auth.url, 'https://auth.example.test/oauth/authorize?state=abc');
  assert.equal(typeof auth.browser_opened, 'boolean');
  const [code] = await run.exit;
  assert.equal(code, 0);
  assert.deepEqual(run.events.at(-1), { done: true, ok: true, account: 'codex-1', applied: 'config_only' });
  assert.equal(readConfig().accounts.find(a => a.name === 'codex-1').provider, 'codex');
});

test('codex login --json: SIGTERM stops the CLI child and removes its temp CODEX_HOME', async () => {
  const homeFile = join(t.dir, 'codex-home.txt');
  const pidFile = join(t.dir, 'codex.pid');
  const run = login(['codex', 'login', '--name', 'codex-1', '--json'], {
    TEAMCODEX_CODEX_BIN: fakeCodex(), FAKE_CODEX_HANG: '1', FAKE_CODEX_HOME_FILE: homeFile, FAKE_CODEX_PID_FILE: pidFile,
  });
  await run.next(e => e.event === 'waiting');
  for (let i = 0; i < 50 && !existsSync(pidFile); i += 1) await new Promise(r => setTimeout(r, 50));
  const pid = Number(readFileSync(pidFile, 'utf8'));
  const home = readFileSync(homeFile, 'utf8').trim();
  run.child.kill('SIGTERM');
  const [code] = await run.exit;
  assert.equal(code, 1);
  assert.deepEqual(run.events.at(-1), { done: true, ok: false, error: 'cancelled' });
  assert.equal(existsSync(home), false);
  await new Promise(r => setTimeout(r, 200));
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
  assert.deepEqual(readdirSync(t.dir).filter(n => n.startsWith('teamcodex-login-')), []);
});

test('codex login --json reports a missing CLI as codex_not_found', async () => {
  const run = login(['codex', 'login', '--json'], { TEAMCODEX_CODEX_BIN: join(t.dir, 'nope') });
  const [code] = await run.exit;
  assert.equal(code, 1);
  assert.equal(run.events.at(-1).error, 'codex_not_found');
});

test('login --json refuses a name that already exists (no overwrite) and never contacts the provider', async () => {
  const run = login(['login', '--name', 'main', '--json']);
  const [code] = await run.exit;
  assert.equal(code, 1);
  assert.deepEqual(run.events, [{ done: true, ok: false, error: 'name_taken', message: 'Account "main" already exists' }]);
  assert.equal(readConfig().accounts.find(a => a.name === 'main').accessToken, 'AT-SECRET');
});

test('cancelling a codex login reports cancelled every time (20 runs)', async () => {
  for (let i = 0; i < 20; i += 1) {
    const run = login(['codex', 'login', '--name', `c-${i}`, '--json'], { TEAMCODEX_CODEX_BIN: fakeCodex(), FAKE_CODEX_HANG: '1', FAKE_CODEX_HOME_FILE: join(t.dir, 'h'), FAKE_CODEX_PID_FILE: join(t.dir, 'p') });
    await run.next(e => e.event === 'waiting');
    run.child.kill('SIGTERM');
    const [code] = await run.exit;
    assert.equal(code, 1);
    assert.deepEqual(run.events.filter(e => e.done), [{ done: true, ok: false, error: 'cancelled' }], `run ${i}`);
  }
});

test('a name that appears between the pre-check and the save is not overwritten (name_taken)', async () => {
  const run = login(['login', '--name', 'raced', '--json'], { RACE_NAME: 'raced' });
  const auth = await run.next(e => e.event === 'auth_url');
  await callback(auth.url);
  const [code] = await run.exit;
  assert.equal(code, 1);
  assert.equal(run.events.at(-1).error, 'name_taken');
  assert.equal(readConfig().accounts.find(a => a.name === 'raced').apiKey, 'other');
});

// ── Windows paths (no SIGTERM handler, no SIGHUP, no lsof) ──

test('a {"cancel":true} line on stdin cancels with a done line', { timeout: 30_000 }, async () => {
  const run = login();
  await run.next(e => e.event === 'waiting');
  run.child.stdin.write('{"cancel":true}\n');
  const [code] = await run.exit;
  assert.equal(code, 1);
  assert.deepEqual(run.events.at(-1), { done: true, ok: false, error: 'cancelled' });
});

test('a login --json whose stdin is not a pipe (/dev/null, NUL) is not cancelled by its EOF', { timeout: 30_000 }, async () => {
  const run = login(undefined, {}, 'ignore');
  const auth = await run.next(e => e.event === 'waiting').then(() => run.events.find(e => e.event === 'auth_url'));
  await new Promise(r => setTimeout(r, 1_500));
  assert.equal(run.events.some(e => e.done), false, JSON.stringify(run.events));
  await callback(auth.url);
  const [code] = await run.exit;
  assert.equal(code, 0);
  assert.deepEqual(run.events.at(-1), { done: true, ok: true, account: 'app-1', applied: 'config_only' });
});

test('stdin EOF cancels a claude login with a done line', { timeout: 30_000 }, async () => {
  const run = login();
  await run.next(e => e.event === 'waiting');
  run.child.stdin.end();
  const [code] = await run.exit;
  assert.equal(code, 1);
  assert.deepEqual(run.events.filter(e => e.done), [{ done: true, ok: false, error: 'cancelled' }]);
});

test('stdin EOF cancels a codex login and removes its temp CODEX_HOME', { timeout: 30_000 }, async () => {
  const homeFile = join(t.dir, 'codex-home.txt');
  const pidFile = join(t.dir, 'codex.pid');
  const run = login(['codex', 'login', '--name', 'codex-1', '--json'], {
    TEAMCODEX_CODEX_BIN: fakeCodex(), FAKE_CODEX_HANG: '1', FAKE_CODEX_HOME_FILE: homeFile, FAKE_CODEX_PID_FILE: pidFile,
  });
  await run.next(e => e.event === 'waiting');
  for (let i = 0; i < 50 && !existsSync(pidFile); i += 1) await new Promise(r => setTimeout(r, 50));
  const home = readFileSync(homeFile, 'utf8').trim();
  run.child.stdin.end();
  const [code] = await run.exit;
  assert.equal(code, 1);
  assert.deepEqual(run.events.filter(e => e.done), [{ done: true, ok: false, error: 'cancelled' }]);
  assert.equal(existsSync(home), false);
});

test('a code pasted before the race starts is not lost', async () => {
  const run = login(undefined, { TEAMPROXY_NEED_CODE_MS: '100000' });
  run.child.stdin.write('pasted-early\n'); // may arrive before the callback server is up
  const [code] = await run.exit;
  assert.equal(code, 0);
  assert.deepEqual(run.events.at(-1), { done: true, ok: true, account: 'app-1', applied: 'config_only' });
});

const sync = (headers = { 'x-api-key': 'tc-test' }, method = 'POST') =>
  fetch(`http://127.0.0.1:${t.port}/teamclaude/accounts/sync`, { method, headers });

test('POST /teamclaude/accounts/sync: key required, POST only, applies the on-disk accounts', async () => {
  await startServer();
  assert.equal((await sync({ 'x-api-key': 'wrong' })).status, 401);
  assert.equal((await sync(undefined, 'GET')).status, 405);
  const config = readConfig();
  config.accounts[0].enabled = false;
  writeFileSync(t.configPath, JSON.stringify(config));
  const res = await sync();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, total: 2 });
  // applied before the response: no polling needed
  const status = await json(['status', '--json']);
  assert.equal(status.accounts.find(a => a.name === 'api-1').usable, false);
});

test('without lsof (as on Windows) --json changes and login still apply live through accounts/sync', async () => {
  await startServer();
  // A PATH holding only node: no lsof or ps anywhere (Ubuntu has /usr/bin/lsof).
  const bin = join(t.dir, 'bin');
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, 'node'));
  const noLsof = { PATH: bin };
  const disable = await cli(['disable', 'api-1', '--json'], noLsof);
  assert.deepEqual(JSON.parse(disable.stdout), { ok: true, account: 'api-1', enabled: false, applied: 'live' });
  const status = await json(['status', '--json']);
  assert.equal(status.accounts.find(a => a.name === 'api-1').usable, false);
  const run = login(undefined, noLsof);
  const auth = await run.next(e => e.event === 'auth_url');
  await callback(auth.url);
  const [code] = await run.exit;
  assert.equal(code, 0);
  assert.deepEqual(run.events.at(-1), { done: true, ok: true, account: 'app-1', applied: 'live' });
});

test('POST /teamclaude/accounts/sync from a non-loopback address is refused (403) even with the key', async ctx => {
  const external = Object.values(networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal);
  if (!external) return ctx.skip('no non-loopback IPv4 interface on this machine to call from');
  const config = readConfig();
  config.proxy.host = '0.0.0.0';
  writeFileSync(t.configPath, JSON.stringify(config));
  await startServer();
  const res = await fetch(`http://${external.address}:${t.port}/teamclaude/accounts/sync`, { method: 'POST', headers: { 'x-api-key': 'tc-test' } });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error.message, /local-only/);
});

test('accounts/sync answers once the accounts are applied, without waiting for a slow quota fetch', async () => {
  // A codex server whose wham/usage never answers in time: the sync reply must not wait for it.
  writeFileSync(join(t.dir, 'mock-fetch.mjs'), `
const real = globalThis.fetch;
globalThis.fetch = (url, init) => String(url).includes('/wham/usage')
  ? new Promise(() => {}) // never settles
  : real(url, init);
`);
  const config = {
    provider: 'codex',
    proxy: { port: t.port, apiKey: 'tc-test', host: '127.0.0.1', allowNoAccounts: true },
    activeWarmup: false,
    accounts: [{ name: 'codex-1', provider: 'codex', type: 'oauth', accessToken: 'tok-1', refreshToken: 'r-1', accountId: 'ws-1', expiresAt: Date.now() + 3_600_000 }],
  };
  writeFileSync(t.configPath, JSON.stringify(config));
  t.env.TEAMCLAUDE_PROVIDER = 'codex';
  await startServer();
  config.accounts.push({ ...config.accounts[0], name: 'codex-2', accessToken: 'tok-2', accountId: 'ws-2' });
  writeFileSync(t.configPath, JSON.stringify(config));
  const started = Date.now();
  const res = await fetch(`http://127.0.0.1:${t.port}/teamclaude/accounts/sync`, {
    method: 'POST', headers: { 'x-api-key': 'tc-test' }, signal: AbortSignal.timeout(5_000), // fail, not hang, if it waits again
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, total: 2 });
  assert.ok(Date.now() - started < 5_000, `sync took ${Date.now() - started} ms`);
});

test('an older server (no accountsSync in its status) gets no POST: the change reports restart_required', async () => {
  const posts = [];
  const old = http.createServer((req, res) => {
    if (req.method === 'POST') posts.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ accounts: [], switchThreshold: 0.98, usableCount: 0, totalCount: 2 })); // status without the flag
  });
  await new Promise(r => old.listen(t.port, '127.0.0.1', r));
  try {
    const bin = join(t.dir, 'bin');
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, 'node'));
    const r = await cli(['disable', 'api-1', '--json'], { PATH: bin });
    assert.deepEqual(JSON.parse(r.stdout), { ok: true, account: 'api-1', enabled: false, applied: 'restart_required' });
    assert.deepEqual(posts, []);
  } finally {
    old.close();
  }
});
