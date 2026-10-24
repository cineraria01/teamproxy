import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import http2 from 'node:http2';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDefaultConfig, getConfigPath, getQuotaCachePath, getServerStatePath } from '../src/config.js';

const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));
const jwt = payload => `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const userOf = header => JSON.parse(Buffer.from(String(header).slice('Bearer '.length).split('.')[1], 'base64url')).marker;

function listen(server, host = '127.0.0.1') {
  return new Promise(resolve => server.listen(0, host, () => resolve(server.address().port)));
}

async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

function isolatedEnv(dir, extra = {}) {
  const env = { ...process.env };
  for (const key of ['TEAMCLAUDE_PROVIDER', 'TEAMCLAUDE_CONFIG', 'TEAMCLAUDE_SESSION_SUPERVISED',
    'TEAMCURSOR_CURSOR_BIN', 'CURSOR_API_ENDPOINT']) delete env[key];
  return { ...env, HOME: dir, XDG_CONFIG_HOME: join(dir, 'xdg'), ...extra };
}

/**
 * Fake api2.cursor.sh: /auth/poll (pending once, then the token of the current user), and the Connect JSON
 * RPCs GetMe / GetPlanInfo / GetCurrentPeriodUsage, whose identity follows the bearer (`marker` claim).
 */
async function fakeCursor() {
  const calls = [];
  let next = 'u1';
  let meFails = false;
  const polled = new Map();
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const url = new URL(req.url, 'http://x');
    calls.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/auth/poll') {
      const uuid = url.searchParams.get('uuid');
      if (!polled.has(uuid)) {
        polled.set(uuid, url.searchParams.get('verifier'));
        res.statusCode = 404;
        res.end('{}');
        return;
      }
      const token = jwt({ sub: `auth0|${next}`, exp: 2_000_000_000, marker: next });
      res.end(JSON.stringify({ accessToken: token, refreshToken: token }));
    } else if (url.pathname === '/aiserver.v1.DashboardService/GetMe' && meFails) {
      res.statusCode = 503;
      res.end('{}');
    } else if (url.pathname === '/aiserver.v1.DashboardService/GetMe') {
      const user = userOf(req.headers.authorization);
      res.end(JSON.stringify({ userId: Number(user.slice(1)) * 100, email: `${user}@example.com` }));
    } else if (url.pathname === '/aiserver.v1.DashboardService/GetPlanInfo') {
      res.end(JSON.stringify({ planInfo: { planName: 'Ultra' } }));
    } else if (url.pathname === '/aiserver.v1.DashboardService/GetCurrentPeriodUsage') {
      res.end(JSON.stringify({ billingCycleEnd: '4102444800000', planUsage: { totalSpend: 100, limit: 40000 } }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  const port = await listen(server);
  return {
    server, calls, polled, url: `http://127.0.0.1:${port}`,
    setUser: user => { next = user; }, setMeFails: fails => { meFails = fails; },
  };
}

async function cursorConfig(dir, api, extra = {}) {
  const path = join(dir, 'teamcursor.json');
  await writeFile(path, JSON.stringify({
    provider: 'cursor',
    proxy: { port: await freePort(), apiKey: 'proxy-key' },
    cursorUpstream: api?.url ?? 'http://127.0.0.1:9',
    cursorWebsiteUrl: 'https://cursor.example',
    accounts: [],
    ...extra,
  }));
  return path;
}

