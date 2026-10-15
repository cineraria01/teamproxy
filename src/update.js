// `<pool> update`: bring this machine's proxy install(s) up to the fork's latest
// main (README "업데이트"). Steps per install: fetch → local-edit check → wait until
// the pools it serves are idle → back up → replace src/ and package.json →
// restart → verify, restoring the backup and restarting again when verification
// fails. App-mode installs (~/.local/share/teamproxy-app) are left to the app.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emit } from './app-json.js';

const DEFAULT_URL = 'https://github.com/cineraria01/teamproxy.git';
const CODEX_CLIENT_VERSION_FALLBACK = '0.162.1';
// A request the upstream answers only when the account pool behind the proxy works.
const POOLS = {
  teamclaude: { prefix: [], file: 'teamclaude.json', probe: () => ({ path: '/v1/models', headers: { 'anthropic-version': '2023-06-01' } }) },
  teamcodex: { prefix: ['codex'], file: 'teamcodex.json', probe: () => ({ path: `/codex/models?client_version=${codexClientVersion()}` }) },
  teamagy: { prefix: ['agy'], file: 'teamagy.json', probe: () => ({ method: 'POST', path: '/v1internal:fetchAvailableModels', body: '{}', headers: { 'content-type': 'application/json' } }) },
  teamgrok: { prefix: ['grok'], file: 'teamgrok.json', probe: () => ({ path: '/v1/models' }) },
};
const RESTART_TIMEOUT_MS = 120_000; // a cold tmux shell has taken ~90 s to come up
const SELF_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const USAGE = 'Usage: <pool> update [--all] [--dry-run] [--no-restart] [--ref <branch|tag|commit>] [--wait <seconds>] [--json]';

export async function updateCommand({ pool, configPath, argv }) {
  const opts = { all: false, dryRun: false, restart: true, ref: 'main', waitSec: 600, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') opts.all = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--no-restart') opts.restart = false;
    else if (a === '--json') opts.json = true;
    else if (a === '--ref' && argv[i + 1]) opts.ref = argv[++i];
    else if (a === '--wait' && Number(argv[i + 1]) >= 0) opts.waitSec = Number(argv[++i]);
    else { console.error(USAGE); return 2; }
  }
  const pollMs = Number(process.env.TEAMPROXY_UPDATE_POLL_MS) || 2000;
  const say = line => (opts.json ? console.error : console.log)(`[${pool} update] ${line}`);
  const results = [];
  const warnings = [];
  const finish = (ok, extra = {}) => {
    say(ok ? `끝: ${summary(results)}` : `실패: ${extra.message ?? summary(results)}`);
    if (opts.json) emit({ ok, ...extra, ...(warnings.length ? { warnings } : {}), installs: results });
    return ok ? 0 : 1;
  };
  const guard = { active: null };
  const onSignal = signal => {
    if (guard.active) interruptInstall(guard.active);
    finish(false, { error: 'interrupted', message: `${signal}로 중단 — ${guard.active?.entry.result ?? '바꾼 것 없음'}` });
    process.exit(130);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    // 1. Which installs, and which running servers each one serves.
    const servers = discoverServers(pool, configPath);
    const appDir = join(homedir(), '.local', 'share', 'teamproxy-app');
    if (existsSync(appDir)) say(`앱 모드 설치본 ${tilde(appDir)}은 건드리지 않습니다(셀비 앱이 고정 묶음으로 갱신)`);
    let roots;
    if (opts.all) {
      roots = new Set([SELF_ROOT, ...servers.map(s => s.root), ...globalInstalls()]);
    } else {
      const own = servers.find(s => s.pool === pool);
      if (own && own.root !== SELF_ROOT) say(`서버가 ${tilde(own.root)}에서 돌고 있어 그 설치본을 갱신합니다`);
      roots = new Set([own?.root ?? SELF_ROOT]);
    }
    const installs = [];
    for (const root of roots) {
      if (isAppPath(root)) { say(`건너뜀: ${tilde(root)} — 앱 모드 설치본`); results.push({ path: tilde(root), result: 'skipped_app' }); continue; }
      if (!isInstall(root)) {
        if (!opts.all) return finish(false, { error: 'not_an_install', message: `${tilde(root)}은 설치본이 아닙니다(git 클론에서는 git pull을 쓰세요)` });
        continue;
      }
      installs.push(root);
    }
    if (!installs.length) return finish(true);

    // 2. The target commit and its files.
    const repo = prepareRepo(opts, say, warnings);
    const stage = mkdtempSync(join(tmpdir(), 'teamproxy-update-'));
    try {
      const archive = git(['-C', repo.dir, 'archive', repo.commit, 'src', 'package.json'], { encoding: 'buffer' });
      run('tar', ['-x', '-C', stage], { input: archive, check: true });
      const pkg = JSON.parse(readFileSync(join(stage, 'package.json'), 'utf8'));
      if (Object.keys(pkg.dependencies ?? {}).length) {
        return finish(false, { error: 'runtime_dependencies', message: `${repo.short}에 런타임 의존성이 있어 파일 복사로 갱신할 수 없습니다` });
      }
      const target = fileMap(join(stage, 'src'));
      const targetHash = sourceHash(join(stage, 'src'));

      for (const root of installs) {
        const entry = { path: tilde(root), to: repo.short, result: null, pools: [] };
        results.push(entry);
        await updateInstall({
          root, entry, repo, stage, target, targetHash, opts, say, pollMs, guard,
          pools: servers.filter(s => s.root === root),
        });
      }
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
    const failed = results.filter(r => FAILURES.has(r.result));
    return finish(!failed.length, failed.length ? { error: failed[0].result, message: `${failed[0].path} — ${failed[0].result}` } : {});
  } catch (err) {
    return finish(false, { error: 'update_failed', message: err.message });
  }
}

