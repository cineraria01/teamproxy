// Idle re-measure (remeasureStale, quotaMaxAgeMs) and the stale-number display
// (quota.updatedAt, quotaStale). 2026-11-10: other machines had spent 38% of
// an account this proxy still showed at 0% — it never re-measured an account
// it left idle, so switching to it surfaced the jump all at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { TUI, quotaAge } from '../src/tui.js';
import { accountViews } from '../src/app-json.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
// Fixed resets so a probe that reports the same usage leaves the numbers equal.
const RESET_5H = Math.floor((Date.now() + 3 * HOUR) / 1000);
const RESET_7D = Math.floor((Date.now() + 50 * HOUR) / 1000);

const rl = (u5 = 0.1, u7 = 0.2) => ({
  'anthropic-ratelimit-unified-5h-utilization': String(u5),
  'anthropic-ratelimit-unified-5h-reset': String(RESET_5H),
  'anthropic-ratelimit-unified-7d-utilization': String(u7),
  'anthropic-ratelimit-unified-7d-reset': String(RESET_7D),
});

function makeAccounts(n) {
  return Array.from({ length: n }, (_, i) => ({
    name: `a${i}`, type: 'oauth', accessToken: `tok-${i}`, refreshToken: 'r', expiresAt: Date.now() + 8 * HOUR,
  }));
}

/** Every account measured just now (both windows), as after real traffic. */
function measuredManager(n, { maxConcurrent = 3, reevalMs = 0 } = {}) {
  const am = new AccountManager(makeAccounts(n), 0.98, reevalMs, maxConcurrent);
  for (let i = 0; i < n; i++) am.updateQuota(i, rl(), { status: 200 });
  return am;
}

const makeOld = (am, i, ms) => { am.accounts[i].quota.updatedAt = Date.now() - ms; };

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function waitFor(cond, ms = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await new Promise(r => setTimeout(r, 10));
  }
  return cond();
}

const settle = ms => new Promise(r => setTimeout(r, ms));

/** Records every request; `answer(req, res, body)` writes the response. */
async function fakeUpstream(answer) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    await answer(req, res, body);
  });
  const port = await listen(server);
  return { seen, url: `http://127.0.0.1:${port}`, close: () => { server.closeAllConnections(); return new Promise(r => server.close(r)); } };
}

/** A Claude-mode proxy with a restored probe template (as after a restart), timer off unless set. */
async function claudeProxy(am, upstreamUrl, extra = {}) {
  const proxy = createProxyServer(am, { upstream: upstreamUrl, warmupIntervalMs: 0, ...extra });
  await listen(proxy);
  assert.equal(proxy.importProbeTemplate({ model: 'claude-x' }), true);
  return proxy;
}

const closeProxy = proxy => { proxy.closeAllConnections(); return new Promise(r => proxy.close(r)); };

/** Run `fn(proxy)` against a Claude-mode proxy, always closing it. */
async function withClaudeProxy(am, upstreamUrl, extra, fn) {
  const proxy = await claudeProxy(am, upstreamUrl, extra);
  try { return await fn(proxy); } finally { await closeProxy(proxy); }
}

const probes = seen => seen.filter(r => r.url === '/v1/messages');

// ── B: the freshness stamp ───────────────────────────────────────────────────

test('updateQuota stamps quota.updatedAt only when Anthropic window headers arrive', () => {
  const am = new AccountManager([
    ...makeAccounts(1),
    { name: 'api', type: 'apikey', apiKey: 'k' },
    { name: 'cx', type: 'oauth', provider: 'codex', accessToken: 't' },
    { name: 'gk', type: 'oauth', provider: 'grok', accessToken: 't' },
    { name: 'cu', type: 'oauth', provider: 'cursor', accessToken: 't' },
  ], 0.98, 0, 3);
  const [max, api, codex, grok, cursor] = am.accounts;
  assert.equal(max.quota.updatedAt, null, 'unknown until something is measured');

  am.updateQuota(max, {}, { status: 200 });                     // header-less / held fold
  am.updateQuota(max, { 'anthropic-ratelimit-unified-status': 'allowed' }, { status: 200 });
  assert.equal(max.quota.updatedAt, null, 'no window header, no new numbers');

  const t0 = Date.now();
  am.updateQuota(max, rl(), { status: 200 });
  assert.ok(max.quota.updatedAt >= t0 && max.quota.updatedAt <= Date.now());
  am.updateQuota(api, {
    'anthropic-ratelimit-tokens-limit': '1000', 'anthropic-ratelimit-tokens-remaining': '900',
    'anthropic-ratelimit-tokens-reset': new Date(Date.now() + MIN).toISOString(),
  }, { status: 200 });
  assert.ok(api.quota.updatedAt >= t0, 'API-key windows stamp too');

  // Other pools keep their own stamps (codexUsageAt, grokRateLimit.at, …).
  am.updateQuota(codex, {
    'x-codex-primary-used-percent': '40', 'x-codex-primary-window-minutes': '300',
    'x-codex-secondary-used-percent': '10', 'x-codex-secondary-window-minutes': '10080',
  }, { status: 200 });
  am.updateQuota(grok, { 'x-ratelimit-limit-requests': '100', 'x-ratelimit-remaining-requests': '50' }, { status: 200 });
  am.updateQuota(cursor, {}, { status: 200 });
  assert.equal(codex.quota.unified5h, 0.4, 'codex numbers still folded');
  for (const a of [codex, grok, cursor]) {
    assert.equal(a.quota.updatedAt, null, `${a.name} is not stamped`);
    assert.equal(am.isQuotaStale(a), false);
  }
});

