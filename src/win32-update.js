// `<pool> update` on Windows (src/platform.js picks it; macOS/Linux keep src/update.js). A Windows install is the
// git clone the CLI runs from (scripts/install-win.mjs, default %USERPROFILE%\src\teamproxy), shared by every pool,
// so an update fast-forwards that clone to origin/<ref>, then restarts each pool whose scheduled task runs a
// server (Task Scheduler, src/win32.js taskLifecycle) and verifies it as src/update.js does. Any failure moves the
// clone back to the old commit (`git reset --keep`, the tree was clean) and restarts what was restarted.
// Not handled: Ctrl-C mid-update (the clone stays where it was interrupted; rerun update or reset by hand).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emit } from './app-json.js';
import { accountSnapshot, liveStatus, probeModels, quiesce, sourceHash, statusJson } from './update.js';
import { POOLS, taskExists, taskLifecycle } from './win32.js';

const SELF_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const USAGE = 'Usage: <pool> update [--dry-run] [--no-restart] [--ref <branch>] [--wait <seconds>] [--json]'
  + '   (Windows: 이 git 클론 하나를 갱신하고 작업으로 도는 풀을 모두 다시 띄웁니다. --all도 같은 뜻)';
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function updateCommand({ pool, configPath, argv }) {
  const opts = { ref: 'main', dryRun: false, restart: true, waitSec: 600, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') continue;
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--no-restart') opts.restart = false;
    else if (a === '--json') opts.json = true;
    else if (a === '--ref' && argv[i + 1]) opts.ref = argv[++i];
    else if (a === '--wait' && Number(argv[i + 1]) >= 0) opts.waitSec = Number(argv[++i]);
    else { console.error(USAGE); return 2; }
  }
  const pollMs = Number(process.env.TEAMPROXY_UPDATE_POLL_MS) || 2000;
  const say = line => (opts.json ? console.error : console.log)(`[${pool} update] ${line}`);
  let result;
  try {
    result = await updateClone({ root: SELF_ROOT, ...opts, pools: taskPools(pool, configPath), say, ops: liveOps(pollMs, say) });
  } catch (err) {
    result = { ok: false, result: 'update_failed', message: err.message };
  }
  say(`${result.ok ? '끝' : '실패'}: ${result.message}`);
  if (opts.json) emit(result);
  return result.ok ? 0 : 1;
}

/** Pools with a scheduled task of their name and a config: { pool (= cli), configPath, config, port, lifecycleId, entry }. */
function taskPools(ownCli, ownConfigPath) {
  const dir = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return Object.values(POOLS).flatMap(({ cli, config: file, port }) => {
    const configPath = cli === ownCli ? ownConfigPath : join(dir, file);
    const config = readJson(configPath);
    if (!config || !taskExists(cli)) return [];
    const state = readJson(configPath.replace(/\.json$/, '') + '.server.json');
    return [{
      pool: cli, configPath, config, port: state?.port ?? config.proxy?.port ?? port,
      lifecycleId: typeof state?.lifecycle?.id === 'string' ? state.lifecycle.id : null,
      entry: join(SELF_ROOT, 'src', 'index.js'),
    }];
  });
}

/** The real servers: what updateClone asks of a pool. Tests pass their own. */
function liveOps(pollMs, say) {
  return {
    live: p => liveStatus(p),
    quiesce: (pools, deadline) => quiesce(pools, deadline, pollMs),
    probe: p => probeModels(p),
    async restart(p) {
      const failure = await taskLifecycle('restart', { cli: p.pool, isUp: async () => Boolean(await liveStatus(p)), say });
      return failure ?? `작업 ${p.pool}이 없어졌습니다`;
    },
    async verify(p) {
      const status = statusJson(p);
      if (!status?.ok || !status.running) return `${p.pool} status --json이 ok/running이 아님`;
      const after = JSON.stringify((status.accounts ?? []).map(a => [a.name, a.enabled !== false]));
      if (after !== JSON.stringify(p.before.accounts)) return `${p.pool} 계정 목록·활성 상태가 전과 다름`;
      if (p.before.models !== 200) return '';
      let code = null;
      for (let i = 0; i < 5 && code !== 200; i++) {
        if (i) await sleep(pollMs);
        code = await probeModels(p);
      }
      return code === 200 ? '' : `${p.pool} 모델 목록 HTTP ${code ?? '응답 없음'}(전에는 200)`;
    },
  };
}

/**
 * The update itself. `ops`: live(p) → {sourceHash, active} | null, quiesce(pools, deadline) → {ok, active},
 * probe(p) → HTTP status | null, restart(p) / verify(p) → '' or a failure line.
 * Returns { ok, result, message, from?, to?, pools? }.
 */
