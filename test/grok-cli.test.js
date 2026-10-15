import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDefaultConfig,
  getConfigPath,
  getQuotaCachePath,
  getServerStatePath,
} from '../src/config.js';
import { GROK_CLIENT_ID } from '../src/grok.js';

const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));
const jwt = payload => `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
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
    'TEAMGROK_GROK_BIN', 'GROK_HOME']) delete env[key];
  return { ...env, HOME: dir, XDG_CONFIG_HOME: join(dir, 'xdg'), ...extra };
}

/**
 * Fake auth.x.ai + cli-chat-proxy in one server: device code, token endpoint (always approves at once),
 * and /v1/user, whose identity follows the access token (`access-<user>`).
 */
async function fakeXai({ codeAccess = true } = {}) {
  const calls = [];
  let next = 'u1';
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/oauth2/device/code') {
      res.end(JSON.stringify({
        device_code: 'dev', user_code: 'ABCD-1234', verification_uri: 'https://accounts.x.ai/oauth2/device',
        verification_uri_complete: 'https://accounts.x.ai/oauth2/device?user_code=ABCD-1234', expires_in: 60, interval: 0,
      }));
    } else if (req.url === '/oauth2/token') {
      res.end(JSON.stringify({
        access_token: jwt({ sub: `sub-${next}`, exp: 2_000_000_000, marker: `access-${next}` }),
        refresh_token: `refresh-${next}`, expires_in: 21600,
      }));
    } else if (req.url === '/v1/user?include=subscription') {
      const token = req.headers.authorization.slice('Bearer '.length);
      const user = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).marker.slice('access-'.length);
      res.end(JSON.stringify({
        userId: user, email: `${user}@example.com`, teamId: `team-${user}`, subscriptionTier: 'SuperGrokPro',
        hasGrokCodeAccess: codeAccess,
      }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  const port = await listen(server);
  return { server, calls, url: `http://127.0.0.1:${port}`, setUser: user => { next = user; } };
}

async function grokConfig(dir, xai, extra = {}) {
  const path = join(dir, 'teamgrok.json');
  await writeFile(path, JSON.stringify({
    provider: 'grok',
    proxy: { port: await freePort(), apiKey: 'proxy-key' },
    grokUpstream: xai?.url ?? 'http://127.0.0.1:9',
    grokTokenUrl: xai ? `${xai.url}/oauth2/token` : undefined,
    grokDeviceUrl: xai ? `${xai.url}/oauth2/device/code` : undefined,
    accounts: [],
    ...extra,
  }));
  return path;
}

test('grok mode has its own config file, port 3459, upstream, and state files', () => {
  const saved = { provider: process.env.TEAMCLAUDE_PROVIDER, config: process.env.TEAMCLAUDE_CONFIG, xdg: process.env.XDG_CONFIG_HOME };
  try {
    delete process.env.TEAMCLAUDE_CONFIG;
    process.env.XDG_CONFIG_HOME = '/tmp/teamgrok-xdg';
    process.env.TEAMCLAUDE_PROVIDER = 'grok';
    assert.equal(getConfigPath(), '/tmp/teamgrok-xdg/teamgrok.json');
    assert.equal(getServerStatePath(), '/tmp/teamgrok-xdg/teamgrok.server.json');
    assert.equal(getQuotaCachePath(), '/tmp/teamgrok-xdg/teamgrok.quota.json');
    const config = createDefaultConfig();
    assert.equal(config.provider, 'grok');
    assert.equal(config.proxy.port, 3459);
    assert.equal(config.upstream, 'https://cli-chat-proxy.grok.com');
    assert.equal(config.continuityMode, false);
    assert.equal(config.activeWarmup, false);
    assert.equal(config.maxConcurrentPerAccount, 8);
    process.env.TEAMCLAUDE_PROVIDER = 'agy';
    assert.equal(createDefaultConfig().proxy.port, 3458);
  } finally {
    for (const [key, name] of [['provider', 'TEAMCLAUDE_PROVIDER'], ['config', 'TEAMCLAUDE_CONFIG'], ['xdg', 'XDG_CONFIG_HOME']]) {
      if (saved[key] === undefined) delete process.env[name];
      else process.env[name] = saved[key];
    }
  }
});

