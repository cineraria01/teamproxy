// Remote pool client mode: a machine with no pool of its own runs Claude Code
// against another machine's teamclaude pool through that machine's
// `tailscale serve` address (`<pool> remote on` there), with the remote token as
// the API key. The setting lives in this machine's teamclaude config as
// `client: { url, token }` (written 0600 by config.js). Platform-neutral: the same
// code on macOS, Linux and Windows (Windows-only pieces are src/win32.js and
// scripts/win32/). Guide: docs/install/INSTALL-ALL.md §9-4/§9-5. The token is
// never printed, logged or put on a command line.
import { randomBytes } from 'node:crypto';
import { readFile, open, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { createInterface } from 'node:readline';
import { renameWithRetry } from './config.js';
import { parsePriority } from './remote.js';

/** `config.client` when it names a usable remote pool, else null. */
export function clientOf(config) {
  const c = config?.client;
  return c && typeof c.url === 'string' && c.url && typeof c.token === 'string' && c.token
    ? { url: c.url, token: c.token }
    : null;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** The pool's origin. https only, except a loopback http address (an SSH tunnel, tests). */
export function normalizeClientUrl(raw) {
  let url;
  // Never echo the value: a token pasted where the address goes would land on the screen.
  try { url = new URL(String(raw)); } catch {
    throw new Error('주소가 아닙니다(https://<기계>.<tailnet>.ts.net:8456 꼴). 토큰을 넣었다면 셸 기록에 남았으니 풀 기계에서 remote token --rotate.');
  }
  if (url.username || url.password) throw new Error('주소에 사용자 이름·비밀번호를 넣지 마세요.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    throw new Error('주소는 https:// 여야 합니다(평문 http는 이 기계의 루프백 주소만).');
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new Error('주소에는 경로 없이 https://<기계>.<tailnet>.ts.net:8456 꼴만 넣습니다.');
  }
  return url.origin;
}

// Printable ASCII only (remote tokens are base64url): a control character (a NUL from a UTF-16 token file) would
// make fetch/spawn throw an error that quotes the value.
export function validToken(token) {
  return typeof token === 'string' && /^[\x21-\x7e]{1,4096}$/.test(token);
}

/** The token from --token-file, else standard input (a terminal gets a prompt that does not echo). */
export async function readToken({ tokenFile = null, stdin = process.stdin, stderr = process.stderr } = {}) {
  if (tokenFile) return (await readFile(tokenFile, 'utf8')).trim();
  if (!stdin.isTTY) {
    let text = '';
    for await (const chunk of stdin) {
      text += chunk;
      if (text.length > 65536) break;
    }
    return text.trim();
  }
  stderr.write('원격 토큰(풀 기계의 `teamclaude remote token`)을 붙여 넣고 Enter (화면에 보이지 않음): ');
  const silent = new Writable({ write(_chunk, _enc, done) { done(); } });
  const rl = createInterface({ input: stdin, output: silent, terminal: true });
  try {
    return await new Promise(resolve => {
      rl.once('line', line => resolve(line.trim()));
      rl.once('close', () => resolve(''));
      // Raw mode turns Ctrl+C into this event (without a listener readline would only pause and wait).
      rl.once('SIGINT', () => resolve(''));
    });
  } finally {
    rl.close();
    stderr.write('\n');
  }
}

/** Claude Code's environment for the remote pool: its API key mode, never a local OAuth token. */
export function clientChildEnv(env, client) {
  const child = { ...env };
  delete child.ANTHROPIC_AUTH_TOKEN;
  delete child.CLAUDE_CODE_OAUTH_TOKEN;
  child.ANTHROPIC_BASE_URL = client.url;
  child.ANTHROPIC_API_KEY = client.token;
  // Same as the local pool: the proxy supports tool_reference blocks.
  child.ENABLE_TOOL_SEARCH ??= 'true';
  child.TEAMCLAUDE_SESSION_SUPERVISED = '1';
  return child;
}

export function claudeGlobalConfigPath(env = process.env, home = homedir()) {
  return join(env.CLAUDE_CONFIG_DIR || home, '.claude.json');
}

/**
 * Pre-approve the key in Claude Code's global config (`customApiKeyResponses.approved` holds the key's last 20
 * characters) so an interactive start does not ask whether to use it. Only writes when it is not approved yet;
 * every other field is kept, the write is a rename. Returns { changed } or { error }.
 */
export async function approveClaudeApiKey(key, path) {
  let raw = null;
  let mode = 0o600;
  try {
    raw = await readFile(path, 'utf8');
    mode = (await stat(path)).mode & 0o777;
  } catch (err) {
    if (err.code !== 'ENOENT') return { error: err.code || err.message };
  }
  let config = {};
  if (raw != null && raw.trim()) {
    try { config = JSON.parse(raw); } catch { return { error: 'JSON이 아님' }; }
    if (!config || typeof config !== 'object' || Array.isArray(config)) return { error: 'JSON 객체가 아님' };
  }
  const tail = key.slice(-20);
  const responses = config.customApiKeyResponses && typeof config.customApiKeyResponses === 'object'
    ? config.customApiKeyResponses : {};
  const approved = Array.isArray(responses.approved) ? responses.approved : [];
  const rejected = Array.isArray(responses.rejected) ? responses.rejected : [];
  if (approved.includes(tail) && !rejected.includes(tail)) return { changed: false };
  config.customApiKeyResponses = {
    ...responses,
    approved: [...approved.filter(k => k !== tail), tail],
    rejected: rejected.filter(k => k !== tail),
  };
  const tmp = `${path}.teamclaude-${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  try {
    const fh = await open(tmp, 'w', mode);
    try { await fh.writeFile(JSON.stringify(config, null, 2)); } finally { await fh.close(); }
    await renameWithRetry(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    return { error: err.code || err.message };
  }
  return { changed: true };
}

// ── remote calls ───────────────────────────────────────────

export class RemoteError extends Error {}

export const BAD_SAVED_TOKEN = '설정의 원격 토큰이 올바르지 않습니다(출력 가능한 ASCII가 아님). teamclaude remote use <주소>로 다시 넣으세요.';

function failureLine(status, message) {
  if (status === 401) return '원격 토큰이 맞지 않습니다(401). 풀 기계의 `teamclaude remote token`으로 보고 `teamclaude remote use <주소>`로 다시 넣으세요.';
  if (status === 403) {
    const hint = /login is not allowed/i.test(message) ? ' — 풀 기계 설정 remote.allowLogins에 이 기기의 Tailscale 로그인을 더하세요.'
      : /remote access is off/i.test(message) ? ' — 풀 기계에서 `teamclaude remote on`.'
        : /tailscale serve only/i.test(message) ? ' — 풀 기계의 tailscale serve 주소(https://…ts.net:8456)를 쓰세요.' : '';
    return `원격이 거절했습니다(403): ${message || '이유 없음'}${hint}`;
  }
  return `원격 오류 HTTP ${status}: ${message || '본문 없음'}`;
}

/** One call to the remote surface. Throws RemoteError with a one-line Korean cause. */
export async function remoteCall(client, method, path, body = undefined, { timeoutMs = 10_000, fetchImpl = fetch } = {}) {
  if (!validToken(client.token)) throw new RemoteError(BAD_SAVED_TOKEN);
  let res;
  try {
    res = await fetchImpl(client.url + path, {
      method,
      headers: { 'x-api-key': client.token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      // A redirect could carry the token to another host.
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // Only the cause's code: a message may quote a header value (the token).
    const code = err?.name === 'TimeoutError' ? `${timeoutMs / 1000}초 안에 답이 없음`
      : err?.cause?.code || err?.code || err?.name || 'unknown';
    throw new RemoteError(`원격 풀에 못 닿습니다(${client.url}): ${code}`);
  }
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) throw new RemoteError(failureLine(res.status, data?.error?.message));
  if (!data || typeof data !== 'object') throw new RemoteError(`원격 응답을 읽을 수 없습니다(HTTP ${res.status}).`);
  return data;
}

export async function remoteStatus(client, options) {
  const data = await remoteCall(client, 'GET', '/teamproxy/status', undefined, options);
  if (!Array.isArray(data.accounts)) throw new RemoteError('원격 응답에 계정 목록이 없습니다(teamproxy 원격 접속이 있는 판인지 보세요).');
  return data;
}

// ── table ──────────────────────────────────────────────────

const STATE = { ready: '대기', busy: '사용 중', off: '꺼짐', error: '오류', wait: '한도 대기', cool: '식는 중', limit: '한도', back: '복구됨' };

// East Asian wide characters take two terminal cells.
const cells = s => [...s].reduce((n, ch) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿＀-｠]/.test(ch) ? 2 : 1), 0);
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - cells(s)));

function left(at, now) {
  const s = (Date.parse(at) - now) / 1000;
  if (!(s > 0)) return '';
  const m = Math.floor(s / 60), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  return d ? `${d}일${h}시간` : h ? `${h}시간${m % 60}분` : `${Math.max(1, m)}분`;
}

function gauge(g, now) {
  if (!g || typeof g.pct !== 'number') return '-';
  const rest = g.resetsAt ? left(g.resetsAt, now) : '';
  return `${g.pct}%${rest ? ' ' + rest : ''}`;
}

export function formatRemoteStatus(data, url, now = Date.now()) {
  const rows = data.accounts.map(a => [
    a.active ? '*' : '',
    String(a.n ?? ''),
    String(a.name ?? '-'),
    (STATE[a.state] || String(a.state ?? '-')) + (a.enabled === false && a.state !== 'off' ? '(꺼짐)' : ''),
    gauge(a.weekly, now),
    gauge(a.fable, now),
    a.session === null && data.pool === 'claude' ? '-' : gauge(a.session, now),
    a.priority == null ? '자동' : String(a.priority),
    a.stale ? '오래된 값' : '',
  ]);
  const head = ['', '#', '이름', '상태', '주간', 'Fable', '5시간', '우선', ''];
  const widths = head.map((h, i) => Math.max(cells(h), ...rows.map(r => cells(r[i]))));
  const line = r => r.map((c, i) => pad(c, widths[i])).join('  ').trimEnd();
  return [
    `원격 풀 ${data.pool ?? '?'} · ${url}${data.version ? ` · 판 ${data.version}` : ''} · 처리 중 요청 ${data.requests?.active ?? '-'}`,
    line(head),
    ...rows.map(line),
    ...(rows.length ? [] : ['  (계정 없음)']),
    '* = 지금 고르는 계정. 이 표와 아래 명령은 원격 풀 전체 기준입니다.',
  ].join('\n');
}

/** `<번호|이름>` → account: number, exact name, then a unique name prefix. */
export function resolveAccount(accounts, ref) {
  if (/^\d+$/.test(ref)) {
    const found = accounts.find(a => a.n === Number(ref));
    if (found) return found;
    throw new RemoteError(`원격 풀에 ${ref}번 계정이 없습니다(1~${accounts.length}).`);
  }
  const exact = accounts.find(a => a.name === ref);
  if (exact) return exact;
  const prefixed = accounts.filter(a => typeof a.name === 'string' && a.name.startsWith(ref));
  if (prefixed.length === 1) return prefixed[0];
  const names = (prefixed.length ? prefixed : accounts).map(a => a.name).join(', ');
  throw new RemoteError(prefixed.length
    ? `"${ref}"에 맞는 계정이 여럿입니다: ${names}`
    : `원격 풀에 "${ref}" 계정이 없습니다(있는 것: ${names || '없음'}).`);
}

// ── commands ───────────────────────────────────────────────

const HERE = 'teamclaude [Claude 옵션] · teamclaude -- <Claude 하위 명령> · status · accounts · reload · restart · '
  + 'enable|disable <번호|이름> · priority <번호|이름> <n|auto> · remote use';

/** status/accounts/reload/restart/enable/disable/priority and the refusals. Returns the exit code. */
export async function clientCommand(command, argv, client, { out = console.log, err = console.error, fetchImpl } = {}) {
  const options = fetchImpl ? { fetchImpl } : {};
  try {
    if (command === 'status' || command === 'accounts') {
      const data = await remoteStatus(client, options);
      out(argv.includes('--json') ? JSON.stringify(data) : formatRemoteStatus(data, client.url));
      return 0;
    }
    if (command === 'reload' || command === 'restart') {
      if (command === 'restart') {
        out('이 기계에는 서버가 없습니다(원격 풀 클라이언트). 원격 풀 재시작은 원격에서 할 수 없어(그 기계의 세션이 모두 끊김) 사용량 다시 재기로 대신합니다.');
      }
      const r = await remoteCall(client, 'POST', '/teamproxy/reload', {}, { timeoutMs: 120_000, ...options });
      out(`원격 풀 사용량 다시 잼: ${r.measured ?? '?'}/${r.targets ?? '?'} 계정(전체 ${r.total ?? '?'}) — 원격 풀 전체에 적용.`);
      return 0;
    }
    if (command === 'enable' || command === 'disable' || command === 'priority') {
      const ref = argv[1];
      const raw = argv[2];
      const priority = command === 'priority' ? parsePriority(raw ?? '') : null;
      if (!ref || ref.startsWith('-') || (command === 'priority' && !priority)) {
        err(`사용법: teamclaude ${command} <번호|이름>${command === 'priority' ? ' <n|auto>' : ''}`);
        return 1;
      }
      const account = resolveAccount((await remoteStatus(client, options)).accounts, ref);
      const body = command === 'priority' ? { priority: priority.clear ? 'auto' : priority.value } : {};
      const r = await remoteCall(client, 'POST', `/teamproxy/accounts/${account.n}/${command}`, body, options);
      const what = command === 'priority' ? (r.priority == null ? '자동 순서' : `우선 ${r.priority}`)
        : r.enabled ? '켬' : '끔';
      out(`원격 풀 전체에 적용: ${r.n ?? account.n}. ${r.name ?? account.name} ${what}`);
      return 0;
    }
  } catch (e) {
    if (!(e instanceof RemoteError)) throw e;
    err(e.message);
    return 1;
  }
  err(`teamclaude ${command ?? ''}`.trimEnd() + `: 이 기계는 원격 풀 클라이언트(${client.url})라 여기서 할 수 없습니다.`);
  err(`  여기서 되는 것: ${HERE}`);
  err('  계정 추가·로그인·제거·업데이트·서버 켜고 끄기는 풀 기계에서 하세요. 클라이언트 모드 끄기: teamclaude remote use --off');
  err('  (이 기계에 로컬 서버가 있으면 먼저 remote use --off 한 뒤 다룹니다.)');
  return 1;
}

/** `teamclaude remote use <URL> [--token-file PATH] [--no-check]` · `remote use --off` · `remote use`. */
export async function remoteUseCommand(argv, { config, configPath, update, out = console.log, err = console.error, stdin, fetchImpl } = {}) {
  const current = clientOf(config);
  if (argv.includes('--off')) {
    if (!config?.client) { out('클라이언트 모드가 이미 꺼져 있습니다.'); return 0; }
    await update(cfg => { delete cfg.client; });
    out(`클라이언트 모드 끔: ${configPath}의 client 칸을 지웠습니다. 이제 이 기계의 로컬 풀을 씁니다.`);
    return 0;
  }
  // --token-file PATH or --token-file=PATH.
  const joined = argv.find(a => a.startsWith('--token-file='));
  const i = argv.indexOf('--token-file');
  const next = i >= 0 ? argv[i + 1] : undefined;
  const tokenFile = joined ? joined.slice('--token-file='.length) || null
    : next && !next.startsWith('-') ? next : null;
  const positional = argv.filter((a, n) => !a.startsWith('-') && argv[n - 1] !== '--token-file');
  if (!positional.length) {
    out(current ? `클라이언트 모드: ${current.url} (토큰 있음 — 보이지 않음)` : '클라이언트 모드: 꺼짐');
    out('켜기: teamclaude remote use <https://기계.tailnet.ts.net:8456> (토큰은 표준 입력 또는 --token-file) · 끄기: teamclaude remote use --off');
    return 0;
  }
  if ((i >= 0 || joined) && !tokenFile) { err('--token-file 뒤에 파일 경로를 주세요.'); return 1; }
  if (positional.length > 1) {
    err('주소 하나만 줍니다. 토큰은 명령줄에 넣지 않습니다(이미 쳤다면 셸 기록에 남았으니 풀 기계에서 remote token --rotate).');
    return 1;
  }
  let url;
  try { url = normalizeClientUrl(positional[0]); } catch (e) { err(e.message); return 1; }
  const accounts = Array.isArray(config?.accounts) ? config.accounts.length : 0;
  if (accounts > 0) {
    err(`${configPath}에 로컬 계정 ${accounts}개가 있습니다 — 이 기계는 자기 풀을 씁니다. 클라이언트 모드는 계정 없는 설정에서만 켭니다.`);
    return 1;
  }
  let token;
  try { token = await readToken({ tokenFile, stdin }); } catch (e) { err(`토큰을 못 읽었습니다: ${e.code || e.message}`); return 1; }
  if (!validToken(token)) {
    err('토큰이 비었거나 공백·제어 문자가 들어 있습니다(토큰 파일은 UTF-8/ASCII로). 풀 기계의 `teamclaude remote token` 값을 그대로 넣으세요.');
    return 1;
  }
  const client = { url, token };
  if (!argv.includes('--no-check')) {
    try {
      const data = await remoteStatus(client, fetchImpl ? { fetchImpl } : {});
      if (data.pool !== 'claude') {
        err(`이 주소는 ${data.pool ?? '알 수 없는'} 풀입니다. Claude 풀(:8456) 주소를 넣으세요. 저장하지 않았습니다.`);
        return 1;
      }
      out(`원격 풀 확인: ${url} · 계정 ${data.accounts.length}개`);
    } catch (e) {
      if (!(e instanceof RemoteError)) throw e;
      err(e.message);
      err('저장하지 않았습니다. 연결을 고친 뒤 다시 하거나, 지금 저장만 하려면 --no-check.');
      return 1;
    }
  }
  await update(cfg => { cfg.client = client; });
  out(`클라이언트 모드 켬: ${configPath}에 저장(토큰은 이 파일에만). 이제 teamclaude가 원격 풀로 Claude Code를 띄웁니다.`);
  return 0;
}