export async function updateClone({ root, ref = 'main', dryRun = false, restart = true, waitSec = 600, pools, say, ops }) {
  const git = (...args) => {
    const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 120_000 });
    return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? r.error?.message ?? '').trim() };
  };
  const fail = (result, message, extra = {}) => ({ ok: false, result, message, ...extra });
  if (!existsSync(join(root, '.git'))) {
    return fail('not_a_clone', `${root}은 git 클론이 아닙니다 — scripts/install-win.mjs로 깐 클론에서 실행하세요(앱 모드는 앱이 갱신)`);
  }
  const dirty = git('status', '--porcelain', '--untracked-files=no').out;
  if (dirty) return fail('local_changes', `${root}에 커밋 안 한 수정이 있습니다 — ${dirty.split('\n').map(l => l.slice(3)).join(', ')}`);
  const branch = git('symbolic-ref', '--short', '-q', 'HEAD').out;
  if (branch !== ref) return fail('not_on_branch', `${root}가 ${branch || 'detached HEAD'}에 있습니다(${ref}이어야 함)`);
  const fetched = git('fetch', '--quiet', 'origin');
  if (!fetched.ok) return fail('fetch_failed', `git fetch 실패: ${fetched.err.split('\n').pop()}`);
  const from = git('rev-parse', 'HEAD').out;
  const to = git('rev-parse', '--verify', '-q', `refs/remotes/origin/${ref}^{commit}`).out;
  if (!to) return fail('no_ref', `origin/${ref}이 없습니다`);
  const short = { from: from.slice(0, 7), to: to.slice(0, 7) };
  if (from !== to && !git('merge-base', '--is-ancestor', from, to).ok) {
    return fail('diverged', `${root}의 ${ref}(${short.from})가 origin/${ref}(${short.to})에서 갈라졌습니다 — 손으로 정리하세요`, short);
  }

  // Which servers to restart: all live ones when the code changes, else those still on other code (--no-restart).
  const localHash = () => sourceHash(join(root, 'src'));
  const live = [];
  for (const p of pools) {
    const status = await ops.live(p);
    if (status) live.push(Object.assign(p, { sourceHash: status.sourceHash }));
    else say(`${p.pool}: 작업은 있지만 서버가 떠 있지 않아 다시 띄우지 않습니다`);
  }
  const restartPools = !restart ? [] : from !== to ? live : live.filter(p => p.sourceHash !== localHash());
  const names = restartPools.map(p => p.pool).join(', ') || '없음';
  if (from === to && !restartPools.length) return { ok: true, result: 'up_to_date', message: `이미 최신(${short.to})`, ...short };
  say(`${short.from} → ${short.to}, 다시 띄울 풀: ${names}`);
  if (dryRun) return { ok: true, result: 'dry_run', message: `(dry-run) ${short.from} → ${short.to}, 다시 띄울 풀: ${names} — 아무것도 바꾸지 않았습니다`, ...short };

  for (const p of restartPools) p.before = { accounts: accountSnapshot(p.config), models: await ops.probe(p) };
  if (restartPools.length) {
    say(`요청 0 기다림: ${names} (최대 ${waitSec}초)`);
    const quiet = await ops.quiesce(restartPools, Date.now() + waitSec * 1000);
    if (!quiet.ok) return fail('wait_timeout', `진행 중 요청 ${quiet.active}개 — 쉴 때 다시 실행하세요(--wait로 늘리기). 아무것도 바꾸지 않았습니다`, short);
  }
  if (from !== to) {
    const merged = git('merge', '--ff-only', '--quiet', to);
    if (!merged.ok) return fail('merge_failed', `git merge --ff-only 실패: ${merged.err.split('\n').pop()}`, short);
    say(`클론을 ${short.to}로 옮김(되돌리기: git -C "${root}" reset --keep ${short.from})`);
  }
  if (!restart) return { ok: true, result: 'updated_no_restart', message: `${short.to}로 갱신, 다시 띄우지 않음 — 다음 restart 때 반영`, ...short };

  const restarted = [];
  let failure = '';
  for (const p of restartPools) {
    const quiet = await ops.quiesce([p], Date.now() + waitSec * 1000); // the drain lease is short: renew per pool
    if (!quiet.ok) { failure = `${p.pool} 진행 중 요청 ${quiet.active}개`; break; }
    restarted.push(p);
    failure = await ops.restart(p) || await ops.verify(p);
    if (failure) break;
    say(`확인: ${p.pool}`);
  }
  if (!failure) return { ok: true, result: 'updated', message: `${short.to}로 갱신, 다시 띄움: ${names}`, ...short };
  if (from === to) return fail('restart_failed', `재시작 실패: ${failure} — 코드는 그대로입니다`, short);

  say(`확인 실패: ${failure} — ${short.from}로 되돌립니다`);
  const back = git('reset', '--keep', '--quiet', from);
  if (!back.ok) return fail('restore_failed', `되돌리기 실패(git reset --keep ${short.from}): ${back.err.split('\n').pop()}`, { ...short, failure });
  for (const p of restarted) {
    const again = await ops.restart(p);
    if (again) return fail('restore_failed', `${short.from}로 되돌렸지만 ${p.pool}을 다시 띄우지 못함: ${again}`, { ...short, failure });
  }
  return fail('restored', `${failure} — ${short.from}로 되돌리고 다시 띄웠습니다`, { ...short, failure });
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}