const FAILURES = new Set(['local_changes', 'locked', 'no_restart_method', 'wait_timeout', 'restart_failed', 'restored', 'restore_failed']);
const MARKER = '.teamproxy-commit';

async function updateInstall({ root, entry, repo, stage, target, targetHash, opts, say, pollMs, pools, guard }) {
  const where = tilde(root);
  const current = fileMap(join(root, 'src'));
  const history = historyFor(repo, root);
  const local = [...current].filter(([, blob]) => !history.has(blob)).map(([path]) => path);
  if (local.length) {
    entry.result = 'local_changes';
    entry.files = local;
    say(`멈춤: ${where}에 포크 이력(${repo.short}·origin/main·설치 기록)에 없는 수정 ${local.length}개 — ${local.join(', ')}`);
    return;
  }
  const changed = diffMaps(current, target);
  const pkgSame = sameBytes(join(root, 'package.json'), join(stage, 'package.json'));
  const filesSame = !changed.total && pkgSame;
  // A server started before an earlier --no-restart still runs the old code.
  for (const p of pools) p.sourceHash = (await liveStatus(p))?.sourceHash ?? null;
  const restartPools = opts.restart ? pools.filter(p => !filesSame || p.sourceHash !== targetHash) : [];
  entry.pools = pools.map(p => ({ pool: p.pool, restart: restartPools.includes(p) }));
  if (filesSame && !restartPools.length) {
    entry.result = 'up_to_date';
    say(`이미 최신: ${where} (${repo.short})`);
    return;
  }
  say(`${where}: 파일 ${changed.total}개 바뀜(추가 ${changed.added}·변경 ${changed.modified}·삭제 ${changed.removed})${pkgSame ? '' : ' + package.json'}`
    + `, 다시 띄울 풀: ${restartPools.map(p => p.pool).join(', ') || '없음'}`);
  if (!existsSync(join(stage, 'src', 'update.js'))) say(`주의: ${repo.short}에는 update 명령이 없습니다 — 이 판으로 내리면 다음 갱신은 손 절차로 해야 합니다`);

  for (const p of restartPools) {
    p.method = restartMethod(p.pool);
    if (!p.method) {
      entry.result = 'no_restart_method';
      say(`멈춤: ${p.pool}을 다시 띄울 감독자를 찾지 못했습니다(systemd 사용자 단위도, launchd가 감독하는 tmux 세션 proxy도 없음). `
        + '--no-restart로 파일만 바꾼 뒤 손으로 다시 띄우세요');
      return;
    }
  }
  if (opts.dryRun) {
    entry.result = 'dry_run';
    for (const p of restartPools) say(`(dry-run) ${p.pool}: 요청 0과 drain 뒤 ${p.method.label}`);
    say(`(dry-run) ${where}: 백업 뒤 src/·package.json을 ${repo.short}로 덮습니다 — 아무것도 바꾸지 않았습니다`);
    return;
  }

  const lock = acquireLock(root);
  if (!lock.ok) {
    entry.result = 'locked';
    say(`멈춤: ${where}을 다른 update(pid ${lock.holder})가 갱신 중입니다`);
    return;
  }
  const stamp = freeStamp(root);
  const state = { root, stamp, entry, swapped: false, done: false, restarted: [], prevMarker: readText(join(root, MARKER)) };
  guard.active = state;
  try {
    // Baselines: verification only demands what worked before the update.
    for (const p of restartPools) {
      p.probeBefore = await probeModels(p);
      p.accountsBefore = accountSnapshot(p.config);
    }
    if (restartPools.length) {
      say(`요청 0 기다림: ${restartPools.map(p => p.pool).join(', ')} (최대 ${opts.waitSec}초)`);
      const quiet = await quiesce(restartPools, Date.now() + opts.waitSec * 1000, pollMs);
      if (!quiet.ok) {
        entry.result = 'wait_timeout';
        say(`멈춤: 진행 중 요청 ${quiet.active}개 — 이 풀을 쓰는 다른 세션이 쉴 때 다시 실행하세요(--wait로 늘리기). 아무것도 바꾸지 않았습니다`);
        return;
      }
    }

    if (!filesSame) {
      swapIn(root, stage, stamp);
      state.swapped = true;
      writeFileSync(join(root, MARKER), `${repo.commit}\n`);
      entry.backup = `src.pre-${stamp}`;
      say(`덮음: ${where} → ${repo.short} (백업 src.pre-${stamp}, package.json.pre-${stamp})`);
    }
    if (!opts.restart) {
      state.done = true;
      entry.result = 'updated_no_restart';
      pruneBackups(root);
      for (const p of pools) say(`다시 띄우지 않음: ${p.pool} — 다음 재시작 때 반영`);
      return;
    }

    let failure = null;
    for (const p of restartPools) {
      const quiet = await quiesce([p], Date.now() + opts.waitSec * 1000, pollMs); // drain lease is short: renew per pool
      if (!quiet.ok) { failure = `${p.pool} 진행 중 요청 ${quiet.active}개`; break; }
      state.restarted.push(p);
      failure = await restartAndVerify(p, pollMs, say);
      if (failure) break;
    }
    if (!failure) {
      state.done = true;
      entry.result = 'updated';
      pruneBackups(root);
      return;
    }
    entry.failure = failure;
    if (!state.swapped) {
      state.done = true;
      entry.result = 'restart_failed';
      say(`재시작 실패: ${failure} — 파일은 바꾸지 않았습니다. 손으로 확인하세요`);
      return;
    }
    say(`확인 실패: ${failure} — 되돌립니다`);
    try {
      restoreFiles(state);
    } catch (err) {
      entry.result = 'restore_failed';
      entry.state = installState(root);
      say(`되돌리기 실패: ${err.message} — 설치본 상태: ${entry.state}`);
      return;
    }
    state.done = true;
    entry.result = 'restored';
    pruneBackups(root);
    say(`되돌림: ${where} (실패한 판은 src.failed-${stamp}에 남김)`);
    for (const p of state.restarted) {
      const again = await restartAndVerify(p, pollMs, say, { restoring: true });
      if (again) { entry.result = 'restore_failed'; say(`되돌린 판도 확인 실패: ${p.pool} — ${again}. 손으로 확인하세요`); }
    }
  } finally {
    guard.active = null;
    rmSync(lock.file, { force: true });
  }
}

