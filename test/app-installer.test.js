import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, accessSync, constants,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const INSTALL = join(ROOT, 'scripts/install-app.mjs');
const BUILD = join(ROOT, 'scripts/build-app-bundle.mjs');

// Stands in for npm: a local folder is copied (never a git/network spec), @openai/codex@V gets a fake CLI.
const FAKE_NPM = `
const { cpSync, mkdirSync, statSync, writeFileSync, chmodSync, appendFileSync } = require('node:fs');
const { join } = require('node:path');
const a = process.argv.slice(2);
appendFileSync(process.env.FAKE_NPM_LOG, a.join(' ') + '\\n');
if (a[0] !== 'install' || a[1] !== '--global' || a[2] !== '--prefix' || !a.includes('--ignore-scripts')) throw new Error(a.join(' '));
const prefix = a[3];
const spec = a[a.length - 1];
if (spec.startsWith('@openai/codex@')) {
  if (process.env.FAKE_NPM_FAIL) process.exit(1);
  const dir = join(prefix, 'lib/node_modules/@openai/codex');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: spec.split('@')[2] }));
  mkdirSync(join(prefix, 'bin'), { recursive: true });
  writeFileSync(join(prefix, 'bin/codex'), '#!/bin/sh\\n');
  chmodSync(join(prefix, 'bin/codex'), 0o755);
} else {
  if (!statSync(spec).isDirectory()) throw new Error('not a folder: ' + spec);
  const target = join(prefix, 'lib/node_modules/teamcodex');
  cpSync(join(spec, 'src'), join(target, 'src'), { recursive: true });
  cpSync(join(spec, 'package.json'), join(target, 'package.json'));
}
`;

const FAKE_LAUNCHCTL = `#!/bin/sh
state=$FAKE_LAUNCHD; mkdir -p "$state"; echo "$*" >> "$state/calls.log"
case $1 in
  bootstrap) label=$(basename "$3" .plist); echo loaded > "$state/$label" ;;
  bootout) rm -f "$state/\${2##*/}" ;;
  print) [ -e "$state/\${2##*/}" ] ;;
esac
`;

let t;

const freePort = () => new Promise(done => {
  const server = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => done(port));
  });
});

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'teamproxy-app-test-'));
  const home = join(dir, 'home');
  const bin = join(dir, 'bin');
  const nodeRoot = join(dir, 'noderoot');
  mkdirSync(home);
  mkdirSync(bin);
  mkdirSync(join(nodeRoot, 'bin'), { recursive: true });
  mkdirSync(join(nodeRoot, 'lib/node_modules/npm/bin'), { recursive: true });
  symlinkSync(process.execPath, join(nodeRoot, 'bin/node'));
  writeFileSync(join(nodeRoot, 'lib/node_modules/npm/bin/npm-cli.js'), FAKE_NPM);
  writeFileSync(join(bin, 'launchctl'), FAKE_LAUNCHCTL);
  chmodSync(join(bin, 'launchctl'), 0o755);
  const ports = { claude: await freePort(), codex: await freePort(), agy: await freePort(), grok: await freePort() };
  t = {
    dir, home, ports, node: join(nodeRoot, 'bin/node'), launchd: join(dir, 'launchd'), npmLog: join(dir, 'npm.log'),
    env: {
      HOME: home, PATH: `${bin}:/usr/bin:/bin`, FAKE_LAUNCHD: join(dir, 'launchd'), FAKE_NPM_LOG: join(dir, 'npm.log'),
      TEAMPROXY_APP_HEALTH_WAIT: '0',
      ...Object.fromEntries(Object.entries(ports).map(([p, n]) => [`TEAMPROXY_APP_PORT_${p.toUpperCase()}`, String(n)])),
    },
  };
});

afterEach(() => rmSync(t.dir, { recursive: true, force: true }));

// Runs the installer and returns the JSON lines (progress) and the final line.
function app(args, { expect = 0, env = {}, node = true } = {}) {
  const nodeArgs = node && args[0] === '--app' ? ['--node', t.node] : [];
  const result = spawnSync(process.execPath, [INSTALL, ...args, ...nodeArgs, '--json'], { env: { ...t.env, ...env }, encoding: 'utf8' });
  assert.equal(result.status, expect, result.stdout + result.stderr);
  const lines = result.stdout.trim().split('\n').map(line => JSON.parse(line)); // one JSON object per line
  return { steps: lines.slice(0, -1), done: lines.at(-1) };
}

