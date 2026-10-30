import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDefaultConfig,
  getConfigPath,
  getQuotaCachePath,
  getServerStatePath,
} from '../src/config.js';

const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));
// Obviously fake OAuth client values, assembled at runtime (public repository).
const FAKE_CLIENT_ID = `${['1071006060591', 'fakeclient'].join('-')}.apps.googleusercontent.com`;
// agy 1.3.3's layout, faked: the right secret heads a longer run of glued Go
// strings; the free-standing one belongs to another client.
const FAKE_SECRET = ['GOCSPX', 'R'.repeat(28)].join('-');
const DECOY_SECRET = ['GOCSPX', 'D'.repeat(28)].join('-');

function jwt(payload) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

function login(accessToken, refreshToken = '1//fake-refresh') {
  return {
    token: { access_token: accessToken, token_type: 'Bearer', refresh_token: refreshToken, expiry: '2030-01-01T00:00:00Z' },
    auth_method: 'consumer',
    id_token: jwt({ sub: 'google-sub-1', email: 'pro@example.com', aud: FAKE_CLIENT_ID }),
  };
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}

/** Run the CLI without blocking this process (fake servers live here). */
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
    'TEAMAGY_AGY_BIN', 'TEAMAGY_SECURITY_BIN']) delete env[key];
  return { ...env, HOME: dir, XDG_CONFIG_HOME: join(dir, 'xdg'), ...extra };
}

test('agy mode has its own config file, port 3458, and state files', () => {
  const saved = {
    provider: process.env.TEAMCLAUDE_PROVIDER,
    config: process.env.TEAMCLAUDE_CONFIG,
    xdg: process.env.XDG_CONFIG_HOME,
  };
  try {
    delete process.env.TEAMCLAUDE_CONFIG;
    process.env.XDG_CONFIG_HOME = '/tmp/teamagy-xdg';
    process.env.TEAMCLAUDE_PROVIDER = 'agy';
    assert.equal(getConfigPath(), '/tmp/teamagy-xdg/teamagy.json');
    assert.equal(getServerStatePath(), '/tmp/teamagy-xdg/teamagy.server.json');
    assert.equal(getQuotaCachePath(), '/tmp/teamagy-xdg/teamagy.quota.json');
    const config = createDefaultConfig();
    assert.equal(config.provider, 'agy');
    assert.equal(config.proxy.port, 3458);
    assert.equal(config.upstream, 'https://daily-cloudcode-pa.googleapis.com');
    assert.equal(config.continuityMode, false);
    assert.equal(config.activeWarmup, false);

    process.env.TEAMCLAUDE_PROVIDER = 'codex';
    assert.equal(getConfigPath(), '/tmp/teamagy-xdg/teamcodex.json');
    assert.equal(createDefaultConfig().proxy.port, 3457);
    delete process.env.TEAMCLAUDE_PROVIDER;
    assert.equal(getConfigPath(), '/tmp/teamagy-xdg/teamclaude.json');
    assert.equal(createDefaultConfig().proxy.port, 3456);
  } finally {
    for (const [key, name] of [['provider', 'TEAMCLAUDE_PROVIDER'], ['config', 'TEAMCLAUDE_CONFIG'], ['xdg', 'XDG_CONFIG_HOME']]) {
      if (saved[key] === undefined) delete process.env[name];
      else process.env[name] = saved[key];
    }
  }
});