/** Ctrl-C / SIGTERM mid-update: put the old files back and restart what already runs the new ones. */
function interruptInstall(state) {
  try {
    if (state.swapped && !state.done) {
      restoreFiles(state);
      for (const p of state.restarted) run(p.method.cmd[0], p.method.cmd.slice(1));
      state.entry.result = 'interrupted_restored';
    } else {
      state.entry.result ??= 'interrupted';
    }
  } catch (err) {
    state.entry.result = 'restore_failed';
    state.entry.state = installState(state.root);
    state.entry.failure = err.message;
  }
  rmSync(join(state.root, '.update.lock'), { force: true });
}

async function restartAndVerify(p, pollMs, say, { restoring = false } = {}) {
  const oldPid = p.pid;
  say(`다시 띄움: ${p.pool} (${p.method.label})`);
  const r = run(p.method.cmd[0], p.method.cmd.slice(1));
  if (r.status !== 0) return `${p.method.label} 실패(종료 코드 ${r.status})`;
  const deadline = Date.now() + RESTART_TIMEOUT_MS;
  let fresh = null;
  while (Date.now() < deadline) {
    fresh = readServer(p.pool, p.configPath);
    if (fresh && fresh.pid !== oldPid) break;
    fresh = null;
    await sleep(Math.min(pollMs, 500));
  }
  if (!fresh) return `${RESTART_TIMEOUT_MS / 1000}초 안에 새 서버가 뜨지 않음`;
  Object.assign(p, { pid: fresh.pid, port: fresh.port, entry: fresh.entry, root: fresh.root, lifecycleId: fresh.lifecycleId });

  const status = statusJson(p);
  if (!status?.ok || !status.running) return `${p.pool} status --json이 ok/running이 아님`;
  if (restoring) { say(`확인: ${p.pool} 다시 떠 있음`); return null; }
  const after = JSON.stringify((status.accounts ?? []).map(a => [a.name, a.enabled !== false]));
  if (after !== JSON.stringify(p.accountsBefore)) return `${p.pool} 계정 목록·활성 상태가 전과 다름`;
  let code = null;
  if (p.probeBefore === 200) {
    for (let i = 0; i < 5 && code !== 200; i++) {
      if (i) await sleep(pollMs);
      code = await probeModels(p);
    }
    if (code !== 200) return `${p.pool} 모델 목록 HTTP ${code ?? '응답 없음'}(전에는 200)`;
  } else {
    say(`모델 목록 확인 생략: ${p.pool} — 갱신 전에도 HTTP ${p.probeBefore ?? '응답 없음'}`);
  }
  say(`확인: ${p.pool} status ok, 계정 ${p.accountsBefore.length}개 같음${code === 200 ? ', 모델 목록 200' : ''}`);
  return null;
}

