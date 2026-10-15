// `<pool> update` against a fake world: a local bare repo as the fork, npm-style
// installs under a temporary HOME, fake proxy servers (separate processes whose
// command line points into an install, like the real ones) and fake systemctl /
// tmux / launchctl on PATH. The machine's real proxies are never touched.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/teamclaude.js', import.meta.url));
// Linux accepts only a systemd user unit; macOS the launchd-supervised tmux session.
const SYSTEMD = process.platform === 'darwin' ? '0' : '1';
const worlds = [];
after(() => {
  for (const w of worlds) {
    for (const cfg of ['teamclaude', 'teamgrok']) {
      try { process.kill(JSON.parse(readFileSync(join(w.home, '.config', `${cfg}.server.json`), 'utf8')).pid, 'SIGKILL'); } catch { /* not running */ }
    }
    rmSync(w.root, { recursive: true, force: true });
  }
});

// The fake proxy. `server` listens and writes the state file; `status --json` reports.
// Flag files next to the config steer it: busy, flap, models400, dropaccount.
const fakeProxy = ({ version, broken = false }) => `
const fs = require('fs'); const http = require('http'); const crypto = require('crypto'); const path = require('path');
const VERSION = ${JSON.stringify(version)}; const BROKEN = ${broken};
const cfgPath = process.env.TEAMCLAUDE_CONFIG;
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const statePath = cfgPath.replace(/\\.json$/, '.server.json');
const flag = name => fs.existsSync(cfgPath + '.' + name);
const args = process.argv.slice(2);
if (args.includes('server')) {
  const digest = crypto.createHash('sha256');
  for (const n of fs.readdirSync(__dirname).filter(n => n.endsWith('.js')).sort()) {
    digest.update(n).update('\\0').update(fs.readFileSync(path.join(__dirname, n))).update('\\0');
  }
  const HASH = digest.digest('hex');
  const LIFECYCLE = 'lifecycle-' + process.pid + '-0123456789';
  let flap = 0;
  const active = () => (flag('busy') ? 1 : flag('flap') ? flap++ % 2 : 0);
  http.createServer((req, res) => {
    if (req.url === '/teamclaude/status') {
      res.setHeader('x-teamcodex-source-hash', HASH);
      res.setHeader('x-teamcodex-active-requests', String(active()));
      res.end(JSON.stringify({ version: VERSION, accounts: cfg.accounts.map(() => ({ inflight: 0 })) }));
    } else if (req.url === '/teamclaude/deployment/drain') {
      const ok = req.headers['x-api-key'] === cfg.proxy.apiKey && req.headers['x-teamcodex-lifecycle-id'] === LIFECYCLE;
      fs.appendFileSync(cfgPath + '.drain', req.method + ' ' + ok + '\\n');
      res.statusCode = ok ? 200 : 403;
      res.end(JSON.stringify({ draining: req.method === 'POST', activeRequests: 0 }));
    } else if (req.url === '/v1/models') {
      res.statusCode = flag('models400') ? 400 : BROKEN ? 500 : req.headers['anthropic-version'] === '2023-06-01' ? 200 : 400;
      res.end('{}');
    } else { res.statusCode = 404; res.end(); }
  }).listen(cfg.proxy.port, '127.0.0.1', () =>
    fs.writeFileSync(statePath, JSON.stringify({ pid: process.pid, port: cfg.proxy.port, lifecycle: { id: LIFECYCLE } })));
  process.on('SIGTERM', () => { try { fs.unlinkSync(statePath); } catch {} process.exit(0); });
} else if (args.includes('status')) {
  let running = false;
  try { process.kill(JSON.parse(fs.readFileSync(statePath, 'utf8')).pid, 0); running = true; } catch {}
  const accounts = cfg.accounts.map(a => ({ name: a.name, enabled: a.enabled !== false }));
  if (flag('dropaccount')) accounts.pop();
  console.log(JSON.stringify({ ok: true, running, version: VERSION, accounts }));
}
`;

