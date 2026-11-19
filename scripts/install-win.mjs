#!/usr/bin/env node
// Windows installer for the teamproxy pools (docs/install/INSTALL-WINDOWS.md). Run it with the Node that will run
// the pools, from the git clone that becomes the install (recommended %USERPROFILE%\src\teamproxy; `<pool> update`
// pulls that clone):
//   node scripts\install-win.mjs [--pools claude,codex,agy,grok,cursor|all] [--remote <URL> [--token-file <path>]
//                                [--no-check]] [--no-start] [--dry-run]
// Per pool: the wrapper %USERPROFILE%\.local\bin\team<pool>.cmd, the server %LOCALAPPDATA%\teamproxy\
// team<pool>-server.cmd (log logs\team<pool>.log) started without a window by team<pool>-server.vbs from the
// scheduled task team<pool> (at logon, restart on failure), and the config when missing (proxy.host 127.0.0.1).
// A hand install with the same names is taken over: a file that differs is kept as <file>.bak-install-<stamp>,
// a task as team<pool>.task.bak-install-<stamp>.xml. Existing configs (accounts) are never modified.
// Windows only (2026-11-18 user: "맥이랑 윈도우 코드 섞이면 안된다"): macOS/Linux use scripts/install.py and INSTALL-ALL.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = file => import(pathToFileURL(join(ROOT, 'src', file)).href);
const { POOLS, decodeSchtasksOutput, schtasks, taskExists } = await src('win32.js');
// Same default bundle as INSTALL-ALL (§1 teamcodex, §1-2 teamclaude); agy·grok·cursor are opt-in there too.
const DEFAULT_POOLS = ['claude', 'codex'];
const USAGE = 'Usage: node scripts\\install-win.mjs [--pools claude,codex,agy,grok,cursor|all] '
  + '[--remote <URL> [--token-file <path>] [--no-check]] [--no-start] [--dry-run]';

class Fail extends Error {}