// ── discovery ───────────────────────────────────────────────

function configDir() {
  return process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
}

function discoverServers(pool, ownConfigPath) {
  return Object.keys(POOLS).map(name => {
    const configPath = name === pool ? ownConfigPath : join(configDir(), POOLS[name].file);
    return readServer(name, configPath);
  }).filter(Boolean);
}

/** The pool's live server, located by its state file and the real process command (not the wrapper). */
function readServer(pool, configPath) {
  const state = readJson(configPath.replace(/\.json$/, '') + '.server.json');
  if (!Number.isInteger(state?.pid) || !isAlive(state.pid)) return null;
  // -ww: never truncate the command (a cut path once looked like a wrong install).
  const command = run('ps', ['-ww', '-o', 'command=', '-p', String(state.pid)]).stdout?.trim();
  const entry = command?.split(/\s+/).filter(t => t.startsWith('/')).map(realpathOrNull).find(p => p && /\/src\/(index|teamclaude)\.js$/.test(p));
  if (!entry) return null;
  return {
    pool, configPath, pid: state.pid, port: state.port, entry, root: dirname(dirname(entry)),
    lifecycleId: typeof state.lifecycle?.id === 'string' ? state.lifecycle.id : null,
    config: readJson(configPath) ?? {},
  };
}

