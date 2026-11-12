import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import {
  HUD_HTML, REMOTE_PORTS, accountState, buildTeamproxyStatus, failureDelayMs, isServeRequest, parsePriority,
  remotePort, remoteVerdict, selfFromStatus, serveArgs, serveState, tokenMatches,
} from '../src/remote.js';

const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));
const TOKEN = 'remote-token-0123456789abcdef0123456789';
const LOGIN = 'me@example.com';
const remoteOn = { enabled: true, token: TOKEN, allowLogins: [LOGIN] };

// ── pure helpers ────────────────────────────────────────────

test('remoteVerdict: off, login, token, Bearer, HUD shell', () => {
  const h = extra => ({ 'tailscale-user-login': LOGIN, ...extra });
  assert.equal(remoteVerdict(h({ 'x-api-key': TOKEN }), { ...remoteOn, enabled: false }).status, 403);
  assert.equal(remoteVerdict(h({ 'x-api-key': TOKEN }), undefined).status, 403);
  assert.equal(remoteVerdict({ 'x-api-key': TOKEN, 'x-forwarded-for': '100.1.2.3' }, remoteOn).status, 403);
  assert.equal(remoteVerdict(h({ 'tailscale-user-login': 'other@example.com', 'x-api-key': TOKEN }), remoteOn).status, 403);
  assert.equal(remoteVerdict(h({}), remoteOn).status, 401);
  assert.equal(remoteVerdict(h({ 'x-api-key': 'wrong' }), remoteOn).status, 401);
  assert.equal(remoteVerdict(h({ authorization: 'Bearer wrong' }), remoteOn).status, 401);
  assert.deepEqual(remoteVerdict(h({ 'x-api-key': TOKEN }), remoteOn), { ok: true });
  assert.deepEqual(remoteVerdict(h({ authorization: `Bearer ${TOKEN}` }), remoteOn), { ok: true });
  assert.deepEqual(remoteVerdict(h({}), remoteOn, { shellOnly: true }), { ok: true });
  assert.equal(remoteVerdict({}, remoteOn, { shellOnly: true }).status, 403);
});

