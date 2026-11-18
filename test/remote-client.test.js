// Remote pool client mode (src/remote-client.js, `teamclaude remote use`). A fake remote surface on loopback,
// temp HOME/config, no real network. Runs on macOS/Linux and natively on Windows CI; the Windows lifecycle
// branch also runs anywhere via TEAMPROXY_APP_PLATFORM=win32 (honored under node --test only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  approveClaudeApiKey, clientChildEnv, clientOf, formatRemoteStatus, normalizeClientUrl, resolveAccount, wrapperArgs,
} from '../src/remote-client.js';

const index = fileURLToPath(new URL('../src/index.js', import.meta.url));
const entry = fileURLToPath(new URL('../src/teamclaude.js', import.meta.url));
const TOKEN = 'rt-0123456789abcdefghijklmnopqrstuvwxyzABCD';
const WIN = process.platform === 'win32';

const STATUS = {
  pool: 'claude',
  version: 'abc12345',
  accounts: [
    { n: 1, name: 'claude-main', enabled: true, active: true, priority: null, state: 'busy',
      session: { pct: 20, resetsAt: null }, weekly: { pct: 45, resetsAt: null }, fable: { pct: 7, resetsAt: null }, stale: false },
    { n: 2, name: 'claude-spare', enabled: false, active: false, priority: 1, state: 'off',
      session: null, weekly: null, fable: null, stale: true },
    { n: 3, name: 'work', enabled: true, active: false, priority: null, state: 'ready',
      session: null, weekly: { pct: 1, resetsAt: null }, fable: null, stale: false },
  ],
  requests: { active: 2 },
  updatedAt: new Date().toISOString(),
};

// The remote surface: token check, status, reload, account actions; every request is recorded.
async function fakeRemote({ status = STATUS, reject = null } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, key: req.headers['x-api-key'], body });
      const send = (code, payload) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (reject) return send(reject.status, { type: 'error', error: { type: 'x', message: reject.message } });
      if (req.headers['x-api-key'] !== TOKEN) return send(401, { type: 'error', error: { message: 'Invalid remote token' } });
      if (req.method === 'GET' && req.url === '/teamproxy/status') return send(200, status);
      if (req.method === 'POST' && req.url === '/teamproxy/reload') return send(200, { targets: 3, measured: 2, total: 3 });
      const m = /^\/teamproxy\/accounts\/(\d+)\/(enable|disable|priority)$/.exec(req.url);
      if (req.method === 'POST' && m) {
        const a = status.accounts[Number(m[1]) - 1];
        const parsed = body ? JSON.parse(body) : {};
        return send(200, { ok: true, n: a.n, name: a.name, enabled: m[2] === 'disable' ? false : m[2] === 'enable' ? true : a.enabled,
          priority: m[2] === 'priority' ? (parsed.priority === 'auto' ? null : parsed.priority) : a.priority });
      }
      send(404, { type: 'error', error: { message: 'Unknown teamproxy resource.' } });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise(r => server.close(r)) };
}

async function sandbox(config = null) {
  const home = await mkdtemp(join(tmpdir(), 'tp-remote-client-'));
  const configPath = join(home, 'teamclaude.json');
  if (config) await writeFile(configPath, JSON.stringify(config));
  // A clean environment: nothing inherited from a supervised session or the real config.
  const env = {
    PATH: process.env.PATH, HOME: home, USERPROFILE: home, TEAMCLAUDE_CONFIG: configPath,
    CLAUDE_CONFIG_DIR: join(home, 'claude'),
    ...(WIN ? { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP } : {}),
  };
  return { home, configPath, env, cleanup: () => rm(home, { recursive: true, force: true }) };
}

