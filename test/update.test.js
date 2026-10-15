// `<pool> update` against a fake world: a local bare repo as the fork, npm-style
// installs under a temporary HOME, fake proxy servers (separate processes whose
// command line points into an install, like the real ones) and fake tmux /
// systemctl on PATH. The machine's real proxies are never touched.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/teamclaude.js', import.meta.url));
const worlds = [];
after(() => {
  for (const w of worlds) {
    for (const cfg of ['teamclaude', 'teamgrok']) {
      try { process.kill(JSON.parse(readFileSync(join(w.home, '.config', `${cfg}.server.json`), 'utf8')).pid, 'SIGKILL'); } catch { /* not running */ }
    }
    rmSync(w.root, { recursive: true, force: true });
  }
});

// The fake proxy: `server` listens and writes the state file, `status --json` reports.
const fakeProxy = ({ version, broken = false }) => `
const fs = require('fs'); const http = require('http');
const VERSION = ${JSON.stringify(version)}; const BROKEN = ${broken};
const cfgPath = process.env.TEAMCLAUDE_CONFIG;
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const statePath = cfgPath.replace(/\\.json$/, '.server.json');
const args = process.argv.slice(2);
if (args.includes('server')) {
  http.createServer((req, res) => {
    if (req.url === '/teamclaude/status') {
      const inflight = fs.existsSync(cfgPath + '.inflight') ? 1 : 0;
      res.end(JSON.stringify({ version: VERSION, accounts: cfg.accounts.map(() => ({ inflight })) }));
    } else if (req.url === '/v1/models') {
      res.statusCode = BROKEN ? 500 : req.headers['anthropic-version'] === '2023-06-01' ? 200 : 400;
      res.end('{}');
    } else { res.statusCode = 404; res.end(); }
  }).listen(cfg.proxy.port, '127.0.0.1', () =>
    fs.writeFileSync(statePath, JSON.stringify({ pid: process.pid, port: cfg.proxy.port })));
  process.on('SIGTERM', () => { try { fs.unlinkSync(statePath); } catch {} process.exit(0); });
} else if (args.includes('status')) {
  let running = false;
  try { process.kill(JSON.parse(fs.readFileSync(statePath, 'utf8')).pid, 0); running = true; } catch {}
  console.log(JSON.stringify({ ok: true, running, version: VERSION,
    accounts: cfg.accounts.map(a => ({ name: a.name, enabled: a.enabled !== false })) }));
}
`;

// tmux stand-in for "kill the session, launchd starts the same command again".
const FAKE_TMUX = `#!/usr/bin/env node
const fs = require('fs'); const { execFileSync, spawn } = require('child_process');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, args.join(' ') + '\\n');
if (args.includes('kill-session')) {
  const statePath = process.env.TEAMCLAUDE_CONFIG.replace(/\\.json$/, '.server.json');
  const { pid } = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const command = execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)]).toString().trim().split(/\\s+/);
  process.kill(pid, 'SIGTERM');
  const until = Date.now() + 5000;
  while (Date.now() < until) { try { process.kill(pid, 0); } catch { break; } }
  spawn(process.execPath, command.slice(1), { detached: true, stdio: 'ignore' }).unref();
}
`;

function sh(cwd, cmd, args) {
  return execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' },
  });
}

function writeTree(dir, files) {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
}

async function freePort() {
  const srv = createServer().listen(0, '127.0.0.1');
  await new Promise(r => srv.once('listening', r));
  const { port } = srv.address();
  await new Promise(r => srv.close(r));
  return port;
}