// "The supervisor starts the same command again": kill the server, rerun its command line.
const FAKE_RESTART = `
const fs = require('fs'); const { execFileSync, spawn } = require('child_process');
fs.appendFileSync(process.env.FAKE_LOG, 'RESTART\\n');
const statePath = process.env.TEAMCLAUDE_CONFIG.replace(/\\.json$/, '.server.json');
const { pid } = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const command = execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)]).toString().trim().split(/\\s+/);
process.kill(pid, 'SIGTERM');
const until = Date.now() + 5000;
while (Date.now() < until) { try { process.kill(pid, 0); } catch { break; } }
if (!process.env.FAKE_NO_RESPAWN) spawn(process.execPath, command.slice(1), { detached: true, stdio: 'ignore' }).unref();
`;
const FAKE_TMUX = `#!/usr/bin/env node
const args = process.argv.slice(2);
require('fs').appendFileSync(process.env.FAKE_LOG, 'tmux ' + args.join(' ') + '\\n');
if (args.includes('kill-session')) require('./restart.js');
`;
const FAKE_SYSTEMCTL = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('is-active')) process.exit(process.env.FAKE_SYSTEMD === '1' ? 0 : 3);
if (args.includes('restart')) require('./restart.js');
`;
const FAKE_LAUNCHCTL = `#!/bin/sh
echo "PID	Status	Label"
[ -n "$FAKE_NO_LAUNCHD" ] || echo "4242	0	com.example.teamclaude"
`;

function sh(cwd, cmd, args) {
  return execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' },
  });
}

function commit(seed, files, message) {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(seed, rel, '..'), { recursive: true });
    writeFileSync(join(seed, rel), body);
  }
  sh(seed, 'git', ['add', '-A']);
  sh(seed, 'git', ['commit', '-qm', message]);
  return sh(seed, 'git', ['rev-parse', 'HEAD']).trim();
}

async function freePort() {
  const srv = createServer().listen(0, '127.0.0.1');
  await new Promise(r => srv.once('listening', r));
  const { port } = srv.address();
  await new Promise(r => srv.close(r));
  return port;
}

/**
 * Fork: main = A → B; branch `broken` (C, model list 500) and `feature` (F) off B.
 * Clone at ~/src/teamproxy; the teamclaude install starts at A.
 */
async function makeWorld({ installAt = 'A' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tp-update-'));
  const home = join(root, 'home');
  const seed = join(root, 'seed');
  mkdirSync(seed, { recursive: true });
  sh(seed, 'git', ['init', '-q', '-b', 'main']);
  const c = {};
  c.A = commit(seed, {
    'src/teamclaude.js': fakeProxy({ version: 'A' }), 'src/index.js': '// A\n', 'src/hud/x.py': 'x = 1\n',
    'package.json': JSON.stringify({ name: 'teamcodex', version: '1.0.0' }),
  }, 'A');
  c.B = commit(seed, { 'src/teamclaude.js': fakeProxy({ version: 'B' }), 'src/new.js': '// new in B\n' }, 'B');
  sh(seed, 'git', ['checkout', '-qb', 'broken']);
  c.C = commit(seed, { 'src/teamclaude.js': fakeProxy({ version: 'C', broken: true }) }, 'C');
  sh(seed, 'git', ['checkout', '-q', 'main']);
  sh(seed, 'git', ['checkout', '-qb', 'feature']);
  c.F = commit(seed, { 'src/teamclaude.js': fakeProxy({ version: 'F' }) }, 'F');
  sh(seed, 'git', ['checkout', '-q', 'main']);
  const origin = join(root, 'origin.git');
  sh(root, 'git', ['clone', '-q', '--bare', seed, origin]);
  mkdirSync(join(home, 'src'), { recursive: true });
  sh(root, 'git', ['clone', '-q', origin, join(home, 'src', 'teamproxy')]);

  const install = (name, at = 'A') => {
    const dir = join(home, '.local', 'share', name, 'lib', 'node_modules', 'teamcodex');
    mkdirSync(dir, { recursive: true });
    const tar = spawnSync('git', ['-C', seed, 'archive', c[at], 'src', 'package.json']).stdout;
    spawnSync('tar', ['-x', '-C', dir], { input: tar });
    mkdirSync(join(dir, 'src', 'hud', '__pycache__'));
    writeFileSync(join(dir, 'src', 'hud', '__pycache__', 'x.cpython-313.pyc'), 'cache');
    return dir;
  };
  const bin = join(root, 'bin');
  mkdirSync(bin);
  for (const [name, body] of [['restart.js', FAKE_RESTART], ['tmux', FAKE_TMUX], ['systemctl', FAKE_SYSTEMCTL], ['launchctl', FAKE_LAUNCHCTL]]) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  const config = join(home, '.config', 'teamclaude.json');
  mkdirSync(join(home, '.config'), { recursive: true });
  writeFileSync(config, JSON.stringify({
    proxy: { port: await freePort(), apiKey: 'fake-proxy-key' },
    accounts: [{ name: 'a1' }, { name: 'a2', enabled: false }],
  }));
  const w = { root, home, origin, config, bin, c, log: join(root, 'restart.log'), claude: install('teamclaude-global', installAt), install };
  worlds.push(w);
  return w;
}

async function startServer(w, installDir, configPath = w.config) {
  const state = configPath.replace(/\.json$/, '.server.json');
  spawn(process.execPath, [join(installDir, 'src', 'teamclaude.js'), 'server'], {
    detached: true, stdio: 'ignore', env: { ...process.env, TEAMCLAUDE_CONFIG: configPath },
  }).unref();
  for (let i = 0; i < 100 && !existsSync(state); i++) await new Promise(r => setTimeout(r, 50));
  assert.ok(existsSync(state), 'fake server started');
}

function update(w, args, extraEnv = {}, onStderr = () => {}) {
  const env = {
    ...process.env, HOME: w.home, PATH: `${w.bin}:${process.env.PATH}`, TEAMCLAUDE_CONFIG: w.config,
    FAKE_LOG: w.log, FAKE_SYSTEMD: SYSTEMD, TEAMPROXY_UPDATE_POLL_MS: '100', TEAMPROXY_UPDATE_URL: w.origin, ...extraEnv,
  };
  for (const k of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TEAMCLAUDE_PROVIDER', 'TEAMCLAUDE_SESSION_SUPERVISED']) delete env[k];
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, 'update', '--json', ...args], { env });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; onStderr(stderr, child); });
    child.on('close', status => resolve({ status, stderr, result: JSON.parse(stdout.trim().split('\n').pop() || 'null') }));
  });
}

const version = dir => readFileSync(join(dir, 'src', 'teamclaude.js'), 'utf8').match(/VERSION = "(\w)"/)[1];
const restarts = w => (existsSync(w.log) ? readFileSync(w.log, 'utf8').match(/^RESTART$/gm)?.length ?? 0 : 0);
const flag = (w, name) => writeFileSync(`${w.config}.${name}`, '1');
const backups = dir => readdirSync(dir).filter(n => /\.(pre|failed|new)-/.test(n));
async function liveVersion(w) {
  const { port } = JSON.parse(readFileSync(join(w.home, '.config', 'teamclaude.server.json'), 'utf8'));
  return (await (await fetch(`http://127.0.0.1:${port}/teamclaude/status`)).json()).version;
}