const labelOf = pool => `kr.selvi.teamproxy.${pool}`;
const calls = () => readFileSync(join(t.launchd, 'calls.log'), 'utf8');
const plistOf = pool => readFileSync(join(t.home, 'Library/LaunchAgents', `${labelOf(pool)}.plist`), 'utf8');
const untouched = () => {
  assert.equal(existsSync(join(t.home, '.local/share/teamproxy-app')), false);
  assert.equal(existsSync(join(t.home, 'Library/LaunchAgents', `${labelOf('codex')}.plist`)), false);
};

test('--app installs wrappers, config, launchd agents and nothing else', () => {
  const { steps, done } = app(['--app']);
  assert.equal(done.done && done.ok, true);
  assert.deepEqual(Object.keys(done.pools).sort(), ['agy', 'claude', 'codex', 'grok']);
  for (const [pool, cmd] of [['claude', 'teamclaude'], ['codex', 'teamcodex'], ['agy', 'teamagy'], ['grok', 'teamgrok']]) {
    assert.deepEqual(done.pools[pool], { port: t.ports[pool], label: labelOf(pool), installed: true, running: false, config: 'created' });
    const wrapper = join(t.home, '.local/bin', cmd);
    accessSync(wrapper, constants.X_OK);
    const text = readFileSync(wrapper, 'utf8');
    assert.match(text, /# teamproxy-app/);
    assert.ok(text.includes(`'${t.node}'`), 'wrapper uses the given node, not PATH');
    const config = JSON.parse(readFileSync(join(t.home, '.config', `${cmd}.json`), 'utf8'));
    assert.equal(config.proxy.host, '127.0.0.1');
    assert.equal(config.proxy.allowNoAccounts, true);
    assert.equal(config.proxy.port, t.ports[pool]);
    assert.ok(config.proxy.apiKey);
    assert.equal(config.provider, pool === 'claude' ? 'anthropic' : pool);
    const plist = plistOf(pool);
    assert.ok(plist.includes(`<string>${wrapper}</string>\n    <string>server</string>`));
    assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
    assert.match(plist, /<key>ProcessType<\/key>\s*<string>Standard<\/string>/);
    assert.ok(plist.includes(join(t.home, 'Library/Logs/teamproxy', `${pool}.log`)));
    assert.ok(plist.includes(`${join(t.dir, 'noderoot/bin')}:`), 'launchd PATH starts with the node folder');
    assert.equal(existsSync(join(t.launchd, labelOf(pool))), true);
  }
  assert.ok(steps.every(s => s.step && ['start', 'ok', 'skip', 'fail'].includes(s.status) && s.detail));
  for (const name of ['.zshrc', '.bashrc', '.claude']) assert.equal(existsSync(join(t.home, name)), false, name);
  assert.doesNotMatch(readFileSync(t.npmLog, 'utf8'), /git\+|https?:/);
});

test('--pools limits the install', () => {
  const { done } = app(['--app', '--pools', 'codex']);
  assert.deepEqual(Object.keys(done.pools), ['codex']);
  assert.equal(existsSync(join(t.home, '.local/bin/teamclaude')), false);
});

test('rerun is idempotent; an older recorded version is reinstalled and restarted', () => {
  app(['--app']);
  const boots = calls().split('bootstrap').length;
  const again = app(['--app']);
  const acted = again.steps.filter(s => /^(npm|wrapper|config|launchd):/.test(s.step));
  assert.ok(acted.length >= 12);
  assert.deepEqual([...new Set(acted.map(s => s.status))], ['skip']);
  assert.equal(calls().split('bootstrap').length, boots);

  const manifest = join(t.home, '.local/share/teamproxy-app/manifest.json');
  const data = JSON.parse(readFileSync(manifest, 'utf8'));
  data.pools.codex.version = '0.0.1';
  writeFileSync(manifest, JSON.stringify(data));
  const update = Object.fromEntries(app(['--app']).steps.filter(s => s.status !== 'start').map(s => [s.step, s.status]));
  assert.deepEqual([update['npm:codex'], update['launchd:codex'], update['npm:claude']], ['ok', 'ok', 'skip']);
});

test('rerun repairs a Background agent without reinstalling the package', () => {
  app(['--app', '--pools', 'claude']);
  const path = join(t.home, 'Library/LaunchAgents', `${labelOf('claude')}.plist`);
  writeFileSync(path, plistOf('claude').replace('<string>Standard</string>', '<string>Background</string>'));
  const boots = calls().split('bootstrap').length;

  const { steps, done } = app(['--app', '--pools', 'claude']);
  assert.equal(done.ok, true);
  assert.equal(steps.find(s => s.step === 'npm:claude' && s.status !== 'start').status, 'skip');
  assert.equal(steps.find(s => s.step === 'launchd:claude' && s.status !== 'start').status, 'ok');
  assert.match(plistOf('claude'), /<key>ProcessType<\/key>\s*<string>Standard<\/string>/);
  assert.equal(calls().split('bootstrap').length, boots + 1);
});

test('a launch agent from someone else running the same command is a conflict', () => {
  const agents = join(t.home, 'Library/LaunchAgents');
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, 'com.example.teamcodex.plist'), '<plist><string>/x/.local/bin/teamcodex</string></plist>');
  const { steps, done } = app(['--app'], { expect: 1 });
  assert.deepEqual([done.ok, done.error], [false, 'conflict_existing_install']);
  assert.equal(steps.at(-1).status, 'fail');
  untouched();
});