/** Fork with main = B (A before it) and branch `broken`; the clone at ~/src/teamproxy; one install at A. */
async function makeWorld() {
  const root = mkdtempSync(join(tmpdir(), 'tp-update-'));
  const home = join(root, 'home');
  const seed = join(root, 'seed');
  const pkg = JSON.stringify({ name: 'teamcodex', version: '1.0.0' });
  mkdirSync(seed, { recursive: true });
  sh(seed, 'git', ['init', '-q', '-b', 'main']);
  writeTree(seed, { 'src/teamclaude.js': fakeProxy({ version: 'A' }), 'src/index.js': '// A\n', 'src/hud/x.py': 'x = 1\n', 'package.json': pkg });
  sh(seed, 'git', ['add', '-A']);
  sh(seed, 'git', ['commit', '-qm', 'A']);
  const commitA = sh(seed, 'git', ['rev-parse', 'HEAD']).trim();
  writeTree(seed, { 'src/teamclaude.js': fakeProxy({ version: 'B' }), 'src/new.js': '// new in B\n' });
  sh(seed, 'git', ['add', '-A']);
  sh(seed, 'git', ['commit', '-qm', 'B']);
  sh(seed, 'git', ['checkout', '-qb', 'broken']);
  writeTree(seed, { 'src/teamclaude.js': fakeProxy({ version: 'C', broken: true }) });
  sh(seed, 'git', ['commit', '-qam', 'C']);
  sh(root, 'git', ['clone', '-q', '--bare', seed, join(root, 'origin.git')]);
  mkdirSync(join(home, 'src'), { recursive: true });
  sh(root, 'git', ['clone', '-q', join(root, 'origin.git'), join(home, 'src', 'teamproxy')]);

  const install = name => {
    const dir = join(home, '.local', 'share', name, 'lib', 'node_modules', 'teamcodex');
    mkdirSync(dir, { recursive: true });
    const tar = spawnSync('git', ['-C', seed, 'archive', commitA, 'src', 'package.json']).stdout;
    spawnSync('tar', ['-x', '-C', dir], { input: tar });
    mkdirSync(join(dir, 'src', 'hud', '__pycache__'));
    writeFileSync(join(dir, 'src', 'hud', '__pycache__', 'x.cpython-313.pyc'), 'cache');
    return dir;
  };
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'tmux'), FAKE_TMUX);
  writeFileSync(join(bin, 'systemctl'), '#!/bin/sh\nexit 3\n');
  chmodSync(join(bin, 'tmux'), 0o755);
  chmodSync(join(bin, 'systemctl'), 0o755);
  const config = join(home, '.config', 'teamclaude.json');
  mkdirSync(join(home, '.config'), { recursive: true });
  writeFileSync(config, JSON.stringify({ proxy: { port: await freePort() }, accounts: [{ name: 'a1' }, { name: 'a2', enabled: false }] }));
  const w = { root, home, config, bin, log: join(root, 'tmux.log'), claude: install('teamclaude-global'), install };
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

function update(w, args) {
  const env = { ...process.env, HOME: w.home, PATH: `${w.bin}:${process.env.PATH}`, TEAMCLAUDE_CONFIG: w.config, FAKE_LOG: w.log, TEAMPROXY_UPDATE_POLL_MS: '100' };
  for (const k of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TEAMCLAUDE_PROVIDER', 'TEAMCLAUDE_SESSION_SUPERVISED']) delete env[k];
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, 'update', '--json', ...args], { env });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', status => resolve({ status, stderr, result: JSON.parse(stdout.trim().split('\n').pop() || 'null') }));
  });
}

const version = dir => readFileSync(join(dir, 'src', 'teamclaude.js'), 'utf8').match(/VERSION = "(\w)"/)[1];
const tmuxLog = w => (existsSync(w.log) ? readFileSync(w.log, 'utf8') : '');
async function liveVersion(w) {
  const { port } = JSON.parse(readFileSync(join(w.home, '.config', 'teamclaude.server.json'), 'utf8'));
  return (await (await fetch(`http://127.0.0.1:${port}/teamclaude/status`)).json()).version;
}

