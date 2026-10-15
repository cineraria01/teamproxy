// The installer's Windows path (no service, no wrapper, no npm: configs + manifest + run specs).
// On macOS/Linux TEAMPROXY_APP_PLATFORM=win32 runs the same branch; the Windows CI job runs it natively.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const INSTALL = join(ROOT, 'scripts', 'install-app.mjs');
let t;

const freePort = () => new Promise(done => {
  const server = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => done(port));
  });
});

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'teamproxy-app-win-'));
  const home = join(dir, 'home');
  const local = join(dir, 'local');
  mkdirSync(home);
  const ports = { claude: await freePort(), codex: await freePort(), agy: await freePort(), grok: await freePort() };
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('TEAMCLAUDE_') && !k.startsWith('TEAMPROXY_')));
  Object.assign(env, {
    HOME: home, USERPROFILE: home, LOCALAPPDATA: local, TEAMPROXY_APP_PLATFORM: 'win32',
    ...Object.fromEntries(Object.entries(ports).map(([p, n]) => [`TEAMPROXY_APP_PORT_${p.toUpperCase()}`, String(n)])),
  });
  t = { dir, home, local, root: join(local, 'Selvi', 'teamproxy'), ports, env, servers: [] };
});

afterEach(async () => {
  for (const child of t.servers) {
    child.kill();
    await once(child, 'exit').catch(() => {});
  }
  rmSync(t.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); // Windows: the worker may still be exiting
});