test('update replaces the install, drains, restarts the pool and verifies it', async () => {
  const w = await makeWorld();
  await startServer(w, w.claude);
  const { status, result, stderr } = await update(w, []);
  assert.equal(status, 0, stderr);
  assert.equal(result.ok, true);
  assert.equal(result.warnings, undefined);
  assert.equal(result.installs[0].result, 'updated');
  assert.equal(version(w.claude), 'B');
  assert.ok(existsSync(join(w.claude, 'src', 'new.js')));
  assert.ok(backups(w.claude).some(n => n.startsWith('src.pre-')), 'backup kept');
  assert.ok(backups(w.claude).some(n => n.startsWith('package.json.pre-')));
  assert.ok(!backups(w.claude).some(n => n.includes('.new-')), 'staging renamed into place');
  assert.equal(readFileSync(join(w.claude, '.teamproxy-commit'), 'utf8').trim(), w.c.B);
  assert.ok(!existsSync(join(w.claude, '.update.lock')), 'lock released');
  assert.match(readFileSync(`${w.config}.drain`, 'utf8'), /^POST true$/m, 'fenced with lifecycle id + api key');
  assert.equal(restarts(w), 1);
  assert.equal(await liveVersion(w), 'B');
  assert.match(stderr, /모델 목록 200/);
});

test('update stops on a local-only edit and changes nothing', async () => {
  const w = await makeWorld();
  await startServer(w, w.claude);
  writeFileSync(join(w.claude, 'src', 'index.js'), '// hand patch\n');
  const { status, result } = await update(w, []);
  assert.equal(status, 1);
  assert.equal(result.error, 'local_changes');
  assert.deepEqual(result.installs[0].files, ['index.js']);
  assert.equal(version(w.claude), 'A');
  assert.equal(restarts(w), 0);
});

test('--dry-run reports the plan without touching files or the server; a non-fork origin warns', async () => {
  const w = await makeWorld();
  await startServer(w, w.claude);
  const { status, result, stderr } = await update(w, ['--dry-run'], { TEAMPROXY_UPDATE_URL: undefined });
  assert.equal(status, 0, stderr);
  assert.equal(result.installs[0].result, 'dry_run');
  assert.deepEqual(result.warnings, ['origin_not_fork']);
  assert.match(stderr, /dry-run.*(kill-session|systemctl)/);
  assert.equal(version(w.claude), 'A');
  assert.deepEqual(backups(w.claude), []);
  assert.equal(restarts(w), 0);
  assert.equal(await liveVersion(w), 'A');
});

