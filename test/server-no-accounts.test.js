import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

async function freePort() {
  const holder = http.createServer();
  await new Promise(resolve => holder.listen(0, resolve));
  const { port } = holder.address();
  await new Promise(resolve => holder.close(resolve));
  return port;
}

function request(port, path, method = 'GET', body) {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json' } }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', () => resolve(null));
    req.end(body);
  });
}

async function waitFor(check, what) {
  for (let i = 0; i < 100; i += 1) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(`timed out: ${what}`);
}

async function start(proxy) {
  const port = await freePort();
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-noacct-'));
  const configPath = join(dir, 'config.json');
  const config = { proxy: { port, apiKey: 'tc-test', ...proxy }, upstream: 'http://127.0.0.1:9', activeWarmup: false, accounts: [] };
  await writeFile(configPath, JSON.stringify(config));
  const child = spawn(process.execPath, [cliPath, 'server'], {
    env: { ...process.env, TEAMCLAUDE_PROVIDER: 'anthropic', TEAMCLAUDE_CONFIG: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  return { child, port, config, configPath, dir, stderr: () => stderr };
}

test('without proxy.allowNoAccounts an empty config still exits', async () => {
  const s = await start({});
  const [code] = await once(s.child, 'exit');
  assert.equal(code, 1);
  assert.match(s.stderr(), /No accounts configured/);
});

test('proxy.allowNoAccounts: stays up, answers 503 to API calls, and picks up a login via SIGHUP', async () => {
  const s = await start({ allowNoAccounts: true });
  try {
    const status = await waitFor(async () => {
      const r = await request(s.port, '/teamclaude/status');
      return r?.status === 200 ? JSON.parse(r.text) : null;
    }, 'status 200');
    assert.equal(status.totalCount, 0);

    const api = await request(s.port, '/v1/messages', 'POST', '{"model":"x","messages":[]}');
    assert.equal(api.status, 503, api.text);
    assert.match(api.text, /계정이 없습니다/);

    s.config.accounts = [{ name: 'api-test', type: 'apikey', apiKey: 'sk-ant-test' }];
    await writeFile(s.configPath, JSON.stringify(s.config));
    const state = await waitFor(async () => {
      try {
        const value = JSON.parse(await readFile(s.configPath.replace(/\.json$/, '.server.json'), 'utf8'));
        return value.workerPid ? value : null;
      } catch { return null; }
    }, 'server state with workerPid');
    process.kill(state.workerPid, 'SIGHUP'); // what `<pool> login` sends (noteRunningServerReload)
    await waitFor(async () => {
      const r = await request(s.port, '/teamclaude/status');
      return r?.status === 200 && JSON.parse(r.text).totalCount === 1;
    }, 'totalCount 1 after SIGHUP');
  } finally {
    s.child.kill('SIGTERM');
    await once(s.child, 'exit');
  }
});