function globalInstalls() {
  const share = join(homedir(), '.local', 'share');
  let names = [];
  try { names = readdirSync(share); } catch { /* none */ }
  return names.map(n => join(share, n, 'lib', 'node_modules', 'teamcodex'))
    .filter(p => existsSync(join(p, 'package.json'))).map(p => realpathOrNull(p) ?? p);
}

function isAppPath(p) {
  return p.split('/').includes('teamproxy-app');
}

/** An npm-style install of this package — not a git checkout, which updates with git pull. */
function isInstall(root) {
  return readJson(join(root, 'package.json'))?.name === 'teamcodex' && !existsSync(join(root, '.git'));
}

// ── repository ──────────────────────────────────────────────

function prepareRepo(opts, say, warnings) {
  const own = join(homedir(), 'src', 'teamproxy');
  const expected = process.env.TEAMPROXY_UPDATE_URL || DEFAULT_URL;
  let dir = own;
  if (existsSync(join(own, '.git'))) {
    const origin = run('git', ['-C', own, 'remote', 'get-url', 'origin']).stdout.trim();
    if (normalizeUrl(origin) !== normalizeUrl(expected)) {
      warnings.push('origin_not_fork');
      say(`경고: ${tilde(own)}의 origin(${origin || '없음'})이 포크(${expected})가 아닙니다 — 그 저장소의 커밋을 설치합니다`);
    }
  } else {
    dir = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'teamproxy-update');
    if (!existsSync(join(dir, '.git'))) {
      say(`클론: ${process.env.TEAMPROXY_UPDATE_URL || DEFAULT_URL} → ${tilde(dir)}`);
      git(['clone', '--quiet', process.env.TEAMPROXY_UPDATE_URL || DEFAULT_URL, dir]);
    }
  }
  git(['-C', dir, 'fetch', '--quiet', '--tags', 'origin']);
  const branch = run('git', ['-C', dir, 'rev-parse', '--verify', '-q', `refs/remotes/origin/${opts.ref}^{commit}`]).stdout.trim();
  const commit = branch || run('git', ['-C', dir, 'rev-parse', '--verify', '-q', `${opts.ref}^{commit}`]).stdout.trim();
  if (!commit) throw new Error(`${opts.ref}을(를) ${tilde(dir)}에서 찾지 못했습니다`);
  const short = commit.slice(0, 7);
  // Keep the working clone current too, but only when that cannot clobber anything.
  if (dir === own && branch && !opts.dryRun) {
    const clean = run('git', ['-C', dir, 'status', '--porcelain']).stdout.trim() === '';
    const head = run('git', ['-C', dir, 'symbolic-ref', '--short', '-q', 'HEAD']).stdout.trim();
    if (clean && head === opts.ref) run('git', ['-C', dir, 'merge', '--ff-only', '--quiet', `origin/${opts.ref}`]);
    else say(`${tilde(dir)}는 ${clean ? `${head || 'detached'} 브랜치` : '수정 중'}이라 pull하지 않음(설치에는 ${short} 내용을 씁니다)`);
  }
  say(`받기: ${opts.ref} = ${short} (${tilde(dir)})`);
  return { dir, commit, short };
}

// ── live server ─────────────────────────────────────────────

