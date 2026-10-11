#!/usr/bin/env node
// App-mode installer: non-interactive, user-level, JSON-lines output (docs/install/APP-INSTALL.md).
// Needs only Node (the one that runs it, or --node). No Python, tmux, git, sudo or network
// (except `--with-codex-cli`, which asks npm for the pinned Codex CLI). Never touches shell rc files or ~/.claude.
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, rmdirSync, writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LABEL_PREFIX = 'kr.selvi.teamproxy.';
const MARKER = '# teamproxy-app';
// pool -> command name, default port, config file, node entry (script + leading args), extra env
const POOLS = {
  claude: { cmd: 'teamclaude', port: 3456, config: 'teamclaude.json', entry: ['src/teamclaude.js'], env: '' },
  codex: { cmd: 'teamcodex', port: 3457, config: 'teamcodex.json', entry: ['src/index.js', 'codex'], env: 'TEAMCLAUDE_PROVIDER=codex ' },
  agy: {
    cmd: 'teamagy', port: 3458, config: 'teamagy.json', entry: ['src/index.js', 'agy'],
    env: '-u TEAMCLAUDE_SESSION_SUPERVISED TEAMCLAUDE_PROVIDER=agy ',
  },
};

class Fail extends Error {
  constructor(code, detail) {
    super(detail);
    this.code = code;
  }
}

const emit = fields => process.stdout.write(`${JSON.stringify(fields)}\n`);
const step = (name, status, detail) => emit({ step: name, status, detail });
const shq = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const sleep = ms => new Promise(done => setTimeout(done, ms));

function layoutFor(home) {
  const root = join(home, '.local/share/teamproxy-app');
  return {
    home,
    root,
    manifest: join(root, 'manifest.json'),
    codexCli: join(root, 'codex-cli'),
    agents: join(home, 'Library/LaunchAgents'),
    logs: join(home, 'Library/Logs/teamproxy'),
    bin: join(home, '.local/bin'),
    label: pool => LABEL_PREFIX + pool,
    plist: pool => join(home, 'Library/LaunchAgents', `${LABEL_PREFIX}${pool}.plist`),
    wrapper: pool => join(home, '.local/bin', POOLS[pool].cmd),
    prefix: pool => join(root, pool),
    config: pool => join(home, '.config', POOLS[pool].config),
    pkg: pool => join(root, pool, 'lib/node_modules/teamcodex'),
  };
}

const readJson = (path, fallback) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
};
const readText = path => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};
const readManifest = L => readJson(L.manifest, { version: null, pools: {}, codexCli: null });
const writeFile = (path, data, mode) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data, { mode });
  chmodSync(path, mode);
};

const sourceVersion = () => readJson(join(SOURCE, 'package.json'), {}).version;
const envPort = pool => process.env[`TEAMPROXY_APP_PORT_${pool.toUpperCase()}`];
const defaultPort = pool => Number(envPort(pool) || POOLS[pool].port);
const poolPort = (L, pool) => Number(readJson(L.config(pool), {})?.proxy?.port) || defaultPort(pool);

function portOpen(port) {
  return new Promise(done => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.setTimeout(500);
    socket.once('connect', () => { socket.destroy(); done(true); });
    socket.once('timeout', () => { socket.destroy(); done(false); });
    socket.once('error', () => done(false));
  });
}

