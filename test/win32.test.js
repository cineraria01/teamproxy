// Windows-only pieces of installed pools (src/win32.js, src/teamproxy-win32.js): the teamcodex exec -c guard, the
// pool entry, and stop/restart through the scheduled task. Runs on any OS (fake schtasks under node --test only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexExecConfigError, decodeSchtasksOutput, taskLifecycle, taskStart } from '../src/win32.js';

const ENTRY = fileURLToPath(new URL('../src/teamproxy-win32.js', import.meta.url));
const FAKE = fileURLToPath(new URL('./helpers/fake-schtasks.mjs', import.meta.url));

test('codexExecConfigError: refuses -c after exec, like the macOS teamcodex wrapper', () => {
  const refused = argv => codexExecConfigError(['run', '--', ...argv]) !== null;
  assert.equal(refused(['exec', '-c', 'x=1']), true);
  assert.equal(refused(['e', '-cx=1']), true);
  assert.equal(refused(['--yolo', 'exec', '--json', '--config=x=1']), true);
  // As in sh: a flag's value before the subcommand is not skipped (only -c/--config's is), so `o` is taken as it.
  assert.equal(refused(['-m', 'o', 'exec', '-c', 'x']), false);
  assert.equal(refused(['-c', 'model=x', 'exec', 'hi']), false, '-c before exec is the right order');
  assert.equal(refused(['-c', 'exec', 'resume']), false, "-c's value is not the subcommand");
  assert.equal(refused(['exec', '--', '-c']), false, 'after -- it is the prompt');
  assert.equal(refused(['resume', '-c', 'x']), false, 'other subcommands are not guarded');
  assert.equal(codexExecConfigError(['status', 'exec', '-c']), null, 'only the CLI path (run --)');
});

const node = (args, env = {}) => new Promise(done => {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('TEAMCLAUDE_') && !k.startsWith('TEAMPROXY_')));
  execFile(process.execPath, args, { env: { ...clean, ...env }, timeout: 30_000 }, (error, stdout, stderr) => {
    done({ code: error ? (error.code ?? 1) : 0, out: stdout + stderr });
  });
});

const freePort = () => new Promise(done => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); });
});