test('cursor mode has its own config file, port 3460, upstream, and state files', () => {
  const saved = { provider: process.env.TEAMCLAUDE_PROVIDER, config: process.env.TEAMCLAUDE_CONFIG, xdg: process.env.XDG_CONFIG_HOME };
  try {
    delete process.env.TEAMCLAUDE_CONFIG;
    process.env.XDG_CONFIG_HOME = '/tmp/teamcursor-xdg';
    process.env.TEAMCLAUDE_PROVIDER = 'cursor';
    assert.equal(getConfigPath(), '/tmp/teamcursor-xdg/teamcursor.json');
    assert.equal(getServerStatePath(), '/tmp/teamcursor-xdg/teamcursor.server.json');
    assert.equal(getQuotaCachePath(), '/tmp/teamcursor-xdg/teamcursor.quota.json');
    const config = createDefaultConfig();
    assert.equal(config.provider, 'cursor');
    assert.equal(config.proxy.port, 3460);
    assert.equal(config.upstream, 'https://api2.cursor.sh');
    assert.equal(config.maxConcurrentPerAccount, 8);
    process.env.TEAMCLAUDE_PROVIDER = 'grok';
    assert.equal(createDefaultConfig().proxy.port, 3459);
  } finally {
    for (const [key, name] of [['provider', 'TEAMCLAUDE_PROVIDER'], ['config', 'TEAMCLAUDE_CONFIG'], ['xdg', 'XDG_CONFIG_HOME']]) {
      if (saved[key] === undefined) delete process.env[name];
      else process.env[name] = saved[key];
    }
  }
});