/** Active requests: the supervisor's own count (x-teamcodex-active-requests); account inflight only on servers without it. */
async function liveStatus(p) {
  try {
    const res = await fetch(`http://127.0.0.1:${p.port}/teamclaude/status`, {
      headers: p.config.proxy?.apiKey ? { 'x-api-key': p.config.proxy.apiKey } : undefined,
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json();
    const header = res.headers.get('x-teamcodex-active-requests');
    return {
      sourceHash: res.headers.get('x-teamcodex-source-hash'),
      active: header != null ? Number(header)
        : (data.accounts ?? []).reduce((n, a) => n + (Number(a.inflight) || 0), 0),
    };
  } catch {
    return null;
  }
}

/** Every pool idle on two consecutive polls, `pollMs` apart. */
async function waitIdle(pools, deadline, pollMs) {
  let idleStreak = 0;
  for (;;) {
    const counts = await Promise.all(pools.map(liveStatus));
    const active = counts.reduce((n, c) => n + (c ? c.active : 0), 0);
    idleStreak = counts.every(c => c && c.active === 0) ? idleStreak + 1 : 0;
    if (idleStreak >= 2) return { ok: true };
    if (Date.now() + pollMs > deadline) return { ok: false, active };
    await sleep(pollMs);
  }
}

/** The supervisor's deployment fence (runbook teamcodex-runtime-deployment): null when this server has none. */
async function drain(p, on) {
  const apiKey = p.config.proxy?.apiKey;
  if (!p.lifecycleId || !apiKey) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${p.port}/teamclaude/deployment/drain`, {
      method: on ? 'POST' : 'DELETE',
      headers: { 'x-api-key': apiKey, 'x-teamcodex-lifecycle-id': p.lifecycleId },
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json();
    return res.ok && data.draining === on && Number.isInteger(data.activeRequests) ? data.activeRequests : null;
  } catch {
    return null;
  }
}

/** Idle, then fenced (new requests get 503 + retry-after while the 15 s lease lasts) with zero in flight. */
async function quiesce(pools, deadline, pollMs) {
  for (;;) {
    const idle = await waitIdle(pools, deadline, pollMs);
    if (!idle.ok) return idle;
    let active = 0;
    const fenced = [];
    for (const p of pools) {
      const n = await drain(p, true);
      if (n === null) continue;
      fenced.push(p);
      active += n;
    }
    if (!active) return { ok: true };
    await Promise.all(fenced.map(p => drain(p, false)));
    if (Date.now() + pollMs > deadline) return { ok: false, active };
  }
}

async function probeModels(p) {
  const probe = POOLS[p.pool].probe();
  try {
    const res = await fetch(`http://127.0.0.1:${p.port}${probe.path}`, {
      method: probe.method ?? 'GET', headers: probe.headers, body: probe.body, signal: AbortSignal.timeout(30_000),
    });
    await res.arrayBuffer();
    return res.status;
  } catch {
    return null;
  }
}

function statusJson(p) {
  const env = { ...process.env, TEAMCLAUDE_CONFIG: p.configPath };
  delete env.TEAMCLAUDE_PROVIDER;
  delete env.TEAMCLAUDE_SESSION_SUPERVISED;
  const r = run(process.execPath, [p.entry, ...POOLS[p.pool].prefix, 'status', '--json'], { env, timeout: 30_000 });
  const last = (r.stdout ?? '').trim().split('\n').pop();
  try { return JSON.parse(last); } catch { return null; }
}

function accountSnapshot(config) {
  return (config.accounts ?? []).map(a => [a.name, a.enabled !== false]);
}

/** A supervisor that starts the pool again: a systemd user unit, or (macOS) a launchd job owning the tmux session. */
function restartMethod(pool) {
  if (run('systemctl', ['--user', 'is-active', '--quiet', pool]).status === 0) {
    return { cmd: ['systemctl', '--user', 'restart', pool], label: `systemctl --user restart ${pool}` };
  }
  if (process.platform !== 'darwin') return null;
  if (run('tmux', ['-L', pool, 'has-session', '-t', 'proxy']).status !== 0) return null;
  const label = launchdLabel(pool);
  if (!label) return null;
  return { cmd: ['tmux', '-L', pool, 'kill-session', '-t', 'proxy'], label: `tmux -L ${pool} kill-session -t proxy (launchd ${label})` };
}

