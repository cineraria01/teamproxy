import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
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

async function startServer(host) {
  const port = await freePort();
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-host-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    proxy: { port, apiKey: 'tc-test', ...(host ? { host } : {}) },
    upstream: 'http://127.0.0.1:9',
    activeWarmup: false,
    accounts: [{ name: 'api-test', type: 'apikey', apiKey: 'sk-ant-test' }],
  }));
  const child = spawn(process.execPath, [cliPath, 'server'], {
    env: { ...process.env, TEAMCLAUDE_PROVIDER: 'anthropic', TEAMCLAUDE_CONFIG: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  return { child, port, stderr: () => stderr };
}

async function waitStatus(port) {
  for (let i = 0; i < 100; i += 1) {
    const ok = await new Promise(resolve => {
      http.get({ host: '127.0.0.1', port, path: '/teamclaude/status' }, res => {
        res.resume();
        resolve(true);
      }).on('error', () => resolve(false));
    });
    if (ok) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

test('proxy.host is the bind address: loopback serves, a non-local address fails to bind', async () => {
  const bad = await startServer('203.0.113.1'); // TEST-NET-3, never a local interface
  const [code] = await once(bad.child, 'exit');
  assert.equal(code, 1);
  assert.match(bad.stderr(), /Failed to listen on port \d+: .*(EADDRNOTAVAIL|203\.0\.113\.1)/);

  const ok = await startServer('127.0.0.1');
  try {
    assert.equal(await waitStatus(ok.port), true, ok.stderr());
  } finally {
    ok.child.kill('SIGTERM');
    await once(ok.child, 'exit');
  }
});