test('the OAuth usage report stamps quota.updatedAt (no probe needed)', async () => {
  const iso = ms => new Date(Date.now() + ms).toISOString();
  const up = await fakeUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ five_hour: { utilization: 12, resets_at: iso(HOUR) }, seven_day: { utilization: 34, resets_at: iso(24 * HOUR) } }));
  });
  const am = new AccountManager(makeAccounts(1), 0.98, 0, 3);
  const proxy = createProxyServer(am, {
    upstream: up.url, oauthUsageUrl: `${up.url}/api/oauth/usage`, warmupIntervalMs: 0,
  });
  await listen(proxy);
  try {
    assert.ok(await waitFor(() => am.accounts[0].quota.unified5h === 0.12), 'measured from the report');
    assert.ok(Date.now() - am.accounts[0].quota.updatedAt < 5_000, 'stamped by the report');
    assert.equal(probes(up.seen).length, 0);
  } finally {
    await closeProxy(proxy);
    await up.close();
  }
});

test('quota.updatedAt survives the quota snapshot; an old snapshot loads as unknown', () => {
  const am = measuredManager(1);
  const at = Date.now() - 42 * MIN;
  am.accounts[0].quota.updatedAt = at;
  const saved = JSON.parse(JSON.stringify(am.exportQuotaState()));
  assert.equal(saved[0].quota.updatedAt, at, 'written with the snapshot');

  const restored = new AccountManager(makeAccounts(1), 0.98, 0, 3);
  restored.importQuotaState(saved);
  assert.equal(restored.accounts[0].quota.updatedAt, at, 'restored after a worker restart');
  assert.equal(restored.accounts[0].quota.unified5h, 0.1);

  // Snapshots written before the stamp existed (or damaged ones) load fine, age unknown.
  for (const updatedAt of [undefined, 'x', null, Infinity]) {
    const old = structuredClone(saved);
    if (updatedAt === undefined) delete old[0].quota.updatedAt;
    else old[0].quota.updatedAt = updatedAt;
    const m = new AccountManager(makeAccounts(1), 0.98, 0, 3);
    m.importQuotaState(old);
    assert.equal(m.accounts[0].quota.updatedAt, null, `updatedAt ${String(updatedAt)} → unknown`);
    assert.equal(m.accounts[0].quota.unified5h, 0.1, 'the numbers themselves still restore');
    assert.equal(m.isQuotaStale(m.accounts[0]), false, 'unknown age displays as before');
  }
  // A stamp from the future (clock moved back) cannot postpone the re-measure forever.
  const future = structuredClone(saved);
  future[0].quota.updatedAt = Date.now() + 10 * HOUR;
  const m = new AccountManager(makeAccounts(1), 0.98, 0, 3);
  m.importQuotaState(future);
  assert.ok(m.accounts[0].quota.updatedAt <= Date.now());
});

test('stale display: older than twice quotaMaxAgeMs (30 min when the re-measure is off)', () => {
  const thresholdFor = config => {
    const am = new AccountManager(makeAccounts(1), 0.98, 0, 3);
    const proxy = createProxyServer(am, { upstream: 'http://127.0.0.1:9', ...config });
    proxy.close(() => {});
    return am.quotaStaleMs;
  };
  assert.equal(thresholdFor({}), 30 * MIN, 'default: twice the 15-min re-measure age');
  assert.equal(thresholdFor({ quotaMaxAgeMs: 10 * MIN }), 20 * MIN);
  assert.equal(thresholdFor({ quotaMaxAgeMs: 45 * MIN }), 90 * MIN);
  for (const off of [{ quotaMaxAgeMs: 0 }, { quotaMaxAgeMs: false }, { warmupIntervalMs: 0, quotaMaxAgeMs: 45 * MIN },
    { activeWarmup: false, quotaMaxAgeMs: 45 * MIN }, { provider: 'codex', quotaMaxAgeMs: 45 * MIN }]) {
    assert.equal(thresholdFor(off), 30 * MIN, `re-measure off (${JSON.stringify(off)}) → 30 min`);
  }

  const am = measuredManager(4);
  makeOld(am, 1, 31 * MIN);
  makeOld(am, 2, 29 * MIN);
  am.accounts[3].quota.updatedAt = null;
  const stale = am.getStatus({ includeIdentity: true }).accounts.map(a => [a.name, a.quotaStale]);
  assert.deepEqual(stale, [['a0', false], ['a1', true], ['a2', false], ['a3', false]]);
  // Nothing left to show (every window swept) → nothing to mark stale.
  Object.assign(am.accounts[1].quota, { unified5h: null, unified5hReset: null, unified7d: null, unified7dReset: null });
  assert.equal(am.isQuotaStale(am.accounts[1]), false);
});

// ── A: which accounts the idle re-measure picks ──────────────────────────────

test('needsRemeasure picks only idle, available, fully-measured accounts older than the age', () => {
  const am = measuredManager(10);
  for (let i = 0; i < 10; i++) makeOld(am, i, 20 * MIN);
  makeOld(am, 0, 5 * MIN);                                  // a0 fresh
  // a1 stale and idle → the only plain target
  am.accounts[2].inflight = 1;                              // its response refreshes it anyway
  am.setEnabled(am.accounts[3], false);                     // out of rotation
  am.markRateLimited(4, 300);                               // throttled
  am.accounts[5].status = 'error';                          // auth error
  am.accounts[5].errorReason = 'auth-revoked';
  am.accounts[6].quota.unified7d = 0.99;                    // near quota (exhausted by the numbers)
  am.accounts[7].capacityCooldown = new Map([['claude-x', Date.now() + MIN]]); // capacity cooling
  Object.assign(am.accounts[8].quota, { unified5h: null, unified5hReset: null }); // half-measured: its own pass
  am.accounts[9].quota.updatedAt = null;                    // unknown age (old snapshot) → re-measure
  const now = Date.now();
  const picked = am.accounts.filter(a => am.needsRemeasure(a, 15 * MIN, now)).map(a => a.name);
  assert.deepEqual(picked, ['a1', 'a9']);

  // An attempt (successful or not) paces the next one to a full age later.
  am.accounts[1]._remeasureAt = now - 5 * MIN;
  assert.equal(am.needsRemeasure(am.accounts[1], 15 * MIN, now), false);
  assert.equal(am.needsRemeasure(am.accounts[1], 15 * MIN, now + 10 * MIN), true);
});

