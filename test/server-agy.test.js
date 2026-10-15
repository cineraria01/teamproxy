import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { AGY_DEFAULT_USER_AGENT } from '../src/agy.js';

const HOUR = 60 * 60 * 1000;
const AGY_UA = 'antigravity/cli/1.3.3 (aidev_client; os_type=darwin; arch=arm64; cl=1; auth_method=consumer)';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('condition was not met before timeout');
}

function agyAccount(name, extra = {}) {
  return {
    name,
    provider: 'agy',
    type: 'oauth',
    accountUuid: `sub-${name}`,
    accessToken: `tok-${name}`,
    refreshToken: `refresh-${name}`,
    expiresAt: Date.now() + HOUR,
    ...extra,
  };
}

function quotaSummary({ geminiRemaining = 1 } = {}) {
  const reset = ms => new Date(Date.now() + ms).toISOString();
  return {
    groups: [
      { displayName: 'Gemini Models', buckets: [
        { bucketId: 'gemini-weekly', window: 'weekly', resetTime: reset(100 * HOUR), remainingFraction: 1 },
        // proto3 omits a zero fraction: a spent bucket arrives without the field
        { bucketId: 'gemini-5h', window: '5h', resetTime: reset(3 * HOUR),
          ...(geminiRemaining == null ? {} : { remainingFraction: geminiRemaining }) },
      ] },
      { displayName: 'Claude and GPT models', buckets: [
        { bucketId: '3p-weekly', window: 'weekly', resetTime: reset(100 * HOUR), remainingFraction: 1 },
        { bucketId: '3p-5h', window: '5h', resetTime: reset(3 * HOUR), remainingFraction: 1 },
      ] },
    ],
  };
}

function exhausted429(reason = 'RATE_LIMIT_EXCEEDED', retryDelay = '20s') {
  return JSON.stringify({
    error: {
      code: 429,
      message: 'You have exhausted your capacity on this model.',
      status: 'RESOURCE_EXHAUSTED',
      details: [
        { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'cloudcode-pa.googleapis.com' },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay },
      ],
    },
  });
}

/** Fake Cloud Code upstream: records every call; `route(call, res)` answers. */
async function agyUpstream(route) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const call = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
    call.json = (() => { try { return JSON.parse(call.body.toString()); } catch { return null; } })();
    calls.push(call);
    if (req.url === '/v1internal:retrieveUserQuotaSummary' && !route.ownsSummary) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(quotaSummary()));
      return;
    }
    route(call, res);
  });
  const port = await listen(server);
  return { server, calls, url: `http://127.0.0.1:${port}` };
}

async function agyProxy(accounts, upstreamUrl, extra = {}) {
  const manager = new AccountManager(accounts, 0.98, 0, 8);
  const proxy = createProxyServer(manager, {
    provider: 'agy',
    proxy: { apiKey: 'local-proxy-key' },
    agyUpstream: upstreamUrl,
    agyQuotaRefresh: false,
    ...extra,
  });
  const port = await listen(proxy);
  return { manager, proxy, url: `http://127.0.0.1:${port}` };
}

const inferenceBody = model => JSON.stringify({
  project: 'aicode-consumers',
  requestId: 'agent/conv-1/1760000000000/traj-1/1',
  request: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }], sessionId: 'session-1' },
  model,
  userAgent: 'antigravity',
  requestType: 'agent',
});

test('agy proxy strips client credentials, injects the pool bearer, keeps the user-agent, and aims the body at the account project', async () => {
  const upstream = await agyUpstream((call, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"models":{}}');
  });
  const { proxy, url } = await agyProxy([agyAccount('a', { projectId: 'proj-a' })], upstream.url);
  try {
    const response = await fetch(`${url}/v1internal:fetchAvailableModels`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer agy-own-login-token',
        'x-api-key': 'client-key',
        'x-goog-api-key': 'client-goog-key',
        'x-goog-user-project': 'client-project',
        'user-agent': AGY_UA,
        'content-type': 'application/json',
      },
      body: '{"project":"aicode-consumers"}',
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '{"models":{}}');

    const [call] = upstream.calls;
    assert.equal(call.url, '/v1internal:fetchAvailableModels');
    assert.equal(call.headers.authorization, 'Bearer tok-a');
    assert.equal(call.headers['x-api-key'], undefined);
    assert.equal(call.headers['x-goog-api-key'], undefined);
    assert.equal(call.headers['x-goog-user-project'], undefined);
    assert.equal(call.headers['user-agent'], AGY_UA);
    assert.deepEqual(call.json, { project: 'proj-a' });
    assert.equal(Number(call.headers['content-length']), call.body.length);
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream.server)]);
  }
});