test('update gives up when requests never drain within --wait', async () => {
  const w = await makeWorld();
  await startServer(w, w.claude);
  flag(w, 'busy');
  const { status, result, stderr } = await update(w, ['--wait', '1']);
  assert.equal(status, 1);
  assert.equal(result.error, 'wait_timeout');
  assert.match(stderr, /진행 중 요청 1개 — 이 풀을 쓰는 다른 세션이 쉴 때/);
  assert.equal(version(w.claude), 'A');
  assert.equal(restarts(w), 0);
});

test('a single idle sample is not idle: two in a row are required', async () => {
  const w = await makeWorld();
  await startServer(w, w.claude);
  flag(w, 'flap'); // 0, 1, 0, 1 …
  const { result } = await update(w, ['--wait', '2']);
  assert.equal(result.error, 'wait_timeout');
  assert.equal(version(w.claude), 'A');
});

test('failed verification restores the backup and restarts the old code', async () => {
  const w = await makeWorld();
  await startServer(w, w.claude);
  const { status, result, stderr } = await update(w, ['--ref', 'broken']);
  assert.equal(status, 1);
  assert.equal(result.installs[0].result, 'restored', stderr);
  assert.match(result.installs[0].failure, /HTTP 500/);
  assert.equal(version(w.claude), 'A');
  assert.ok(backups(w.claude).some(n => n.startsWith('src.failed-')));
  assert.ok(!backups(w.claude).some(n => n.includes('.pre-')), 'backup moved back into place');
  assert.ok(!existsSync(join(w.claude, '.teamproxy-commit')), 'install record restored (none before)');
  assert.equal(restarts(w), 2);
  assert.equal(await liveVersion(w), 'A');
});

test('a model list that already failed before the update does not trigger a rollback', async () => {
  const w = await makeWorld();
  await startServer(w, w.claude);
  flag(w, 'models400');
  const { status, result, stderr } = await update(w, []);
  assert.equal(status, 0, stderr);
  assert.equal(result.installs[0].result, 'updated');
  assert.match(stderr, /모델 목록 확인 생략/);
  assert.equal(await liveVersion(w), 'B');
});

test('a changed account list after the restart triggers a rollback', async () => {
  const w = await makeWorld();
  await startServer(w, w.claude);
  flag(w, 'dropaccount');
  const { status, result } = await update(w, []);
  assert.equal(status, 1);
  assert.equal(result.installs[0].result, 'restored');
  assert.match(result.installs[0].failure, /계정/);
  assert.equal(version(w.claude), 'A');
});

test('--no-restart swaps files only; the next run restarts the stale server, the one after is a no-op', async () => {
  const w = await makeWorld();
  writeFileSync(join(w.home, '.config', 'teamclaude.server.json'), '{}'); // not running
  // Not running: the pool's own install is the one this CLI runs from, a git checkout → refused.
  assert.equal((await update(w, ['--no-restart'])).result.error, 'not_an_install');
  await startServer(w, w.claude);
  assert.equal((await update(w, ['--no-restart'])).result.installs[0].result, 'updated_no_restart');
  assert.equal(version(w.claude), 'B');
  assert.equal(await liveVersion(w), 'A');
  const second = await update(w, []);
  assert.equal(second.result.installs[0].result, 'updated', 'files match but the live source hash is A');
  assert.equal(await liveVersion(w), 'B');
  const third = await update(w, []);
  assert.equal(third.status, 0);
  assert.equal(third.result.installs[0].result, 'up_to_date', 'live source hash matches: no restart');
  assert.equal(restarts(w), 1);
});

test('an older --ref can replace newer files, and main brings them back', async () => {
  const w = await makeWorld({ installAt: 'B' }); // no install record: only origin/main vouches for B's files
  await startServer(w, w.claude);
  const down = await update(w, ['--ref', w.c.A]);
  assert.equal(down.result.installs[0].result, 'updated', down.stderr);
  assert.equal(version(w.claude), 'A');
  const up = await update(w, []);
  assert.equal(up.result.installs[0].result, 'updated', up.stderr);
  assert.equal(version(w.claude), 'B');
});

test('after a feature-branch --ref, updating to main is not blocked as a local change', async () => {
  const w = await makeWorld();
  await startServer(w, w.claude);
  assert.equal((await update(w, ['--ref', 'feature'])).result.installs[0].result, 'updated');
  assert.equal(version(w.claude), 'F');
  const back = await update(w, []);
  assert.equal(back.result.installs[0].result, 'updated', back.stderr);
  assert.equal(version(w.claude), 'B');
});