test('the warm-up timer re-measures only the stale account, with the probe R sends', async () => {
  const up = await fakeUpstream((req, res) => { res.writeHead(200, rl(0.5, 0.6)); res.end('{}'); });
  const am = measuredManager(2);
  makeOld(am, 1, 20_000);
  // Fable top-up off: these accounts lack the Fable window, and that pass would probe them too.
  const proxy = await claudeProxy(am, up.url, { warmupIntervalMs: 20, quotaMaxAgeMs: 10_000, modelWeeklyProbeModel: false });
  try {
    assert.ok(await waitFor(() => am.accounts[1].quota.unified5h === 0.5), 'a1 re-measured on the timer');
    assert.ok(Date.now() - am.accounts[1].quota.updatedAt < 5_000, 'and stamped');
    assert.equal(am.accounts[0].quota.unified5h, 0.1, 'the fresh account is left alone');
    const sent = probes(up.seen);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].auth, 'Bearer tok-1');
    assert.deepEqual(JSON.parse(sent[0].body), { model: 'claude-x', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] });
    await settle(300); // ~15 more ticks, all inside a1's new 10 s age
    assert.equal(probes(up.seen).length, 1, 'not probed again before its age runs out');
  } finally {
    await closeProxy(proxy);
    await up.close();
  }
});

// The Fable top-up runs earlier on the same tick and wins the account's probe
// slot, so an account needing both is probed once, with the Fable model, and
// the top-up's own budget (_mwProbes) is not spent by a plain-model probe.
// Both passes then wait a full age (a Fable probe is paced like the re-measure).
test('a stale account the Fable top-up also wants is probed once, by the top-up', async () => {
  const up = await fakeUpstream((req, res) => { res.writeHead(200, rl(0.5, 0.6)); res.end('{}'); });
  const am = measuredManager(1);
  makeOld(am, 0, 20_000);
  const proxy = await claudeProxy(am, up.url, { warmupIntervalMs: 20, quotaMaxAgeMs: 10_000, modelWeeklyProbeModel: 'claude-fable-test' });
  try {
    assert.ok(await waitFor(() => am.accounts[0]._mwProbes === 1), 'the top-up probed');
    await settle(300); // ~15 more ticks, all inside the 10 s age
    const models = probes(up.seen).map(r => JSON.parse(r.body).model);
    assert.deepEqual(models, ['claude-fable-test'], 'one probe, from the top-up, and none again inside the age');
    assert.equal(am.accounts[0]._mwProbes, 1, 'the plain-model re-measure stood down');
  } finally {
    await closeProxy(proxy);
    await up.close();
  }
});

test('quotaMaxAgeMs 0 or false turns the re-measure off, and quotaProbeSeconds is never read', async () => {
  const up = await fakeUpstream((req, res) => { res.writeHead(200, rl()); res.end('{}'); });
  try {
    for (const quotaMaxAgeMs of [0, false]) {
      const am = measuredManager(1);
      makeOld(am, 0, 10 * HOUR);
      await withClaudeProxy(am, up.url, { quotaMaxAgeMs }, p => p.remeasureStale());
    }
    assert.equal(probes(up.seen).length, 0, 'off: nothing probed however old');

    // Left over in existing configs; read as seconds it would re-measure this account.
    const am = measuredManager(1);
    makeOld(am, 0, 5_000);
    await withClaudeProxy(am, up.url, { quotaProbeSeconds: 1 }, p => p.remeasureStale());
    assert.equal(probes(up.seen).length, 0, 'the 15-min default still applies');

    makeOld(am, 0, 16 * MIN);
    await withClaudeProxy(am, up.url, { quotaProbeSeconds: 300 }, p => p.remeasureStale());
    assert.equal(probes(up.seen).length, 1, 'past the default age it is re-measured');
  } finally {
    await up.close();
  }
});

// ── A, property 1: only the numbers change ───────────────────────────────────

function selectionState(am) {
  return {
    currentIndex: am.currentIndex,
    lastEvalAt: am.lastEvalAt,
    warmupCursor: am._warmupCursor,
    accounts: am.accounts.map(a => ({
      status: a.status, enabled: a.enabled, priority: a.priority, rateLimitedUntil: a.rateLimitedUntil,
      inflight: a.inflight, warmupTries: a._warmupTries ?? 0,
      quota: [a.quota.unified5h, a.quota.unified5hReset, a.quota.unified7d, a.quota.unified7dReset],
    })),
    order: am.accounts.filter(a => am._isAvailable(a)).sort((x, y) => am.autoCompare(x, y)).map(a => a.name),
  };
}