test('teamproxy-win32.js: pool prefix and the wrapper rule; teamcodex exec -c exits 2; an unknown pool exits 2', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'teamproxy-win32-'));
  try {
    writeFileSync(join(dir, 'agy.json'), JSON.stringify({ provider: 'agy', proxy: { port: await freePort() }, accounts: [] }));
    const help = await node([ENTRY, 'agy', '-h'], { TEAMCLAUDE_CONFIG: join(dir, 'agy.json') });
    assert.equal(help.code, 0, help.out);
    assert.match(help.out, /Usage: teamagy/);
    const guard = await node([ENTRY, 'codex', '--', 'exec', '-c', 'x=1'], { TEAMCLAUDE_CONFIG: join(dir, 'codex.json') });
    assert.equal(guard.code, 2, guard.out);
    assert.match(guard.out, /exec 뒤의 '-c'/);
    assert.equal((await node([ENTRY, 'bogus', 'status'])).code, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stop through the task (win32): no server → nothing ended; without the task the usual path answers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'teamproxy-win32-task-'));
  try {
    mkdirSync(join(dir, 'fake', 'tasks'), { recursive: true });
    writeFileSync(join(dir, 'grok.json'), JSON.stringify({ provider: 'grok', proxy: { port: await freePort() }, accounts: [] }));
    const env = {
      TEAMCLAUDE_CONFIG: join(dir, 'grok.json'), NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT || 'child-v8',
      TEAMPROXY_APP_PLATFORM: 'win32', TEAMPROXY_WIN_SCHTASKS: FAKE, FAKE_SCHTASKS_DIR: join(dir, 'fake'),
    };
    const none = await node([ENTRY, 'grok', 'stop'], env);
    assert.equal(none.code, 0, none.out);
    assert.match(none.out, /No TeamClaude server is running/);
    writeFileSync(join(dir, 'fake', 'tasks', 'teamgrok.xml'), '<Task/>');
    const viaTask = await node([ENTRY, 'grok', 'stop'], env);
    assert.equal(viaTask.code, 0, viaTask.out);
    assert.match(viaTask.out, /\[teamgrok\] 떠 있는 서버가 없습니다/);
    const calls = readFileSync(join(dir, 'fake', 'calls.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(calls.map(c => c[0]), ['/Query', '/Query']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A scripted schtasks: /End takes the server down, /Run brings it up (unless told otherwise). */
function fakeRun({ task = true, endWorks = true, runStatus = 0, startsServer = true, up = true } = {}) {
  const state = { up, calls: [] };
  state.run = (_cmd, args) => {
    state.calls.push(args[0]);
    if (args[0] === '/Query') return { status: task ? 0 : 1 };
    if (args[0] === '/End' && endWorks) state.up = false;
    if (args[0] === '/Run') { if (runStatus === 0 && startsServer) state.up = true; return { status: runStatus }; }
    return { status: 0 };
  };
  state.isUp = async () => state.up;
  return state;
}

test('taskLifecycle: no task → null; restart = End, wait down, Run, wait up; failures are lines, never a pid signal', async () => {
  const opts = s => ({ cli: 'teamcodex', isUp: s.isUp, run: s.run, say: () => {}, stopMs: 300, startMs: 300 });
  let s = fakeRun({ task: false });
  assert.equal(await taskLifecycle('restart', opts(s)), null);
  assert.deepEqual(s.calls, ['/Query']);

  s = fakeRun();
  assert.equal(await taskLifecycle('restart', opts(s)), '');
  assert.deepEqual(s.calls, ['/Query', '/End', '/Run']);
  assert.equal(s.up, true);

  s = fakeRun();
  assert.equal(await taskLifecycle('stop', opts(s)), '');
  assert.deepEqual(s.calls, ['/Query', '/End']);
  assert.equal(s.up, false);

  s = fakeRun({ up: false });
  assert.equal(await taskLifecycle('restart', opts(s)), '', 'a stopped pool is just started');
  assert.deepEqual(s.calls, ['/Query', '/Run']);

  s = fakeRun({ endWorks: false });
  assert.match(await taskLifecycle('restart', opts(s)), /계속 응답합니다.*taskkill/);
  assert.deepEqual(s.calls, ['/Query', '/End'], 'not started again over a server it did not stop');

  s = fakeRun({ runStatus: 1 });
  assert.match(await taskLifecycle('restart', opts(s)), /schtasks \/Run \/TN teamcodex 실패/);

  s = fakeRun({ startsServer: false });
  assert.match(await taskLifecycle('restart', opts(s)), /응답하지 않습니다.*teamcodex\.log/);

  // /End is hard: the drain runs first, and a busy pool is said to be cut, not waited on forever.
  s = fakeRun();
  const order = [];
  const said = [];
  const busy = async () => { order.push(s.calls.length); return { ok: false, active: 2 }; };
  assert.equal(await taskLifecycle('stop', { ...opts(s), quiesce: busy, say: line => said.push(line) }), '');
  assert.deepEqual(order, [1], 'quiesce ran after /Query, before /End');
  assert.match(said[0], /진행 중 요청 2개가 끊깁니다/);
});

test('taskStart: /Run only for an existing task; decodeSchtasksOutput reads UTF-16, UTF-8 and CP949', () => {
  assert.equal(taskStart('teamgrok', fakeRun({ task: false }).run), false);
  const s = fakeRun({ up: false });
  assert.equal(taskStart('teamgrok', s.run), true);
  assert.deepEqual(s.calls, ['/Query', '/Run']);

  const xml = '<UserId>PC\\홍길동</UserId>';
  assert.equal(decodeSchtasksOutput(Buffer.from(`﻿${xml}`, 'utf16le')), xml);
  assert.equal(decodeSchtasksOutput(Buffer.from(xml, 'utf8')), xml);
  const cp949 = Buffer.from([...Buffer.from('<UserId>PC\\'), 0xc8, 0xab, 0xb1, 0xe6, 0xb5, 0xbf, ...Buffer.from('</UserId>')]);
  assert.equal(decodeSchtasksOutput(cp949), xml);
});
