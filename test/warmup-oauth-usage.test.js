import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, resolveAnthropicUsageUrl } from '../src/server.js';

const HOUR = 3600_000;

function makeAccounts(n) {
  return Array.from({ length: n }, (_, i) => ({
    name: `a${i}`, type: 'oauth', accessToken: `tok-${i}`, refreshToken: 'r', expiresAt: Date.now() + HOUR,
  }));
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function waitFor(cond, ms = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await new Promise(r => setTimeout(r, 15));
  }
  return cond();
}

const iso = ms => new Date(Date.now() + ms).toISOString();

// The OAuth usage report as api.anthropic.com/api/oauth/usage returns it: the
// session and weekly windows plus the model-scoped Fable weekly limit.
function usageReport() {
  return {
    five_hour: { utilization: 12, resets_at: iso(HOUR) },
    seven_day: { utilization: 34, resets_at: iso(24 * HOUR) },
    limits: [
      { kind: 'weekly_scoped', scope: { surface: 'code', model: { display_name: 'Fable 5.1' } }, percent: 99, resets_at: iso(24 * HOUR) },
      { kind: 'weekly_scoped', scope: { model: { display_name: 'Fable 5.1' } }, percent: 33, resets_at: iso(24 * HOUR) },
    ],
  };
}

// An upstream that answers the usage endpoint and records every request, so
// a test can assert no /v1/messages probe was spent.
function fixtureUpstream(seen, { usageStatus = 200, report = usageReport } = {}) {
  return http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    seen.push({ method: req.method, url: req.url, auth: req.headers['authorization'], beta: req.headers['anthropic-beta'], body: raw });
    if (req.method === 'GET' && req.url === '/api/oauth/usage') {
      res.writeHead(usageStatus, { 'content-type': 'application/json' });
      res.end(usageStatus === 200 ? JSON.stringify(report()) : '{"error":"nope"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
}

function status(am, name) {
  return am.getStatus({ includeIdentity: true }).accounts.find(a => a.name === name);
}

test('resolveAnthropicUsageUrl derives the endpoint only for the real Anthropic upstream', () => {
  assert.equal(resolveAnthropicUsageUrl(undefined, 'https://api.anthropic.com'), 'https://api.anthropic.com/api/oauth/usage');
  assert.equal(resolveAnthropicUsageUrl(undefined, 'http://127.0.0.1:4321'), null);
  assert.equal(resolveAnthropicUsageUrl(undefined, 'https://proxy.example.com'), null);
  assert.equal(resolveAnthropicUsageUrl(false, 'https://api.anthropic.com'), null);
  assert.equal(resolveAnthropicUsageUrl('http://127.0.0.1:1/usage', 'http://127.0.0.1:1'), 'http://127.0.0.1:1/usage');
  assert.equal(resolveAnthropicUsageUrl(undefined, 'not a url'), null);
});

test('the OAuth usage report measures every idle account at startup without a probe request', async () => {
  const seen = [];
  const upstream = fixtureUpstream(seen);
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeAccounts(2), 0.98, 0, 3);
  const proxy = createProxyServer(am, {
    provider: 'anthropic', upstream: `http://127.0.0.1:${upstreamPort}`,
    oauthUsageUrl: `http://127.0.0.1:${upstreamPort}/api/oauth/usage`,
    activeWarmup: true, warmupIntervalMs: 0,
  });
  await listen(proxy);
  try {
    assert.ok(await waitFor(() => status(am, 'a0')?.quota.unified5h != null && status(am, 'a1')?.quota.unified5h != null),
      'both accounts measured from the usage report');
    for (const name of ['a0', 'a1']) {
      const q = status(am, name).quota;
      assert.equal(q.unified5h, 0.12);
      assert.equal(q.unified7d, 0.34);
      // Only the unscoped Fable limit is the model weekly window; the surface-scoped one is ignored.
      assert.equal(q.modelWeekly['7d_oi']?.utilization, 0.33);
    }
    const usageCalls = seen.filter(r => r.url === '/api/oauth/usage');
    assert.equal(usageCalls.length, 2);
    assert.deepEqual(usageCalls.map(r => r.auth).sort(), ['Bearer tok-0', 'Bearer tok-1']);
    assert.ok(usageCalls.every(r => r.beta === 'oauth-2025-04-20'));
    assert.equal(seen.filter(r => r.url === '/v1/messages').length, 0, 'no probe request was spent');

    // A forced fleet refresh (TUI R) re-reads the report even without a probe template.
    const result = await proxy.refreshQuotaAll();
    assert.deepEqual(result, { targets: 2, measured: 2 });
    assert.equal(seen.filter(r => r.url === '/api/oauth/usage').length, 4);
    // An unforced pass inside the 60s window does not re-fetch.
    await proxy.refreshAnthropicQuotaAll();
    assert.equal(seen.filter(r => r.url === '/api/oauth/usage').length, 4);
  } finally {
    proxy.closeAllConnections();
    await new Promise(r => proxy.close(r));
    upstream.closeAllConnections();
    await new Promise(r => upstream.close(r));
  }
});

test('POST /teamclaude/reload re-measures the fleet and reports what it covered', async () => {
  const seen = [];
  const upstream = fixtureUpstream(seen);
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeAccounts(2), 0.98, 0, 3);
  const proxy = createProxyServer(am, {
    provider: 'anthropic', upstream: `http://127.0.0.1:${upstreamPort}`,
    oauthUsageUrl: `http://127.0.0.1:${upstreamPort}/api/oauth/usage`,
    proxy: { apiKey: 'fixture-proxy-key' },
    activeWarmup: true, warmupIntervalMs: 0,
  });
  const port = await listen(proxy);
  const url = `http://127.0.0.1:${port}/teamclaude/reload`;
  try {
    assert.ok(await waitFor(() => seen.filter(r => r.url === '/api/oauth/usage').length === 2));
    am.accounts[1].inflight = 1; // a busy account is skipped, and the reply says so

    const res = await fetch(url, { method: 'POST', headers: { 'x-api-key': 'fixture-proxy-key' } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { targets: 1, measured: 1, total: 2 });
    assert.equal(seen.filter(r => r.url === '/api/oauth/usage').length, 3);

    assert.equal((await fetch(url, { headers: { 'x-api-key': 'fixture-proxy-key' } })).status, 405);
    assert.equal((await fetch(url, { method: 'POST', headers: { 'x-api-key': 'wrong' } })).status, 401);
    assert.equal(seen.filter(r => r.url === '/teamclaude/reload').length, 0, 'never forwarded upstream');
  } finally {
    am.accounts[1].inflight = 0;
    proxy.closeAllConnections();
    await new Promise(r => proxy.close(r));
    upstream.closeAllConnections();
    await new Promise(r => upstream.close(r));
  }
});

test('a failing usage endpoint leaves the account unmeasured and never breaks the proxy', async () => {
  const seen = [];
  const upstream = fixtureUpstream(seen, { usageStatus: 500 });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeAccounts(1), 0.98, 0, 3);
  const proxy = createProxyServer(am, {
    provider: 'anthropic', upstream: `http://127.0.0.1:${upstreamPort}`,
    oauthUsageUrl: `http://127.0.0.1:${upstreamPort}/api/oauth/usage`,
    activeWarmup: true, warmupIntervalMs: 0,
  });
  const port = await listen(proxy);
  try {
    assert.ok(await waitFor(() => seen.some(r => r.url === '/api/oauth/usage')));
    await new Promise(r => setTimeout(r, 50));
    assert.equal(status(am, 'a0').quota.unified5h, null);
    assert.equal(am.accounts[0].status, 'active');
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 1, messages: [] }),
    });
    assert.equal(res.status, 200);
    await res.text();
  } finally {
    proxy.closeAllConnections();
    await new Promise(r => proxy.close(r));
    upstream.closeAllConnections();
    await new Promise(r => upstream.close(r));
  }
});