test('a re-measure changes only the numbers: no switch, no order input, no client slot', async () => {
  let release;
  const held = new Promise(r => { release = r; });
  const up = await fakeUpstream(async (req, res, body) => {
    if (body.includes('"max_tokens":1')) await held;
    res.writeHead(200, rl());          // the same usage as before
    res.end('{}');
  });
  const am = measuredManager(2, { maxConcurrent: 1, reevalMs: 5 * MIN });
  const proxy = await claudeProxy(am, up.url, { quotaMaxAgeMs: MIN });
  try {
    am.currentIndex = 0;
    am.lastEvalAt = Date.now();
    makeOld(am, 1, 2 * MIN);           // the idle, non-active account goes stale
    const before = selectionState(am);
    assert.equal(am.getActiveAccount().name, 'a0');

    const pass = proxy.remeasureStale();
    assert.ok(await waitFor(() => am.accounts[1]._warming === true), 'probe in flight on a1');
    assert.equal(am.accounts[1].inflight, 0, 'the probe holds no client slot');
    // With one slot per account, a client still gets a0 and then a1 itself.
    const first = await am.acquireAccount();
    const second = await am.acquireAccount();
    assert.deepEqual([first?.name, second?.name], ['a0', 'a1']);
    am.releaseAccount(first);
    am.releaseAccount(second);

    release();
    await pass;
    assert.equal(probes(up.seen).length, 1);
    assert.ok(Date.now() - am.accounts[1].quota.updatedAt < 5_000, 'a1 re-measured');
    assert.deepEqual(selectionState(am), before, 'active account, order inputs and slots untouched');
    assert.equal(am.getActiveAccount().name, 'a0', 'a re-measure never makes the account active');
  } finally {
    release();
    await closeProxy(proxy);
    await up.close();
  }
});

// ── A, property 3: a failed re-measure parks nothing ─────────────────────────

test('a failed re-measure parks nothing and refreshes no token (401, 403, 5xx, 429, network)', async () => {
  const failures = {
    401: res => { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"type":"error"}'); },
    403: res => { res.writeHead(403, { 'content-type': 'application/json' }); res.end('{"type":"error"}'); },
    500: res => { res.writeHead(500); res.end(); },
    529: res => { res.writeHead(529); res.end(); },
    429: res => { res.writeHead(429, { ...rl(0.9, 0.9), 'anthropic-ratelimit-unified-status': 'allowed_warning' }); res.end(); },
    network: res => res.socket.destroy(),
  };
  for (const [kind, fail] of Object.entries(failures)) {
    const up = await fakeUpstream((req, res) => fail(res));
    const am = measuredManager(1);
    makeOld(am, 0, 20 * MIN);
    const refreshes = [];
    const ensure = am.ensureTokenFresh.bind(am);
    am.ensureTokenFresh = (...args) => { refreshes.push(args); return ensure(...args); };
    const proxy = await claudeProxy(am, up.url);
    try {
      const before = structuredClone(am.getStatus({ includeIdentity: true }).accounts[0]);
      await proxy.remeasureStale();
      assert.equal(probes(up.seen).length, 1, `${kind}: probed once`);
      const after = am.getStatus({ includeIdentity: true }).accounts[0];
      assert.deepEqual(after, before, `${kind}: status, numbers and flags unchanged`);
      assert.equal(am._isAvailable(am.accounts[0]), true, `${kind}: still in rotation`);
      assert.deepEqual(refreshes, [], `${kind}: no token refresh`);
      await proxy.remeasureStale();
      assert.equal(probes(up.seen).length, 1, `${kind}: not retried before the age runs out again`);
    } finally {
      await closeProxy(proxy);
      await up.close();
    }
  }
});

// The commonest 429 a re-measure meets: other machines used the account up.
// That is a measurement, not a failure — only the numbers change, and the
// account leaves rotation through them alone (no throttle, no park).
test('a re-measure that meets an exhausted account (429 rejected) only takes its numbers', async () => {
  const up = await fakeUpstream((req, res) => {
    res.writeHead(429, { ...rl(0.4, 1), 'anthropic-ratelimit-unified-status': 'rejected', 'retry-after': '120' });
    res.end('{"type":"error","error":{"type":"rate_limit_error"}}');
  });
  const am = measuredManager(1);
  const a = am.accounts[0];
  makeOld(am, 0, 20 * MIN);
  const refreshes = [];
  const ensure = am.ensureTokenFresh.bind(am);
  am.ensureTokenFresh = (...args) => { refreshes.push(args); return ensure(...args); };
  const proxy = await claudeProxy(am, up.url);
  try {
    const t0 = Date.now();
    await proxy.remeasureStale();
    assert.equal(probes(up.seen).length, 1);
    assert.equal(a.quota.unified7d, 1, 'the exhausted weekly window is taken');
    assert.ok(a.quota.updatedAt >= t0, 'and stamped');
    assert.equal(a.status, 'active', 'not throttled or parked');
    assert.equal(a.rateLimitedUntil, null);
    assert.equal(a.errorReason, undefined);
    assert.deepEqual(refreshes, [], 'no token refresh');
    assert.equal(am._isAvailable(a), false, 'out of rotation now…');
    assert.equal(am._isNearQuota(a), true, '…because of its numbers');
    a.quota.unified7d = 0.5;
    assert.equal(am._isAvailable(a), true, 'and nothing else keeps it out');
    await proxy.remeasureStale();
    assert.equal(probes(up.seen).length, 1, 'not re-measured before the age runs out');
  } finally {
    await closeProxy(proxy);
    await up.close();
  }
});

test('an account whose token is about to expire is left to the keep-alive sweep', async () => {
  const up = await fakeUpstream((req, res) => { res.writeHead(200, rl()); res.end('{}'); });
  const am = measuredManager(1);
  am.accounts[0].expiresAt = Date.now() + MIN;      // inside the 5-min refresh window
  makeOld(am, 0, 20 * MIN);
  let refreshed = 0;
  am.ensureTokenFresh = async () => { refreshed++; };
  const proxy = await claudeProxy(am, up.url);
  try {
    await proxy.remeasureStale();
    assert.equal(probes(up.seen).length, 0, 'no probe on an expiring token');
    assert.equal(refreshed, 0, 'and no refresh from a background pass');
    assert.equal(am.accounts[0]._remeasureAt, undefined, 'tried again on a later tick');
  } finally {
    await closeProxy(proxy);
    await up.close();
  }
});

