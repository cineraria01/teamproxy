// Windows-only CLI behavior, kept apart from the macOS/Linux code (2026-11-18 user: "맥이랑 윈도우 코드 섞이면
// 안된다"). Common code never imports this file directly: src/platform.js picks it. The Windows wrapper is
// scripts/win32/teamclaude.cmd → src/teamclaude-win32.js. Guide: docs/install/INSTALL-ALL.md §9-5.

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