test('small helpers', () => {
  assert.equal(isServeRequest({ 'tailscale-user-login': 'x' }), true);
  assert.equal(isServeRequest({ 'x-forwarded-for': '1.2.3.4' }), true);
  assert.equal(isServeRequest({ 'x-api-key': 'k' }), false);
  assert.equal(tokenMatches(TOKEN, TOKEN), true);
  assert.equal(tokenMatches(TOKEN.slice(1), TOKEN), false);
  assert.equal(tokenMatches(undefined, TOKEN), false);
  assert.equal(tokenMatches('', ''), false);
  assert.deepEqual(Object.values(REMOTE_PORTS), [8456, 8457, 8458, 8459, 8460]);
  assert.equal(remotePort('grok', {}), 8459);
  assert.equal(remotePort('grok', { port: 9000 }), 9000);
  assert.ok(failureDelayMs(1) < failureDelayMs(4) && failureDelayMs(1000) === 5000);
  assert.deepEqual(parsePriority('auto'), { clear: true });
  assert.deepEqual(parsePriority('2.7'), { clear: false, value: 2 });
  assert.deepEqual(parsePriority(1), { clear: false, value: 1 });
  assert.equal(parsePriority('x'), null);
  for (const on of [true, false]) assert.ok(!serveArgs(on, 8456, 3456).includes('funnel'));
  assert.deepEqual(serveArgs(true, 8456, 3456), ['serve', '--bg', '--https=8456', 'http://127.0.0.1:3456']);
  assert.deepEqual(serveArgs(false, 8456, 3456), ['serve', '--https=8456', 'off']);
  assert.deepEqual(selfFromStatus({ Self: { UserID: 7, DNSName: 'mac.t.ts.net.' }, User: { 7: { LoginName: LOGIN } } }),
    { login: LOGIN, dnsName: 'mac.t.ts.net' });
  const served = { TCP: { 8456: { HTTPS: true } }, Web: { 'mac.t.ts.net:8456': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3456' } } } } };
  assert.deepEqual(serveState(served, 8456, 3456), { served: true, target: 'http://127.0.0.1:3456', matches: true, funnel: false });
  assert.equal(serveState({ ...served, AllowFunnel: { 'mac.t.ts.net:8456': true } }, 8456, 3456).funnel, true);
  assert.equal(serveState({}, 8456, 3456).served, false);
});

test('HUD page carries no data and no inline secret', () => {
  assert.match(HUD_HTML, /<html lang="ko">/);
  assert.match(HUD_HTML, /prefers-color-scheme:dark/);
  assert.match(HUD_HTML, /10000/);
  assert.doesNotMatch(HUD_HTML, /"accounts"\s*:/);
});

const NOW = Date.parse('2026-11-13T00:00:00Z');
function snapshot(quota, extra = {}) {
  return {
    currentAccount: 'a1',
    accounts: [
      { name: 'a1', planType: 'pro', enabled: true, priority: 1, inflight: 2, usable: true, status: 'active',
        quota, subscription: { endsAt: '2026-12-01T00:00:00Z' }, quotaStale: false, ...extra },
      { name: 'a2', planType: null, enabled: false, priority: null, inflight: 0, usable: true, status: 'active', quota: {} },
    ],
  };
}

test('status JSON: claude has every cell, other pools null where the footer has none', () => {
  const quota = {
    unified5h: 0.004, unified5hReset: NOW + 3600_000, unified7d: 0.9, unified7dReset: '2026-11-15T00:00:00Z',
    modelWeekly: { '7d_oi': { utilization: 0.38, reset: NOW + 86400_000 } },
    agyGroups: { '3p': { fiveHour: { utilization: 0.2, reset: NOW + 1000 }, weekly: { utilization: 0.5, reset: NOW + 2000 } } },
  };
  const claude = buildTeamproxyStatus(snapshot(quota), { pool: 'claude', version: 'abc12345', now: NOW });
  assert.deepEqual(Object.keys(claude), ['pool', 'version', 'accounts', 'requests', 'updatedAt']);
  assert.deepEqual(claude.requests, { active: 2 });
  assert.equal(claude.updatedAt, '2026-11-13T00:00:00.000Z');
  const [a1, a2] = claude.accounts;
  assert.deepEqual(a1, {
    n: 1, name: 'a1', tag: 'pro', enabled: true, active: true, priority: 1, state: 'busy',
    session: { pct: 0, resetsAt: '2026-11-13T01:00:00.000Z' },
    weekly: { pct: 90, resetsAt: '2026-11-15T00:00:00.000Z' },
    fable: { pct: 38, resetsAt: '2026-11-14T00:00:00.000Z' },
    thirdParty: null,
    end: '2026-12-01T00:00:00.000Z',
    stale: false,
  });
  assert.equal(a2.n, 2);
  assert.equal(a2.active, false);
  assert.equal(a2.state, 'off');
  assert.equal(a2.session, null);

  const codex = buildTeamproxyStatus(snapshot(quota), { pool: 'codex', now: NOW }).accounts[0];
  assert.equal(codex.fable, null);
  assert.equal(codex.thirdParty, null);
  assert.equal(codex.end, '2026-12-01T00:00:00.000Z');
  const agy = buildTeamproxyStatus(snapshot(quota), { pool: 'agy', now: NOW }).accounts[0];
  assert.deepEqual(agy.thirdParty, { pct: 50, resetsAt: new Date(NOW + 2000).toISOString() });
  assert.equal(agy.end, null);
  for (const pool of ['grok', 'cursor']) {
    const row = buildTeamproxyStatus(snapshot(quota), { pool, now: NOW }).accounts[0];
    assert.equal(row.weekly, null);
    assert.equal(row.fable, null);
    assert.equal(row.end, null);
    assert.equal(row.session.pct, 0);
  }
  // Ultra: the proxy stated there is no 5-hour window.
  assert.equal(buildTeamproxyStatus(snapshot({ ...quota, sessionWindowStated: false }), { pool: 'claude', now: NOW })
    .accounts[0].session, null);
});

test('accountState matches the footer states', () => {
  const base = { enabled: true, status: 'active', inflight: 0, usable: true };
  assert.equal(accountState({ ...base, enabled: false }, NOW), 'off');
  assert.equal(accountState({ ...base, status: 'error' }, NOW), 'error');
  assert.equal(accountState({ ...base, rateLimitedUntil: new Date(NOW + 1000).toISOString() }, NOW), 'wait');
  assert.equal(accountState({ ...base, capacityCooling: { m: NOW + 1000 } }, NOW), 'cool');
  assert.equal(accountState({ ...base, inflight: 1 }, NOW), 'busy');
  assert.equal(accountState({ ...base, usable: false }, NOW), 'limit');
  assert.equal(accountState({ ...base, capacityRecovered: { m: NOW - 1000 } }, NOW), 'back');
  assert.equal(accountState(base, NOW), 'ready');
});

// ── supervisor + worker ─────────────────────────────────────

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function unusedPort() {
  const holder = http.createServer();
  const port = await listen(holder);
  await new Promise(resolve => holder.close(resolve));
  return port;
}

function request(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const out = http.request({ host: '127.0.0.1', port, path, method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    out.once('error', reject);
    out.end(body);
  });
}

const serve = (extra = {}) => ({ 'tailscale-user-login': LOGIN, 'x-forwarded-for': '100.64.0.9', ...extra });

const accounts = () => [
  { name: 'account-a', type: 'apikey', apiKey: 'fixture-a' },
  { name: 'account-b', type: 'apikey', apiKey: 'fixture-b' },
];

async function startServer(t, { remote, upstream = 'http://127.0.0.1:9' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'teamproxy-remote-'));
  const configPath = join(dir, 'config.json');
  const port = await unusedPort();
  await writeFile(configPath, JSON.stringify({
    proxy: { port, host: '127.0.0.1', apiKey: 'tc-proxy-key-for-tests' },
    upstream,
    activeWarmup: false,
    tokenRefreshIntervalMs: 0,
    ...(remote ? { remote } : {}),
    accounts: accounts(),
  }), { mode: 0o600 });
  const env = { ...process.env, TEAMCLAUDE_CONFIG: configPath };
  delete env.TEAMCLAUDE_PROVIDER;
  const child = spawn(process.execPath, [entry, 'server'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  t.after(async () => {
    if (child.exitCode == null && child.signalCode == null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await Promise.race([exited, delay(6500)]);
      if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
    }
    await rm(dir, { recursive: true, force: true });
  });
  const deadline = Date.now() + 10_000;
  for (;;) {
    const ok = await request(port, '/teamclaude/status').then(r => r.status === 200, () => false);
    if (ok) break;
    if (Date.now() > deadline) throw new Error(`proxy did not start:\n${log}`);
    await delay(50);
  }
  return { port, dir, configPath, env, log: () => log };
}

test('remote off: requests through tailscale serve are refused; loopback is unchanged', { timeout: 20000 }, async t => {
  const { port } = await startServer(t);
  const viaServe = await request(port, '/teamproxy/status', { headers: serve({ 'x-api-key': TOKEN }) });
  assert.equal(viaServe.status, 403);
  assert.doesNotMatch(viaServe.body, /account-a/);
  const legacyStatus = await request(port, '/teamclaude/status', { headers: serve() });
  assert.equal(legacyStatus.status, 403);
  assert.equal((await request(port, '/teamproxy/status')).status, 401, 'a local caller needs a key too');
  assert.equal((await request(port, '/teamproxy/hud')).status, 200);
  const local = await request(port, '/teamproxy/status', { headers: { 'x-api-key': 'tc-proxy-key-for-tests' } });
  assert.equal(local.status, 200);
  assert.equal(JSON.parse(local.body).accounts[0].name, 'account-a');
  assert.equal((await request(port, '/teamclaude/status')).status, 200);
});

test('remote on: token + allowed login, 401 slows down, local-only routes stay local', { timeout: 20000 }, async t => {
  const { port, configPath, log } = await startServer(t, { remote: remoteOn });

  const noToken = await request(port, '/teamproxy/status', { headers: serve() });
  assert.equal(noToken.status, 401);
  assert.doesNotMatch(noToken.body, /account-a/);
  const started = Date.now();
  const wrong = await request(port, '/teamproxy/status', { headers: serve({ 'x-api-key': 'nope' }) });
  assert.equal(wrong.status, 401);
  assert.ok(Date.now() - started >= 450, 'consecutive failures are delayed');
  const otherLogin = await request(port, '/teamproxy/status',
    { headers: serve({ 'tailscale-user-login': 'stranger@example.com', 'x-api-key': TOKEN }) });
  assert.equal(otherLogin.status, 403);

  const ok = await request(port, '/teamproxy/status', { headers: serve({ 'x-api-key': TOKEN }) });
  assert.equal(ok.status, 200);
  const status = JSON.parse(ok.body);
  assert.equal(status.pool, 'claude');
  assert.deepEqual(status.accounts.map(a => [a.n, a.name, a.enabled]), [[1, 'account-a', true], [2, 'account-b', true]]);
  assert.deepEqual(Object.keys(status.accounts[0]),
    ['n', 'name', 'tag', 'enabled', 'active', 'priority', 'state', 'session', 'weekly', 'fable', 'thirdParty', 'end', 'stale']);
  const bearer = await request(port, '/teamproxy/status', { headers: serve({ authorization: `Bearer ${TOKEN}` }) });
  assert.equal(bearer.status, 200);

  // The HUD shell needs the login but no token, and carries no account data.
  const hud = await request(port, '/teamproxy/hud', { headers: serve() });
  assert.equal(hud.status, 200);
  assert.match(hud.headers['content-type'], /text\/html/);
  assert.match(hud.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.doesNotMatch(hud.body, /account-a|account-b/);
  assert.equal((await request(port, '/teamproxy/hud', { headers: serve({ 'tailscale-user-login': 'x@y' }) })).status, 403);

  // A remote token holder is still remote: operator routes stay loopback-only.
  for (const path of ['/teamclaude/reload', '/teamclaude/rotate', '/teamclaude/accounts/sync']) {
    const res = await request(port, path, { method: 'POST', headers: serve({ 'x-api-key': TOKEN }) });
    assert.equal(res.status, 403, path);
  }
  const identity = await request(port, '/teamclaude/status',
    { headers: serve({ 'x-api-key': TOKEN, 'x-teamcodex-status-identity': '1' }) });
  assert.equal(identity.status, 200);
  assert.equal(JSON.parse(identity.body).accounts[0].name, undefined);

  // Rotating the token in the config applies without a restart.
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.remote.token = `${TOKEN}-rotated`;
  await writeFile(configPath, JSON.stringify(config));
  await delay(20);
  assert.equal((await request(port, '/teamproxy/status', { headers: serve({ 'x-api-key': TOKEN }) })).status, 401);
  assert.equal((await request(port, '/teamproxy/status', { headers: serve({ 'x-api-key': `${TOKEN}-rotated` }) })).status, 200);

  assert.ok(!log().includes(TOKEN), 'the token never reaches a log line');
});

test('remote requests reach the upstream without the token or Tailscale identity headers', { timeout: 20000 }, async t => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers);
    req.resume();
    req.once('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg', type: 'message', content: [] }));
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const { port } = await startServer(t, { remote: remoteOn, upstream: `http://127.0.0.1:${upstreamPort}` });
  const res = await request(port, '/v1/messages', {
    method: 'POST',
    headers: serve({ 'x-api-key': TOKEN, 'content-type': 'application/json' }),
    body: JSON.stringify({ model: 'claude-test', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 200, res.body);
  assert.equal(seen.length, 1);
  const forwarded = JSON.stringify(seen[0]);
  assert.ok(!forwarded.includes(TOKEN));
  assert.ok(!forwarded.includes(LOGIN));
  assert.equal(seen[0]['x-forwarded-for'], undefined);
  assert.equal(seen[0]['x-api-key'], 'fixture-a');
});

test('account actions change the config exactly like the CLI', { timeout: 30000 }, async t => {
  const { port, configPath, dir, env } = await startServer(t, { remote: remoteOn });
  // A local POST without a key is refused (a visited web page could otherwise POST here).
  assert.equal((await request(port, '/teamproxy/accounts/2/disable', { method: 'POST' })).status, 401);

  const post = (path, body, headers = serve({ 'x-api-key': TOKEN })) => request(port, path, {
    method: 'POST',
    headers: body ? { ...headers, 'content-type': 'application/json' } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.equal((await post('/teamproxy/accounts/2/disable')).status, 200);
  assert.equal((await post('/teamproxy/accounts/1/priority', { priority: 1 })).status, 200);
  const local = await post('/teamproxy/accounts/2/priority', { priority: 3 }, { 'x-api-key': 'tc-proxy-key-for-tests' });
  assert.equal(local.status, 200);
  assert.equal((await post('/teamproxy/accounts/2/priority', { priority: 'auto' })).status, 200);
  assert.equal((await post('/teamproxy/accounts/9/enable')).status, 404);
  assert.equal((await post('/teamproxy/accounts/1/priority', { priority: 'high' })).status, 400);
  assert.equal((await post('/teamproxy/accounts/1/priority')).status, 400);

  // The same changes through the CLI on a twin config.
  const twin = join(dir, 'twin.json');
  await writeFile(twin, JSON.stringify({ proxy: { port: await unusedPort() }, accounts: accounts() }), { mode: 0o600 });
  const cli = (...argv) => {
    const run = spawnSync(process.execPath, [entry, ...argv], { env: { ...env, TEAMCLAUDE_CONFIG: twin }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
  };
  cli('disable', 'account-b');
  cli('priority', 'account-a', '1');
  cli('priority', 'account-b', '3');
  cli('priority', 'account-b', 'auto');
  const pick = async path => JSON.parse(await readFile(path, 'utf8')).accounts
    .map(({ name, enabled, priority }) => ({ name, enabled, priority }));
  assert.deepEqual(await pick(configPath), await pick(twin));

  // The live server follows (same account reload as the CLI's).
  const status = JSON.parse((await request(port, '/teamproxy/status', { headers: { 'x-api-key': TOKEN } })).body);
  assert.deepEqual(status.accounts.map(a => [a.name, a.enabled, a.priority]),
    [['account-a', true, 1], ['account-b', false, null]]);
  // Reload is reachable; with no traffic yet there is nothing to re-measure with.
  assert.equal((await post('/teamproxy/reload')).status, 409);
});

test('remote CLI drives tailscale serve (never funnel) and keeps the token off on/status output', { timeout: 20000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'teamproxy-remote-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'config.json');
  const logPath = join(dir, 'tailscale.log');
  const fake = join(dir, 'tailscale');
  const port = await unusedPort();
  await writeFile(fake, `#!/bin/sh
echo "$@" >> "${logPath}"
case "$1 $2" in
  "status --json") echo '{"Self":{"UserID":7,"DNSName":"mac.tail1.ts.net."},"User":{"7":{"LoginName":"${LOGIN}"}}}' ;;
  "serve status") echo '{"TCP":{"8456":{"HTTPS":true}},"Web":{"mac.tail1.ts.net:8456":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:${port}"}}}}}' ;;
esac
`);
  await chmod(fake, 0o755);
  await writeFile(configPath, JSON.stringify({ proxy: { port, host: '127.0.0.1' }, accounts: accounts() }), { mode: 0o600 });
  const env = { ...process.env, TEAMCLAUDE_CONFIG: configPath, TEAMPROXY_TAILSCALE_BIN: fake };
  delete env.TEAMCLAUDE_PROVIDER;
  const cli = (...argv) => spawnSync(process.execPath, [entry, 'remote', ...argv], { env, encoding: 'utf8' });

  assert.equal(cli('token').status, 1);
  const on = cli('on');
  assert.equal(on.status, 0, on.stderr);
  assert.match(on.stdout, /https:\/\/mac\.tail1\.ts\.net:8456/);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(config.remote.enabled, true);
  assert.deepEqual(config.remote.allowLogins, [LOGIN]);
  assert.equal(Buffer.from(config.remote.token, 'base64url').length, 32);
  assert.ok(!on.stdout.includes(config.remote.token) && !on.stderr.includes(config.remote.token));

  const status = cli('status');
  assert.equal(status.status, 0);
  assert.match(status.stdout, /Remote: {3}on/);
  assert.match(status.stdout, /Serve: {4}on → http:\/\/127\.0\.0\.1:/);
  assert.ok(!status.stdout.includes(config.remote.token));

  assert.equal(cli('token').stdout.trim(), config.remote.token);
  const rotated = cli('token', '--rotate');
  assert.notEqual(rotated.stdout.trim(), config.remote.token);
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).remote.token, rotated.stdout.trim());

  assert.equal(cli('off').status, 0);
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).remote.enabled, false);
  const calls = await readFile(logPath, 'utf8');
  assert.match(calls, new RegExp(`serve --bg --https=8456 http://127.0.0.1:${port}`));
  assert.match(calls, /serve --https=8456 off/);
  assert.doesNotMatch(calls, /funnel/);
});