// ── A, property 4: the other pools are untouched ─────────────────────────────

test('codex, agy, grok and cursor pools never run the idle re-measure', async () => {
  const up = await fakeUpstream((req, res) => { res.writeHead(404); res.end(); });
  try {
    for (const provider of ['codex', 'agy', 'grok', 'cursor']) {
      const am = new AccountManager([{ name: `${provider}-1`, type: 'oauth', provider, accessToken: 't', expiresAt: Date.now() + 8 * HOUR }], 0.98, 0, 3);
      Object.assign(am.accounts[0].quota, {
        unified5h: 0.1, unified5hReset: RESET_5H * 1000, unified7d: 0.2, unified7dReset: RESET_7D * 1000,
        updatedAt: Date.now() - 10 * HOUR,
      });
      const proxy = createProxyServer(am, {
        provider, upstream: up.url, agyUpstream: up.url, grokUpstream: up.url, cursorUpstream: up.url, cursorAgentUpstream: up.url,
        activeWarmup: true, warmupIntervalMs: 20, quotaMaxAgeMs: 1,
        codexUsageRefresh: false, agyQuotaRefresh: false, cursorUsageRefresh: false,
      });
      await listen(proxy);
      try {
        assert.equal(proxy.importProbeTemplate({ model: 'claude-x' }), false, `${provider}: no probe template`);
        await proxy.remeasureStale();
        await settle(100);
      } finally {
        await closeProxy(proxy);
      }
      assert.equal(am.quotaStaleMs, 30 * MIN, `${provider}: display threshold untouched`);
    }
    assert.deepEqual(up.seen, [], 'no request at all reached the upstream');
  } finally {
    await up.close();
  }
});

// ── B: the displays ──────────────────────────────────────────────────────────

const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');

test('quotaAge reads minutes, hours, then days', () => {
  const now = Date.now();
  assert.equal(quotaAge(now - 45 * MIN, now), '45m ago');
  assert.equal(quotaAge(now - 2 * HOUR - 5 * MIN, now), '2h ago');
  assert.equal(quotaAge(now - 3 * 24 * HOUR, now), '3d ago');
  assert.equal(quotaAge(now + MIN, now), '0m ago');
});