test('an exhaustion 429 blocks that account\'s group, refreshes its summary, and fails over with the next account\'s project', async () => {
  const route = (call, res) => {
    if (call.url === '/v1internal:retrieveUserQuotaSummary') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(quotaSummary({
        geminiRemaining: call.headers.authorization === 'Bearer tok-a' && route.aExhausted ? null : 1,
      })));
      return;
    }
    if (call.headers.authorization === 'Bearer tok-a') {
      route.aExhausted = true;
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(exhausted429());
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"response":{"candidates":[]}}');
  };
  route.ownsSummary = true;
  const upstream = await agyUpstream(route);
  const { manager, proxy, url } = await agyProxy(
    [agyAccount('a', { projectId: 'proj-a' }), agyAccount('b', { projectId: 'proj-b' })],
    upstream.url,
    { agyQuotaRefresh: true, warmupIntervalMs: 0 },
  );
  try {
    await waitFor(() => manager.accounts.every(a => a.quota.agyQuotaAt));
    const response = await fetch(`${url}/v1internal:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': AGY_UA },
      body: inferenceBody('gemini-3.6-flash-low'),
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '{"response":{"candidates":[]}}');

    const inference = upstream.calls.filter(call => call.url === '/v1internal:generateContent');
    assert.deepEqual(inference.map(call => [call.headers.authorization, call.json.project]), [
      ['Bearer tok-a', 'proj-a'],
      ['Bearer tok-b', 'proj-b'],
    ]);

    const [a] = manager.accounts;
    await waitFor(() => upstream.calls.filter(call => call.url === '/v1internal:retrieveUserQuotaSummary'
      && call.headers.authorization === 'Bearer tok-a').length === 2);
    await waitFor(() => a.quota.agyGroups.gemini.blockedUntil > Date.now() + 2 * HOUR);
    const refresh = upstream.calls.filter(call => call.url === '/v1internal:retrieveUserQuotaSummary').at(-1);
    assert.equal(refresh.headers['user-agent'], AGY_UA, 'proxy-originated calls reuse the client user-agent');
    assert.deepEqual(refresh.json, { project: 'proj-a' });
    assert.equal(manager._isAvailable(a, 'gemini-3.6-flash-low'), false);
    assert.equal(manager._isAvailable(a, 'claude-opus-5-5-high'), true, 'the Claude/GPT group stays routable');
    assert.equal(a.status, 'active', 'the account itself is not throttled');
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream.server)]);
  }
});

test('a MODEL_CAPACITY 429 fails over without throttling the account', async () => {
  const upstream = await agyUpstream((call, res) => {
    if (call.headers.authorization === 'Bearer tok-a') {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(exhausted429('MODEL_CAPACITY_EXHAUSTED', '5s'));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"response":{}}');
  });
  const { manager, proxy, url } = await agyProxy([agyAccount('a'), agyAccount('b')], upstream.url);
  try {
    const response = await fetch(`${url}/v1internal:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: inferenceBody('gemini-3.1-pro-high'),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(upstream.calls.map(call => call.headers.authorization), ['Bearer tok-a', 'Bearer tok-b']);
    const [a] = manager.accounts;
    assert.equal(a.quota.agyGroups, undefined);
    assert.equal(manager._isAvailable(a, 'gemini-3.1-pro-high'), true);
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream.server)]);
  }
});