test('a live lock blocks a second update; a dead one is taken over', async () => {
  const w = await makeWorld();
  await startServer(w, w.claude);
  const lock = join(w.claude, '.update.lock');
  writeFileSync(lock, String(process.pid));
  const blocked = await update(w, []);
  assert.equal(blocked.result.installs[0].result, 'locked');
  assert.equal(version(w.claude), 'A');
  assert.equal(restarts(w), 0);
  writeFileSync(lock, String(spawnSync(process.execPath, ['-e', '']).pid)); // exited
  assert.equal((await update(w, [])).result.installs[0].result, 'updated');
  assert.ok(!existsSync(lock));
});

test('no supervisor to restart the pool: stop before changing anything', async () => {
  const w = await makeWorld();
  await startServer(w, w.claude);
  const { status, result } = await update(w, [], { FAKE_SYSTEMD: '0', FAKE_NO_LAUNCHD: '1' });
  assert.equal(status, 1);
  assert.equal(result.installs[0].result, 'no_restart_method');
  assert.equal(version(w.claude), 'A');
  assert.deepEqual(backups(w.claude), []);
});

test('only the two newest backups of each kind are kept', async () => {
  const w = await makeWorld();
  await startServer(w, w.claude);
  for (const d of ['20200101', '20200102-000000', '20200103-000000']) cpSync(join(w.claude, 'src'), join(w.claude, `src.pre-${d}`), { recursive: true });
  assert.equal((await update(w, [])).result.installs[0].result, 'updated');
  const pre = backups(w.claude).filter(n => n.startsWith('src.pre-')).sort();
  assert.equal(pre.length, 2);
  assert.equal(pre[0], 'src.pre-20200103-000000');
});

test('--all updates every install it finds and leaves app-mode installs alone', async () => {
  const w = await makeWorld();
  const codex = w.install('teamcodex-global'); // installed, not running
  const app = join(w.home, '.local', 'share', 'teamproxy-app', 'grok', 'lib', 'node_modules', 'teamcodex');
  cpSync(w.claude, app, { recursive: true });
  const grokConfig = join(w.home, '.config', 'teamgrok.json');
  writeFileSync(grokConfig, JSON.stringify({ provider: 'grok', proxy: { port: await freePort() }, accounts: [] }));
  await startServer(w, w.claude);
  await startServer(w, app, grokConfig); // an app-mode server for another pool
  const { status, result, stderr } = await update(w, ['--all']);
  assert.equal(status, 0, stderr);
  assert.ok(result.installs.some(i => i.result === 'skipped_app'), 'app-mode install reported');
  assert.equal(result.installs.filter(i => i.result === 'updated').length, 2);
  assert.equal(version(w.claude), 'B');
  assert.equal(version(codex), 'B');
  assert.equal(version(app), 'A');
  assert.match(stderr, /앱 모드 설치본/);
  assert.equal(restarts(w), 1, 'only the running claude pool restarts');
});

test('SIGTERM after the swap puts the old files back', async () => {
  const w = await makeWorld();
  await startServer(w, w.claude);
  let sent = false;
  // The supervisor never brings the server back, so update sits in the restart wait.
  const { status, result } = await update(w, [], { FAKE_NO_RESPAWN: '1' }, (err, child) => {
    if (!sent && /다시 띄움/.test(err)) { sent = true; setTimeout(() => child.kill('SIGTERM'), 300); }
  });
  assert.equal(status, 130);
  assert.equal(result.error, 'interrupted');
  assert.equal(result.installs[0].result, 'interrupted_restored');
  assert.equal(version(w.claude), 'A');
  assert.ok(!existsSync(join(w.claude, '.update.lock')));
  assert.equal(restarts(w), 2, 'the restarted pool is restarted again on the old files');
});

test('a backup name already taken in the same second gets a new suffix', async () => {
  const w = await makeWorld();
  await startServer(w, w.claude);
  const two = n => String(n).padStart(2, '0');
  for (let s = 0; s < 6; s++) {
    const d = new Date(Date.now() + s * 1000);
    const stamp = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
    mkdirSync(join(w.claude, `src.pre-${stamp}`));
    writeFileSync(join(w.claude, `src.pre-${stamp}`, 'keep'), ''); // non-empty: rename() onto it fails
  }
  const { result, stderr } = await update(w, []);
  assert.equal(result.installs[0].result, 'updated', stderr);
  assert.equal(version(w.claude), 'B');
});