test('dashboard: a fresh row is unchanged; a stale row grays its bars and appends its age', () => {
  const am = measuredManager(2);
  am.accounts[0].quota.modelWeekly['7d_oi'] = { utilization: 0.3, reset: RESET_7D * 1000 };
  am.accounts[1].quota.modelWeekly['7d_oi'] = { utilization: 0.3, reset: RESET_7D * 1000 };
  am.setPriority(am.accounts[0], 0);
  am.setPriority(am.accounts[1], 1);
  const tui = new TUI({ accountManager: am, config: { accounts: [] }, saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {} });
  const row = i => tui._renderAcct(am.accounts[i], i, 12, true, true);

  const fresh = row(0);
  am.accounts[0].quota.updatedAt = null;            // as every row rendered before the stamp existed
  assert.equal(fresh, row(0), 'a fresh row is byte-for-byte the old rendering');
  assert.match(fresh, /\x1b\[42;97m/, 'fresh bars keep their colored fill');

  makeOld(am, 1, 2 * HOUR + 5 * MIN);
  const stale = row(1);
  assert.doesNotMatch(stale, /\x1b\[4[123];97m/, 'stale bars lose the colored fill');
  assert.match(stale, /\x1b\[2m2h ago\x1b\[0m$/, 'age appended, dimmed, after everything else');
  // Same columns: the stale row is the fresh row's text plus the age.
  am.accounts[1].quota.updatedAt = Date.now();
  const same = stripAnsi(row(1));
  assert.equal(stripAnsi(stale), `${same}  2h ago`);
  assert.match(same, /Ses .*10%.*Wk .*20%.*Fbl .*30%.*#2$/, 'the numbers and badge stay put');
});

// Only accounts the idle re-measure keeps fresh can read as stale: a
// near-quota (re-measure skips it until its reset), throttled, disabled or
// errored row keeps its usual look however old its numbers are.
test('a near-quota, throttled, disabled or errored account never reads as stale', () => {
  const am = measuredManager(6);
  for (let i = 0; i < 6; i++) makeOld(am, i, 3 * HOUR);
  am.accounts[1].quota.unified7d = 0.99;                    // near quota
  am.markRateLimited(2, 300);                               // throttled
  am.setEnabled(am.accounts[3], false);                     // disabled
  am.accounts[4].status = 'error';                          // auth error
  am.accounts[4].errorReason = 'auth-revoked';
  am.accounts[5].status = 'throttled';                      // throttle ran out, not healed yet
  am.accounts[5].rateLimitedUntil = Date.now() - 1000;
  const stale = am.getStatus({ includeIdentity: true }).accounts.map(a => [a.name, a.quotaStale]);
  assert.deepEqual(stale, [['a0', true], ['a1', false], ['a2', false], ['a3', false], ['a4', false], ['a5', false]]);
  assert.equal(am.accounts[5].status, 'throttled', 'a status poll heals no throttle (the next tick does)');

  // The near-quota row renders exactly as it did before the stamp existed.
  const tui = new TUI({ accountManager: am, config: { accounts: [] }, saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {} });
  const row = tui._renderAcct(am.accounts[1], 1, 12, true, true);
  am.accounts[1].quota.updatedAt = null;
  assert.equal(row, tui._renderAcct(am.accounts[1], 1, 12, true, true));
  assert.match(row, /\x1b\[41;97m/, 'keeps its red fill');
  assert.doesNotMatch(stripAnsi(row), /ago/, 'and no age');
});

const accountState = am => structuredClone(am.accounts.map(a => ({
  quota: a.quota, status: a.status, rateLimitedUntil: a.rateLimitedUntil, enabled: a.enabled,
  counters: [a._partialProbes, a._warmupTries, a._mwProbes],
})));

// Re-audit R1: the TUI redraws on every log line, and the expired-window sweep
// logs before it clears the window. A stale check that swept from the render
// re-entered itself until the stack overflowed (the worker died, and died again
// on restart — the window was never cleared). Drawing must only read.
test('a TUI that redraws on every log line survives a stale account past its window reset', () => {
  for (const win of ['5h', '7d']) for (const used of [0.5, 0.98]) for (const trigger of ['render', 'sweepExpired', 'getStatus']) {
    const label = `${win} at ${used}, ${trigger}`;
    const am = measuredManager(2);
    for (const i of [0, 1]) makeOld(am, i, 45 * MIN);
    am.accounts[0].status = 'throttled';                   // throttle ran out, not healed yet
    am.accounts[0].rateLimitedUntil = Date.now() - 1000;
    const a = am.accounts[1];
    a.quota[`unified${win}`] = used;
    a.quota[`unified${win}Reset`] = Date.now() - 1000;     // past its reset, not swept yet
    a._partialProbes = a._warmupTries = 2;
    const tui = new TUI({ accountManager: am, config: { accounts: [] }, saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {} });
    const before = accountState(am);
    const { log, error } = console;
    const { write } = process.stdout;
    let writes = 0;
    tui.running = true;                                    // as start() leaves it
    console.log = console.error = (...m) => tui._addLog(m.join(' '));
    process.stdout.write = () => { writes++; return true; };
    try {
      if (trigger === 'render') tui.render(); else am[trigger]();
    } finally {
      tui.running = false;
      Object.assign(console, { log, error });
      process.stdout.write = write;
    }
    assert.equal(writes, 1, `${label}: one frame drawn`);
    assert.equal(am.accounts[0].status, 'throttled', `${label}: no throttle healed`);
    if (trigger === 'render') {
      assert.deepEqual(accountState(am), before, `${label}: drawing changes no account state`);
      assert.equal(tui.log.length, 0, `${label}: drawing logs nothing`);
    } else {
      assert.equal(a.quota[`unified${win}`], null, `${label}: the sweep still clears the window`);
      assert.equal(tui.log.length, 1, `${label}: one reset line`);
    }
  }
});

test('app JSON adds quotaUpdatedAt and quotaStale next to the unchanged fields', () => {
  const at = Date.now() - 2 * HOUR;
  const live = { accounts: [
    { name: 'old', usable: true, quotaStale: true, quota: { unified5h: 0.1, unified7d: 0.2, updatedAt: at } },
    { name: 'new', usable: true, quotaStale: false, quota: { unified5h: 0.1, unified7d: 0.2, updatedAt: null } },
  ] };
  const [old, fresh] = accountViews([{ name: 'old' }, { name: 'new' }], live);
  assert.equal(old.quotaUpdatedAt, new Date(at).toISOString());
  assert.equal(old.quotaStale, true);
  assert.equal(fresh.quotaUpdatedAt, null);
  assert.equal(fresh.quotaStale, false);
  assert.deepEqual(old.fiveHour, { usedPct: 10, resetsAt: null }, 'existing fields keep their shape');
  const [offline] = accountViews([{ name: 'old' }], null);
  assert.equal(offline.quotaStale, null, 'unknown without a running server');
  assert.equal(offline.quotaUpdatedAt, null);
  const [older] = accountViews([{ name: 'old' }], { accounts: [{ name: 'old', quota: {} }] });
  assert.equal(older.quotaStale, null, 'unknown from a server that predates the field');
});

// ── C: the Fable window's own age ────────────────────────────────────────────
// 2026-11-11: seven proxies sharing six accounts showed two different sets of
// Fable weekly numbers. The 7d_oi window rides only Fable-tier responses; a
// proxy whose template is lower-tier refreshed quota.updatedAt with every
// response and probe but never that window, so it kept the first value it saw
// — through R, too.

const FABLE = 'claude-fable-test';
const oi = u => ({
  'anthropic-ratelimit-unified-7d_oi-utilization': String(u),
  'anthropic-ratelimit-unified-7d_oi-reset': String(RESET_7D),
});

/** Fable-tier models (by name) answer with their 7d_oi window too; `fable` overrides that answer. */
function fableUpstream(u = 0.4, { fable = null, hold = null } = {}) {
  return fakeUpstream(async (req, res, body) => {
    const { model } = JSON.parse(body || '{}');
    if (/fable/.test(model)) {
      if (hold) await hold;
      if (fable) return fable(res);
      res.writeHead(200, { ...rl(0.5, 0.6), ...oi(u) });
    } else {
      res.writeHead(200, rl(0.5, 0.6));
    }
    res.end('{}');
  });
}

const sentModels = seen => probes(seen).map(r => JSON.parse(r.body).model);
const fableOf = a => a.quota.modelWeekly['7d_oi'];

/** Measured with a Fable window last seen `ageMs` ago; quota.updatedAt stays fresh (lower-tier traffic). */
function withOldFable(am, i, ageMs, u = 0.1) {
  am.updateQuota(i, oi(u), { status: 200 });
  am.accounts[i].quota.modelWeekly['7d_oi'].at = Date.now() - ageMs;
}

test('updateQuota stamps each model window with its own time', () => {
  const am = measuredManager(1);
  const a = am.accounts[0];
  const t0 = Date.now();
  am.updateQuota(a, { ...rl(), ...oi(0.3) }, { status: 200 });
  assert.ok(fableOf(a).at >= t0 && fableOf(a).at <= Date.now(), 'stamped with the window');
  fableOf(a).at = t0 - HOUR;
  am.updateQuota(a, rl(0.2, 0.3), { status: 200 });           // a lower-tier response
  assert.equal(fableOf(a).at, t0 - HOUR, 'a response without the window leaves its stamp');
  assert.ok(a.quota.updatedAt >= t0, 'while the account stamp moves on');
  assert.deepEqual(Object.keys(am.getStatus().accounts[0].quota.modelWeekly['7d_oi']).slice(0, 2),
    ['utilization', 'reset'], 'the status fields stay as they were (the stamp is added)');
});

test('needsModelWeekly with an age: an old or unstamped window counts, one attempt per age', () => {
  const am = measuredManager(1);
  const a = am.accounts[0];
  const now = Date.now();
  withOldFable(am, 0, 0);
  assert.equal(am.needsModelWeekly(a, 15 * MIN, now), false, 'fresh window');
  withOldFable(am, 0, 16 * MIN);
  assert.equal(am.needsModelWeekly(a), false, 'without an age only a missing window counts (as before)');
  assert.equal(am.needsModelWeekly(a, 15 * MIN, now), true, 'older than the age');
  delete fableOf(a).at;
  assert.equal(am.needsModelWeekly(a, 15 * MIN, now), true, 'no stamp reads as old');
  // An attempt, answered or not, paces the next one to a full age later.
  a._mwProbeAt = now - 5 * MIN;
  assert.equal(am.needsModelWeekly(a, 15 * MIN, now), false);
  assert.equal(am.needsModelWeekly(a, 15 * MIN, now + 10 * MIN), true);
  // The budget still caps an account that never reports the window.
  a._mwProbes = am.maxWarmupTries;
  assert.equal(am.needsModelWeekly(a, 15 * MIN, now + 10 * MIN), false);

  // A snapshot from before the stamp (or any snapshot): model windows are not
  // restored, so the first tick measures them.
  const saved = JSON.parse(JSON.stringify(am.exportQuotaState()));
  saved[0].quota.modelWeekly = { '7d_oi': { utilization: 0.9, reset: RESET_7D * 1000 } };
  const restored = new AccountManager(makeAccounts(1), 0.98, 0, 3);
  restored.importQuotaState(saved);
  assert.deepEqual(restored.accounts[0].quota.modelWeekly, {});
  assert.equal(restored.needsModelWeekly(restored.accounts[0], 15 * MIN), true);
});

test('the timer re-measures an old Fable window with a Fable-model probe on a lower-tier template', async () => {
  const up = await fableUpstream(0.4);
  const am = measuredManager(1);
  const a = am.accounts[0];
  withOldFable(am, 0, 20_000);
  const proxy = await claudeProxy(am, up.url, { warmupIntervalMs: 20, quotaMaxAgeMs: 10_000, modelWeeklyProbeModel: FABLE });
  try {
    assert.ok(await waitFor(() => fableOf(a).utilization === 0.4), 'the upstream value replaced the old one');
    assert.ok(Date.now() - fableOf(a).at < 5_000, 'and stamped');
    await settle(300); // ~15 more ticks, all inside the new 10 s age
    assert.deepEqual(sentModels(up.seen), [FABLE], 'one Fable probe, none again inside the age');
    assert.equal(a._mwProbes, 0, 'the window came back: budget clear');
  } finally {
    await closeProxy(proxy);
    await up.close();
  }
});

test('R re-measures the Fable window at once: one Fable probe per account, the template when refused', async () => {
  const up = await fableUpstream(0.4);
  const refusing = await fableUpstream(0.4, { fable: res => { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{}'); } });
  try {
    const am = measuredManager(2);
    withOldFable(am, 0, 0);                  // fresh by its stamp — R measures anyway
    withOldFable(am, 1, 0);
    await withClaudeProxy(am, up.url, { modelWeeklyProbeModel: FABLE }, async proxy => {
      assert.deepEqual(await proxy.refreshQuotaAll(), { targets: 2, measured: 2 });
    });
    assert.deepEqual(sentModels(up.seen), [FABLE, FABLE], 'one request per account');
    assert.deepEqual(am.accounts.map(a => fableOf(a).utilization), [0.4, 0.4]);
    assert.equal(am.needsModelWeekly(am.accounts[0], 15 * MIN), false, 'the timer waits a full age after R');

    // A refused probe model (400) still leaves R measuring the account, with the template.
    const am2 = measuredManager(1);
    withOldFable(am2, 0, 0);
    makeOld(am2, 0, 20 * MIN);
    await withClaudeProxy(am2, refusing.url, { modelWeeklyProbeModel: FABLE }, async proxy => {
      assert.deepEqual(await proxy.refreshQuotaAll(), { targets: 1, measured: 1 });
    });
    assert.deepEqual(sentModels(refusing.seen), [FABLE, 'claude-x']);
    assert.ok(Date.now() - am2.accounts[0].quota.updatedAt < 5_000, '5h/7d measured by the template');
    assert.equal(am2.accounts[0]._mwProbes, am2.maxWarmupTries, 'the refused model is not retried by the timer');
  } finally {
    await up.close();
    await refusing.close();
  }
});

test('a busy account gets its Fable probe in a real slot; a full one waits for a later tick', async () => {
  let release;
  const hold = new Promise(r => { release = r; });
  const up = await fableUpstream(0.4, { hold });
  const am = measuredManager(2, { maxConcurrent: 2 });
  const [a0, a1] = am.accounts;
  withOldFable(am, 0, 20_000);
  withOldFable(am, 1, 20_000);
  a0.inflight = 1;                           // serving Opus, one slot free
  a1.inflight = 2;                           // full
  const proxy = await claudeProxy(am, up.url, { warmupIntervalMs: 20, quotaMaxAgeMs: 10_000, modelWeeklyProbeModel: FABLE });
  try {
    assert.ok(await waitFor(() => a0._warming === true), 'a0 probed while busy');
    assert.equal(a0.inflight, 2, 'the probe holds a real slot');
    assert.equal(await am.acquireAccount(), null, 'so a client finds both accounts full');
    await settle(100);
    assert.equal(a1._warming, undefined, 'a full account is not probed');
    assert.equal(a1._mwProbeAt, undefined, 'nor charged an attempt');
    release();
    assert.ok(await waitFor(() => fableOf(a0).utilization === 0.4));
    assert.ok(await waitFor(() => a0.inflight === 1), 'the slot is given back');
    a1.inflight = 1;                         // a request finished: a slot frees up
    assert.ok(await waitFor(() => fableOf(a1).utilization === 0.4), 'a1 measured on a later tick');
    assert.equal(a1.inflight, 1);
    assert.deepEqual(probes(up.seen).map(r => r.auth), ['Bearer tok-0', 'Bearer tok-1']);
    assert.deepEqual(sentModels(up.seen), [FABLE, FABLE]);
  } finally {
    release();
    await closeProxy(proxy);
    await up.close();
  }
});

test('a failed Fable probe waits a full age; an account that never reports the window stops at the budget', async () => {
  const up = await fableUpstream(0.4, { fable: res => { res.writeHead(500); res.end(); } });
  const am = measuredManager(1);
  withOldFable(am, 0, 20_000);
  const before = structuredClone(am.getStatus({ includeIdentity: true }).accounts[0]);
  const proxy = await claudeProxy(am, up.url, { warmupIntervalMs: 20, quotaMaxAgeMs: 10_000, modelWeeklyProbeModel: FABLE });
  try {
    assert.ok(await waitFor(() => probes(up.seen).length === 1));
    await settle(300);
    assert.deepEqual(sentModels(up.seen), [FABLE], 'not retried inside the age');
    assert.deepEqual(am.getStatus({ includeIdentity: true }).accounts[0], before, 'nothing changed');
  } finally {
    await closeProxy(proxy);
    await up.close();
  }

  // 200 without the window, an age of 30 ms: three attempts, then nothing.
  const silent = await fableUpstream(0.4, { fable: res => { res.writeHead(200, rl(0.5, 0.6)); res.end('{}'); } });
  const am2 = measuredManager(1);
  withOldFable(am2, 0, 20_000);
  const proxy2 = await claudeProxy(am2, silent.url, { warmupIntervalMs: 10, quotaMaxAgeMs: 30, modelWeeklyProbeModel: FABLE });
  try {
    assert.ok(await waitFor(() => am2.accounts[0]._mwProbes === am2.maxWarmupTries));
    await settle(300);
    assert.equal(sentModels(silent.seen).filter(m => m === FABLE).length, am2.maxWarmupTries);
    assert.equal(fableOf(am2.accounts[0]).utilization, 0.1, 'the old value stays until its reset');
  } finally {
    await closeProxy(proxy2);
    await silent.close();
  }
});

test('a template that already brings the window: one probe per account, never two', async () => {
  const up = await fableUpstream(0.4);
  const am = measuredManager(2);
  withOldFable(am, 0, 20_000);               // Opus traffic keeps a0's stamp fresh, not its Fable window
  withOldFable(am, 1, 20_000);
  makeOld(am, 1, 20_000);                    // a1: everything old
  const proxy = createProxyServer(am, { upstream: up.url, warmupIntervalMs: 20, quotaMaxAgeMs: 10_000 });
  await listen(proxy);
  try {
    assert.equal(proxy.importProbeTemplate({ model: 'claude-fable-top', _elicitsModelWeekly: true }), true);
    assert.ok(await waitFor(() => am.accounts.every(a => fableOf(a).utilization === 0.4)));
    await settle(300);
    assert.deepEqual(sentModels(up.seen), ['claude-fable-top', 'claude-fable-top'],
      'the template as committed (no model swap), one request each');
    assert.deepEqual(probes(up.seen).map(r => r.auth).sort(), ['Bearer tok-0', 'Bearer tok-1']);
    assert.ok(Date.now() - am.accounts[1].quota.updatedAt < 5_000, "a1's 5h/7d came with it");
  } finally {
    await closeProxy(proxy);
    await up.close();
  }
});

test('a probe replays only the Claude Code identity line of the template system', async () => {
  const MARKER = "You are Claude Code, Anthropic's official CLI for Claude.";
  const big = 'x'.repeat(17_000);
  const cases = [
    [[{ type: 'text', text: 'x-anthropic-billing-header: cc_version=1;' },
      { type: 'text', text: MARKER, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: big, cache_control: { type: 'ephemeral' } }], MARKER],
    [`${MARKER}\n${big}`, MARKER],
    ['You are a helpful assistant.', 'You are a helpful assistant.'],     // not Claude Code: as is
    [[{ type: 'text', text: 'Be brief.' }], [{ type: 'text', text: 'Be brief.' }]],
  ];
  const up = await fableUpstream(0.4);
  try {
    for (const [system, expected] of cases) {
      const am = measuredManager(1);
      const proxy = createProxyServer(am, { upstream: up.url, warmupIntervalMs: 0, modelWeeklyProbeModel: false });
      await listen(proxy);
      try {
        assert.equal(proxy.importProbeTemplate({ model: 'claude-x', system }), true);
        await proxy.refreshQuotaAll();
      } finally {
        await closeProxy(proxy);
      }
      assert.deepEqual(JSON.parse(probes(up.seen).at(-1).body).system, expected);
    }
  } finally {
    await up.close();
  }
});
