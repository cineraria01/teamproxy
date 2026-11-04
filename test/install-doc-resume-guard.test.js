import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// docs/install/INSTALL-ALL.md §1-2 builds ~/.local/bin/teamclaude; its resume guard must refuse a second run of a
// session that a live Claude already runs (exit 75) and let everything else through.
const doc = fileURLToPath(new URL('../docs/install/INSTALL-ALL.md', import.meta.url));

async function buildWrapper() {
  const text = await readFile(doc, 'utf8');
  const start = text.indexOf('cat > ~/.local/bin/teamclaude <<EOF\n');
  const end = text.indexOf('teamclaude --help | head -3', start);   // through the chmod line
  assert.ok(start >= 0 && end > start, 'wrapper recipe found in INSTALL-ALL.md §1-2');
  const home = await mkdtemp(join(tmpdir(), 'teamclaude-resume-guard-'));
  await mkdir(join(home, '.local', 'bin'), { recursive: true });
  await mkdir(join(home, '.claude', 'sessions'), { recursive: true });
  const made = spawnSync('/bin/sh', ['-c', text.slice(start, end)], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  return home;
}

function run(home, args) {
  const env = { ...process.env, HOME: home };
  delete env.CLAUDE_CONFIG_DIR;
  return spawnSync(join(home, '.local', 'bin', 'teamclaude'), args, { env, encoding: 'utf8', timeout: 20000 });
}

test('install doc wrapper refuses to resume a session a live process runs', async (t) => {
  const home = await buildWrapper();
  const live = spawn('sleep', ['60']);
  t.after(async () => { live.kill(); await rm(home, { recursive: true, force: true }); });
  const lstart = spawnSync('ps', ['-o', 'lstart=', '-p', String(live.pid)], { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, encoding: 'utf8' }).stdout.trim();
  const id = '11111111-2222-3333-4444-555555555555';
  // Claude writes compact JSON without a trailing newline
  await writeFile(join(home, '.claude', 'sessions', `${live.pid}.json`),
    JSON.stringify({ pid: live.pid, sessionId: id, cwd: '/tmp/work', name: 'busy-one', procStart: lstart }));

  for (const args of [['run', '--', '--resume', id], ['--', '-r', id], [`--resume=${id}`]]) {
    const r = run(home, args);
    assert.equal(r.status, 75, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`세션 11111111는 pid ${live.pid}\\(busy-one, cwd /tmp/work\\)`));
  }

  // another id, or the same id whose process started at another time (pid reused), goes past the guard
  const other = run(home, ['-h', '--resume', '99999999-2222-3333-4444-555555555555']);
  assert.notEqual(other.status, 75, other.stderr);
  assert.doesNotMatch(other.stderr, /이미 돌리는 중/);
  await writeFile(join(home, '.claude', 'sessions', `${live.pid}.json`),
    JSON.stringify({ pid: live.pid, sessionId: id, cwd: '/tmp/work', name: 'busy-one', procStart: 'Mon Jan  1 00:00:00 2001' }));
  const reused = run(home, ['-h', '--resume', id]);
  assert.notEqual(reused.status, 75, reused.stderr);
});