test('update replaces the install, restarts the pool and verifies it', async () => {
  const w = await makeWorld();
  await startServer(w, w.claude);
  const { status, result, stderr } = await update(w, []);
  assert.equal(status, 0, stderr);
  assert.equal(result.ok, true);
  assert.equal(result.installs[0].result, 'updated');
  assert.equal(version(w.claude), 'B');
  assert.ok(existsSync(join(w.claude, 'src', 'new.js')));
  assert.ok(readdirSync(w.claude).some(n => n.startsWith('src.pre-')), 'backup kept');
  assert.ok(readdirSync(w.claude).some(n => n.startsWith('package.json.pre-')));
  assert.match(tmuxLog(w), /-L teamclaude kill-session -t proxy/);
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
  assert.doesNotMatch(tmuxLog(w), /kill-session/);
});

test('--dry-run reports the plan without touching files or the server', async () => {
  const w = await makeWorld();
  await startServer(w, w.claude);
  const { status, result, stderr } = await update(w, ['--dry-run']);
  assert.equal(status, 0, stderr);
  assert.equal(result.installs[0].result, 'dry_run');
  assert.match(stderr, /dry-run.*kill-session/);
  assert.equal(version(w.claude), 'A');
  assert.ok(!readdirSync(w.claude).some(n => n.includes('.pre-')));
  assert.doesNotMatch(tmuxLog(w), /kill-session/);
  assert.equal(await liveVersion(w), 'A');
});

test('update gives up when requests never drain within --wait', async () => {
  const w = await makeWorld();
  await startServer(w, w.claude);
  writeFileSync(`${w.config}.inflight`, '1');
  const { status, result } = await update(w, ['--wait', '1']);
  assert.equal(status, 1);
  assert.equal(result.error, 'wait_timeout');
  assert.equal(version(w.claude), 'A');
  assert.doesNotMatch(tmuxLog(w), /kill-session/);
});

test('failed verification restores the backup and restarts the old code', async () => {
  const w = await makeWorld();
  await startServer(w, w.claude);
  const { status, result, stderr } = await update(w, ['--ref', 'broken']);
  assert.equal(status, 1);
  assert.equal(result.installs[0].result, 'restored', stderr);
  assert.match(result.installs[0].failure, /HTTP 500/);
  assert.equal(version(w.claude), 'A');
  assert.ok(readdirSync(w.claude).some(n => n.startsWith('src.failed-')));
  assert.ok(!readdirSync(w.claude).some(n => n.includes('.pre-')), 'backup moved back into place');
  assert.equal(tmuxLog(w).match(/kill-session/g).length, 2);
  assert.equal(await liveVersion(w), 'A');
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
  const byResult = Object.fromEntries(result.installs.map(i => [i.result, i]));
  assert.ok(byResult.skipped_app, 'app-mode install reported');
  assert.equal(result.installs.filter(i => i.result === 'updated').length, 2);
  assert.equal(version(w.claude), 'B');
  assert.equal(version(codex), 'B');
  assert.equal(version(app), 'A');
  assert.match(stderr, /앱 모드 설치본/);
  assert.equal(tmuxLog(w).match(/kill-session/g).length, 1, 'only the running claude pool restarts');
});

test('--no-restart swaps files only; a later run restarts the stale server', async () => {
  const w = await makeWorld();
  writeFileSync(join(w.home, '.config', 'teamclaude.server.json'), '{}'); // not running
  const env = ['--no-restart'];
  // Not running: the pool's own install is the one this CLI runs from, a git checkout → refused.
  const first = await update(w, env);
  assert.equal(first.result.error, 'not_an_install');
  await startServer(w, w.claude);
  assert.equal((await update(w, env)).result.installs[0].result, 'updated_no_restart');
  assert.equal(version(w.claude), 'B');
  const again = await update(w, []);
  assert.equal(again.status, 0);
  // Files already match, but the server still runs A (no source-hash header) → restart only.
  assert.equal(again.result.installs[0].result, 'updated');
  assert.equal(await liveVersion(w), 'B');
});