test('the agy prefix selects teamagy.json and refuses Claude/Codex-only commands', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamagy-help-'));
  try {
    const help = await runCli(['agy', 'help'], isolatedEnv(dir));
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /TeamAgy/);
    assert.match(help.stdout, new RegExp(`Config: ${join(dir, 'xdg', 'teamagy.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

    const api = await runCli(['agy', 'api', '/x'], isolatedEnv(dir));
    assert.equal(api.status, 1);
    assert.match(api.stderr, /not available for the Antigravity/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('agy import (file, then keychain) updates one account in place, caches the OAuth client, and stores tier and project', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamagy-import-'));
  const loadCalls = [];
  const probes = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.url === '/token') {
      // Fake Google token endpoint: a bogus refresh token tells the right
      // client (invalid_grant) from a wrong one (invalid_client).
      const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
      probes.push(form);
      const right = form.client_id === FAKE_CLIENT_ID && form.client_secret === FAKE_SECRET;
      res.writeHead(right ? 400 : 401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: right ? 'invalid_grant' : 'invalid_client' }));
      return;
    }
    loadCalls.push({ url: req.url, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString() });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      currentTier: { id: 'free-tier', name: 'Antigravity' },
      paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' },
      cloudaicompanionProject: 'aicode-consumers',
    }));
  });
  const upstreamPort = await listen(upstream);
  const configPath = join(dir, 'teamagy.json');
  const fakeAgy = join(dir, 'agy-binary');
  const fakeSecurity = join(dir, 'security');
  const loginFile = join(dir, 'login.json');
  const second = login('ya29.second-access', '1//second-refresh');
  try {
    await writeFile(configPath, JSON.stringify({
      provider: 'agy',
      proxy: { port: await freePort(), apiKey: 'proxy-key' },
      agyUpstream: `http://127.0.0.1:${upstreamPort}`,
      agyTokenUrl: `http://127.0.0.1:${upstreamPort}/token`,
      accounts: [],
    }));
    // A fake agy binary laid out like 1.3.3: the right secret glued to the
    // next string, a free-standing decoy secret after it.
    await writeFile(fakeAgy, Buffer.concat([
      Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0]),
      Buffer.from(`...${FAKE_CLIENT_ID}\0...${FAKE_SECRET}${'NextGoStringGluedOn_'.padEnd(35, 'z')}\0..${DECOY_SECRET}\0`),
    ]));
    await writeFile(loginFile, JSON.stringify(login('ya29.first-access')));
    await writeFile(fakeSecurity, `#!/bin/sh
echo "go-keyring-base64:${Buffer.from(JSON.stringify(second)).toString('base64')}"
`);
    await chmod(fakeSecurity, 0o755);
    const env = isolatedEnv(dir, {
      TEAMCLAUDE_CONFIG: configPath,
      TEAMAGY_AGY_BIN: fakeAgy,
      TEAMAGY_SECURITY_BIN: fakeSecurity,
    });

    const first = await runCli(['agy', 'import', '--file', loginFile, '--name', 'main'], env);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /Added Antigravity account "main" \(g1-pro-tier\)/);

    const again = await runCli(['agy', 'import'], env);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /Updated Antigravity account "main"/);

    const config = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(config.accounts.length, 1);
    const [account] = config.accounts;
    assert.equal(account.name, 'main', 're-import keeps the chosen name');
    assert.equal(account.provider, 'agy');
    assert.equal(account.type, 'oauth');
    assert.equal(account.source, 'keychain');
    assert.equal(account.accountUuid, 'google-sub-1');
    assert.equal(account.email, 'pro@example.com');
    assert.equal(account.accessToken, 'ya29.second-access');
    assert.equal(account.refreshToken, '1//second-refresh');
    assert.equal(account.tierId, 'g1-pro-tier');
    assert.equal(account.projectId, 'aicode-consumers');
    assert.equal(config.agyOAuthClientId, FAKE_CLIENT_ID);
    assert.equal(config.agyOAuthClientSecret, FAKE_SECRET, 'the probe-verified secret, not the free-standing decoy');
    assert.deepEqual(probes.map(form => form.client_secret), [FAKE_SECRET, DECOY_SECRET],
      'probed once (first import); the second import reuses the cache');

    assert.deepEqual(loadCalls.map(call => [call.url, call.authorization, JSON.parse(call.body)]), [
      ['/v1internal:loadCodeAssist', 'Bearer ya29.first-access', { metadata: { ideType: 'ANTIGRAVITY' } }],
      ['/v1internal:loadCodeAssist', 'Bearer ya29.second-access', { metadata: { ideType: 'ANTIGRAVITY' } }],
    ]);
  } finally {
    await new Promise(resolve => upstream.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('agy run points agy at the running proxy with the user\'s environment, and names a missing binary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamagy-run-'));
  // Stands in for a running TeamAgy proxy (findRunningServer only needs a
  // TeamClaude-shaped status answer on the configured port).
  const statusServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ accounts: [], switchThreshold: 0.98 }));
  });
  const port = await listen(statusServer);
  const configPath = join(dir, 'teamagy.json');
  const fakeAgy = join(dir, 'agy');
  try {
    await writeFile(configPath, JSON.stringify({
      provider: 'agy',
      proxy: { port, apiKey: 'proxy-key' },
      // Never a real endpoint, even if a server were auto-started here.
      agyUpstream: 'http://127.0.0.1:9',
      agyQuotaRefresh: false,
      accounts: [{ name: 'main', provider: 'agy', type: 'oauth', accessToken: 'x', refreshToken: 'y' }],
    }));
    await writeFile(fakeAgy, `#!/usr/bin/env node
console.log(JSON.stringify({
  args: process.argv.slice(2),
  cloudCodeUrl: process.env.CLOUD_CODE_URL ?? null,
  provider: process.env.TEAMCLAUDE_PROVIDER ?? null,
  config: process.env.TEAMCLAUDE_CONFIG ?? null,
  userVar: process.env.USER_SETTING ?? null,
}));
`);
    await chmod(fakeAgy, 0o755);

    const result = await runCli(['agy', 'run', '--', '-p', 'say OK'], isolatedEnv(dir, {
      TEAMCLAUDE_CONFIG: configPath,
      TEAMAGY_AGY_BIN: fakeAgy,
      USER_SETTING: 'kept',
    }));
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      args: ['--dangerously-skip-permissions', '-p', 'say OK'],
      cloudCodeUrl: `http://127.0.0.1:${port}`,
      provider: null,
      config: null,
      userVar: 'kept',
    });
    // An explicit mode, sandbox or the flag itself is kept as given, with nothing added.
    for (const args of [['--mode', 'plan', '-p', 'x'], ['--sandbox'], ['--dangerously-skip-permissions', '-p', 'x']]) {
      const explicit = await runCli(['agy', 'run', '--', ...args], isolatedEnv(dir, {
        TEAMCLAUDE_CONFIG: configPath,
        TEAMAGY_AGY_BIN: fakeAgy,
      }));
      assert.equal(explicit.status, 0, explicit.stderr);
      assert.deepEqual(JSON.parse(explicit.stdout.trim()).args, args);
    }

    const missing = join(dir, 'no-such-agy');
    const absent = await runCli(['agy', 'run'], isolatedEnv(dir, {
      TEAMCLAUDE_CONFIG: configPath,
      TEAMAGY_AGY_BIN: missing,
    }));
    assert.equal(absent.status, 1);
    assert.match(absent.stderr, new RegExp(`not found at ${missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

    const env = await runCli(['agy', 'env'], isolatedEnv(dir, { TEAMCLAUDE_CONFIG: configPath }));
    assert.equal(env.status, 0, env.stderr);
    assert.equal(env.stdout.trim(), `export CLOUD_CODE_URL=http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => statusServer.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('env-only agy mode (no prefix) gets the agy help and refuses Claude/Codex-only commands', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamagy-env-'));
  try {
    const env = isolatedEnv(dir, { TEAMCLAUDE_PROVIDER: 'agy' });
    const help = await runCli(['help'], env);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /TeamAgy/);
    for (const command of ['api', 'reauth', 'subscription']) {
      const refused = await runCli([command, 'x'], env);
      assert.equal(refused.status, 1, command);
      assert.match(refused.stderr, /not available for the Antigravity/, command);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('agy and Claude/Codex never share a config file; the refusal writes nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamagy-mismatch-'));
  const claudeConfig = join(dir, 'teamclaude.json');
  const agyConfig = join(dir, 'teamagy.json');
  const loginFile = join(dir, 'login.json');
  const claudeBody = JSON.stringify({ provider: 'anthropic', proxy: { port: 1, apiKey: 'k' }, accounts: [] });
  const agyBody = JSON.stringify({ provider: 'agy', proxy: { port: 1, apiKey: 'k' }, agyUpstream: 'http://127.0.0.1:9', accounts: [] });
  try {
    await writeFile(claudeConfig, claudeBody);
    await writeFile(agyConfig, agyBody);
    await writeFile(loginFile, JSON.stringify(login('ya29.x')));

    const agyOnClaude = await runCli(['agy', 'import', '--file', loginFile],
      isolatedEnv(dir, { TEAMCLAUDE_CONFIG: claudeConfig, TEAMAGY_AGY_BIN: join(dir, 'none') }));
    assert.equal(agyOnClaude.status, 1);
    assert.match(agyOnClaude.stderr, /not an Antigravity \(agy\) config \(provider: "anthropic"\)/);
    assert.equal(await readFile(claudeConfig, 'utf8'), claudeBody);

    const envAgyOnClaude = await runCli(['status'], isolatedEnv(dir, { TEAMCLAUDE_CONFIG: claudeConfig, TEAMCLAUDE_PROVIDER: 'agy' }));
    assert.equal(envAgyOnClaude.status, 1);
    assert.match(envAgyOnClaude.stderr, /not an Antigravity/);

    for (const prefix of [[], ['codex']]) {
      const otherOnAgy = await runCli([...prefix, 'status'], isolatedEnv(dir, { TEAMCLAUDE_CONFIG: agyConfig }));
      assert.equal(otherOnAgy.status, 1, prefix.join(' '));
      assert.match(otherOnAgy.stderr, /Antigravity \(agy\) config — refusing/, prefix.join(' '));
    }
    assert.equal(await readFile(agyConfig, 'utf8'), agyBody);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a name match with another Google account does not inherit its tier or project', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamagy-rename-'));
  const upstream = http.createServer((req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const upstreamPort = await listen(upstream);
  const configPath = join(dir, 'teamagy.json');
  const loginFile = join(dir, 'login.json');
  try {
    await writeFile(configPath, JSON.stringify({
      provider: 'agy',
      proxy: { port: await freePort(), apiKey: 'k' },
      agyUpstream: `http://127.0.0.1:${upstreamPort}`,
      agyOAuthClientId: 'fake-id',
      agyOAuthClientSecret: 'fake-secret',
      accounts: [{
        name: 'main', provider: 'agy', type: 'oauth', accountUuid: 'other-google-sub',
        accessToken: 'old', refreshToken: 'old', tierId: 'g1-ultra-tier', projectId: 'other-project', priority: 0,
      }],
    }));
    await writeFile(loginFile, JSON.stringify(login('ya29.new')));
    const result = await runCli(['agy', 'import', '--file', loginFile, '--name', 'main'],
      isolatedEnv(dir, { TEAMCLAUDE_CONFIG: configPath, TEAMAGY_AGY_BIN: join(dir, 'none') }));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /loadCodeAssist failed/);
    const [account] = JSON.parse(await readFile(configPath, 'utf8')).accounts;
    assert.equal(account.accountUuid, 'google-sub-1');
    assert.equal(account.accessToken, 'ya29.new');
    assert.equal(account.tierId, undefined);
    assert.equal(account.projectId, undefined);
    assert.equal(account.priority, 0, 'routing settings of the slot are kept');
  } finally {
    await new Promise(resolve => upstream.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('a provider-less Claude config is never touched in agy mode (prefix or env); a missing file is created as agy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamagy-claude-config-'));
  const claudeConfig = join(dir, 'teamclaude.json');
  const loginFile = join(dir, 'login.json');
  const fakeAgy = join(dir, 'agy');
  // The shape of a real Claude config: no provider key, accounts without one.
  const claudeBody = `${JSON.stringify({
    proxy: { port: await freePort(), apiKey: 'tc-claude' },
    upstream: 'https://api.anthropic.com',
    accounts: [
      { name: 'one@example.com', type: 'oauth', accessToken: 'sk-ant-oat-1', refreshToken: 'r1', expiresAt: 1 },
      { name: 'two@example.com', type: 'oauth', accessToken: 'sk-ant-oat-2', refreshToken: 'r2', expiresAt: 1 },
      { name: 'api-1', type: 'apikey', apiKey: 'sk-ant-api-1' },
    ],
  }, null, 2)}\n`;
  try {
    await writeFile(claudeConfig, claudeBody);
    await writeFile(loginFile, JSON.stringify(login('ya29.x')));
    await writeFile(fakeAgy, '#!/bin/sh\necho must-not-run\n');
    await chmod(fakeAgy, 0o755);
    const base = { TEAMCLAUDE_CONFIG: claudeConfig, TEAMAGY_AGY_BIN: fakeAgy };
    const attempts = [
      [['agy', 'import', '--file', loginFile], base],
      [['agy', 'stop'], base],
      [['agy', 'restart'], base],
      [['agy', 'run'], base],
      [['import', '--file', loginFile], { ...base, TEAMCLAUDE_PROVIDER: 'agy' }],
      [['stop'], { ...base, TEAMCLAUDE_PROVIDER: 'agy' }],
      [['run'], { ...base, TEAMCLAUDE_PROVIDER: 'agy' }],
    ];
    for (const [argv, extra] of attempts) {
      const result = await runCli(argv, isolatedEnv(dir, extra));
      const label = `${extra.TEAMCLAUDE_PROVIDER ? 'env ' : ''}${argv.join(' ')}`;
      assert.equal(result.status, 1, label);
      assert.match(result.stderr, /not an Antigravity \(agy\) config \(provider: unset\)/, label);
      assert.doesNotMatch(result.stdout, /must-not-run/, label);
      assert.equal(await readFile(claudeConfig, 'utf8'), claudeBody, `${label} left the file byte-identical`);
    }
    assert.equal(await readFile(join(dir, 'teamclaude.server.json'), 'utf8').catch(() => null), null,
      'no server was started against it');

    // No file at all: agy mode creates an agy config.
    const fresh = join(dir, 'fresh', 'teamagy.json');
    const created = await runCli(['agy', 'accounts'], isolatedEnv(dir, { TEAMCLAUDE_CONFIG: fresh }));
    assert.equal(created.status, 0, created.stderr);
    const config = JSON.parse(await readFile(fresh, 'utf8'));
    assert.equal(config.provider, 'agy');
    assert.equal(config.proxy.port, 3458);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a running server whose cached secret is refused re-resolves it from the binary, caches it, and keeps the account', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamagy-client-recovery-'));
  const tokenForms = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.url === '/token') {
      const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
      tokenForms.push(form);
      const right = form.client_id === FAKE_CLIENT_ID && form.client_secret === FAKE_SECRET;
      if (!right) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end('{"error":"invalid_client"}');
      } else if (form.refresh_token === 'teamagy-oauth-client-probe') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"error":"invalid_grant"}');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'ya29.refreshed', expires_in: 3599 }));
      }
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"groups":[]}');
  });
  const upstreamPort = await listen(upstream);
  const configPath = join(dir, 'teamagy.json');
  const fakeAgy = join(dir, 'agy-binary');
  const port = await freePort();
  let server;
  try {
    await writeFile(fakeAgy, Buffer.from(
      `..${FAKE_CLIENT_ID}\0${FAKE_SECRET}${'NextGoStringGluedOn_'.padEnd(35, 'z')}\0..${DECOY_SECRET}\0`));
    await writeFile(configPath, JSON.stringify({
      provider: 'agy',
      proxy: { port, apiKey: 'proxy-key' },
      agyUpstream: `http://127.0.0.1:${upstreamPort}`,
      agyTokenUrl: `http://127.0.0.1:${upstreamPort}/token`,
      // The incident: the free-standing decoy was cached as the secret.
      agyOAuthClientId: FAKE_CLIENT_ID,
      agyOAuthClientSecret: DECOY_SECRET,
      accounts: [{
        name: 'main', provider: 'agy', type: 'oauth', accountUuid: 'sub-main',
        accessToken: 'ya29.expired', refreshToken: '1//main-refresh', expiresAt: Date.now() - 60_000,
      }],
    }));
    server = spawn(process.execPath, [entry, 'agy', 'server'], {
      env: isolatedEnv(dir, { TEAMCLAUDE_CONFIG: configPath, TEAMAGY_AGY_BIN: fakeAgy }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    server.stdout.on('data', chunk => { output += chunk; });
    server.stderr.on('data', chunk => { output += chunk; });

    const deadline = Date.now() + 15_000;
    let config;
    while (Date.now() < deadline) {
      config = JSON.parse(await readFile(configPath, 'utf8'));
      if (config.accounts[0].accessToken === 'ya29.refreshed') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(config.accounts[0].accessToken, 'ya29.refreshed', output);
    assert.equal(config.agyOAuthClientSecret, FAKE_SECRET, 'the re-resolved secret is cached');
    assert.match(output, /refused the cached OAuth client \(invalid_client\)/);

    const status = await (await fetch(`http://127.0.0.1:${port}/teamclaude/status`)).json();
    assert.equal(status.accounts[0].status, 'active', 'the account was never parked for the client\'s fault');
    assert.equal(tokenForms.some(form => form.refresh_token === '1//main-refresh' && form.client_secret === FAKE_SECRET), true);
  } finally {
    if (server && server.exitCode == null) {
      const exited = new Promise(resolve => server.once('exit', resolve));
      server.kill('SIGTERM');
      await exited;
    }
    await new Promise(resolve => upstream.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
