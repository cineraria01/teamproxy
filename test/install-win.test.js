// scripts/install-win.mjs (docs/install/INSTALL-WINDOWS.md): wrappers, server .cmd/.vbs, task XML, configs, takeover
// of a hand install, start, remote pool mode. Runs on any OS: TEAMPROXY_APP_PLATFORM=win32 and a fake schtasks
// (test/helpers/fake-schtasks.mjs) under node --test only; a temp USERPROFILE/LOCALAPPDATA. No real task, no pool.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cmdPath, serverCmd, taskXml, wrapperCmd } from '../scripts/install-win.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const INSTALL = join(ROOT, 'scripts', 'install-win.mjs');
const FAKE = join(ROOT, 'test', 'helpers', 'fake-schtasks.mjs');
const CLIS = { claude: 'teamclaude', codex: 'teamcodex', agy: 'teamagy', grok: 'teamgrok', cursor: 'teamcursor' };
let t;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'teamproxy-install-win-'));
  const home = join(dir, 'home');
  const local = join(home, 'AppData', 'Local');
  const fake = join(dir, 'schtasks');
  mkdirSync(join(fake, 'tasks'), { recursive: true });
  mkdirSync(home, { recursive: true });
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('TEAMCLAUDE_') && !k.startsWith('TEAMPROXY_')));
  Object.assign(env, {
    USERPROFILE: home, HOME: home, LOCALAPPDATA: local, USERDOMAIN: 'PC', USERNAME: 'me',
    Path: `${join(home, '.local', 'bin')};C:\\Windows`, NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT || 'child-v8',
    TEAMPROXY_APP_PLATFORM: 'win32', TEAMPROXY_WIN_SCHTASKS: FAKE, FAKE_SCHTASKS_DIR: fake,
  });
  t = { dir, home, local, fake, env, tp: join(local, 'teamproxy'), bin: join(home, '.local', 'bin') };
});

afterEach(() => rmSync(t.dir, { recursive: true, force: true }));

