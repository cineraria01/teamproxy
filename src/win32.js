// Windows-only CLI behavior, kept apart from the macOS/Linux code (2026-11-18 user: "맥이랑 윈도우 코드 섞이면
// 안된다"). Common code never imports this file directly: src/platform.js picks it. The hand wrapper is
// scripts/win32/teamclaude.cmd → src/teamclaude-win32.js; installed pools use src/teamproxy-win32.js
// (scripts/install-win.mjs). Guides: docs/install/INSTALL-WINDOWS.md, INSTALL-ALL.md §9-5.
import { spawnSync } from 'node:child_process';

/**
 * The sh wrapper's argument rule (INSTALL-ALL §1-2) for teamclaude.cmd: no arguments or a Claude option opens
 * Claude Code, `--` passes a Claude subcommand, `-h`/`--help` and any other word are proxy commands.
 */
export function wrapperArgs(argv) {
  const first = argv[0];
  if (first === '-h' || first === '--help') return argv;
  if (first === undefined) return ['run', '--'];
  if (first === '--') return ['run', ...argv];
  if (first.startsWith('-')) return ['run', '--', ...argv];
  return argv;
}

/**
 * No ps/lsof here, so a running server's identity is never verified and it is never signalled (a pid taken on
 * faith could be a recycled one). The lines `stop`/`restart` print instead, or null when nothing applies.
 */
export function unverifiedServerHint(r, verb, cli) {
  if (r.reason !== 'unverified-lifecycle' && r.reason !== 'no-pid') return null;
  return [
    `[${cli}] Windows에서는 서버 프로세스의 신원을 확인할 수 없어(ps·lsof 없음) ${verb === 'stop' ? '끄지' : '다시 띄우지'} 않았습니다.`,
    '  앱 모드(셀비)라면 앱이 서버를 끄고 켭니다 — 앱에서 하세요.',
    r.pid
      ? `  손으로: tasklist /FI "PID eq ${r.pid}" 로 node.exe인지 본 뒤  taskkill /PID ${r.pid} /T /F`
      : `  손으로: netstat -ano | findstr :${r.port} 로 pid를 찾아  taskkill /PID <pid> /T /F`,
    `  그다음 다시 띄우기: ${cli} server   (원격 풀만 쓰는 기계라면: ${cli} remote use <주소>)`,
  ];
}

// ── installed pools (scripts/install-win.mjs) ──

/** Pool → its command (= scheduled task name), config file, default port and index.js prefix (Claude has none). */
export const POOLS = {
  claude: { cli: 'teamclaude', config: 'teamclaude.json', port: 3456, prefix: [] },
  codex: { cli: 'teamcodex', config: 'teamcodex.json', port: 3457, prefix: ['codex'] },
  agy: { cli: 'teamagy', config: 'teamagy.json', port: 3458, prefix: ['agy'] },
  grok: { cli: 'teamgrok', config: 'teamgrok.json', port: 3459, prefix: ['grok'] },
  cursor: { cli: 'teamcursor', config: 'teamcursor.json', port: 3460, prefix: ['cursor'] },
};

/**
 * The macOS teamcodex wrapper's guard (scripts/install_teamcodex.py EXEC_CONFIG_GUARD): a `-c` after `exec`
 * drops TeamCodex's root provider overrides and ends in a 401, so `run -- … exec … -c …` is refused (exit 2).
 * Returns the lines to print, or null.
 */
export function codexExecConfigError(argv) {
  if (argv[0] !== 'run' || argv[1] !== '--') return null;
  let sub = null;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!sub) {
      if (arg === '-c' || arg === '--config') i++;
      else if (arg !== '--' && !arg.startsWith('-')) sub = arg;
      continue;
    }
    if (sub !== 'exec' && sub !== 'e') return null;
    if (arg === '--') return null;
    if (arg.startsWith('-c') || arg === '--config' || arg.startsWith('--config=')) {
      return [
        `teamcodex: exec 뒤의 '${arg}' 설정은 TeamCodex 프록시 설정을 지워 401로 실패합니다.`,
        'teamcodex: -c 설정은 exec 앞에 두세요. 예: teamcodex run -- -c model_reasoning_effort=high exec --ignore-user-config -m MODEL ...',
      ];
    }
  }
  return null;
}

/** schtasks.exe; tests (node --test only) swap in a fake .mjs (run with this node) with TEAMPROXY_WIN_SCHTASKS. */
function schtasksArgv(args, env = process.env) {
  const fake = env.NODE_TEST_CONTEXT && env.TEAMPROXY_WIN_SCHTASKS;
  return fake ? [process.execPath, [fake, ...args]] : ['schtasks', args];
}

export function schtasks(args, run = spawnSync) {
  const [cmd, argv] = schtasksArgv(args);
  const r = run(cmd, argv, { encoding: 'utf8', timeout: 30_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function taskExists(task, run = spawnSync) {
  return schtasks(['/Query', '/TN', task], run).status === 0;
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check, ms, step) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await pause(step);
  }
}

/**
 * Stop, and for `restart` start again, a pool the installer runs as the scheduled task `<cli>`. Task Scheduler
 * ends the whole process tree it started, so no pid is ever signalled here. `isUp()` = a TeamClaude server answers
 * on the pool's port. Returns null when `cli` is a task's name nowhere (the caller's usual path applies), else
 * an error line or '' on success.
 */
export async function taskLifecycle(verb, { cli, isUp, run = spawnSync, say = console.log, stopMs = 15_000, startMs = 120_000 }) {
  if (!taskExists(cli, run)) return null;
  if (await isUp()) {
    schtasks(['/End', '/TN', cli], run);
    if (!await waitFor(async () => !await isUp(), stopMs, 250)) {
      return `작업 ${cli}을 끝냈지만 서버가 계속 응답합니다 — 이 작업이 띄운 서버가 아닙니다(예: ${cli} run이 자동으로 띄운 것). `
        + 'netstat -ano | findstr LISTENING 으로 그 포트의 pid를 찾아 tasklist /FI "PID eq <pid>" 로 node.exe인지 본 뒤 taskkill /PID <pid> /T /F';
    }
    say(`[${cli}] 서버를 껐습니다(작업 ${cli} 끝냄).`);
  } else if (verb === 'stop') {
    say(`[${cli}] 떠 있는 서버가 없습니다.`);
  }
  if (verb === 'stop') return '';
  const r = schtasks(['/Run', '/TN', cli], run);
  if (r.status !== 0) return `schtasks /Run /TN ${cli} 실패(종료 ${r.status})`;
  if (!await waitFor(isUp, startMs, 500)) {
    return `작업 ${cli}을 띄웠지만 ${startMs / 1000}초 안에 서버가 응답하지 않습니다 — %LOCALAPPDATA%\\teamproxy\\logs\\${cli}.log를 보세요`;
  }
  say(`[${cli}] 서버를 다시 띄웠습니다(작업 ${cli}).`);
  return '';
}