function cli(argv, env, { input = null, script = entry } = {}) {
  return new Promise(resolve => {
    const child = execFile(process.execPath, [script, ...argv], { env, encoding: 'utf8', timeout: 20_000 },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}

const noToken = (r, label) => {
  assert.ok(!r.stdout.includes(TOKEN) && !r.stderr.includes(TOKEN), `${label}: token printed`);
  assert.ok(!r.stdout.includes(TOKEN.slice(-20)) && !r.stderr.includes(TOKEN.slice(-20)), `${label}: token tail printed`);
};

// ── pure helpers ────────────────────────────────────────────

test('normalizeClientUrl: https origin, loopback http only, no path or credentials', () => {
  assert.equal(normalizeClientUrl('https://pool.example.ts.net:8456/'), 'https://pool.example.ts.net:8456');
  assert.equal(normalizeClientUrl('http://127.0.0.1:9999'), 'http://127.0.0.1:9999');
  assert.equal(normalizeClientUrl('http://localhost:9999'), 'http://localhost:9999');
  for (const bad of ['http://pool.example.ts.net:8456', 'ftp://x', 'nonsense', 'https://u:p@h.ts.net', 'https://h.ts.net/v1', 'https://h.ts.net?k=1']) {
    assert.throws(() => normalizeClientUrl(bad), Error, bad);
  }
});

test('wrapperArgs: the sh wrapper rule (no args / -… → Claude, -- → subcommand, word → proxy)', () => {
  assert.deepEqual(wrapperArgs([]), ['run', '--']);
  assert.deepEqual(wrapperArgs(['-p', 'hi']), ['run', '--', '-p', 'hi']);
  assert.deepEqual(wrapperArgs(['--model', 'x']), ['run', '--', '--model', 'x']);
  assert.deepEqual(wrapperArgs(['--', 'mcp', 'list']), ['run', '--', 'mcp', 'list']);
  assert.deepEqual(wrapperArgs(['status']), ['status']);
  assert.deepEqual(wrapperArgs(['--help']), ['--help']);
  assert.deepEqual(wrapperArgs(['-h']), ['-h']);
});

test('clientOf / clientChildEnv: API-key mode, local OAuth dropped', () => {
  assert.equal(clientOf(null), null);
  assert.equal(clientOf({ client: { url: 'https://x' } }), null);
  const client = clientOf({ client: { url: 'https://x.ts.net:8456', token: TOKEN } });
  const env = clientChildEnv({ ANTHROPIC_AUTH_TOKEN: 'o', CLAUDE_CODE_OAUTH_TOKEN: 'o', ANTHROPIC_BASE_URL: 'http://localhost:3456', KEEP: '1' }, client);
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://x.ts.net:8456');
  assert.equal(env.ANTHROPIC_API_KEY, TOKEN);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.TEAMCLAUDE_SESSION_SUPERVISED, '1');
  assert.equal(env.KEEP, '1');
});

test('resolveAccount: number, exact name, unique prefix; ambiguous and missing refused', () => {
  assert.equal(resolveAccount(STATUS.accounts, '3').name, 'work');
  assert.equal(resolveAccount(STATUS.accounts, 'work').n, 3);
  assert.equal(resolveAccount(STATUS.accounts, 'claude-s').n, 2);
  assert.throws(() => resolveAccount(STATUS.accounts, 'claude'), /여럿/);
  assert.throws(() => resolveAccount(STATUS.accounts, 'nope'), /없습니다/);
  assert.throws(() => resolveAccount(STATUS.accounts, '9'), /9번/);
});

test('formatRemoteStatus: one row per account, active mark, priority, stale', () => {
  const text = formatRemoteStatus(STATUS, 'https://x.ts.net:8456');
  const lines = text.split('\n');
  assert.match(lines[0], /원격 풀 claude · https:\/\/x\.ts\.net:8456 · 판 abc12345 · 처리 중 요청 2/);
  assert.match(lines[2], /^\*\s+1\s+claude-main\s+사용 중\s+45%\s+7%\s+20%\s+자동$/);
  assert.match(lines[3], /^\s+2\s+claude-spare\s+꺼짐\s+-\s+-\s+-\s+1\s+오래된 값$/);
  assert.equal(lines.length, 6);
});

test('approveClaudeApiKey: adds the 20-char tail once, keeps other fields, leaves a broken file alone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-approve-'));
  try {
    const path = join(dir, '.claude.json');
    await writeFile(path, JSON.stringify({ numStartups: 4, customApiKeyResponses: { approved: ['old'], rejected: [TOKEN.slice(-20)] } }));
    assert.deepEqual(await approveClaudeApiKey(TOKEN, path), { changed: true });
    const after = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(after.numStartups, 4);
    assert.deepEqual(after.customApiKeyResponses, { approved: ['old', TOKEN.slice(-20)], rejected: [] });
    assert.deepEqual(await approveClaudeApiKey(TOKEN, path), { changed: false });
    const fresh = join(dir, 'missing', '..', 'fresh.json');
    assert.deepEqual(await approveClaudeApiKey(TOKEN, fresh), { changed: true });
    assert.deepEqual(JSON.parse(await readFile(fresh, 'utf8')).customApiKeyResponses.approved, [TOKEN.slice(-20)]);
    await writeFile(path, '{broken');
    assert.ok((await approveClaudeApiKey(TOKEN, path)).error);
    assert.equal(await readFile(path, 'utf8'), '{broken');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── remote use ─────────────────────────────────────────────

test('remote use: token from stdin or --token-file is checked, saved 0600, never printed; --off removes it', async () => {
  const remote = await fakeRemote();
  const box = await sandbox();
  try {
    const bad = await cli(['remote', 'use', remote.url], box.env, { input: 'wrong-token\n' });
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /원격 토큰이 맞지 않습니다\(401\)/);
    assert.match(bad.stderr, /저장하지 않았습니다/);
    await assert.rejects(readFile(box.configPath, 'utf8'));

    const ok = await cli(['remote', 'use', remote.url + '/'], box.env, { input: `${TOKEN}\n` });
    assert.equal(ok.code, 0, ok.stderr);
    noToken(ok, 'use');
    assert.match(ok.stdout, /계정 3개/);
    const saved = JSON.parse(await readFile(box.configPath, 'utf8'));
    assert.deepEqual(saved.client, { url: remote.url, token: TOKEN });
    if (!WIN) assert.equal((await stat(box.configPath)).mode & 0o777, 0o600);
    assert.ok(remote.seen.every(r => r.url === '/teamproxy/status'));

    const shown = await cli(['remote', 'use'], box.env);
    assert.match(shown.stdout, /클라이언트 모드: http:\/\/127\.0\.0\.1:\d+ \(토큰 있음/);
    noToken(shown, 'use (show)');
    const status = await cli(['remote', 'status'], box.env);
    assert.equal(status.code, 0);
    noToken(status, 'remote status');
    const token = await cli(['remote', 'token'], box.env);
    assert.equal(token.code, 1);
    noToken(token, 'remote token');

    const file = join(box.home, 'token.txt');
    await writeFile(file, `  ${TOKEN}\r\n`);
    const fromFile = await cli(['remote', 'use', remote.url, '--token-file', file], box.env);
    assert.equal(fromFile.code, 0, fromFile.stderr);
    noToken(fromFile, 'use --token-file');

    const off = await cli(['remote', 'use', '--off'], box.env);
    assert.equal(off.code, 0);
    assert.equal(JSON.parse(await readFile(box.configPath, 'utf8')).client, undefined);
  } finally {
    await remote.close();
    await box.cleanup();
  }
});

test('remote use refuses a config with local accounts, a non-Claude pool, and an unreachable address', async () => {
  const codexPool = await fakeRemote({ status: { ...STATUS, pool: 'codex' } });
  const withAccounts = await sandbox({ proxy: { port: 3456 }, accounts: [{ name: 'a', type: 'apikey', apiKey: 'k' }] });
  const empty = await sandbox();
  try {
    const local = await cli(['remote', 'use', codexPool.url], withAccounts.env, { input: TOKEN });
    assert.equal(local.code, 1);
    assert.match(local.stderr, /로컬 계정 1개/);
    const codex = await cli(['remote', 'use', codexPool.url], empty.env, { input: TOKEN });
    assert.equal(codex.code, 1);
    assert.match(codex.stderr, /codex 풀입니다/);
    const closed = await new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
    const down = await cli(['remote', 'use', `http://127.0.0.1:${closed}`], empty.env, { input: TOKEN });
    assert.equal(down.code, 1);
    assert.match(down.stderr, /원격 풀에 못 닿습니다\(http:\/\/127\.0\.0\.1:\d+\): ECONNREFUSED/);
    const empty2 = await cli(['remote', 'use', codexPool.url], empty.env, { input: '\n' });
    assert.equal(empty2.code, 1);
    assert.match(empty2.stderr, /토큰이 비었거나/);
    const plain = await cli(['remote', 'use', 'http://pool.example.ts.net:8456'], empty.env, { input: TOKEN });
    assert.equal(plain.code, 1);
    assert.match(plain.stderr, /https:\/\//);
    for (const r of [local, codex, down]) noToken(r, 'refusal');
  } finally {
    await codexPool.close();
    await withAccounts.cleanup();
    await empty.cleanup();
  }
});

// ── commands in client mode ─────────────────────────────────

test('client mode: status, accounts --json, reload, restart, enable/disable/priority go to the remote pool', async () => {
  const remote = await fakeRemote();
  const box = await sandbox();
  try {
    await writeFile(box.configPath, JSON.stringify({ proxy: { port: 3456 }, accounts: [], client: { url: remote.url, token: TOKEN } }));
    const status = await cli(['status'], box.env);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /claude-main/);
    assert.match(status.stdout, /오래된 값/);
    const json = await cli(['accounts', '--json'], box.env);
    assert.equal(JSON.parse(json.stdout).accounts.length, 3);

    const reload = await cli(['reload'], box.env);
    assert.match(reload.stdout, /2\/3 계정\(전체 3\) — 원격 풀 전체에 적용/);
    const restart = await cli(['restart'], box.env);
    assert.equal(restart.code, 0);
    assert.match(restart.stdout, /이 기계에는 서버가 없습니다/);
    assert.match(restart.stdout, /사용량 다시 잼/);

    const enable = await cli(['enable', 'claude-s'], box.env);
    assert.match(enable.stdout, /원격 풀 전체에 적용: 2\. claude-spare 켬/);
    const disable = await cli(['disable', '1'], box.env);
    assert.match(disable.stdout, /1\. claude-main 끔/);
    const prio = await cli(['priority', 'work', '2'], box.env);
    assert.match(prio.stdout, /3\. work 우선 2/);
    const auto = await cli(['priority', 'work', 'auto'], box.env);
    assert.match(auto.stdout, /3\. work 자동 순서/);
    const usage = await cli(['priority', 'work'], box.env);
    assert.equal(usage.code, 1);
    const ambiguous = await cli(['disable', 'claude'], box.env);
    assert.equal(ambiguous.code, 1);
    assert.match(ambiguous.stderr, /여럿/);

    const posts = remote.seen.filter(r => r.method === 'POST').map(r => `${r.url} ${r.body}`);
    assert.deepEqual(posts, [
      '/teamproxy/reload {}', '/teamproxy/reload {}',
      '/teamproxy/accounts/2/enable {}', '/teamproxy/accounts/1/disable {}',
      '/teamproxy/accounts/3/priority {"priority":2}', '/teamproxy/accounts/3/priority {"priority":"auto"}',
    ]);
    assert.ok(remote.seen.every(r => r.key === TOKEN));
    for (const r of [status, json, reload, restart, enable, disable, prio, auto, usage, ambiguous]) noToken(r, 'client command');
    assert.equal(json.stdout.includes(TOKEN), false);
    // Nothing local was started or recorded.
    await assert.rejects(stat(join(box.home, 'teamclaude.server.json')));
  } finally {
    await remote.close();
    await box.cleanup();
  }
});

test('client mode: what only the pool machine can do is refused with guidance; remote errors are one line, exit 1', async () => {
  const remote = await fakeRemote();
  const box = await sandbox();
  try {
    await writeFile(box.configPath, JSON.stringify({ proxy: { port: 3456 }, accounts: [], client: { url: remote.url, token: TOKEN } }));
    for (const cmd of [['login'], ['logout'], ['remove', 'x'], ['update'], ['server'], ['stop'], ['import'], ['env'], [], ['remote', 'on']]) {
      const r = await cli(cmd, box.env);
      assert.equal(r.code, 1, cmd.join(' '));
      assert.match(r.stdout + r.stderr, /풀 기계/, cmd.join(' '));
      noToken(r, cmd.join(' ') || '(no args)');
    }
    assert.equal(remote.seen.length, 0);
    const help = await cli(['help'], box.env);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /remote use <URL>/);
  } finally {
    await remote.close();
  }
  for (const [reject, pattern] of [
    [{ status: 403, message: 'This Tailscale login is not allowed.' }, /403.*remote\.allowLogins/],
    [{ status: 403, message: 'Remote access is off on this proxy.' }, /403.*remote on/],
    [{ status: 502, message: 'bad gateway' }, /HTTP 502: bad gateway/],
  ]) {
    const failing = await fakeRemote({ reject });
    await writeFile(box.configPath, JSON.stringify({ accounts: [], client: { url: failing.url, token: TOKEN } }));
    const r = await cli(['status'], box.env);
    assert.equal(r.code, 1);
    assert.match(r.stderr, pattern);
    assert.equal(r.stderr.trim().split('\n').length, 1);
    noToken(r, 'remote error');
    await failing.close();
  }
  await box.cleanup();
});

// ── run ─────────────────────────────────────────────────────

// A stand-in for claude: records argv and the routing environment. A shebang script cannot stand in for
// claude.exe on Windows (spawn without a shell), so these two tests run on macOS/Linux; the env they check is
// built by clientChildEnv, tested above on every OS.
async function fakeClaude(dir) {
  const bin = join(dir, 'fake-claude');
  const out = join(dir, 'claude-call.json');
  await writeFile(bin, `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2),
    base: process.env.ANTHROPIC_BASE_URL, key: process.env.ANTHROPIC_API_KEY, auth: process.env.ANTHROPIC_AUTH_TOKEN ?? null,
    oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null, supervised: process.env.TEAMCLAUDE_SESSION_SUPERVISED,
    wrapper: process.env.TEAMCLAUDE_WRAPPER ?? null }));\nprocess.exit(7);\n`);
  await chmod(bin, 0o755);
  return { bin, read: async () => JSON.parse(await readFile(out, 'utf8')) };
}

test('client mode run: Claude Code gets the remote URL and token, yolo, an approved key, no local proxy', { skip: WIN }, async () => {
  const box = await sandbox();
  try {
    await writeFile(box.configPath, JSON.stringify({ proxy: { port: 3456 }, accounts: [], client: { url: 'https://pool.example.ts.net:8456', token: TOKEN } }));
    await mkdir(box.env.CLAUDE_CONFIG_DIR, { recursive: true });
    await writeFile(join(box.env.CLAUDE_CONFIG_DIR, '.claude.json'), JSON.stringify({ theme: 'dark' }));
    const claude = await fakeClaude(box.home);
    const env = { ...box.env, TEAMCLAUDE_CLAUDE_BIN: claude.bin, ANTHROPIC_AUTH_TOKEN: 'local-oauth', CLAUDE_CODE_OAUTH_TOKEN: 'local' };

    const r = await cli(['run', '--', '-p', 'hello', '--model', 'claude-opus-5-5'], env);
    assert.equal(r.code, 7, r.stderr);
    noToken(r, 'run');
    assert.doesNotMatch(r.stderr, /starting it automatically|waiting for the configured proxy/);
    const call = await claude.read();
    assert.deepEqual(call.argv, ['--dangerously-skip-permissions', '-p', 'hello', '--model', 'claude-opus-5-5']);
    assert.equal(call.base, 'https://pool.example.ts.net:8456');
    assert.equal(call.key, TOKEN);
    assert.equal(call.auth, null);
    assert.equal(call.oauth, null);
    assert.equal(call.supervised, '1');
    const claudeJson = JSON.parse(await readFile(join(box.env.CLAUDE_CONFIG_DIR, '.claude.json'), 'utf8'));
    assert.equal(claudeJson.theme, 'dark');
    assert.deepEqual(claudeJson.customApiKeyResponses.approved, [TOKEN.slice(-20)]);

    const sub = await cli(['run', '--', 'mcp', 'list'], env);
    assert.equal(sub.code, 7);
    assert.deepEqual((await claude.read()).argv, ['mcp', 'list']);
    const ask = await cli(['run', '--', '--permission-mode', 'plan'], env);
    assert.equal(ask.code, 7);
    assert.deepEqual((await claude.read()).argv, ['--permission-mode', 'plan']);

    const nested = await cli(['run'], { ...env, TEAMCLAUDE_SESSION_SUPERVISED: '1' });
    assert.equal(nested.code, 75);
    await assert.rejects(stat(join(box.home, 'teamclaude.server.json')));
  } finally {
    await box.cleanup();
  }
});

test('TEAMCLAUDE_WRAPPER=1 (teamclaude.cmd): no args and Claude flags open Claude, -- a subcommand, words stay proxy commands', { skip: WIN }, async () => {
  const remote = await fakeRemote();
  const box = await sandbox();
  try {
    await writeFile(box.configPath, JSON.stringify({ accounts: [], client: { url: remote.url, token: TOKEN } }));
    const claude = await fakeClaude(box.home);
    const env = { ...box.env, TEAMCLAUDE_CLAUDE_BIN: claude.bin, TEAMCLAUDE_WRAPPER: '1' };
    assert.equal((await cli([], env)).code, 7);
    let call = await claude.read();
    assert.deepEqual(call.argv, ['--dangerously-skip-permissions']);
    assert.equal(call.wrapper, null);
    assert.equal((await cli(['-p', 'x'], env)).code, 7);
    assert.deepEqual((await claude.read()).argv, ['--dangerously-skip-permissions', '-p', 'x']);
    assert.equal((await cli(['--', 'doctor'], env)).code, 7);
    call = await claude.read();
    assert.deepEqual(call.argv, ['doctor']);
    const status = await cli(['status'], env);
    assert.equal(status.code, 0);
    assert.match(status.stdout, /claude-main/);
  } finally {
    await remote.close();
    await box.cleanup();
  }
});

// ── Windows local pool: stop/restart never signal an unverified pid, and say what to do ─────

async function unusedPort() {
  const s = net.createServer().listen(0, '127.0.0.1');
  await once(s, 'listening');
  const { port } = s.address();
  await new Promise(r => s.close(r));
  return port;
}

test('Windows stop/restart: an unverifiable server is left running and the exact steps are printed', async () => {
  const port = await unusedPort();
  const box = await sandbox({
    proxy: { port, host: '127.0.0.1', apiKey: 'tc-test' }, upstream: 'http://127.0.0.1:9', activeWarmup: false,
    accounts: [{ name: 'api-test', type: 'apikey', apiKey: 'sk-ant-test' }],
  });
  const server = spawn(process.execPath, [index, 'server'], { env: box.env, stdio: 'ignore' });
  try {
    const up = async () => new Promise(resolve => {
      http.get({ host: '127.0.0.1', port, path: '/teamclaude/status' }, res => { res.resume(); resolve(true); })
        .once('error', () => resolve(false));
    });
    const deadline = Date.now() + 15_000;
    while (!(await up())) {
      assert.ok(Date.now() < deadline && server.exitCode === null, 'server did not start');
      await delay(50);
    }
    const winEnv = { ...box.env, NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT || 'child-v8', TEAMPROXY_APP_PLATFORM: 'win32' };
    for (const command of ['stop', 'restart']) {
      const r = await cli([command], winEnv, { script: index });
      assert.equal(r.code, 1, `${command}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /Windows에서는 서버 프로세스의 신원을 확인할 수 없어/);
      assert.match(r.stderr, /taskkill \/PID \d+ \/T \/F/);
      assert.ok(await up(), `${command} must leave the server running`);
    }
  } finally {
    server.kill('SIGTERM');
    if (server.exitCode === null) await once(server, 'exit');
    await box.cleanup();
  }
});