async function fetchStatus(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/teamclaude/status`, { signal: AbortSignal.timeout(2000) });
    return await response.json();
  } catch {
    return null; // no usable answer
  }
}

const launchctl = (...args) => spawnSync('launchctl', args, { encoding: 'utf8' });
const domain = () => `gui/${process.getuid()}`;
const isLoaded = (L, pool) => launchctl('print', `${domain()}/${L.label(pool)}`).status === 0;
const isOurs = (L, pool) => pool in readManifest(L).pools && existsSync(L.plist(pool));

function wrapperText(L, pool, node, codexBin) {
  const { cmd, config, entry, env } = POOLS[pool];
  const [script, ...rest] = entry;
  // LC_ALL=C: the server (launchd) and the CLI must print process start times alike, or live reload refuses (lifecycle identity unverified).
  // Codex login needs the Codex CLI; use the app-installed one when there is one.
  // Paths are single-quoted (shq) and joined to the double-quoted $-expansions, so a quote, $, backtick or space in a path is inert.
  const codex = pool === 'codex' && codexBin
    ? `[ -n "$TEAMCODEX_CODEX_BIN" ] || TEAMCODEX_CODEX_BIN=${shq(codexBin)}\nexport TEAMCODEX_CODEX_BIN\n` : '';
  const path = `${shq(dirname(node))}":$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"`;
  return `#!/bin/sh\n${MARKER} (${cmd}, pool ${pool}); removed by install-app.mjs --uninstall\n`
    + `PATH=${path}\n${codex}`
    + `exec env ${env}LC_ALL=C TEAMCLAUDE_CONFIG="$HOME/.config/${config}" `
    + `${[shq(node), shq(join(L.pkg(pool), script)), ...rest].join(' ')} "$@"\n`;
}