const install = (args, env = {}) => new Promise(done => {
  execFile(process.execPath, [INSTALL, ...args], { env: { ...t.env, ...env }, timeout: 60_000 }, (error, stdout, stderr) => {
    done({ code: error ? (error.code ?? 1) : 0, out: stdout + stderr });
  });
});
const calls = () => (existsSync(join(t.fake, 'calls.log')) ? readFileSync(join(t.fake, 'calls.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []);
const configOf = pool => join(t.home, '.config', `${CLIS[pool]}.json`);
const utf16 = file => readFileSync(file).toString('utf16le');

test('fresh install --pools all: wrapper, server cmd/vbs, task and config per pool, in the shapes Windows reads', async () => {
  const r = await install(['--pools', 'all', '--no-start']);
  assert.equal(r.code, 0, r.out);
  for (const [pool, cli] of Object.entries(CLIS)) {
    const wrapper = readFileSync(join(t.bin, `${cli}.cmd`));
    assert.ok(wrapper.every(b => b < 0x80), `${cli}.cmd is ASCII`);
    const text = wrapper.toString('ascii');
    assert.ok(!/[^\r]\n/.test(text) && text.endsWith('\r\n'), `${cli}.cmd is CRLF`);
    assert.match(text, new RegExp(`set "TEAMCLAUDE_CONFIG=%USERPROFILE%[\\\\/]\\.config[\\\\/]${cli}\\.json"`));
    assert.match(text, new RegExp(`teamproxy-win32\\.js" ${pool} %\\*\\r\\n`));

    const server = readFileSync(join(t.tp, `${cli}-server.cmd`), 'ascii');
    const prefix = pool === 'claude' ? '' : `${pool} `;
    assert.match(server, new RegExp(`index\\.js" ${prefix}server >> "%LOG%" 2>&1`));
    assert.match(server, new RegExp(`set "LOG=%LOCALAPPDATA%[\\\\/]teamproxy[\\\\/]logs[\\\\/]${cli}\\.log"`));
    assert.match(server, /set "TEAMCLAUDE_PROVIDER="/);
    const vbs = readFileSync(join(t.tp, `${cli}-server.vbs`), 'ascii');
    const target = ['%LOCALAPPDATA%', 'teamproxy', `${cli}-server.cmd`].join(sep);
    assert.ok(vbs.includes(`WScript.Quit shell.Run("cmd.exe /d /c """ & shell.ExpandEnvironmentStrings("${target}") & """", 0, True)`), vbs);

    const xml = readFileSync(join(t.fake, 'tasks', `${cli}.xml`));
    assert.deepEqual([...xml.subarray(0, 2)], [0xff, 0xfe], 'UTF-16LE with BOM');
    const task = utf16(join(t.fake, 'tasks', `${cli}.xml`));
    for (const piece of ['<LogonTrigger>', '<UserId>PC\\me</UserId>', '<LogonType>InteractiveToken</LogonType>',
      '<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>', '<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
      '<Interval>PT1M</Interval>', '<Count>9999</Count>', '<Command>wscript.exe</Command>', `<Arguments>//B //Nologo "${join(t.tp, `${cli}-server.vbs`)}"</Arguments>`]) {
      assert.ok(task.includes(piece), `${cli} task has ${piece}`);
    }

    const config = JSON.parse(readFileSync(configOf(pool), 'utf8'));
    assert.equal(config.proxy.host, '127.0.0.1');
    assert.equal(config.proxy.allowNoAccounts, true);
    assert.equal(config.provider, pool === 'claude' ? 'anthropic' : pool);
    assert.deepEqual(config.accounts ?? [], []);
  }
  assert.deepEqual(calls().filter(c => c[0] === '/Create').map(c => c[2]).sort(), Object.values(CLIS).sort());
  assert.ok(!calls().some(c => c[0] === '/Run'), '--no-start starts nothing');
});

test('default bundle is claude + codex; a second run changes nothing (no backups, no task re-create)', async () => {
  assert.equal((await install(['--no-start'])).code, 0);
  assert.deepEqual(readdirSync(t.bin).sort(), ['teamclaude.cmd', 'teamcodex.cmd']);
  const before = calls().length;
  const again = await install(['--no-start']);
  assert.equal(again.code, 0, again.out);
  assert.ok(!calls().slice(before).some(c => c[0] === '/Create'), again.out);
  assert.ok(![...readdirSync(t.bin), ...readdirSync(t.tp)].some(n => n.includes('.bak-install-')));
});

test('takes over a hand install: differing files and the task are backed up, the config (accounts) stays byte-identical', async () => {
  mkdirSync(t.bin, { recursive: true });
  writeFileSync(join(t.bin, 'teamcodex.cmd'), '@echo off\r\nrem hand-made\r\n');
  const config = `${JSON.stringify({ provider: 'codex', proxy: { port: 3457 }, accounts: [{ name: 'codex-1' }] }, null, 2)}\n`;
  mkdirSync(join(t.home, '.config'), { recursive: true });
  writeFileSync(configOf('codex'), config);
  writeFileSync(join(t.fake, 'tasks', 'teamcodex.xml'), '<Task>hand</Task>');

  const r = await install(['--pools', 'codex', '--no-start']);
  assert.equal(r.code, 0, r.out);
  assert.equal(readFileSync(configOf('codex'), 'utf8'), config);
  assert.match(r.out, /proxy\.host가 비어 있어/);
  const bak = readdirSync(t.bin).find(n => n.startsWith('teamcodex.cmd.bak-install-'));
  assert.equal(readFileSync(join(t.bin, bak), 'utf8'), '@echo off\r\nrem hand-made\r\n');
  const taskBak = readdirSync(t.tp).find(n => /^teamcodex\.task\.bak-install-.*\.xml$/.test(n));
  assert.equal(readFileSync(join(t.tp, taskBak), 'utf8'), '<Task>hand</Task>');
  assert.match(utf16(join(t.fake, 'tasks', 'teamcodex.xml')), /teamcodex-server\.vbs/);
});

test('start: a task whose port is free is run; a server already answering is left alone', async () => {
  const busy = http.createServer((_, res) => res.end('{}'));
  await new Promise(done => busy.listen(0, '127.0.0.1', done));
  try {
    mkdirSync(join(t.home, '.config'), { recursive: true });
    writeFileSync(configOf('claude'), JSON.stringify({ proxy: { port: busy.address().port, host: '127.0.0.1' }, accounts: [] }));
    const free = http.createServer();
    await new Promise(done => free.listen(0, '127.0.0.1', done));
    const freePort = free.address().port;
    await new Promise(done => free.close(done));
    writeFileSync(configOf('codex'), JSON.stringify({ provider: 'codex', proxy: { port: freePort, host: '127.0.0.1' }, accounts: [] }));
    const r = await install([]);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(calls().filter(c => c[0] === '/Run').map(c => c[2]), ['teamcodex']);
    assert.match(r.out, /teamclaude: 서버가 이미 :\d+에서 응답합니다/);
  } finally {
    await new Promise(done => busy.close(done));
  }
});

test('a refused /Create fails with the admin hint and leaves no marker, so the next run tries again', async () => {
  const r = await install(['--pools', 'claude', '--no-start'], { FAKE_SCHTASKS_DENY: '1' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /Access is denied[\s\S]*관리자 PowerShell/);
  assert.ok(!existsSync(join(t.tp, 'teamclaude.task.xml')));
  assert.ok(!existsSync(join(t.tp, 'teamclaude.task.xml.new')));
  const ok = await install(['--pools', 'claude', '--no-start']);
  assert.equal(ok.code, 0, ok.out);
  assert.ok(existsSync(join(t.fake, 'tasks', 'teamclaude.xml')));
});

test('--remote: teamclaude wrapper and remote use (client saved), no teamclaude task or local config; codex stays local', async () => {
  const token = join(t.dir, 'token.txt');
  writeFileSync(token, 'tp-remote-token-abcdefghijklmnop\n');
  const r = await install(['--pools', 'codex', '--remote', 'https://pool.example.ts.net:8456', '--token-file', token, '--no-check', '--no-start']);
  assert.equal(r.code, 0, r.out);
  assert.ok(existsSync(join(t.bin, 'teamclaude.cmd')));
  assert.ok(!existsSync(join(t.fake, 'tasks', 'teamclaude.xml')));
  assert.ok(!existsSync(join(t.tp, 'teamclaude-server.cmd')));
  assert.ok(existsSync(join(t.fake, 'tasks', 'teamcodex.xml')));
  const config = JSON.parse(readFileSync(configOf('claude'), 'utf8'));
  assert.equal(config.client?.url, 'https://pool.example.ts.net:8456');
  assert.ok(!r.out.includes('tp-remote-token-abcdefghijklmnop'), 'the token is never printed');
});

test('--dry-run writes nothing; bad arguments and non-Windows are refused', async () => {
  const dry = await install(['--pools', 'all', '--dry-run']);
  assert.equal(dry.code, 0, dry.out);
  assert.ok(!existsSync(t.bin) && !existsSync(t.tp) && !existsSync(join(t.home, '.config')));
  assert.ok(!calls().some(c => c[0] === '/Create' || c[0] === '/Run'));
  assert.equal((await install(['--pools', 'claude,nope'])).code, 1);
  assert.equal((await install(['--token-file', 'x'])).code, 1);
  assert.equal((await install([], { TEAMPROXY_APP_PLATFORM: 'linux' })).code, 2);
});

test('template builders: %USERPROFILE%/%LOCALAPPDATA% spelling, ASCII-only .cmd, claude has no prefix', () => {
  const L = { home: 'C:\\Users\\홍길동', local: 'C:\\Users\\홍길동\\AppData\\Local', dir: 'C:\\Users\\홍길동\\AppData\\Local\\teamproxy' };
  assert.equal(cmdPath('C:\\Users\\홍길동\\src\\teamproxy', L), '%USERPROFILE%\\src\\teamproxy');
  assert.equal(cmdPath('c:\\users\\홍길동\\AppData\\Local\\teamproxy\\x.cmd', L), '%LOCALAPPDATA%\\teamproxy\\x.cmd');
  assert.equal(cmdPath('C:\\Program Files\\nodejs\\node.exe', L), 'C:\\Program Files\\nodejs\\node.exe');
  // A Korean user name is fine (it hides behind %USERPROFILE%); a Korean path outside it is refused, not mangled.
  const ok = { node: 'C:\\Program Files\\nodejs\\node.exe', root: 'C:\\Users\\홍길동\\src\\teamproxy', config: 'C:\\Users\\홍길동\\.config\\teamclaude.json', L };
  assert.ok(wrapperCmd('claude', ok).every(b => b < 0x80));
  assert.match(serverCmd('claude', ok).toString('ascii'), /src[\\/]index\.js" server >>/);
  assert.throws(() => wrapperCmd('claude', { ...ok, node: 'D:\\도구\\node.exe' }), /ASCII 밖 글자/);
  assert.throws(() => wrapperCmd('claude', { ...ok, node: 'D:\\100%\\node.exe' }), /% 또는 "/);
  assert.match(taskXml('codex', { user: 'PC\\홍길동', L }).toString('utf16le'), /<UserId>PC\\홍길동<\/UserId>/);
});