test('a wrapper that is not ours is a conflict and stays as it was', () => {
  const wrapper = join(t.home, '.local/bin/teamclaude');
  mkdirSync(join(t.home, '.local/bin'), { recursive: true });
  writeFileSync(wrapper, '#!/bin/sh\necho mine\n');
  const { done } = app(['--app', '--pools', 'claude'], { expect: 1 });
  assert.equal(done.error, 'conflict_existing_install');
  assert.equal(readFileSync(wrapper, 'utf8'), '#!/bin/sh\necho mine\n');
  untouched();
});

test('a port used by another process is a conflict', async () => {
  const busy = net.createServer();
  await new Promise(done => busy.listen(t.ports.agy, '127.0.0.1', done));
  try {
    // spawnSync would block the event loop that serves the socket, so run it asynchronously.
    const child = await import('node:child_process');
    const output = await new Promise(done => {
      child.execFile(process.execPath, [INSTALL, '--app', '--node', t.node, '--json'], { env: t.env }, (error, stdout) => done({ code: error?.code ?? 0, stdout }));
    });
    const done = JSON.parse(output.stdout.trim().split('\n').at(-1));
    assert.equal(output.code, 1);
    assert.equal(done.error, 'conflict_existing_install');
    assert.match(done.detail, /agy/);
    untouched();
  } finally {
    busy.close();
  }
});

test('missing node or npm reports missing_node', () => {
  const { done } = app(['--app', '--node', join(t.dir, 'nowhere/bin/node'), '--pools', 'codex'], { expect: 1, node: false });
  assert.equal(done.error, 'missing_node');
  // a node with no npm beside it (a real file, so there is no symlink target to fall back on)
  rmSync(join(t.dir, 'noderoot/lib'), { recursive: true });
  rmSync(t.node);
  writeFileSync(t.node, '#!/bin/sh\n');
  assert.equal(app(['--app'], { expect: 1 }).done.error, 'missing_node');
  untouched();
});

test('--with-codex-cli installs the pinned CLI and the codex wrapper uses it', () => {
  const { steps, done } = app(['--app', '--pools', 'codex', '--with-codex-cli', '0.130.0']);
  assert.equal(done.ok, true);
  const bin = join(t.home, '.local/share/teamproxy-app/codex-cli/bin/codex');
  assert.equal(existsSync(bin), true);
  assert.ok(readFileSync(join(t.home, '.local/bin/teamcodex'), 'utf8').includes(`[ -n "$TEAMCODEX_CODEX_BIN" ] || TEAMCODEX_CODEX_BIN='${bin}'`));
  assert.match(readFileSync(t.npmLog, 'utf8'), /@openai\/codex@0\.130\.0/);
  assert.equal(steps.find(s => s.step === 'codex-cli' && s.status !== 'start').status, 'ok');
  assert.equal(app(['--app', '--pools', 'codex', '--with-codex-cli', '0.130.0']).steps.find(s => s.step === 'codex-cli').status, 'skip');
  const failed = app(['--app', '--pools', 'codex', '--with-codex-cli', '9.9.9'], { expect: 1, env: { FAKE_NPM_FAIL: '1' } });
  assert.equal(failed.done.error, 'npm_failed');
});

