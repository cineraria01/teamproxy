import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';

// The fake proxy below serves from THIS process's event loop, so the CLI must be
// spawned asynchronously — spawnSync would block the loop and the probe would
// time out as "not running".
function runCli(cliArgs, env) {
  return new Promise(resolve => {
    execFile(process.execPath, cliArgs, { encoding: 'utf8', env }, (err, stdout, stderr) =>
      resolve({ status: err ? (err.code ?? 1) : 0, stdout, stderr }));
  });
}

const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));

function account(name, extra = {}) {
  return {
    name,
    accountUuid: `uuid-${name}`,
    type: 'oauth',
    provider: 'anthropic',
    status: 'active',
    errorReason: null,
    usable: true,
    enabled: true,
    priority: null,
    quota: {
      tokensLimit: null, tokensRemaining: null,
      requestsLimit: null, requestsRemaining: null,
      unified5h: 0.1, unified7d: 0.2,
      unified5hReset: null, unified7dReset: null,
      unifiedStatus: null, codexUsageAt: null,
      modelWeekly: {}, resetsAt: null, tokensReset: null, requestsReset: null,
    },
    usage: { totalInputTokens: 10, totalOutputTokens: 2, totalRequests: 3, lastUsed: null },
    inflight: 0,
    maxConcurrent: 3,
    rateLimitedUntil: null,
    ...extra,
  };
}

function requestWantsIdentity(req) {
  if (req.headers['x-api-key'] !== 'k') return false;
  return req.headers['x-teamcodex-status-identity'] === '1';
}

function publicStatusPayload(payload) {
  const body = structuredClone(payload);
  delete body.currentAccount;
  delete body.currentAccountUuid;
  for (const account of body.accounts) {
    delete account.name;
    delete account.accountUuid;
  }
  return body;
}