/** The running launchd job for this pool: label `….<pool>`, or one whose process is `<pool>-tmux-server`. */
function launchdLabel(pool) {
  const jobs = run('launchctl', ['list']).stdout.split('\n').map(l => l.trim().split(/\s+/))
    .filter(([pid, , label]) => /^\d+$/.test(pid) && label?.includes(pool));
  const byLabel = jobs.find(([, , label]) => label.endsWith(`.${pool}`));
  if (byLabel) return byLabel[2];
  return jobs.find(([pid]) => run('ps', ['-ww', '-o', 'command=', '-p', pid]).stdout.includes(`${pool}-tmux-server`))?.[2] ?? null;
}

let codexVersion;
function codexClientVersion() {
  codexVersion ??= run('codex', ['--version']).stdout?.match(/\d+\.\d+\.\d+/)?.[0] ?? CODEX_CLIENT_VERSION_FALLBACK;
  return codexVersion;
}

// ── files ───────────────────────────────────────────────────

const IGNORED = new Set(['__pycache__', '.DS_Store']);

/** relative path → git blob id, like `git hash-object`. Python caches are not source. */
function fileMap(dir, prefix = '', out = new Map()) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (IGNORED.has(e.name) || e.name.endsWith('.pyc')) continue;
    const rel = prefix + e.name;
    if (e.isDirectory()) fileMap(join(dir, e.name), `${rel}/`, out);
    else if (e.isFile()) {
      const data = readFileSync(join(dir, e.name));
      out.set(rel, createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex'));
    }
  }
  return out;
}

function diffMaps(from, to) {
  let added = 0; let modified = 0; let removed = 0;
  for (const [k, v] of to) { if (!from.has(k)) added++; else if (from.get(k) !== v) modified++; }
  for (const k of from.keys()) if (!to.has(k)) removed++;
  return { added, modified, removed, total: added + modified + removed };
}

/** Same digest as the supervisor's x-teamcodex-source-hash (index.js runtimeSourceHash). */
function sourceHash(srcDir) {
  const digest = createHash('sha256');
  for (const name of readdirSync(srcDir).filter(n => n.endsWith('.js')).sort()) {
    digest.update(name).update('\0').update(readFileSync(join(srcDir, name))).update('\0');
  }
  return digest.digest('hex');
}

/** Copy the new tree beside src/ first, so the switch itself is two renames. */
function swapIn(root, stage, stamp) {
  const src = join(root, 'src');
  const pkg = join(root, 'package.json');
  const discard = () => {
    for (const f of [`${src}.new-${stamp}`, `${pkg}.new-${stamp}`, `${pkg}.pre-${stamp}`]) rmSync(f, { recursive: true, force: true });
  };
  try {
    cpSync(join(stage, 'src'), `${src}.new-${stamp}`, { recursive: true });
    copyFileSync(join(stage, 'package.json'), `${pkg}.new-${stamp}`);
    copyFileSync(pkg, `${pkg}.pre-${stamp}`);
    renameSync(src, `${src}.pre-${stamp}`);
  } catch (err) {
    discard();
    throw err;
  }
  try {
    renameSync(`${src}.new-${stamp}`, src);
  } catch (err) {
    renameSync(`${src}.pre-${stamp}`, src);
    discard();
    throw err;
  }
  renameSync(`${pkg}.new-${stamp}`, pkg);
}

/** Back to the pre-update files; works from any point of swapIn. The new tree is kept as *.failed-<stamp>. */
function restoreFiles({ root, stamp, prevMarker }) {
  for (const name of ['src', 'package.json']) {
    const live = join(root, name);
    const pre = `${live}.pre-${stamp}`;
    if (!existsSync(pre)) continue;
    if (existsSync(live)) renameSync(live, `${live}.failed-${stamp}`);
    renameSync(pre, live);
  }
  rmSync(join(root, `src.new-${stamp}`), { recursive: true, force: true });
  rmSync(join(root, `package.json.new-${stamp}`), { force: true });
  if (prevMarker == null) rmSync(join(root, MARKER), { force: true });
  else writeFileSync(join(root, MARKER), prevMarker);
}

