// src/win32-update.js updateClone: the Windows `<pool> update` (git clone fast-forward, restart through the task,
// verify, roll back). Real git on throwaway local repos (no network); restart/verify/quiesce are stubs, so no
// task and no server is touched.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceHash } from '../src/update.js';
import { updateClone } from '../src/win32-update.js';

let t;
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.hooksPath=/dev/null',
  '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function commit(dir, content) {
  writeFileSync(join(dir, 'src', 'index.js'), content);
  git(dir, 'add', 'src/index.js');
  git(dir, 'commit', '-q', '-m', content);
  git(dir, 'push', '-q', 'origin', 'HEAD:main');
  return git(dir, 'rev-parse', 'HEAD');
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'teamproxy-win-update-'));
  const origin = join(dir, 'origin.git');
  const work = join(dir, 'work');
  const clone = join(dir, 'clone');
  git(dir, 'init', '-q', '--bare', origin);
  git(dir, 'clone', '-q', origin, work);
  mkdirSync(join(work, 'src'));
  const a = commit(work, 'export const v = 1;\n');
  git(dir, 'clone', '-q', origin, clone);
  const b = commit(work, 'export const v = 2;\n');
  t = { dir, work, clone, a, b };
});

afterEach(() => rmSync(t.dir, { recursive: true, force: true }));

/** Stub ops recording what was asked; `verifyFails` makes verify fail. */
function ops({ live = { sourceHash: 'running', active: 0 }, verifyFails = false, quiet = true } = {}) {
  const calls = [];
  return {
    calls,
    live: async p => { calls.push(['live', p.pool]); return live; },
    quiesce: async pools => { calls.push(['quiesce', pools.map(p => p.pool).join(',')]); return quiet ? { ok: true } : { ok: false, active: 2 }; },
    probe: async () => 200,
    restart: async p => { calls.push(['restart', p.pool, git(t.clone, 'rev-parse', 'HEAD')]); return ''; },
    verify: async p => { calls.push(['verify', p.pool]); return verifyFails ? `${p.pool} 모델 목록 HTTP 502(전에는 200)` : ''; },
  };
}
const pools = () => [{ pool: 'teamcodex', config: { accounts: [{ name: 'c1' }] } }];
const run = (o, extra = {}) => updateClone({ root: t.clone, pools: pools(), say: () => {}, ops: o, ...extra });
const head = () => git(t.clone, 'rev-parse', 'HEAD');

test('updates: fast-forward, quiesce, restart on the new code, verify', async () => {
  const o = ops();
  const r = await run(o);
  assert.equal(r.result, 'updated', r.message);
  assert.equal(r.ok, true);
  assert.equal(head(), t.b);
  assert.deepEqual(o.calls.filter(c => c[0] === 'restart'), [['restart', 'teamcodex', t.b]]);
  assert.ok(o.calls.some(c => c[0] === 'verify'));
});

test('a failed verify rolls the clone back and restarts on the old code', async () => {
  const o = ops({ verifyFails: true });
  const r = await run(o);
  assert.equal(r.result, 'restored', r.message);
  assert.equal(r.ok, false);
  assert.match(r.message, /HTTP 502/);
  assert.equal(head(), t.a);
  assert.deepEqual(o.calls.filter(c => c[0] === 'restart').map(c => c[2]), [t.b, t.a]);
});

test('refuses without changing anything: local edits, busy pool, not a clone, wrong branch', async () => {
  writeFileSync(join(t.clone, 'src', 'index.js'), 'edited\n');
  let r = await run(ops());
  assert.equal(r.result, 'local_changes');
  assert.equal(head(), t.a);
  git(t.clone, 'checkout', '-q', '--', 'src/index.js');

  const busy = ops({ quiet: false });
  r = await run(busy);
  assert.equal(r.result, 'wait_timeout');
  assert.equal(head(), t.a);
  assert.ok(!busy.calls.some(c => c[0] === 'restart'));

  r = await updateClone({ root: t.dir, pools: [], say: () => {}, ops: ops() });
  assert.equal(r.result, 'not_a_clone');

  git(t.clone, 'checkout', '-q', '-b', 'other');
  r = await run(ops());
  assert.equal(r.result, 'not_on_branch');
});

test('up to date: nothing restarted unless a server still runs other code (after --no-restart)', async () => {
  let r = await run(ops(), { restart: false });
  assert.equal(r.result, 'updated_no_restart');
  assert.equal(head(), t.b);

  const current = sourceHash(join(t.clone, 'src'));
  const same = ops({ live: { sourceHash: current, active: 0 } });
  r = await run(same);
  assert.equal(r.result, 'up_to_date');
  assert.ok(!same.calls.some(c => c[0] === 'restart'));

  const stale = ops({ live: { sourceHash: 'older', active: 0 } });
  r = await run(stale);
  assert.equal(r.result, 'updated');
  assert.deepEqual(stale.calls.filter(c => c[0] === 'restart').map(c => c[2]), [t.b]);
});

test('a pool whose task has no running server is updated on disk but not started; --dry-run changes nothing', async () => {
  let r = await run(ops(), { dryRun: true });
  assert.equal(r.result, 'dry_run');
  assert.equal(head(), t.a);

  const down = ops({ live: null });
  r = await run(down);
  assert.equal(r.result, 'updated');
  assert.equal(head(), t.b);
  assert.ok(!down.calls.some(c => c[0] === 'restart'));
});