const run = (file, args, env = {}) => new Promise(done => {
  execFile(process.execPath, [file, ...args], { env: { ...t.env, ...env }, timeout: 30_000 }, (error, stdout, stderr) => {
    done({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
  });
});

async function app(args, expect = 0) {
  const r = await run(INSTALL, [...args, '--json']);
  assert.equal(r.code, expect, r.stdout + r.stderr);
  const lines = r.stdout.trim().split('\n').map(line => JSON.parse(line));
  return { steps: lines.slice(0, -1), done: lines.at(-1) };
}

const configOf = pool => join(t.home, '.config', `${{ claude: 'teamclaude', codex: 'teamcodex', agy: 'teamagy', grok: 'teamgrok' }[pool]}.json`);

test('--app on Windows writes configs and a manifest, registers nothing, and returns run specs', async () => {
  const { steps, done } = await app(['--app', '--node', process.execPath]);
  assert.equal(done.ok, true, JSON.stringify(done));
  for (const [pool, script, provider] of [['claude', 'teamclaude.js', null], ['codex', 'index.js', 'codex'], ['agy', 'index.js', 'agy'], ['grok', 'index.js', 'grok']]) {
    const p = done.pools[pool];
    const cli = [process.execPath, join(ROOT, 'src', script), ...(provider ? [provider] : [])];
    const env = { TEAMCLAUDE_CONFIG: configOf(pool), ...(provider && { TEAMCLAUDE_PROVIDER: provider }) };
    assert.deepEqual(p, {
      port: t.ports[pool], installed: true, running: false, config: 'created',
      run: { argv: [...cli, 'server'], env, log: join(t.root, 'logs', `${pool}.log`) },
      cli: { argv: cli, env },
    });
    const config = JSON.parse(readFileSync(configOf(pool), 'utf8'));
    assert.deepEqual([config.proxy.host, config.proxy.allowNoAccounts, config.proxy.port], ['127.0.0.1', true, t.ports[pool]]);
    assert.ok(config.proxy.apiKey);
  }
  const manifest = JSON.parse(readFileSync(join(t.root, 'manifest.json'), 'utf8'));
  assert.deepEqual([manifest.node, manifest.source, Object.keys(manifest.pools).sort()], [process.execPath, ROOT, ['agy', 'claude', 'codex', 'grok']]);
  assert.equal(existsSync(join(t.root, 'logs')), true);
  // no wrapper, no launchd, no npm copy
  assert.deepEqual(readdirSync(t.home), ['.config']);
  assert.deepEqual(readdirSync(t.root).sort(), ['logs', 'manifest.json']);
  assert.ok(steps.every(s => s.step && ['start', 'ok', 'skip', 'fail'].includes(s.status) && s.detail));
  assert.deepEqual(steps.filter(s => /^(npm|wrapper|launchd):/.test(s.step)), []);
  // rerun keeps the configs (and their keys) as they are
  const key = JSON.parse(readFileSync(configOf('agy'), 'utf8')).proxy.apiKey;
  assert.equal((await app(['--app', '--node', process.execPath])).done.ok, true);
  assert.equal(JSON.parse(readFileSync(configOf('agy'), 'utf8')).proxy.apiKey, key);
});

test('--prefix puts the root under <HOME>\\AppData\\Local, LOCALAPPDATA otherwise', async () => {
  const other = join(t.dir, 'other');
  const { done } = await app(['--app', '--pools', 'claude', '--node', process.execPath, '--prefix', other]);
  assert.equal(done.pools.claude.run.log, join(other, 'AppData', 'Local', 'Selvi', 'teamproxy', 'logs', 'claude.log'));
  assert.equal(done.pools.claude.run.env.TEAMCLAUDE_CONFIG, join(other, '.config', 'teamclaude.json'));
});

test('Windows refuses the Codex CLI install (stage 2) and a missing node', async () => {
  assert.equal((await app(['--app', '--node', process.execPath, '--with-codex-cli', '0.1.0'], 1)).done.error, 'unsupported_platform');
  assert.equal((await app(['--app', '--node', join(t.dir, 'nope', 'node.exe')], 1)).done.error, 'missing_node');
  assert.equal(existsSync(t.root), false);
});

test('a port another process holds is a conflict; our own pool is not', async () => {
  const busy = net.createServer();
  await new Promise(done => busy.listen(t.ports.agy, '127.0.0.1', done));
  try {
    const { done } = await app(['--app', '--node', process.execPath], 1);
    assert.equal(done.error, 'conflict_existing_install');
    assert.match(done.detail, /agy/);
    assert.equal(existsSync(join(t.root, 'manifest.json')), false);
    await app(['--app', '--pools', 'claude', '--node', process.execPath]);
  } finally {
    busy.close();
  }
});

test('--status, --login-command and --uninstall [--purge] work from the manifest', async () => {
  assert.equal((await app(['--status'])).done.installed, false);
  await app(['--app', '--pools', 'claude,agy', '--node', process.execPath]);
  const status = (await app(['--status'])).done;
  assert.equal(status.installed, true);
  assert.deepEqual([status.pools.claude.installed, status.pools.claude.running, status.pools.codex.installed], [true, false, false]);
  assert.equal(status.pools.agy.run.argv.at(-1), 'server');
  assert.equal(status.pools.codex.run, undefined);

  const login = (await app(['--login-command', 'agy'])).done;
  assert.deepEqual(login.argv, [process.execPath, join(ROOT, 'src', 'index.js'), 'agy', 'login', '--name', 'agy-1']);
  assert.deepEqual(login.env, { TEAMCLAUDE_CONFIG: configOf('agy'), TEAMCLAUDE_PROVIDER: 'agy' });

  const plain = (await app(['--uninstall'])).done;
  assert.deepEqual(plain.removed.sort(), ['agy', 'claude']);
  assert.equal(existsSync(join(t.root, 'manifest.json')), false);
  assert.equal(existsSync(configOf('claude')), true);
  rmSync(configOf('claude')); // a plain uninstall left it, so the next install would keep it as pre-existing
  rmSync(configOf('agy'));
  await app(['--app', '--pools', 'claude', '--node', process.execPath]);
  const purged = (await app(['--uninstall', '--purge'])).done;
  assert.deepEqual([purged.removed, purged.purged], [['claude'], true]);
  assert.equal(existsSync(configOf('claude')), false);
  assert.equal(existsSync(t.root), false);
});

test('a config that existed before the app is kept and survives --purge', async () => {
  mkdirSync(join(t.home, '.config'), { recursive: true });
  const mine = JSON.stringify({ proxy: { port: t.ports.claude, apiKey: 'tc-mine' }, accounts: [] });
  writeFileSync(configOf('claude'), mine);
  const { done } = await app(['--app', '--pools', 'claude', '--node', process.execPath]);
  assert.deepEqual([done.pools.claude.config, done.pools.claude.warning], ['existing_kept', 'host_unset']);
  await app(['--uninstall', '--purge']);
  assert.equal(readFileSync(configOf('claude'), 'utf8'), mine);
});

// End to end, as the app does it: install, start the server from run, change accounts with cli --json.
test('the run spec starts a server; accounts/sync and --json changes apply live', async () => {
  const pool = (await app(['--app', '--pools', 'claude', '--node', process.execPath])).done.pools.claude;
  const config = JSON.parse(readFileSync(configOf('claude'), 'utf8'));
  config.activeWarmup = false;
  config.upstream = 'http://127.0.0.1:9';
  writeFileSync(configOf('claude'), JSON.stringify(config));
  const [node, ...argv] = pool.run.argv;
  const child = spawn(node, argv, { env: { ...t.env, ...pool.run.env }, stdio: 'ignore' });
  t.servers.push(child);
  const base = `http://127.0.0.1:${pool.port}`;
  let up = false;
  for (let i = 0; i < 150 && !up; i += 1) {
    up = await fetch(`${base}/teamclaude/status`).then(r => r.ok, () => false);
    if (!up) await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(up, 'server did not start from the run spec');
  assert.equal((await app(['--status'])).done.pools.claude.running, true);

  config.accounts = [{ name: 'api-1', type: 'apikey', apiKey: 'sk-ant-test' }];
  writeFileSync(configOf('claude'), JSON.stringify(config));
  const sync = headers => fetch(`${base}/teamclaude/accounts/sync`, { method: 'POST', headers });
  assert.equal((await sync({ 'x-api-key': 'wrong' })).status, 401);
  const res = await sync({ 'x-api-key': config.proxy.apiKey });
  assert.deepEqual([res.status, await res.json()], [200, { ok: true, total: 1 }]);

  const cli = async args => {
    const [cliNode, ...cliArgv] = pool.cli.argv;
    assert.equal(cliNode, process.execPath);
    const r = await run(cliArgv[0], [...cliArgv.slice(1), ...args], pool.cli.env);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    return JSON.parse(r.stdout);
  };
  assert.deepEqual(await cli(['disable', 'api-1', '--json']), { ok: true, account: 'api-1', enabled: false, applied: 'live' });
  let status = await cli(['status', '--json']);
  for (let i = 0; i < 50 && status.accounts[0].usable; i += 1) { // a SIGHUP (macOS) sync is asynchronous
    await new Promise(r => setTimeout(r, 100));
    status = await cli(['status', '--json']);
  }
  assert.deepEqual([status.running, status.accounts[0].enabled, status.accounts[0].usable], [true, false, false]);
});