// Verified Ultra accounts (2026-10-30) have no 5-hour window: the usage report
// says five_hour: null. That is the same "accepted, 7d but no 5h" evidence as a
// weekly-only /v1/messages response, so the account is complete and no probe
// is spent re-measuring it.
async function withUsageProxy(report, fn) {
  const seen = [];
  const upstream = fixtureUpstream(seen, { report });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeAccounts(1), 0.98, 0, 3);
  const proxy = createProxyServer(am, {
    provider: 'anthropic', upstream: `http://127.0.0.1:${upstreamPort}`,
    oauthUsageUrl: `http://127.0.0.1:${upstreamPort}/api/oauth/usage`,
    activeWarmup: true, warmupIntervalMs: 0,
  });
  await listen(proxy);
  try {
    assert.ok(await waitFor(() => status(am, 'a0')?.quota.unified7d != null), 'measured from the usage report');
    await fn(am, proxy, seen);
  } finally {
    proxy.closeAllConnections();
    await new Promise(r => proxy.close(r));
    upstream.closeAllConnections();
    await new Promise(r => upstream.close(r));
  }
}

test('usage report five_hour: null states "no 5h window" and the account is fully measured', async () => {
  await withUsageProxy(() => ({ ...usageReport(), five_hour: null }), async (am, proxy, seen) => {
    const q = status(am, 'a0').quota;
    assert.equal(q.sessionWindowStated, false);
    assert.equal(q.unified5h, null);
    assert.equal(q.unified7d, 0.34);
    assert.equal(am._fullyMeasured(am.accounts[0]), true);
    assert.equal(am.warmupCandidates().length, 0, 'not a re-measure candidate');
    assert.equal(seen.filter(r => r.url === '/v1/messages').length, 0, 'no probe request was spent');
  });
});

test('usage report with a five_hour value states the 5h window (true), even after false', async () => {
  let fiveHour = null;
  await withUsageProxy(() => ({ ...usageReport(), five_hour: fiveHour }), async (am, proxy) => {
    assert.equal(status(am, 'a0').quota.sessionWindowStated, false);
    fiveHour = { utilization: 12, resets_at: iso(HOUR) };
    await proxy.refreshQuotaAll();
    const q = status(am, 'a0').quota;
    assert.equal(q.sessionWindowStated, true);
    assert.equal(q.unified5h, 0.12);
  });
});

test('an idle five_hour object (no reset yet) is not read as "no 5h window"', async () => {
  await withUsageProxy(() => ({ ...usageReport(), five_hour: { utilization: 0, resets_at: null } }), async am => {
    assert.equal(status(am, 'a0').quota.sessionWindowStated, null);
  });
});

test('a missing five_hour key leaves the flag unknown', async () => {
  await withUsageProxy(() => { const r = usageReport(); delete r.five_hour; return r; }, async am => {
    assert.equal(status(am, 'a0').quota.sessionWindowStated, null);
  });
});