test('--status reports install and load', () => {
  assert.equal(app(['--status']).done.installed, false);
  app(['--app']);
  const { done } = app(['--status']);
  assert.equal(done.installed, true);
  const { installed, loaded, running, usable } = done.pools.codex;
  assert.deepEqual({ installed, loaded, running, usable }, { installed: true, loaded: true, running: false, usable: 0 });
});

test('--uninstall keeps the config, --purge removes it, and foreign files stay', () => {
  app(['--app']);
  const config = join(t.home, '.config/teamcodex.json');
  const { done } = app(['--uninstall']);
  assert.deepEqual([done.ok, done.removed.sort()], [true, ['agy', 'claude', 'codex', 'grok']]);
  assert.equal(existsSync(join(t.home, '.local/bin/teamcodex')), false);
  assert.equal(existsSync(join(t.home, 'Library/LaunchAgents', `${labelOf('codex')}.plist`)), false);
  assert.equal(existsSync(join(t.launchd, labelOf('codex'))), false);
  assert.equal(existsSync(join(t.home, '.local/share/teamproxy-app')), false);
  assert.equal(existsSync(config), true);
  rmSync(config); // a plain uninstall leaves the config, and a later install then treats it as pre-existing (kept)
  app(['--app']);
  app(['--uninstall', '--purge']);
  assert.equal(existsSync(config), false);

  const mine = join(t.home, '.local/bin/teamcodex');
  writeFileSync(mine, '#!/bin/sh\n');
  assert.deepEqual(app(['--uninstall', '--purge']).done.removed, []);
  assert.equal(existsSync(mine), true);
});

test('--login-command gives the first free <pool>-N, never a name already in use', () => {
  assert.equal(app(['--login-command', 'codex']).done.account, 'codex-1');
  mkdirSync(join(t.home, '.config'), { recursive: true });
  const config = join(t.home, '.config/teamcodex.json');
  writeFileSync(config, JSON.stringify({ accounts: [{ name: 'codex-2' }] }));
  const { done } = app(['--login-command', 'codex']);
  assert.deepEqual(done.argv, [join(t.home, '.local/bin/teamcodex'), 'login', '--name', 'codex-1']);
  writeFileSync(config, JSON.stringify({ accounts: [{ name: 'codex-1' }, { name: 'x' }, { name: 'codex-3' }] }));
  assert.equal(app(['--login-command', 'codex']).done.account, 'codex-2');
  const bad = app(['--login-command', 'constructor'], { expect: 2 });
  assert.equal(bad.done.ok, false);
});

test('paths with quotes, $(), backticks and spaces are inert in the wrapper', () => {
  const evil = join(t.dir, 'a"b$(touch INJECTED)`touch INJECTED2` c');
  mkdirSync(join(evil, 'bin'), { recursive: true });
  symlinkSync(join(t.dir, 'noderoot/lib'), join(evil, 'lib'));
  symlinkSync(process.execPath, join(evil, 'bin/node'));
  const { done } = app(['--app', '--pools', 'claude', '--node', join(evil, 'bin/node')], { node: false });
  assert.equal(done.ok, true);
  const wrapper = join(t.home, '.local/bin/teamclaude');
  assert.equal(spawnSync('sh', ['-n', wrapper]).status, 0);
  const run = spawnSync(wrapper, ['--help'], { env: t.env, encoding: 'utf8', cwd: t.dir });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(existsSync(join(t.dir, 'INJECTED')) || existsSync(join(t.dir, 'INJECTED2')), false);
});