test('another client (no agy user-agent, no project) gets an agy user-agent and the account project, failover included', async () => {
  const route = (call, res) => {
    if (call.headers.authorization === 'Bearer tok-a' && call.url.startsWith('/v1internal:streamGenerateContent')
        && !route.failed) {
      route.failed = true;
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(exhausted429('MODEL_CAPACITY_EXHAUSTED', '5s'));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"response":{}}');
  };
  const upstream = await agyUpstream(route);
  const { proxy, url } = await agyProxy(
    [agyAccount('a', { projectId: 'proj-a' }), agyAccount('b')], upstream.url);
  const foreign = project => fetch(`${url}/v1internal:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'curl/8.7.1', 'x-goog-api-key': 'app-key' },
    body: JSON.stringify({
      model: 'gemini-3.6-flash-low',
      ...(project == null ? {} : { project }),
      request: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
    }),
  });
  const projectOf = call => (call.headers.authorization === 'Bearer tok-a' ? 'proj-a' : 'aicode-consumers');
  try {
    assert.equal((await foreign()).status, 200);
    assert.deepEqual(upstream.calls.map(call => [call.headers.authorization, call.headers['user-agent'],
      call.headers['x-goog-api-key'], call.json.project]), [
      ['Bearer tok-a', AGY_DEFAULT_USER_AGENT, undefined, 'proj-a'],
      ['Bearer tok-b', AGY_DEFAULT_USER_AGENT, undefined, 'aicode-consumers'],
    ]);

    // agy's own call: user-agent and a project-less non-inference body stay as sent
    const agyBody = '{"metadata":{"ideType":"ANTIGRAVITY"}}';
    assert.equal((await fetch(`${url}/v1internal:loadCodeAssist`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': AGY_UA }, body: agyBody,
    })).status, 200);
    const load = upstream.calls.at(-1);
    assert.equal(load.headers['user-agent'], AGY_UA);
    assert.equal(load.body.toString(), agyBody);

    // later foreign calls borrow the latest real agy user-agent; '' counts as no project
    const before = upstream.calls.length;
    assert.equal((await foreign('')).status, 200);
    const later = upstream.calls.slice(before);
    assert.ok(later.length > 0);
    for (const call of later) {
      assert.equal(call.headers['user-agent'], AGY_UA);
      assert.equal(call.json.project, projectOf(call));
    }
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream.server)]);
  }
});

test('when every account is exhausted the upstream 429 body reaches agy unchanged', async () => {
  const bodies = {
    'Bearer tok-a': exhausted429('RATE_LIMIT_EXCEEDED', '11s'),
    'Bearer tok-b': exhausted429('QUOTA_EXHAUSTED', '22s'),
  };
  const upstream = await agyUpstream((call, res) => {
    res.writeHead(429, { 'content-type': 'application/json', 'x-upstream': 'cloudcode' });
    res.end(bodies[call.headers.authorization]);
  });
  const { proxy, url } = await agyProxy([agyAccount('a'), agyAccount('b')], upstream.url);
  try {
    const response = await fetch(`${url}/v1internal:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: inferenceBody('claude-sonnet-5-5-low'),
    });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('x-upstream'), 'cloudcode');
    assert.equal(await response.text(), bodies['Bearer tok-b']);
    assert.equal(upstream.calls.length, 2);

    // The next request finds no account for the group and answers in the same
    // Google RPC shape without another upstream call.
    const again = await fetch(`${url}/v1internal:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: inferenceBody('claude-sonnet-5-5-low'),
    });
    assert.equal(again.status, 429);
    const body = await again.json();
    assert.equal(body.error.status, 'RESOURCE_EXHAUSTED');
    assert.match(body.error.details[0].retryDelay, /^\d+s$/);
    assert.ok(Number(again.headers.get('retry-after')) >= 1);
    assert.equal(upstream.calls.length, 2);

    // A model-less call (no quota group) is still dispatched, never gated; its
    // 429 counts as capacity: one bounded failover, then pass-through.
    const control = await fetch(`${url}/v1internal:fetchAvailableModels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"project":"aicode-consumers"}',
    });
    assert.equal(control.status, 429);
    assert.equal(upstream.calls.length, 4);
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream.server)]);
  }
});

