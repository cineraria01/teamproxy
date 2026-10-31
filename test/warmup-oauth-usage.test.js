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

// The usage endpoint is rate limited per token, and the same tokens are shared
// by several machines (2026-10-31: ~every call 429 with Retry-After). A failed
// call must back off per account instead of being retried every warm-up pass.
async function withFailingUsage({ usageStatus, retryAfter }, fn) {
  const seen = [];
  let mode = { usageStatus, retryAfter };
  const upstream = http.createServer(async (req, res) => {
    req.resume(); await new Promise(r => req.on('end', r));
    seen.push({ method: req.method, url: req.url });
    if (req.url === '/api/oauth/usage') {
      const h = { 'content-type': 'application/json' };
      if (mode.retryAfter != null) h['retry-after'] = mode.retryAfter;
      res.writeHead(mode.usageStatus, h);
      res.end(mode.usageStatus === 200 ? JSON.stringify(usageReport()) : '{"error":{"type":"rate_limit_error"}}');
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/json',
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': '0.5',
      'anthropic-ratelimit-unified-5h-reset': String(Math.ceil((Date.now() + HOUR) / 1000)),
      'anthropic-ratelimit-unified-7d-utilization': '0.6',
      'anthropic-ratelimit-unified-7d-reset': String(Math.ceil((Date.now() + 24 * HOUR) / 1000)),
    });
    res.end('{"ok":true}');
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeAccounts(1), 0.98, 0, 3);
  const proxy = createProxyServer(am, {
    provider: 'anthropic', upstream: `http://127.0.0.1:${upstreamPort}`,
    oauthUsageUrl: `http://127.0.0.1:${upstreamPort}/api/oauth/usage`,
    activeWarmup: true, warmupIntervalMs: 0,
  });
  const errors = [];
  const origError = console.error;
  console.error = (...a) => { errors.push(a.join(' ')); };
  await listen(proxy);
  try {
    assert.ok(await waitFor(() => seen.some(r => r.url === '/api/oauth/usage')));
    await new Promise(r => setTimeout(r, 30));
    await fn({ am, proxy, seen, errors, setMode: m => { mode = m; } });
  } finally {
    console.error = origError;
    proxy.closeAllConnections();
    await new Promise(r => proxy.close(r));
    upstream.closeAllConnections();
    await new Promise(r => upstream.close(r));
  }
}

const usageCalls = seen => seen.filter(r => r.url === '/api/oauth/usage').length;
const backoffLeft = am => (am.accounts[0]._anthropicUsageBackoff?.until ?? 0) - Date.now();

test('a 429 with Retry-After backs the account off for that long; forced refreshes respect it', async () => {
  await withFailingUsage({ usageStatus: 429, retryAfter: '244' }, async ({ am, proxy, seen }) => {
    assert.equal(usageCalls(seen), 1);
    const left = backoffLeft(am);
    assert.ok(left > 240_000 && left <= 244_000 + 60_000, `backoff ${left}ms follows Retry-After plus jitter`);
    // Unforced and forced passes (warm-up cycle, TUI R / teamclaude reload) do not call again.
    am.accounts[0]._anthropicUsageCheckedAt = 0;
    await proxy.refreshAnthropicQuotaAll();
    await proxy.refreshQuotaAll();
    assert.equal(usageCalls(seen), 1, 'no usage call while backing off');
  });
});

test('Retry-After as an HTTP date, a missing value, and a huge value are bounded', async () => {
  await withFailingUsage({ usageStatus: 429, retryAfter: new Date(Date.now() + 120_000).toUTCString() }, async ({ am }) => {
    const left = backoffLeft(am);
    assert.ok(left > 100_000 && left <= 120_000 + 60_000, `HTTP-date backoff ${left}ms`);
  });
  await withFailingUsage({ usageStatus: 429, retryAfter: null }, async ({ am }) => {
    const left = backoffLeft(am);
    assert.ok(left > 295_000 && left <= 300_000 + 60_000, `default backoff ${left}ms is 5 minutes`);
  });
  await withFailingUsage({ usageStatus: 429, retryAfter: '999999' }, async ({ am }) => {
    const left = backoffLeft(am);
    assert.ok(left > 3_590_000 && left <= HOUR + 60_000, `capped backoff ${left}ms is 1 hour`);
  });
});

test('a 403 backs off for an hour', async () => {
  await withFailingUsage({ usageStatus: 403, retryAfter: null }, async ({ am }) => {
    const left = backoffLeft(am);
    assert.ok(left > 3_590_000 && left <= HOUR + 60_000, `403 backoff ${left}ms`);
  });
});

test('while backed off, warm-up falls through to the message probe and still measures 5h/7d', async () => {
  await withFailingUsage({ usageStatus: 429, retryAfter: '244' }, async ({ am, proxy, seen }) => {
    assert.equal(proxy.importProbeTemplate({ version: '2023-06-01', model: 'claude-haiku-5' }), true);
    const before = usageCalls(seen);
    await proxy.refreshQuotaAll();
    assert.equal(usageCalls(seen), before, 'usage endpoint not called');
    assert.ok(seen.some(r => r.url === '/v1/messages'), 'message probe sent');
    assert.equal(status(am, 'a0').quota.unified5h, 0.5);
  });
});

test('the backoff is logged once; a success clears it, and the next failure logs again', async () => {
  await withFailingUsage({ usageStatus: 429, retryAfter: '1' }, async ({ am, proxy, seen, errors, setMode }) => {
    const logged = () => errors.filter(e => e.includes('OAuth usage')).length;
    assert.equal(logged(), 1);
    assert.match(errors.find(e => e.includes('OAuth usage')), /429/);
    // Backoff expires, same 429 again: still the same backoff streak, no new line.
    am.accounts[0]._anthropicUsageBackoff.until = 0;
    await proxy.refreshQuotaAll();
    assert.equal(usageCalls(seen), 2);
    assert.equal(logged(), 1, 'a repeated 429 does not log every cycle');
    // Success clears the backoff state.
    setMode({ usageStatus: 200 });
    am.accounts[0]._anthropicUsageBackoff.until = 0;
    await proxy.refreshQuotaAll();
    assert.equal(usageCalls(seen), 3);
    assert.equal(am.accounts[0]._anthropicUsageBackoff, undefined);
    assert.equal(status(am, 'a0').quota.modelWeekly['7d_oi']?.utilization, 0.33);
    // A new failure after a success starts a new backoff and logs again.
    setMode({ usageStatus: 403 });
    await proxy.refreshQuotaAll();
    assert.equal(logged(), 2);
    assert.ok(backoffLeft(am) > 3_590_000);
  });
});