test('the cursor prefix selects teamcursor.json, refuses Claude/Codex-only commands, and never shares a config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamcursor-help-'));
  try {
    const help = await runCli(['cursor', 'help'], isolatedEnv(dir));
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /TeamCursor/);
    assert.match(help.stdout, new RegExp(`Config: ${escape(join(dir, 'xdg', 'teamcursor.json'))}`));
    for (const command of ['api', 'reauth', 'subscription']) {
      const refused = await runCli([command, 'x'], isolatedEnv(dir, { TEAMCLAUDE_PROVIDER: 'cursor' }));
      assert.equal(refused.status, 1, command);
      assert.match(refused.stderr, /not available for the Cursor pool/, command);
    }
    const claudeConfig = join(dir, 'teamclaude.json');
    const claudeText = JSON.stringify({ proxy: { port: 1 }, accounts: [{ name: 'x', type: 'oauth', accessToken: 't' }] });
    await writeFile(claudeConfig, claudeText);
    const cursorOnClaude = await runCli(['cursor', 'accounts'], isolatedEnv(dir, { TEAMCLAUDE_CONFIG: claudeConfig }));
    assert.equal(cursorOnClaude.status, 1);
    assert.match(cursorOnClaude.stderr, /not a Cursor config \(provider: unset\)/);
    assert.equal(await readFile(claudeConfig, 'utf8'), claudeText, 'the refusal writes nothing');
    const cursorFile = await cursorConfig(dir, null);
    for (const prefix of [[], ['codex'], ['grok']]) {
      const other = await runCli([...prefix, 'accounts'], isolatedEnv(dir, { TEAMCLAUDE_CONFIG: cursorFile }));
      assert.equal(other.status, 1, prefix.join(' '));
      assert.match(other.stderr, /(is a Cursor config — refusing|not a Grok config \(provider: "cursor"\))/, prefix.join(' '));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cursor login --json: browser URL with PKCE, polling, cursor-N names, a re-login of the same user updates in place', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamcursor-login-'));
  const api = await fakeCursor();
  try {
    const configPath = await cursorConfig(dir, api);
    const env = isolatedEnv(dir, { TEAMCLAUDE_CONFIG: configPath });
    const lines = text => text.trim().split('\n').map(line => JSON.parse(line));

    const first = await runCli(['cursor', 'login', '--json'], env);
    assert.equal(first.status, 0, first.stderr);
    const [auth, waiting, done] = lines(first.stdout);
    assert.equal(auth.event, 'auth_url');
    assert.equal(auth.browser_opened, false);
    const url = new URL(auth.url);
    assert.equal(url.origin + url.pathname, 'https://cursor.example/loginDeepControl');
    const verifier = api.polled.get(url.searchParams.get('uuid'));
    assert.equal(url.searchParams.get('challenge'), createHash('sha256').update(verifier).digest('base64url'));
    assert.deepEqual(waiting, { event: 'waiting' });
    assert.deepEqual(done, { done: true, ok: true, account: 'cursor-1', applied: 'config_only' });

    api.setUser('u2');
    assert.equal(lines((await runCli(['cursor', 'login', '--json'], env)).stdout).at(-1).account, 'cursor-2');
    api.setUser('u1');
    assert.equal(lines((await runCli(['cursor', 'login', '--json'], env)).stdout).at(-1).account, 'cursor-1', 'same user → same account');
    api.setMeFails(true); // GetMe down: the token's sub still finds the same account
    assert.equal(lines((await runCli(['cursor', 'login', '--json'], env)).stdout).at(-1).account, 'cursor-1', 'same sub → same account');
    api.setMeFails(false);
    const taken = await runCli(['cursor', 'login', '--json', '--name', 'cursor-2'], env);
    assert.equal(taken.status, 1);
    assert.deepEqual(lines(taken.stdout).at(-1), { done: true, ok: false, error: 'name_taken', message: 'Account "cursor-2" already exists' });

    const config = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(config.provider, 'cursor');
    assert.equal(config.accounts.length, 2);
    assert.equal(config.accounts[0].cursorSub, 'auth0|u1');
    assert.deepEqual(config.accounts.map(a => [a.name, a.accountUuid, a.email, a.planType, a.provider, a.type, a.source, a.expiresAt]), [
      ['cursor-1', '100', 'u1@example.com', 'Ultra', 'cursor', 'oauth', 'login', 2_000_000_000_000],
      ['cursor-2', '200', 'u2@example.com', 'Ultra', 'cursor', 'oauth', 'login', 2_000_000_000_000],
    ]);
    assert.equal(config.accounts[0].refreshToken, config.accounts[0].accessToken);
    const view = JSON.parse((await runCli(['cursor', 'accounts', '--json'], env)).stdout);
    assert.equal(view.accounts[0].plan, 'Ultra');
    assert.equal(view.accounts[0].email, 'u***@example.com');
    const listed = await runCli(['cursor', 'accounts'], env);
    assert.match(listed.stdout, /cursor-1 \(Cursor Ultra, login\)/);
    assert.match(listed.stdout, /expire/i);
  } finally {
    await new Promise(resolve => api.server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('cursor import --file: reads the login, warns that it is not refreshed, refuses an expired one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamcursor-import-'));
  const api = await fakeCursor();
  try {
    const configPath = await cursorConfig(dir, api);
    const env = isolatedEnv(dir, { TEAMCLAUDE_CONFIG: configPath });
    const token = jwt({ sub: 'auth0|u1', exp: 2_000_000_000, marker: 'u1' });
    const file = join(dir, 'auth.json');
    await writeFile(file, JSON.stringify({ accessToken: token, refreshToken: token }));
    const result = await runCli(['cursor', 'import', '--file', file], env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /not refreshed; this one stops working on 2033-05-18/);
    assert.match(result.stdout, /Added Cursor account "cursor-1" \(Ultra\)/);
    const [account] = JSON.parse(await readFile(configPath, 'utf8')).accounts;
    assert.deepEqual([account.source, account.accountUuid, account.accessToken], ['import', '100', token]);

    await writeFile(file, JSON.stringify({ accessToken: jwt({ sub: 'x', exp: 1_000, marker: 'u3' }) }));
    const expired = await runCli(['cursor', 'import', '--file', file], env);
    assert.equal(expired.status, 1);
    assert.match(expired.stderr, /has expired/);
    await writeFile(file, '{not json');
    const broken = await runCli(['cursor', 'import', '--file', file], env);
    assert.equal(broken.status, 1);
    assert.match(broken.stderr, /not valid JSON/);
  } finally {
    await new Promise(resolve => api.server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('cursor run points cursor-agent at http://localhost:<port> with the user\'s environment; env prints it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamcursor-run-'));
  const statusServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ accounts: [], switchThreshold: 0.98 }));
  });
  const port = await listen(statusServer);
  const fake = join(dir, 'cursor-agent');
  try {
    const configPath = await cursorConfig(dir, null, {
      proxy: { port, apiKey: 'proxy-key' },
      accounts: [{ name: 'cursor-1', provider: 'cursor', type: 'oauth', accessToken: 'x', refreshToken: 'x' }],
    });
    await writeFile(fake, `#!/usr/bin/env node
console.log(JSON.stringify({
  args: process.argv.slice(2),
  endpoint: process.env.CURSOR_API_ENDPOINT ?? null,
  provider: process.env.TEAMCLAUDE_PROVIDER ?? null,
  config: process.env.TEAMCLAUDE_CONFIG ?? null,
  userVar: process.env.USER_SETTING ?? null,
}));
`);
    await chmod(fake, 0o755);
    const result = await runCli(['cursor', 'run', '--', '-p', 'say ok'], isolatedEnv(dir, {
      TEAMCLAUDE_CONFIG: configPath, TEAMCURSOR_CURSOR_BIN: fake, USER_SETTING: 'kept',
    }));
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      args: ['-p', 'say ok'], endpoint: `http://localhost:${port}`, provider: null, config: null, userVar: 'kept',
    });
    const missing = join(dir, 'no-such-agent');
    const absent = await runCli(['cursor', 'run'], isolatedEnv(dir, { TEAMCLAUDE_CONFIG: configPath, TEAMCURSOR_CURSOR_BIN: missing }));
    assert.equal(absent.status, 1);
    assert.match(absent.stderr, new RegExp(`not found at ${escape(missing)}`));
    const env = await runCli(['cursor', 'env'], isolatedEnv(dir, { TEAMCLAUDE_CONFIG: configPath }));
    assert.equal(env.stdout.trim(), `export CURSOR_API_ENDPOINT=http://localhost:${port}`);
  } finally {
    await new Promise(resolve => statusServer.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('the real server: the public port takes HTTP/1.1 and cursor-agent\'s h2c stream (also on ::1 when pinned to loopback)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamcursor-e2e-'));
  const api = await fakeCursor();
  const agentCalls = [];
  const agent = http2.createServer();
  let releaseHold;
  const hold = new Promise(resolve => { releaseHold = resolve; });
  agent.on('stream', (stream, headers) => {
    if (headers['x-hold']) {
      stream.respond({ ':status': 200, 'content-type': 'application/connect+proto' });
      stream.write(Buffer.from([0, 0, 0, 0, 1, 9])); // one data frame: the stream is committed to the client
      hold.then(() => stream.end());
      return;
    }
    agentCalls.push(headers.authorization);
    stream.respond({ ':status': 200, 'content-type': 'application/connect+proto' });
    stream.on('data', chunk => stream.write(chunk)); // byte echo
    stream.on('end', () => stream.end());
  });
  const agentPort = await listen(agent);
  const port = await freePort();
  const token = jwt({ sub: 'auth0|u1', exp: 2_000_000_000, marker: 'u1' });
  let server = null;
  try {
    const configPath = await cursorConfig(dir, api, {
      proxy: { port, apiKey: 'proxy-key', host: 'localhost' },
      cursorAgentUpstream: `http://127.0.0.1:${agentPort}`,
      cursorUsageRefresh: false,
      accounts: [{ name: 'cursor-1', provider: 'cursor', type: 'oauth', accountUuid: '100', accessToken: token, refreshToken: token, expiresAt: 2_000_000_000_000 }],
    });
    server = spawn(process.execPath, [entry, 'cursor', 'server'], {
      env: isolatedEnv(dir, { TEAMCLAUDE_CONFIG: configPath }), stdio: ['ignore', 'ignore', 'pipe'],
    });
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      ready = await new Promise(resolve => {
        http.get(`http://127.0.0.1:${port}/teamclaude/status`, { agent: false }, res => { res.resume(); resolve(res.statusCode === 200); })
          .on('error', () => resolve(false));
      });
    }
    assert.ok(ready, 'the server came up');
    // HTTP/1.1 through the sniffer to the API upstream, with the pool bearer.
    const me = await new Promise((resolve, reject) => {
      const req = http.request(`http://127.0.0.1:${port}/aiserver.v1.DashboardService/GetMe`, {
        method: 'POST', agent: false, headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
      }, res => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve(JSON.parse(body)));
      });
      req.on('error', reject);
      req.end('{}');
    });
    assert.equal(me.userId, 100);
    // h2c on 127.0.0.1 and on ::1 (cursor-agent tries `localhost` over IPv6 first). The first bytes are one
    // whole Connect data frame (flags 0, length 2): the proxy holds a response until it can read that frame.
    const first = Buffer.from([0, 0, 0, 0, 2, 7, 8]);
    for (const host of ['127.0.0.1', '[::1]']) {
      const session = http2.connect(`http://${host}:${port}`);
      const echoed = await new Promise((resolve, reject) => {
        const req = session.request({ ':method': 'POST', ':path': '/agent.v1.AgentService/Run', 'content-type': 'application/connect+proto', authorization: 'Bearer local' });
        const chunks = [];
        req.on('data', chunk => {
          chunks.push(chunk);
          if (chunks.length === 1) req.end(Buffer.from([4, 5, 6]));
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
        req.write(first);
      });
      session.close();
      assert.deepEqual(echoed, Buffer.concat([first, Buffer.from([4, 5, 6])]), host);
    }
    assert.deepEqual(agentCalls, [`Bearer ${token}`, `Bearer ${token}`]);
    // `update` drains on x-teamcodex-active-requests: a live h2 stream counts there.
    const activeRequests = () => new Promise(resolve => {
      http.get(`http://127.0.0.1:${port}/teamclaude/status`, { agent: false }, res => {
        res.resume();
        resolve(res.headers['x-teamcodex-active-requests']);
      }).on('error', () => resolve(null));
    });
    const holder = http2.connect(`http://[::1]:${port}`);
    const held = holder.request({ ':method': 'POST', ':path': '/agent.v1.AgentService/Run', 'content-type': 'application/connect+proto', 'x-hold': '1' });
    held.on('error', () => {});
    held.resume(); // consume it, or it never reaches 'close'
    held.write(first);
    let seen = null;
    for (let i = 0; i < 50 && seen !== '1'; i++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      seen = await activeRequests();
    }
    assert.equal(seen, '1');
    // A drain reply comes after the worker stopped taking h2 streams, and counts the live one.
    const state = JSON.parse(await readFile(join(dir, 'teamcursor.server.json'), 'utf8'));
    const drain = await new Promise((resolve, reject) => {
      const req = http.request(`http://127.0.0.1:${port}/teamclaude/deployment/drain`, {
        method: 'POST', agent: false,
        headers: { 'x-api-key': 'proxy-key', 'x-teamcodex-lifecycle-id': state.lifecycle.id, 'content-length': '0' },
      }, res => { let body = ''; res.on('data', c => { body += c; }); res.on('end', () => resolve(JSON.parse(body))); });
      req.on('error', reject);
      req.end();
    });
    assert.deepEqual(drain, { draining: true, activeRequests: 1 });
    const refusedSession = http2.connect(`http://127.0.0.1:${port}`);
    const refused = await new Promise((resolve, reject) => {
      const req = refusedSession.request({ ':method': 'POST', ':path': '/agent.v1.AgentService/Run', 'content-type': 'application/connect+proto' });
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
      req.end(first);
    });
    refusedSession.close();
    assert.equal(JSON.parse(refused.subarray(5).toString()).error.code, 'unavailable');
    releaseHold();
    held.end();
    await new Promise(resolve => held.on('close', resolve));
    holder.close();
    for (let i = 0; i < 50 && seen !== '0'; i++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      seen = await activeRequests();
    }
    assert.equal(seen, '0');
  } finally {
    if (server && server.exitCode === null) {
      const exited = new Promise(resolve => server.once('exit', resolve));
      server.kill('SIGTERM');
      await exited;
    }
    await new Promise(resolve => agent.close(resolve));
    await new Promise(resolve => api.server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