function plistText(L, pool, node) {
  const log = join(L.logs, `${pool}.log`);
  const path = `${dirname(node)}:${L.bin}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
  const pair = (key, value, pad) => `${pad}<key>${xml(key)}</key>\n${pad}<string>${xml(value)}</string>\n`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${pair('Label', L.label(pool), '  ')}  <key>ProgramArguments</key>
  <array>
    <string>${xml(L.wrapper(pool))}</string>
    <string>server</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>EnvironmentVariables</key>
  <dict>
${pair('HOME', L.home, '    ')}${pair('PATH', path, '    ')}  </dict>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

function foreignAgent(L, pool) {
  if (!existsSync(L.agents)) return null;
  for (const name of readdirSync(L.agents).sort()) {
    if (!name.endsWith('.plist') || name.startsWith(LABEL_PREFIX)) continue;
    if ((readText(join(L.agents, name)) ?? '').includes(POOLS[pool].cmd)) return name;
  }
  return null;
}

async function checkConflicts(L, pools) {
  for (const pool of pools) {
    if (isOurs(L, pool)) continue;
    const { cmd } = POOLS[pool];
    const port = poolPort(L, pool);
    const wrapper = readText(L.wrapper(pool));
    let reason = null;
    if (wrapper !== null && !wrapper.includes(MARKER)) reason = `기존 ${cmd} 명령이 있습니다`;
    else if (foreignAgent(L, pool)) reason = `다른 launchd 에이전트(${foreignAgent(L, pool)})가 ${cmd}을 씁니다`;
    else if (await portOpen(port)) reason = `포트 ${port}를 다른 프로세스가 쓰고 있습니다`;
    if (reason) throw new Fail('conflict_existing_install', `${pool}: ${reason}. 덮어쓰지 않고 멈춥니다.`);
  }
}

function npmInstall(node, npmCli, prefix, spec, extra = []) {
  const result = spawnSync(node, [npmCli, 'install', '--global', '--prefix', prefix, '--ignore-scripts', ...extra, spec],
    { encoding: 'utf8' });
  return { ok: result.status === 0, tail: `${result.stderr ?? ''}${result.error ?? ''}`.trim().slice(-200) };
}

async function installCodexCli(L, version, node, npmCli, manifest) {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version)) throw new Fail('npm_failed', `Codex CLI 버전 형식이 올바르지 않습니다: ${version}`);
  const pkg = join(L.codexCli, 'lib/node_modules/@openai/codex/package.json');
  if (readJson(pkg, {}).version === version && manifest.codexCli === version) {
    step('codex-cli', 'skip', `Codex CLI ${version}은 이미 설치돼 있습니다`);
    return;
  }
  step('codex-cli', 'start', `Codex CLI ${version} 설치 중`);
  rmSync(L.codexCli, { recursive: true, force: true });
  const result = npmInstall(node, npmCli, L.codexCli, `@openai/codex@${version}`);
  if (!result.ok || !existsSync(join(L.codexCli, 'bin/codex'))) throw new Fail('npm_failed', `Codex CLI 설치에 실패했습니다 (${result.tail})`);
  manifest.codexCli = version;
  step('codex-cli', 'ok', `Codex CLI ${version} 설치 완료`);
}

async function installPool(L, pool, version, node, npmCli, manifest) {
  const { cmd, config: configName } = POOLS[pool];
  let changed = false;
  const entry = join(L.pkg(pool), 'src/index.js');
  if (manifest.pools[pool]?.version === version && existsSync(entry)) {
    step(`npm:${pool}`, 'skip', `${cmd} ${version}은 이미 설치돼 있습니다`);
  } else {
    step(`npm:${pool}`, 'start', `${cmd} ${version} 설치 중`);
    rmSync(L.prefix(pool), { recursive: true, force: true });
    const result = npmInstall(node, npmCli, L.prefix(pool), SOURCE, ['--install-links']);
    if (!result.ok || !existsSync(entry)) throw new Fail('npm_failed', `${pool}: npm 설치에 실패했습니다 (${result.tail})`);
    step(`npm:${pool}`, 'ok', `${cmd} ${version} 설치 완료`);
    changed = true;
  }

  const codexBin = join(L.codexCli, 'bin/codex');
  const wrapper = L.wrapper(pool);
  const text = wrapperText(L, pool, node, existsSync(codexBin) ? codexBin : null);
  if (readText(wrapper) === text) {
    step(`wrapper:${pool}`, 'skip', `${cmd} 명령이 최신입니다`);
  } else {
    writeFile(wrapper, text, 0o755);
    step(`wrapper:${pool}`, 'ok', `${cmd} 명령을 만들었습니다`);
  }

  const configPath = L.config(pool);
  const existing = readJson(configPath, null);
  const previous = manifest.pools[pool];
  // 'created' = the app wrote this file (it may fill in newer keys and --purge may delete it);
  // 'existing_kept' = it was there before the app, so it is never modified or purged.
  let origin = previous ? previous.config ?? 'created' : 'existing_kept';
  if (existing && origin === 'created') {
    // host pins loopback; allowNoAccounts keeps the server up (and launchd quiet) until the first login.
    const added = ['host', 'allowNoAccounts'].filter(key => existing.proxy?.[key] === undefined);
    if (!added.length) {
      step(`config:${pool}`, 'skip', `${configName}이 이미 있습니다`);
    } else {
      existing.proxy = { allowNoAccounts: true, host: '127.0.0.1', ...existing.proxy };
      writeFile(configPath, `${JSON.stringify(existing, null, 2)}\n`, 0o600);
      step(`config:${pool}`, 'ok', `${configName}에 proxy.${added.join('·proxy.')}를 더했습니다`);
    }
  } else if (existing) {
    origin = 'existing_kept';
    emit({ step: `config:${pool}`, status: 'skip', detail: `${configName}은 앱 설치 전부터 있어 바꾸지 않았습니다`, config: 'existing_kept' });
  } else {
    origin = 'created';
    // createDefaultConfig keys its provider (and port) on the env at call time.
    const { createDefaultConfig } = await import(pathToFileURL(join(SOURCE, 'src/config.js')).href);
    if (pool === 'claude') delete process.env.TEAMCLAUDE_PROVIDER; else process.env.TEAMCLAUDE_PROVIDER = pool;
    const config = createDefaultConfig();
    config.proxy.host = '127.0.0.1';
    config.proxy.allowNoAccounts = true;
    if (envPort(pool)) config.proxy.port = Number(envPort(pool));
    writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 0o600);
    step(`config:${pool}`, 'ok', `${configName}을 만들었습니다`);
  }

  const plist = L.plist(pool);
  const want = plistText(L, pool, node);
  mkdirSync(L.logs, { recursive: true });
  if (!changed && readText(plist) === want && isLoaded(L, pool)) {
    step(`launchd:${pool}`, 'skip', `${L.label(pool)}가 이미 실행 중입니다`);
  } else {
    launchctl('bootout', `${domain()}/${L.label(pool)}`);
    for (let i = 0; i < 20 && isLoaded(L, pool); i += 1) await sleep(100); // bootout is asynchronous
    writeFile(plist, want, 0o600);
    let result = launchctl('bootstrap', domain(), plist);
    for (let i = 0; i < 5 && result.status !== 0; i += 1) {
      await sleep(300);
      result = launchctl('bootstrap', domain(), plist);
    }
    if (result.status !== 0) throw new Fail('launchd_failed', `${pool}: launchd 등록에 실패했습니다 (${(result.stderr ?? '').trim().slice(-200)})`);
    step(`launchd:${pool}`, 'ok', `${L.label(pool)}를 등록했습니다`);
  }
  manifest.pools[pool] = { version, config: origin };
  writeFile(L.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 0o644);
}

async function waitRunning(port) {
  const deadline = Date.now() + Number(process.env.TEAMPROXY_APP_HEALTH_WAIT ?? 15) * 1000;
  do {
    if (await fetchStatus(port)) return true;
    await sleep(500);
  } while (Date.now() < deadline);
  return false;
}

const poolReport = (L, pool, installed) => ({ port: poolPort(L, pool), label: L.label(pool), installed });

async function runInstall(L, pools, nodeArg, codexCliVersion) {
  const version = sourceVersion();
  const done = { done: true, ok: false, version, pools: Object.fromEntries(pools.map(p => [p, poolReport(L, p, false)])) };
  try {
    step('preflight', 'start', '필수 프로그램을 확인합니다');
    const node = nodeArg ?? process.execPath;
    if (!isAbsolute(node) || !existsSync(node)) throw new Fail('missing_node', `node를 찾을 수 없습니다: ${node}`);
    // npm ships beside node (<root>/bin/node, <root>/lib/node_modules/npm); follow a symlinked node if needed.
    const npmCli = [node, realpathSync(node)].map(n => join(dirname(dirname(n)), 'lib/node_modules/npm/bin/npm-cli.js'))
      .find(existsSync);
    if (!npmCli) throw new Fail('missing_node', `이 node와 함께 있는 npm이 없습니다: ${node}`);
    if (launchctl('help').error) throw new Fail('launchd_failed', 'launchctl이 없습니다. macOS에서만 설치할 수 있습니다');
    step('preflight', 'ok', 'node, npm, launchctl을 찾았습니다');
    step('conflicts', 'start', '기존 설치와 포트를 확인합니다');
    await checkConflicts(L, pools);
    step('conflicts', 'ok', '충돌이 없습니다');
    const manifest = readManifest(L);
    if (codexCliVersion) await installCodexCli(L, codexCliVersion, node, npmCli, manifest);
    for (const pool of pools) await installPool(L, pool, version, node, npmCli, manifest);
    manifest.version = version;
    writeFile(L.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 0o644);
    for (const pool of pools) {
      const running = await waitRunning(poolPort(L, pool));
      done.pools[pool] = { ...poolReport(L, pool, true), running, config: manifest.pools[pool].config };
      // A pre-existing config is never edited, so without proxy.host the server listens on all interfaces.
      if (done.pools[pool].config === 'existing_kept' && !readJson(L.config(pool), {})?.proxy?.host) done.pools[pool].warning = 'host_unset';
      step(`health:${pool}`, running ? 'ok' : 'skip',
        running ? '서버가 응답합니다' : '서버가 아직 응답하지 않습니다(계정이 없으면 정상, 로그: Library/Logs/teamproxy)');
    }
    done.ok = true;
  } catch (error) {
    const code = error instanceof Fail ? error.code : 'install_failed';
    step('error', 'fail', error.message);
    Object.assign(done, { error: code, detail: error.message });
  }
  emit(done);
  return done.ok ? 0 : 1;
}

async function runStatus(L) {
  const manifest = readManifest(L);
  const pools = {};
  for (const pool of Object.keys(POOLS)) {
    const installed = isOurs(L, pool);
    const info = {
      port: poolPort(L, pool), label: L.label(pool), installed, loaded: installed && isLoaded(L, pool),
      running: false, accounts: (readJson(L.config(pool), {}).accounts ?? []).length, usable: 0,
    };
    const reply = installed ? await fetchStatus(info.port) : null;
    if (reply) Object.assign(info, { running: true, usable: Number(reply.usableCount ?? 0) });
    pools[pool] = info;
  }
  emit({ done: true, ok: true, installed: Object.values(pools).some(p => p.installed), version: manifest.version, pools });
  return 0;
}

function runUninstall(L, purge) {
  const manifest = readManifest(L);
  const removed = [];
  for (const pool of Object.keys(manifest.pools)) {
    launchctl('bootout', `${domain()}/${L.label(pool)}`);
    rmSync(L.plist(pool), { force: true });
    if ((readText(L.wrapper(pool)) ?? '').includes(MARKER)) rmSync(L.wrapper(pool), { force: true });
    rmSync(L.prefix(pool), { recursive: true, force: true });
    if (purge && (manifest.pools[pool].config ?? 'created') === 'created') { // never a config the app did not write
      const config = L.config(pool).replace(/\.json$/, '');
      for (const suffix of ['.json', '.server.json', '.quota.json']) rmSync(config + suffix, { force: true });
    }
    removed.push(pool);
    step(`uninstall:${pool}`, 'ok', `${POOLS[pool].cmd}을 지웠습니다${purge ? ' (설정 포함)' : ''}`);
  }
  rmSync(L.codexCli, { recursive: true, force: true });
  rmSync(L.manifest, { force: true });
  if (purge) rmSync(L.logs, { recursive: true, force: true });
  try { rmdirSync(L.root); } catch { /* not empty or already gone */ }
  emit({ done: true, ok: true, removed, purged: purge });
  return 0;
}

function runLoginCommand(L, pool) {
  if (!Object.hasOwn(POOLS, pool)) throw new Fail('usage', 'Usage: --login-command claude|codex|agy --json');
  const taken = new Set((readJson(L.config(pool), {}).accounts ?? []).map(a => a.name));
  let n = 1;
  while (taken.has(`${pool}-${n}`)) n += 1; // first free number: a name in use would overwrite that account
  const account = `${pool}-${n}`;
  emit({ done: true, ok: true, pool, account, argv: [L.wrapper(pool), 'login', '--name', account] });
  return 0;
}

function parseArgs(argv) {
  const flags = new Map();
  const bare = new Set(['--json', '--app', '--status', '--uninstall', '--purge']);
  for (let i = 0; i < argv.length; i += 1) {
    flags.set(argv[i], bare.has(argv[i]) ? true : argv[++i]);
  }
  return flags;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (!flags.has('--json')) throw new Fail('usage', 'App mode needs --json.');
  const L = layoutFor(flags.has('--prefix') ? resolve(flags.get('--prefix')) : homedir());
  if (flags.has('--status')) return runStatus(L);
  if (flags.has('--uninstall')) return runUninstall(L, flags.has('--purge'));
  if (flags.has('--login-command')) return runLoginCommand(L, flags.get('--login-command'));
  if (flags.has('--app')) {
    const pools = flags.has('--pools') ? flags.get('--pools').split(',').map(p => p.trim()).filter(Boolean) : Object.keys(POOLS);
    if (!pools.length || pools.some(p => !Object.hasOwn(POOLS, p))) throw new Fail('usage', 'Usage: --pools claude,codex,agy');
    return runInstall(L, pools, flags.get('--node'), flags.get('--with-codex-cli'));
  }
  throw new Fail('usage', 'Usage: install-app.mjs --app|--status|--uninstall [--purge]|--login-command POOL --json '
    + '[--pools claude,codex,agy] [--node ABS_PATH] [--with-codex-cli VERSION] [--prefix HOME]');
}

try {
  process.exitCode = await main();
} catch (error) {
  emit({ done: true, ok: false, error: error instanceof Fail ? error.code : 'install_failed', detail: error.message });
  process.exitCode = 2;
}