/** Windows paths as the .cmd files spell them: under %LOCALAPPDATA% / %USERPROFILE% when they are. */
export function cmdPath(path, { home, local }) {
  if (/[%"]/.test(path)) throw new Fail(`경로에 % 또는 "가 있어 .cmd에 넣을 수 없습니다: ${path}`);
  for (const [dir, name] of [[local, '%LOCALAPPDATA%'], [home, '%USERPROFILE%']]) {
    if (path.toLowerCase().startsWith(`${dir.toLowerCase()}\\`) || path.toLowerCase().startsWith(`${dir.toLowerCase()}/`)) {
      return name + path.slice(dir.length);
    }
  }
  return path;
}

/** cmd.exe reads a .cmd in the OEM code page (CP949 on Korean Windows): only ASCII survives, and `%`/`"` would be syntax. */
function cmdText(lines) {
  const text = `${lines.join('\r\n')}\r\n`;
  const bad = text.match(/[^\x09\x0a\x0d\x20-\x7e]/);
  if (bad) throw new Fail(`.cmd에 ASCII 밖 글자(${JSON.stringify(bad[0])})가 들어갑니다 — 그 경로(Node·클론)를 ASCII 경로로 옮겨 다시 실행하세요: ${text.split('\r\n').find(l => l.includes(bad[0]))}`);
  return Buffer.from(text, 'ascii');
}

export function wrapperCmd(pool, { node, root, config, L }) {
  const { cli } = POOLS[pool];
  return cmdText([
    '@echo off',
    `rem ${cli} for Windows (cineraria01/teamproxy scripts/install-win.mjs; rerun the installer instead of editing).`,
    'rem No args or -options open the CLI, -- passes a CLI subcommand, any other word is a proxy command.',
    'setlocal',
    `set "TEAMCLAUDE_CONFIG=${cmdPath(config, L)}"`,
    // One line: cmd re-reads a batch file after each command, and the installer may rewrite this one meanwhile.
    // `exit /b` with no number keeps node's exit code.
    `"${cmdPath(node, L)}" "${cmdPath(join(root, 'src', 'teamproxy-win32.js'), L)}" ${pool} %* & exit /b`,
  ]);
}

export function serverCmd(pool, { node, root, config, L }) {
  const { cli, prefix } = POOLS[pool];
  const logs = cmdPath(join(L.dir, 'logs'), L);
  return cmdText([
    '@echo off',
    `rem ${cli} server for the scheduled task ${cli} (scripts/install-win.mjs; rerun the installer instead of editing).`,
    'setlocal',
    `set "TEAMCLAUDE_CONFIG=${cmdPath(config, L)}"`,
    'set "TEAMCLAUDE_PROVIDER="',
    `set "LOG=${cmdPath(join(L.dir, 'logs', `${cli}.log`), L)}"`,
    `if not exist "${logs}" mkdir "${logs}"`,
    'rem Keep one old log of up to 10 MB.',
    'if exist "%LOG%" for %%F in ("%LOG%") do if %%~zF GTR 10485760 move /y "%LOG%" "%LOG%.1" >nul',
    `"${cmdPath(node, L)}" "${cmdPath(join(root, 'src', 'index.js'), L)}" ${[...prefix, 'server'].join(' ')} >> "%LOG%" 2>&1 & exit /b`,
  ]);
}

/** wscript runs this with no window and waits, so the task lives as long as the server and sees its exit code. */
export function serverVbs(pool, { L }) {
  const { cli } = POOLS[pool];
  const cmd = cmdPath(join(L.dir, `${cli}-server.cmd`), L);
  return cmdText([
    `' ${cli} server without a window, for the scheduled task ${cli} (scripts/install-win.mjs).`,
    'Set shell = CreateObject("WScript.Shell")',
    // cmd /s /c ""path"": the outer quotes are always the ones removed, whatever the path holds.
    `WScript.Quit shell.Run("cmd.exe /d /s /c """"" & shell.ExpandEnvironmentStrings("${cmd}") & """""", 0, True)`,
  ]);
}

const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/** Task Scheduler XML (UTF-16 with BOM, what schtasks /Create /XML reads). */
export function taskXml(pool, { user, L, restartCount = 9999 }) {
  const { cli } = POOLS[pool];
  const vbs = join(L.dir, `${cli}-server.vbs`);
  const text = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>teamproxy ${cli} server (cineraria01/teamproxy scripts/install-win.mjs)</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xml(user)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>${restartCount}</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>//B //Nologo "${xml(vbs)}"</Arguments>
    </Exec>
  </Actions>
</Task>
`;
  return Buffer.from(`﻿${text.replace(/\n/g, '\r\n')}`, 'utf16le');
}

function stamp() {
  const d = new Date();
  const two = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}

function parseArgs(argv) {
  const opts = { pools: DEFAULT_POOLS, remote: null, tokenFile: null, noCheck: false, start: true, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Fail(`${a} 뒤에 값을 주세요.\n${USAGE}`);
      return argv[++i];
    };
    if (a === '--pools') {
      const v = value();
      opts.pools = v === 'all' ? Object.keys(POOLS) : v.split(',').map(s => s.trim()).filter(Boolean);
      const unknown = opts.pools.filter(p => !Object.hasOwn(POOLS, p));
      if (unknown.length || !opts.pools.length) throw new Fail(`모르는 풀: ${unknown.join(', ') || '(없음)'} — ${Object.keys(POOLS).join(', ')} 또는 all`);
    } else if (a === '--remote') opts.remote = value();
    else if (a === '--token-file') opts.tokenFile = value();
    else if (a === '--no-check') opts.noCheck = true;
    else if (a === '--no-start') opts.start = false;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
    else throw new Fail(`모르는 인자: ${a}\n${USAGE}`);
  }
  if ((opts.tokenFile || opts.noCheck) && !opts.remote) throw new Fail('--token-file·--no-check는 --remote와 함께만 씁니다.');
  if (opts.remote && !opts.pools.includes('claude')) opts.pools = ['claude', ...opts.pools];
  return opts;
}

/** A TeamClaude server (its status has an accounts list) answers on the port. */
async function isUp(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/status`, { signal: AbortSignal.timeout(1500) });
    return Array.isArray((await res.json())?.accounts);
  } catch {
    return false;
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const platform = (env.NODE_TEST_CONTEXT && env.TEAMPROXY_APP_PLATFORM) || process.platform;
  if (platform !== 'win32') {
    console.error('install-win.mjs는 Windows 전용입니다 — macOS·Linux는 docs/install/INSTALL-ALL.md(scripts/install.py)를 따르세요.');
    return 2;
  }
  const opts = parseArgs(argv);
  const say = line => console.log(`[install-win] ${line}`);
  const home = env.USERPROFILE || homedir();
  const L = { home, local: env.LOCALAPPDATA || join(home, 'AppData', 'Local') };
  L.dir = join(L.local, 'teamproxy');
  const bin = join(home, '.local', 'bin');
  const node = process.execPath;
  const user = env.USERDOMAIN ? `${env.USERDOMAIN}\\${env.USERNAME}` : env.USERNAME;
  if (!user) throw new Fail('USERNAME이 없어 작업의 사용자를 정할 수 없습니다.');
  const when = stamp();
  const notes = [];
  const dry = opts.dryRun ? '(dry-run) ' : '';

  /** Write unless identical; a different existing file is kept as <file>.bak-install-<stamp> first. */
  const put = (path, bytes) => {
    let old = null;
    try { old = readFileSync(path); } catch { /* new */ }
    if (old?.equals(bytes)) return '그대로';
    if (opts.dryRun) return old ? '바꿀 것(전 판 백업)' : '만들 것';
    mkdirSync(dirname(path), { recursive: true });
    if (old) renameSync(path, `${path}.bak-install-${when}`);
    writeFileSync(path, bytes);
    return old ? `바꿈(전 판 ${path}.bak-install-${when})` : `만듦(${path})`;
  };

  if (!existsSync(join(ROOT, '.git'))) notes.push(`${ROOT}는 git 클론이 아닙니다 — <풀> update는 git 클론에서만 됩니다`);
  say(`${dry}클론 ${ROOT}, Node ${node}, 풀 ${opts.pools.join(', ')}${opts.remote ? ' (teamclaude는 원격 풀)' : ''}`);
  const tasks = [];
  for (const pool of opts.pools) {
    const { cli, config: file } = POOLS[pool];
    const remote = pool === 'claude' && opts.remote;
    const config = join(home, '.config', file);
    const ctx = { node, root: ROOT, config, L };
    let existing = null;
    if (existsSync(config)) {
      try {
        existing = JSON.parse(readFileSync(config, 'utf8'));
      } catch (err) {
        throw new Fail(`${config}을 JSON으로 읽지 못해 아무것도 바꾸지 않았습니다(${err.message}) — 메모장 등으로 BOM·깨진 곳을 고친 뒤 다시`);
      }
    }
    // A teamclaude config in remote-pool client mode has no local server to run.
    const client = pool === 'claude' && !remote && existing?.client;
    say(`${cli}: 래퍼 ${put(join(bin, `${cli}.cmd`), wrapperCmd(pool, ctx))}`);

    let port = POOLS[pool].port;
    if (existing) {
      port = existing.proxy?.port ?? port;
      const host = existing.proxy?.host;
      say(`${cli}: 설정 ${config} 그대로(계정 ${existing.accounts?.length ?? 0}개)`);
      if (!remote && !client && host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
        notes.push(`${cli}: proxy.host가 ${host ? `"${host}"` : '비어 있어'} 이 PC 밖에서도 열립니다 — "127.0.0.1"을 권합니다(설정은 바꾸지 않았음)`);
      }
    } else if (!remote) {
      if (!opts.dryRun) {
        // createDefaultConfig keys its provider (and port) on the env at call time.
        const { createDefaultConfig } = await src('config.js');
        const saved = process.env.TEAMCLAUDE_PROVIDER;
        if (pool === 'claude') delete process.env.TEAMCLAUDE_PROVIDER; else process.env.TEAMCLAUDE_PROVIDER = pool;
        const created = createDefaultConfig();
        if (saved === undefined) delete process.env.TEAMCLAUDE_PROVIDER; else process.env.TEAMCLAUDE_PROVIDER = saved;
        created.proxy.host = '127.0.0.1';
        created.proxy.allowNoAccounts = true; // stay up until the first login (the task would restart it in a loop)
        mkdirSync(dirname(config), { recursive: true });
        writeFileSync(config, `${JSON.stringify(created, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
        port = created.proxy.port;
      }
      say(`${cli}: ${dry}설정 ${config}을 만듦(proxy.host 127.0.0.1)`);
    }

    if (remote) {
      if (taskExists(cli)) notes.push(`${cli}: 로컬 풀 작업 ${cli}이 남아 있습니다 — 원격 풀만 쓰려면 schtasks /End /TN ${cli} 뒤 schtasks /Delete /TN ${cli} /F`);
      continue;
    }
    if (client) {
      notes.push(`${cli}: 설정이 원격 풀 모드(client)라 서버·작업을 만들지 않았습니다 — 로컬 풀로 바꾸려면 teamclaude remote use --off 뒤 다시`);
      continue;
    }
    say(`${cli}: 서버 ${put(join(L.dir, `${cli}-server.cmd`), serverCmd(pool, ctx))}, 창 없이 ${put(join(L.dir, `${cli}-server.vbs`), serverVbs(pool, ctx))}`);
    // RestartOnFailure 9999 (as the hand install); 255 only if this Windows refuses it (the documented schema type
    // is unsignedByte — unverified which one Task Scheduler enforces).
    const variants = [9999, 255].map(restartCount => taskXml(pool, { user, L, restartCount }));
    const marker = join(L.dir, `${cli}.task.xml`);
    const exists = taskExists(cli);
    let marked = null;
    try { marked = readFileSync(marker); } catch { /* first install */ }
    if (exists && variants.some(v => marked?.equals(v))) {
      say(`${cli}: 작업 ${cli} 그대로`);
    } else if (opts.dryRun) {
      say(`${cli}: (dry-run) 작업 ${cli} ${exists ? '바꿈(전 판 백업)' : '만듦'}`);
    } else {
      mkdirSync(L.dir, { recursive: true });
      if (exists) {
        const old = schtasks(['/Query', '/TN', cli, '/XML'], undefined, 'buffer');
        if (old.status !== 0) throw new Fail(`작업 ${cli}의 XML을 읽지 못해 바꾸지 않았습니다: ${decodeSchtasksOutput(old.stderr).trim()}`);
        // UTF-16 with BOM like the XML header says, so `schtasks /Create /XML <backup>` takes it back as is.
        writeFileSync(join(L.dir, `${cli}.task.bak-install-${when}.xml`), Buffer.from(`﻿${decodeSchtasksOutput(old.stdout)}`, 'utf16le'));
      }
      const next = `${marker}.new`;
      let made;
      for (const task of variants) {
        writeFileSync(next, task);
        made = schtasks(['/Create', '/TN', cli, '/XML', next, '/F']);
        if (made.status === 0) break;
        if (/denied|거부/i.test(made.stderr + made.stdout)) break; // a missing right, not the count
      }
      if (made.status !== 0) {
        rmSync(next, { force: true });
        throw new Fail(`schtasks /Create /TN ${cli} 실패(종료 ${made.status}): ${(made.stderr || made.stdout).trim()}\n`
          + '  「액세스가 거부되었습니다」면 로그온 트리거 작업을 만들 권한이 없는 것입니다 — 이 사용자가 관리자 그룹이면 '
          + '「관리자로 실행」한 PowerShell에서 이 명령을 한 번 다시 실행하세요(다른 관리자 계정으로 돌리면 그 계정 프로필에 깔립니다).');
      }
      if (!readFileSync(next).equals(variants[0])) notes.push(`${cli}: 이 Windows가 RestartOnFailure 9999번을 받지 않아 255번으로 만들었습니다`);
      renameSync(next, marker);
      say(`${cli}: 작업 ${cli} ${exists ? `바꿈(전 판 ${cli}.task.bak-install-${when}.xml)` : '만듦'}`);
    }
    tasks.push({ cli, port });
  }

  if (opts.remote && !opts.dryRun) {
    const args = [join(ROOT, 'src', 'teamproxy-win32.js'), 'claude', 'remote', 'use', opts.remote];
    if (opts.tokenFile) args.push('--token-file', opts.tokenFile);
    if (opts.noCheck) args.push('--no-check');
    say('teamclaude: 원격 풀 연결(teamclaude remote use)');
    const r = spawnSync(node, args, { stdio: 'inherit', env: { ...env, TEAMCLAUDE_CONFIG: join(home, '.config', POOLS.claude.config) } });
    // Never echo --remote's value: a token pasted there would land on the screen (remote-client.js does the same).
    if (r.status !== 0) throw new Fail(`teamclaude remote use 실패(종료 ${r.status}) — 위 안내대로 고친 뒤 teamclaude remote use <주소> 로 다시`);
  }

  if (opts.start && !opts.dryRun) {
    for (const { cli, port } of tasks) {
      if (await isUp(port)) {
        say(`${cli}: 서버가 이미 :${port}에서 응답합니다 — 그대로 둠(작업 밖에서 뜬 서버면 그 창에서 끈 뒤 schtasks /Run /TN ${cli})`);
        continue;
      }
      const r = schtasks(['/Run', '/TN', cli]);
      say(`${cli}: ${r.status === 0 ? `작업 ${cli} 시작(:${port}, 로그 ${join(L.dir, 'logs', `${cli}.log`)})` : `작업 시작 실패(종료 ${r.status})`}`);
      if (r.status !== 0) notes.push(`${cli}: schtasks /Run /TN ${cli} 실패 — 다음 로그온 때 뜹니다`);
    }
  }

  // What the pools need beside the proxy (warnings only).
  const pathDirs = String(env.Path ?? env.PATH ?? '').split(';').map(d => d.replace(/[\\/]+$/, '').toLowerCase());
  if (!pathDirs.includes(bin.toLowerCase())) {
    notes.push(`${bin}이 PATH에 없습니다 — PowerShell: [Environment]::SetEnvironmentVariable('Path', "$env:USERPROFILE\\.local\\bin;" + [Environment]::GetEnvironmentVariable('Path', 'User'), 'User') 뒤 새 창`);
  }
  const where = name => spawnSync('where.exe', [name], { stdio: 'ignore' }).status === 0;
  for (const pool of opts.pools) {
    // An older wrapper earlier on PATH (e.g. an npm global %APPDATA%\npm\teamcodex.cmd) would shadow the new one.
    const first = spawnSync('where.exe', [POOLS[pool].cli], { encoding: 'utf8' }).stdout?.split(/\r?\n/)[0]?.trim();
    const mine = join(bin, `${POOLS[pool].cli}.cmd`);
    if (first && first.toLowerCase() !== mine.toLowerCase()) notes.push(`${POOLS[pool].cli}: PATH에서 ${first}가 먼저 잡힙니다 — 지우거나 ${bin}을 PATH 앞으로`);
    if (pool === 'claude' && !existsSync(join(bin, 'claude.exe'))) notes.push('Claude Code가 없습니다(%USERPROFILE%\\.local\\bin\\claude.exe) — PowerShell: irm https://claude.ai/install.ps1 | iex');
    if (pool === 'codex') {
      const { resolveCodexCliBin } = await src('codex.js');
      if (resolveCodexCliBin({ env }) === 'codex' && !where('codex')) notes.push('Codex CLI가 없습니다 — npm i -g @openai/codex');
    }
    if (pool === 'agy' && !where('agy')) notes.push('agy(Antigravity CLI)가 PATH에 없습니다 — 깔고 agy에서 한 번 로그인');
    if (pool === 'grok' && !existsSync(join(home, '.grok', 'bin', 'grok.exe')) && !where('grok')) notes.push('grok(Grok Build CLI)가 없습니다 — 깔고 grok에서 한 번 로그인');
    if (pool === 'cursor' && !where('cursor-agent')) notes.push('cursor-agent가 PATH에 없습니다 — 깔고 cursor-agent login');
  }
  for (const n of notes) say(`주의: ${n}`);
  say(`${dry}끝. 계정: ${opts.pools.filter(p => !(p === 'claude' && opts.remote)).map(p => `${POOLS[p].cli} login`).join(' · ') || '(원격 풀만)'} · 상태: <풀> status · 갱신: <풀> update`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main();
  } catch (err) {
    if (!(err instanceof Fail)) throw err;
    console.error(`[install-win] 실패: ${err.message}`);
    process.exitCode = 1;
  }
}