/** Keep the two newest of each backup kind. */
function pruneBackups(root) {
  const names = readdirSync(root);
  for (const prefix of ['src.pre-', 'package.json.pre-', 'src.failed-', 'package.json.failed-']) {
    for (const old of names.filter(n => n.startsWith(prefix)).sort().slice(0, -2)) rmSync(join(root, old), { recursive: true, force: true });
  }
}

function installState(root) {
  const names = readdirSync(root).filter(n => /^(src|package\.json)(\.|$)/.test(n));
  return names.sort().join(', ') || '비어 있음';
}

/** One update per install at a time; a lock left by a dead process is taken over. */
function acquireLock(root) {
  const file = join(root, '.update.lock');
  for (let i = 0; i < 2; i++) {
    try {
      writeFileSync(file, String(process.pid), { flag: 'wx' });
      return { ok: true, file };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const holder = Number(readText(file));
      if (Number.isInteger(holder) && holder > 0 && isAlive(holder)) return { ok: false, holder };
      rmSync(file, { force: true });
    }
  }
  return { ok: false, holder: '?' };
}

/** Blobs the fork has published: the target, origin/main, and the commit this install was last updated to. */
function historyFor(repo, root) {
  const revs = [repo.commit, 'refs/remotes/origin/main'];
  const installed = readText(join(root, MARKER))?.trim();
  if (/^[0-9a-f]{40}$/.test(installed ?? '')
      && run('git', ['-C', repo.dir, 'cat-file', '-e', `${installed}^{commit}`]).status === 0) revs.push(installed);
  return new Set(git(['-C', repo.dir, 'rev-list', '--objects', ...revs]).split('\n').map(l => l.split(' ')[0]));
}

// ── helpers ─────────────────────────────────────────────────

function run(cmd, args, { input, env, timeout = 60_000, check = false, encoding = 'utf8' } = {}) {
  const r = spawnSync(cmd, args, { input, env, timeout, encoding, maxBuffer: 512 * 1024 * 1024 });
  if (check && r.status !== 0) {
    throw new Error(`${cmd} ${args[0]} 실패: ${String(r.stderr ?? r.error?.message ?? '').trim().split('\n').pop()}`);
  }
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function git(args, opts = {}) {
  return run('git', args, { ...opts, check: true }).stdout;
}

/** https://github.com/o/r(.git) and git@github.com:o/r(.git) compare equal. */
function normalizeUrl(url) {
  return url.trim().replace(/^git@([^:]+):/, 'https://$1/').replace(/\.git$|\/$/g, '').toLowerCase();
}

function readText(path) {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function realpathOrNull(p) {
  try { return realpathSync(p); } catch { return null; }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

function sameBytes(a, b) {
  try { return readFileSync(a).equals(readFileSync(b)); } catch { return false; }
}

/** A backup suffix no earlier run in this install has used (two runs can land in the same second). */
function freeStamp(root) {
  const base = timestamp();
  let stamp = base;
  for (let i = 2; readdirSync(root).some(n => n.endsWith(`-${stamp}`) && /^(src|package\.json)\.(pre|new|failed)-/.test(n)); i++) stamp = `${base}-${i}`;
  return stamp;
}

/** Local YYYYMMDD-HHMMSS, the backup suffix. */
function timestamp() {
  const d = new Date();
  const two = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}

function tilde(p) {
  const home = homedir();
  return p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

function summary(results) {
  const count = r => results.filter(x => x.result === r).length;
  const parts = [['updated', '갱신'], ['updated_no_restart', '갱신(재시작 안 함)'], ['up_to_date', '이미 최신'], ['dry_run', 'dry-run'], ['skipped_app', '앱 모드 건너뜀']]
    .map(([k, label]) => (count(k) ? `${label} ${count(k)}` : null)).filter(Boolean);
  return parts.join(' · ') || '할 일 없음';
}