test('a config that existed before the app is kept untouched and survives --purge', () => {
  mkdirSync(join(t.home, '.config'), { recursive: true });
  const config = join(t.home, '.config/teamcodex.json');
  const mine = JSON.stringify({ proxy: { port: t.ports.codex, apiKey: 'tc-mine' }, accounts: [] });
  writeFileSync(config, mine);
  const { steps, done } = app(['--app', '--pools', 'codex']);
  assert.equal(done.pools.codex.config, 'existing_kept');
  assert.equal(steps.find(s => s.step === 'config:codex').config, 'existing_kept');
  assert.equal(readFileSync(config, 'utf8'), mine);
  app(['--app', '--pools', 'codex']);
  assert.equal(readFileSync(config, 'utf8'), mine);
  app(['--uninstall', '--purge']);
  assert.equal(readFileSync(config, 'utf8'), mine);
});

test('the wrapper runs the pool entry with its own config', () => {
  app(['--app', '--pools', 'agy']);
  const text = readFileSync(join(t.home, '.local/bin/teamagy'), 'utf8');
  assert.match(text, /TEAMCLAUDE_PROVIDER=agy/);
  assert.match(text, /TEAMCLAUDE_CONFIG="\$HOME\/\.config\/teamagy\.json"/);
  assert.match(text, /src\/index\.js' agy "\$@"/);
});

test('the grok pool: teamgrok wrapper, port, launchd label, and its login command', () => {
  const { done } = app(['--app', '--pools', 'grok']);
  assert.deepEqual(done.pools.grok, { port: t.ports.grok, label: labelOf('grok'), installed: true, running: false, config: 'created' });
  const text = readFileSync(join(t.home, '.local/bin/teamgrok'), 'utf8');
  assert.match(text, /-u TEAMCLAUDE_SESSION_SUPERVISED TEAMCLAUDE_PROVIDER=grok/);
  assert.match(text, /TEAMCLAUDE_CONFIG="\$HOME\/\.config\/teamgrok\.json"/);
  assert.match(text, /src\/index\.js' grok "\$@"/);
  const config = JSON.parse(readFileSync(join(t.home, '.config/teamgrok.json'), 'utf8'));
  assert.equal(config.provider, 'grok');
  assert.equal(config.upstream, 'https://cli-chat-proxy.grok.com');
  assert.ok(plistOf('grok').includes(`<string>${join(t.home, '.local/bin/teamgrok')}</string>\n    <string>server</string>`));
  const login = app(['--login-command', 'grok']).done;
  assert.deepEqual(login, { done: true, ok: true, pool: 'grok', account: 'grok-1', argv: [join(t.home, '.local/bin/teamgrok'), 'login', '--name', 'grok-1'] });
});

test('the bundle builder is deterministic', () => {
  const sums = ['one', 'two'].map(name => {
    const result = spawnSync(process.execPath, [BUILD, join(t.dir, name)], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.split(/\s+/)[0];
  });
  assert.equal(sums[0], sums[1]);
  assert.match(sums[0], /^[0-9a-f]{64}$/);
});

test('the bundle holds no dot-path entries (.omc, .DS_Store) even when such files sit in src/', () => {
  const stray = join(ROOT, 'src/.DS_Store-test');
  writeFileSync(stray, 'x');
  try {
    const result = spawnSync(process.execPath, [BUILD, join(t.dir, 'dots')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const names = spawnSync('tar', ['tzf', join(t.dir, 'dots/teamproxy-app-' + JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version + '.tar.gz')], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
    assert.ok(names.length > 20);
    assert.deepEqual(names.filter(n => n.split('/').some(part => part.startsWith('.'))), []);
  } finally {
    rmSync(stray, { force: true });
  }
  const tracked = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n');
  assert.deepEqual(tracked.filter(n => n.split('/').some(part => part === '.omc')), []);
});

test('a pre-existing config without proxy.host is kept and flagged host_unset', () => {
  mkdirSync(join(t.home, '.config'), { recursive: true });
  writeFileSync(join(t.home, '.config/teamcodex.json'), JSON.stringify({ proxy: { port: t.ports.codex, apiKey: 'k' }, accounts: [] }));
  const { done } = app(['--app', '--pools', 'codex']);
  assert.equal(done.pools.codex.warning, 'host_unset');
  assert.equal(app(['--app', '--pools', 'claude']).done.pools.claude.warning, undefined);
});