test('agy SSE passes through byte-identical', async () => {
  const frames = [
    'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"안녕"}]}}],"responseId":"r1"},"traceId":"t1","metadata":{}}\r\n\r\n',
    'data: {"response":{"candidates":[{"content":{"parts":[{"text":"하세요 👋"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"totalTokenCount":11}},"traceId":"t1","metadata":{}}\n\n',
    ': trailing comment without a newline',
  ];
  const expected = Buffer.from(frames.join(''));
  const upstream = await agyUpstream(async (call, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    // Split inside a multi-byte character and inside a frame.
    const cuts = [0, 37, 95, 96, 97, expected.length - 5, expected.length];
    for (let i = 0; i < cuts.length - 1; i++) {
      res.write(expected.subarray(cuts[i], cuts[i + 1]));
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    res.end();
  });
  const { manager, proxy, url } = await agyProxy([agyAccount('a')], upstream.url);
  try {
    const response = await fetch(`${url}/v1internal:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: inferenceBody('gemini-3.6-flash-low'),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    const received = Buffer.from(await response.arrayBuffer());
    assert.equal(received.equals(expected), true, 'no synthetic frames, no re-framing');
    assert.equal(upstream.calls[0].url, '/v1internal:streamGenerateContent?alt=sse');
    // Usage comes from the final frame's usageMetadata (status token totals).
    await waitFor(() => manager.accounts[0].usage.totalOutputTokens > 0);
    assert.equal(manager.accounts[0].usage.totalInputTokens, 3);
    assert.equal(manager.accounts[0].usage.totalOutputTokens, 8);
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream.server)]);
  }
});

test('a trajectory\'s ACL write and its inference stay on one account across connections', async () => {
  const upstream = await agyUpstream((call, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const { manager, proxy, url } = await agyProxy([agyAccount('a'), agyAccount('b')], upstream.url);
  try {
    // A fresh socket per request: only the trajectory key can link the two.
    const post = (path, body) => new Promise((resolve, reject) => {
      const request = http.request(`${url}${path}`, {
        method: 'POST',
        agent: false,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      }, response => {
        response.resume();
        response.on('end', resolve);
      });
      request.on('error', reject);
      request.end(body);
    });
    manager.currentIndex = 1;
    await post('/v1internal:writeTrajectoryAcls', '{"trajectoryId":"traj-1"}');
    manager.currentIndex = 0; // the sticky primary moves meanwhile
    await post('/v1internal:generateContent', inferenceBody('gemini-3.6-flash-low'));
    assert.deepEqual(upstream.calls.map(call => call.headers.authorization), ['Bearer tok-b', 'Bearer tok-b']);
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream.server)]);
  }
});

test('a 429 on a non-inference call with a model is capacity: no group block', async () => {
  const upstream = await agyUpstream((call, res) => {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(exhausted429('RATE_LIMIT_EXCEEDED', '9s'));
  });
  const { manager, proxy, url } = await agyProxy([agyAccount('a'), agyAccount('b'), agyAccount('c')], upstream.url);
  try {
    const response = await fetch(`${url}/v1internal:countTokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'aicode-consumers', model: 'gemini-3.6-flash-low', request: {} }),
    });
    assert.equal(response.status, 429);
    assert.equal(upstream.calls.length, 2, 'one bounded alternate (rateLimitFailovers), then pass-through');
    for (const account of manager.accounts) {
      assert.equal(account.quota.agyGroups, undefined);
      assert.equal(manager._isAvailable(account, 'gemini-3.6-flash-low'), true);
    }
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream.server)]);
  }
});