/** Serve one fixed /teamclaude/status payload; returns { port, close }. */
async function startFakeProxy(payload, onRequest = null) {
  const server = createServer((req, res) => {
    onRequest?.(req);
    if (!req.url.startsWith('/teamclaude/status')) { res.writeHead(404); res.end(); return; }
    const body = requestWantsIdentity(req) ? payload : publicStatusPayload(payload);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

async function runStatusAgainst(payload, { onRequest = null } = {}) {
  const proxy = await startFakeProxy(payload, onRequest);
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-statuscli-'));
  const configPath = join(dir, 'teamclaude.json');
  await writeFile(configPath, JSON.stringify({
    provider: 'anthropic',
    proxy: { port: proxy.port, apiKey: 'k' },
    accounts: [],
  }, null, 2));

  const env = { ...process.env, TEAMCLAUDE_CONFIG: configPath };
  delete env.TEAMCLAUDE_PROVIDER;
  try {
    return await runCli([entry, 'status'], env);
  } finally {
    await proxy.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const basePayload = accounts => ({
  currentAccount: accounts[0].name,
  currentAccountUuid: accounts[0].accountUuid,
  switchThreshold: 0.98,
  usableCount: accounts.filter(a => a.usable).length,
  totalCount: accounts.length,
  accounts,
});

// Regression: an account parked as 'error' made statusCommand read the
// module-level ERROR_REASON_LABELS while the top-level command dispatch was
// still running — a TDZ ReferenceError swallowed by the catch, which printed
// the misleading "Server: unreachable" and exited 1 mid-listing.
test('status renders an error account reason instead of dying as "unreachable"', async () => {
  const res = await runStatusAgainst(basePayload([
    account('revoked@example.com', { status: 'error', errorReason: 'auth-revoked', usable: false }),
    account('good@example.com'),
  ]));

  assert.equal(res.status, 0, `exit ${res.status}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.doesNotMatch(res.stdout, /unreachable/, 'must not report a live server as unreachable');
  assert.match(res.stdout, /revoked@example\.com/);
  assert.match(res.stdout, /인증무효/, 'error reason label must be rendered');
  // Listing must continue past the error account.
  assert.match(res.stdout, /good@example\.com/);
});

test('status lists healthy accounts with quota lines', async () => {
  const res = await runStatusAgainst(basePayload([account('a@example.com'), account('b@example.com')]));

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Usable now:\s+2\/2 accounts/);
  assert.match(res.stdout, /Session:\s+10\.0% used\s+Weekly: 20\.0% used/);
  assert.match(res.stdout, /b@example\.com/);
});

// Numbers the proxy has not refreshed for a while (quotaStale) carry their
// age; fresh lines print exactly as before (no ANSI off a terminal).
test('status appends the age to a stale account and leaves fresh lines alone', async () => {
  const at = Date.now() - (2 * 3600_000 + 5 * 60_000);
  const quota = account('x').quota;
  const res = await runStatusAgainst(basePayload([
    account('fresh@example.com', { quota: { ...quota, updatedAt: Date.now() } }),
    account('stale@example.com', { quotaStale: true, quota: { ...quota, updatedAt: at } }),
    account('api@example.com', {
      type: 'apikey', quotaStale: true,
      quota: { ...quota, unified5h: null, unified7d: null, tokensLimit: 100, tokensRemaining: 50, updatedAt: at },
    }),
  ]));

  assert.equal(res.status, 0, res.stderr);
  const block = name => res.stdout.split('\n\n').find(b => b.includes(`  ${name} (`));
  assert.match(block('fresh@example.com'), /\n {4}Session: {2}10\.0% used {4}Weekly: 20\.0% used\n/);
  assert.match(block('stale@example.com'), /\n {4}Session: {2}10\.0% used {4}Weekly: 20\.0% used {4}\(2h ago\)\n/);
  assert.match(block('api@example.com'), /\n {4}Tokens: {3}50\.0% used {4}Requests: - used {4}\(2h ago\)\n/);
  assert.doesNotMatch(res.stdout, /\x1b\[/, 'no ANSI when stdout is not a terminal');
});

test('reload and status finish when lsof hangs and ignores SIGTERM', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-lsof-timeout-'));
  const bin = join(dir, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'lsof'), `#!${process.execPath}
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  const payload = basePayload([account('idle')]);
  let reloads = 0;
  const proxy = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/teamclaude/reload') {
      assert.equal(req.method, 'POST');
      reloads += 1;
      res.end(JSON.stringify({ targets: 1, measured: 1, total: 1 }));
    } else {
      res.end(JSON.stringify(payload));
    }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    provider: 'anthropic', proxy: { port: proxy.address().port, apiKey: 'k' }, accounts: [],
  }));
  const env = { ...process.env, TEAMCLAUDE_CONFIG: configPath, PATH: `${bin}:${process.env.PATH}` };
  delete env.TEAMCLAUDE_PROVIDER;
  try {
    const result = await new Promise(resolve => {
      execFile(process.execPath, [entry, 'reload'], { env, timeout: 8000 }, (err, stdout, stderr) =>
        resolve({ err, stdout, stderr }));
    });
    assert.equal(result.err, null, result.stderr);
    assert.equal(reloads, 1);
    assert.match(result.stdout, /Re-measured 1\/1 account/);
    assert.match(result.stdout, /Server:\s+running/);
    assert.match(result.stdout, /idle/);
  } finally {
    await new Promise(resolve => proxy.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('status CLI requests the trusted local identity payload', async () => {
  const headers = [];
  const res = await runStatusAgainst(
    basePayload([account('operator@example.com')]),
    { onRequest: req => headers.push(req.headers) },
  );

  assert.equal(res.status, 0, res.stderr);
  assert.ok(
    headers.some(h => h['x-api-key'] === 'k' && h['x-teamcodex-status-identity'] === '1'),
    'status CLI must present both local capability headers for the name-bearing payload',
  );
  assert.match(res.stdout, /operator@example\.com/);
});

test('status distinguishes scheduled cancellation, ended subscription, auth, and organization policy', async () => {
  const res = await runStatusAgainst(basePayload([
    account('scheduled@example.com', {
      provider: 'codex',
      subscription: { state: 'cancellation-scheduled', endsAt: '2026-09-06T15:00:00.000Z' },
    }),
    account('ended@example.com', {
      provider: 'codex', status: 'error', errorReason: 'subscription-ended', usable: false,
      subscription: { state: 'ended', endsAt: null, endedAt: '2026-08-31T00:00:00.000Z' },
    }),
    account('auth@example.com', { status: 'error', errorReason: 'auth-revoked', usable: false }),
    account('policy@example.com', { status: 'error', errorReason: 'subscription-disabled', usable: false }),
  ]));

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /해지 예정.*2026-09-06/);
  assert.match(res.stdout, /구독 종료/);
  assert.match(res.stdout, /인증무효/);
  assert.match(res.stdout, /조직의 Claude Code 접근 차단/);
});