test('the grok prefix selects teamgrok.json, refuses Claude/Codex-only commands, and never shares a config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamgrok-help-'));
  try {
    const help = await runCli(['grok', 'help'], isolatedEnv(dir));
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /TeamGrok/);
    assert.match(help.stdout, new RegExp(`Config: ${escape(join(dir, 'xdg', 'teamgrok.json'))}`));
    for (const command of ['api', 'reauth', 'subscription']) {
      const refused = await runCli([command, 'x'], isolatedEnv(dir, { TEAMCLAUDE_PROVIDER: 'grok' }));
      assert.equal(refused.status, 1, command);
      assert.match(refused.stderr, /not available for the Grok pool/, command);
    }

    const claudeConfig = join(dir, 'teamclaude.json');
    const claudeText = JSON.stringify({ proxy: { port: 1 }, accounts: [{ name: 'x', type: 'oauth', accessToken: 't' }] });
    await writeFile(claudeConfig, claudeText);
    const grokOnClaude = await runCli(['grok', 'accounts'], isolatedEnv(dir, { TEAMCLAUDE_CONFIG: claudeConfig }));
    assert.equal(grokOnClaude.status, 1);
    assert.match(grokOnClaude.stderr, /not a Grok config \(provider: unset\)/);
    assert.equal(await readFile(claudeConfig, 'utf8'), claudeText, 'the refusal writes nothing');

    const grokFile = await grokConfig(dir, null);
    for (const prefix of [[], ['codex'], ['agy']]) {
      const other = await runCli([...prefix, 'accounts'], isolatedEnv(dir, { TEAMCLAUDE_CONFIG: grokFile }));
      assert.equal(other.status, 1, prefix.join(' '));
      assert.match(other.stderr, /(is a Grok config — refusing|not an Antigravity \(agy\) config \(provider: "grok"\))/, prefix.join(' '));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('grok login --json: device-code events, grok-N names, a re-login of the same user updates in place', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamgrok-login-'));
  const xai = await fakeXai();
  try {
    const configPath = await grokConfig(dir, xai);
    const env = isolatedEnv(dir, { TEAMCLAUDE_CONFIG: configPath });
    const lines = text => text.trim().split('\n').map(line => JSON.parse(line));

    const first = await runCli(['grok', 'login', '--json'], env);
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(lines(first.stdout), [
      { event: 'auth_url', url: 'https://accounts.x.ai/oauth2/device?user_code=ABCD-1234', user_code: 'ABCD-1234', browser_opened: false },
      { event: 'waiting' },
      { done: true, ok: true, account: 'grok-1', applied: 'config_only' }, // no server running in this test
    ]);
    const device = xai.calls.find(call => call.url === '/oauth2/device/code');
    assert.equal(new URLSearchParams(device.body).get('client_id'), GROK_CLIENT_ID);
    assert.match(new URLSearchParams(device.body).get('scope'), /grok-cli:access/);

    xai.setUser('u2');
    const second = await runCli(['grok', 'login', '--json'], env);
    assert.equal(lines(second.stdout).at(-1).account, 'grok-2');

    xai.setUser('u1');
    const again = await runCli(['grok', 'login', '--json'], env);
    assert.equal(lines(again.stdout).at(-1).account, 'grok-1', 'same xAI user → same account');

    const taken = await runCli(['grok', 'login', '--json', '--name', 'grok-2'], env);
    assert.equal(taken.status, 1);
    assert.deepEqual(lines(taken.stdout).at(-1), { done: true, ok: false, error: 'name_taken', message: 'Account "grok-2" already exists' });

    const config = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(config.provider, 'grok');
    assert.deepEqual(config.accounts.map(a => [a.name, a.accountUuid, a.email, a.teamId, a.planType, a.provider, a.type, a.source]), [
      ['grok-1', 'u1', 'u1@example.com', 'team-u1', 'SuperGrokPro', 'grok', 'oauth', 'login'],
      ['grok-2', 'u2', 'u2@example.com', 'team-u2', 'SuperGrokPro', 'grok', 'oauth', 'login'],
    ]);
    assert.equal(config.accounts[0].refreshToken, 'refresh-u1');
    assert.equal(config.accounts[0].expiresAt, 2_000_000_000_000);

    const accounts = await runCli(['grok', 'accounts', '--json'], env);
    const view = JSON.parse(accounts.stdout);
    assert.equal(view.accounts[0].plan, 'SuperGrokPro');
    assert.equal(view.accounts[0].email, 'u***@example.com');
  } finally {
    await new Promise(resolve => xai.server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('grok import reads ~/.grok/auth.json, warns about the shared refresh token, and flags missing Grok Build access', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamgrok-import-'));
  const xai = await fakeXai({ codeAccess: false });
  try {
    const configPath = await grokConfig(dir, xai);
    await mkdir(join(dir, '.grok'), { recursive: true });
    await writeFile(join(dir, '.grok', 'auth.json'), JSON.stringify({
      [`https://auth.x.ai::${GROK_CLIENT_ID}`]: {
        key: jwt({ sub: 'sub-u1', exp: 2_000_000_000, marker: 'access-u1' }), refresh_token: 'refresh-file',
        expires_at: '2033-05-18T03:33:20Z', auth_mode: 'oidc', user_id: 'u1', email: 'u1@example.com',
        team_id: 'team-u1', oidc_client_id: GROK_CLIENT_ID,
      },
    }));
    const result = await runCli(['grok', 'import'], isolatedEnv(dir, { TEAMCLAUDE_CONFIG: configPath }));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /share one refresh token/);
    assert.match(result.stderr, /no Grok Build/);
    assert.match(result.stdout, /Added Grok account "grok-1" \(SuperGrokPro\)/);
    const [account] = JSON.parse(await readFile(configPath, 'utf8')).accounts;
    assert.equal(account.source, 'import');
    assert.equal(account.accountUuid, 'u1');
    assert.equal(account.refreshToken, 'refresh-file');
    assert.ok(!xai.calls.some(call => call.url === '/oauth2/token'), 'a live token is not refreshed');
  } finally {
    await new Promise(resolve => xai.server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('grok run points grok at the running proxy with the user\'s environment; env prints the base URL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamgrok-run-'));
  const statusServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ accounts: [], switchThreshold: 0.98 }));
  });
  const port = await listen(statusServer);
  const fakeGrok = join(dir, 'grok');
  try {
    const configPath = await grokConfig(dir, null, {
      proxy: { port, apiKey: 'proxy-key' },
      accounts: [{ name: 'grok-1', provider: 'grok', type: 'oauth', accessToken: 'x', refreshToken: 'y' }],
    });
    await writeFile(fakeGrok, `#!/usr/bin/env node
console.log(JSON.stringify({
  args: process.argv.slice(2),
  base: process.env.GROK_CLI_CHAT_PROXY_BASE_URL ?? null,
  provider: process.env.TEAMCLAUDE_PROVIDER ?? null,
  config: process.env.TEAMCLAUDE_CONFIG ?? null,
  userVar: process.env.USER_SETTING ?? null,
}));
`);
    await chmod(fakeGrok, 0o755);
    const result = await runCli(['grok', 'run', '--', '-p', 'say OK'], isolatedEnv(dir, {
      TEAMCLAUDE_CONFIG: configPath, TEAMGROK_GROK_BIN: fakeGrok, USER_SETTING: 'kept',
    }));
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      args: ['-p', 'say OK'], base: `http://127.0.0.1:${port}/v1`, provider: null, config: null, userVar: 'kept',
    });

    const missing = join(dir, 'no-such-grok');
    const absent = await runCli(['grok', 'run'], isolatedEnv(dir, { TEAMCLAUDE_CONFIG: configPath, TEAMGROK_GROK_BIN: missing }));
    assert.equal(absent.status, 1);
    assert.match(absent.stderr, new RegExp(`not found at ${escape(missing)}`));

    const env = await runCli(['grok', 'env'], isolatedEnv(dir, { TEAMCLAUDE_CONFIG: configPath }));
    assert.equal(env.stdout.trim(), `export GROK_CLI_CHAT_PROXY_BASE_URL=http://127.0.0.1:${port}/v1`);
  } finally {
    await new Promise(resolve => statusServer.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