test('a pool dead end tells agy when the soonest account frees up', async () => {
  const upstream = await agyUpstream((call, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const { manager, proxy, url } = await agyProxy([agyAccount('a'), agyAccount('b')], upstream.url);
  try {
    const [a, b] = manager.accounts;
    manager.blockAgyGroup(a, '3p', 120_000);
    manager.blockAgyGroup(b, '3p', 40_000);
    const response = await fetch(`${url}/v1internal:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: inferenceBody('gpt-oss-120b-medium'),
    });
    assert.equal(response.status, 429);
    const retryAfter = Number(response.headers.get('retry-after'));
    assert.ok(retryAfter >= 39 && retryAfter <= 40, `retry-after ${retryAfter}`);
    const body = await response.json();
    assert.equal(body.error.details[0].retryDelay, `${retryAfter}s`);
    assert.equal(upstream.calls.length, 0, 'nothing was dispatched');
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream.server)]);
  }
});

test('an exhaustion refresh waits behind an in-flight routine refresh instead of being dropped', async () => {
  let releaseHeld;
  const held = new Promise(resolve => { releaseHeld = resolve; });
  const state = { holdNextSummary: false, aExhausted: false, aInference: 0 };
  const route = async (call, res) => {
    if (call.url === '/v1internal:retrieveUserQuotaSummary') {
      if (state.holdNextSummary && call.headers.authorization === 'Bearer tok-a') {
        state.holdNextSummary = false;
        await held; // the routine refresh is still in flight while the 429 lands
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(quotaSummary({
        geminiRemaining: call.headers.authorization === 'Bearer tok-a' && state.aExhausted ? null : 1,
      })));
      return;
    }
    if (call.headers.authorization === 'Bearer tok-a' && ++state.aInference === 2) {
      state.aExhausted = true;
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(exhausted429());
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"response":{}}');
  };
  route.ownsSummary = true;
  const upstream = await agyUpstream(route);
  const { manager, proxy, url } = await agyProxy([agyAccount('a'), agyAccount('b')], upstream.url, {
    agyQuotaRefresh: true,
    warmupIntervalMs: 0,
    agyUsageActiveMs: 1,
  });
  const generate = () => fetch(`${url}/v1internal:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: inferenceBody('gemini-3.6-flash-low'),
  }).then(response => response.status);
  try {
    const [a] = manager.accounts;
    await waitFor(() => manager.accounts.every(account => account.quota.agyQuotaAt));
    await new Promise(resolve => setTimeout(resolve, 5));
    state.holdNextSummary = true;
    assert.equal(await generate(), 200); // served by a → routine refresh of a starts and is held
    await waitFor(() => a._usageRefreshing === true);
    assert.equal(await generate(), 200); // a → 429 (exhausted) → b serves
    assert.ok(a.quota.agyGroups.gemini.blockedUntil <= Date.now() + 20_000, 'RetryInfo fallback while queued');
    releaseHeld();
    await waitFor(() => a.quota.agyGroups.gemini.blockedUntil > Date.now() + 2 * HOUR);
  } finally {
    releaseHeld();
    await Promise.all([closeServer(proxy), closeServer(upstream.server)]);
  }
});

test('every account failing authentication answers agy in the Google RPC shape', async () => {
  const upstream = await agyUpstream((call, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":{"code":401,"status":"UNAUTHENTICATED"}}');
  });
  // No OAuth client configured: the forced refresh fails non-terminally.
  const { proxy, url } = await agyProxy([agyAccount('a')], upstream.url);
  try {
    const response = await fetch(`${url}/v1internal:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: inferenceBody('gemini-3.6-flash-low'),
    });
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error.code, 401);
    assert.equal(body.error.status, 'UNAUTHENTICATED');
    assert.equal(typeof body.error.message, 'string');
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream.server)]);
  }
});

test('an account added during an in-flight quota refresh is measured by that same refresh', async () => {
  let releaseHeld;
  const held = new Promise(resolve => { releaseHeld = resolve; });
  const state = { hold: false };
  const route = async (call, res) => {
    if (call.url === '/v1internal:retrieveUserQuotaSummary') {
      if (state.hold && call.headers.authorization === 'Bearer tok-a') {
        state.hold = false;
        await held;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(quotaSummary()));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"response":{}}');
  };
  route.ownsSummary = true;
  const upstream = await agyUpstream(route);
  const { manager, proxy } = await agyProxy([agyAccount('a')], upstream.url, { agyQuotaRefresh: true, warmupIntervalMs: 0 });
  try {
    await waitFor(() => manager.accounts[0].quota.agyQuotaAt); // the start-up refresh is done
    state.hold = true;
    const first = proxy.refreshQuotaAll(); // a's summary is held: the refresh stays in flight
    await waitFor(() => upstream.calls.filter(c => c.headers.authorization === 'Bearer tok-a').length >= 2);
    manager.addAccount(agyAccount('b')); // a live sync lands meanwhile and asks for a refresh too
    const second = proxy.refreshQuotaAll();
    releaseHeld();
    const [r1, r2] = await Promise.all([first, second]);
    assert.deepEqual(r2, r1);
    assert.equal(r1.targets, 2);
    assert.ok(manager.accounts[1].quota.agyQuotaAt, 'the new account was measured');
  } finally {
    releaseHeld();
    await Promise.all([closeServer(proxy), closeServer(upstream.server)]);
  }
});
