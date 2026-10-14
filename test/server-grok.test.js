import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { GROK_DEFAULT_CLIENT_VERSION } from '../src/grok.js';

const HOUR = 60 * 60 * 1000;
const GROK_UA = 'grok-shell/1.0.47 (macos; aarch64)';

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

function grokAccount(name, extra = {}) {
  return {
    name,
    provider: 'grok',
    type: 'oauth',
    accountUuid: `user-${name}`,
    email: `${name}@example.com`,
    teamId: `team-${name}`,
    accessToken: `tok-${name}`,
    refreshToken: `refresh-${name}`,
    expiresAt: Date.now() + HOUR,
    ...extra,
  };
}

/** Fake cli-chat-proxy upstream: records every call; `route(call, res)` answers. */
async function grokUpstream(route) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const call = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
    calls.push(call);
    route(call, res);
  });
  const port = await listen(server);
  return { server, calls, url: `http://127.0.0.1:${port}` };
}

async function grokProxy(accounts, upstreamUrl, extra = {}) {
  const manager = new AccountManager(accounts, 0.98, 0, 8);
  const proxy = createProxyServer(manager, {
    provider: 'grok',
    proxy: { apiKey: 'local-proxy-key' },
    grokUpstream: upstreamUrl,
    ...extra,
  });
  const port = await listen(proxy);
  return { manager, proxy, url: `http://127.0.0.1:${port}` };
}

/** One request on its own socket (no keep-alive reuse), so socket affinity cannot explain the routing. */
function send(url, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${url}${path}`, { method, headers, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const ok = (res, body = '{}', headers = {}) => {
  res.writeHead(200, { 'content-type': 'application/json', ...headers });
  res.end(body);
};

test('grok proxy strips client credentials and cookies, injects the pool bearer, and keeps the other headers', async () => {
  const upstream = await grokUpstream((call, res) => ok(res, '{"object":"list","data":[]}'));
  const { proxy, url } = await grokProxy([grokAccount('a')], upstream.url);
  try {
    const response = await send(url, '/v1/models', {
      headers: {
        authorization: 'Bearer grok-own-login',
        'x-api-key': 'client-key',
        cookie: 'session=local',
        'user-agent': GROK_UA,
        'x-grok-client-version': '1.0.47',
        'x-xai-token-auth': 'xai-grok-cli',
        'x-grok-model-override': 'grok-4.7',
      },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.toString(), '{"object":"list","data":[]}');
    const [call] = upstream.calls;
    assert.equal(call.url, '/v1/models');
    assert.equal(call.headers.authorization, 'Bearer tok-a');
    assert.equal(call.headers['x-api-key'], undefined);
    assert.equal(call.headers.cookie, undefined);
    assert.equal(call.headers['user-agent'], GROK_UA);
    assert.equal(call.headers['x-xai-token-auth'], 'xai-grok-cli');
    assert.equal(call.headers['x-grok-model-override'], 'grok-4.7');
    assert.equal(call.headers['x-grok-client-version'], '1.0.47');
  } finally {
    await closeServer(proxy);
    await closeServer(upstream.server);
  }
});

test('a client without x-grok-client-version gets the configured default, then the version last seen from grok', async () => {
  const upstream = await grokUpstream((call, res) => ok(res));
  const { proxy, url } = await grokProxy([grokAccount('a')], upstream.url, { grokClientVersion: '1.0.40' });
  try {
    await send(url, '/v1/user', { headers: { 'user-agent': 'selvi/0.2' } });
    // a non-grok client's own version is forwarded but never remembered
    await send(url, '/v1/user', { headers: { 'user-agent': 'selvi/0.2', 'x-grok-client-version': '9.9.9' } });
    await send(url, '/v1/user', { headers: { 'user-agent': 'selvi/0.2' } });
    await send(url, '/v1/user', { headers: { 'user-agent': GROK_UA, 'x-grok-client-version': '1.0.47' } });
    await send(url, '/v1/user', { headers: { 'user-agent': 'selvi/0.2' } });
    assert.deepEqual(upstream.calls.map(call => call.headers['x-grok-client-version']),
      ['1.0.40', '9.9.9', '1.0.40', '1.0.47', '1.0.47']);
  } finally {
    await closeServer(proxy);
    await closeServer(upstream.server);
  }
  const bare = await grokUpstream((call, res) => ok(res));
  const plain = await grokProxy([grokAccount('a')], bare.url);
  try {
    await send(plain.url, '/v1/user');
    assert.equal(bare.calls[0].headers['x-grok-client-version'], GROK_DEFAULT_CLIENT_VERSION);
  } finally {
    await closeServer(plain.proxy);
    await closeServer(bare.server);
  }
});

test('identity headers are rewritten to the serving account, never added, and follow a failover', async () => {
  let first = true;
  const upstream = await grokUpstream((call, res) => {
    if (call.url === '/v1/responses' && first) {
      first = false;
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30' });
      res.end('{"error":"rate limited"}');
      return;
    }
    ok(res);
  });
  const { proxy, url } = await grokProxy([grokAccount('a'), grokAccount('b', { teamId: null })], upstream.url);
  try {
    const identity = { 'x-userid': 'local-user', 'x-grok-user-id': 'local-user', 'x-email': 'me@local', 'x-teamid': 'local-team' };
    await send(url, '/v1/settings', { headers: identity });
    await send(url, '/v1/settings');
    const response = await send(url, '/v1/responses', { method: 'POST', headers: { ...identity, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 200);
    const pick = call => Object.fromEntries(['x-userid', 'x-grok-user-id', 'x-email', 'x-teamid']
      .filter(key => key in call.headers).map(key => [key, call.headers[key]]));
    assert.deepEqual(upstream.calls.map(pick), [
      { 'x-userid': 'user-a', 'x-grok-user-id': 'user-a', 'x-email': 'a@example.com', 'x-teamid': 'team-a' },
      {},
      { 'x-userid': 'user-a', 'x-grok-user-id': 'user-a', 'x-email': 'a@example.com', 'x-teamid': 'team-a' },
      // failover onto b, which has no team: x-teamid dropped, the rest b's
      { 'x-userid': 'user-b', 'x-grok-user-id': 'user-b', 'x-email': 'b@example.com' },
    ]);
    assert.deepEqual(upstream.calls.slice(2).map(call => call.headers.authorization), ['Bearer tok-a', 'Bearer tok-b']);
  } finally {
    await closeServer(proxy);
    await closeServer(upstream.server);
  }
});

test('an upstream 401 refreshes the token once (storing a rotated refresh token) and retries', async () => {
  const tokenCalls = [];
  const tokenServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    tokenCalls.push(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString())));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ access_token: 'tok-new', refresh_token: 'refresh-rotated', expires_in: 21600 }));
  });
  const tokenPort = await listen(tokenServer);
  const upstream = await grokUpstream((call, res) => {
    if (call.headers.authorization === 'Bearer tok-a') {
      res.writeHead(401, { 'www-authenticate': 'Bearer error="invalid_token", error_description="Invalid or expired credentials"' });
      res.end();
      return;
    }
    ok(res, '{"ok":true}');
  });
  const { manager, proxy, url } = await grokProxy([grokAccount('a')], upstream.url);
  manager.grokOAuth = { clientId: 'client-x', tokenUrl: `http://127.0.0.1:${tokenPort}/oauth2/token` };
  try {
    const response = await send(url, '/v1/user');
    assert.equal(response.status, 200);
    assert.equal(response.body.toString(), '{"ok":true}');
    assert.deepEqual(upstream.calls.map(call => call.headers.authorization), ['Bearer tok-a', 'Bearer tok-new']);
    assert.deepEqual(tokenCalls, [{ grant_type: 'refresh_token', refresh_token: 'refresh-a', client_id: 'client-x' }]);
    assert.equal(manager.accounts[0].credential, 'tok-new');
    assert.equal(manager.accounts[0].refreshToken, 'refresh-rotated');
  } finally {
    await closeServer(proxy);
    await closeServer(upstream.server);
    await closeServer(tokenServer);
  }
});

test('invalid_grant on a grok refresh parks the account as refresh-failed', async () => {
  const tokenServer = http.createServer((req, res) => {
    req.resume();
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end('{"error":"invalid_grant"}');
  });
  const tokenPort = await listen(tokenServer);
  const manager = new AccountManager([grokAccount('a', { expiresAt: Date.now() - 1000 })], 0.98, 0, 8);
  manager.grokOAuth = { tokenUrl: `http://127.0.0.1:${tokenPort}/oauth2/token` };
  try {
    await manager.ensureTokenFresh(manager.accounts[0], true);
    assert.equal(manager.accounts[0].status, 'error');
    assert.equal(manager.accounts[0].errorReason, 'refresh-failed');
  } finally {
    await closeServer(tokenServer);
  }
});

test('x-ratelimit headers become the account meter (the fuller of requests and tokens)', async () => {
  const upstream = await grokUpstream((call, res) => ok(res, '{}', {
    'x-ratelimit-limit-requests': '8300',
    'x-ratelimit-remaining-requests': '8217',
    'x-ratelimit-limit-tokens': '53000000',
    'x-ratelimit-remaining-tokens': '26500000',
  }));
  const { manager, proxy, url } = await grokProxy([grokAccount('a')], upstream.url);
  try {
    await send(url, '/v1/responses', { method: 'POST', body: '{}' });
    const [status] = manager.getStatus().accounts;
    assert.equal(status.quota.unified5h, 0.5);
    assert.equal(status.quota.unified5hReset, null);
    assert.equal(status.quota.grokRateLimit.requestsRemaining, 8217);
    assert.equal(status.quota.grokRateLimit.tokensLimit, 53000000);
    assert.equal(status.usable, true, 'the meter alone never takes an account out');
  } finally {
    await closeServer(proxy);
    await closeServer(upstream.server);
  }
});

test('an inference 429 throttles the account (retry-after seconds, HTTP date, or 5 min) and fails over at once', async () => {
  const cases = [
    { retryAfter: '120', expectMs: 120_000 },
    { retryAfter: new Date(Date.now() + 600_000).toUTCString(), expectMs: 600_000 },
    { retryAfter: null, expectMs: 5 * 60_000 },
  ];
  for (const { retryAfter, expectMs } of cases) {
    const upstream = await grokUpstream((call, res) => {
      if (call.headers.authorization === 'Bearer tok-a') {
        res.writeHead(429, { 'content-type': 'application/json', ...(retryAfter ? { 'retry-after': retryAfter } : {}) });
        res.end('{"error":"too many requests"}');
        return;
      }
      ok(res, '{"served":"b"}');
    });
    const { manager, proxy, url } = await grokProxy([grokAccount('a'), grokAccount('b')], upstream.url);
    try {
      const before = Date.now();
      const response = await send(url, '/v1/chat/completions', { method: 'POST', body: '{}' });
      assert.equal(response.status, 200, String(retryAfter));
      assert.equal(response.body.toString(), '{"served":"b"}');
      const a = manager.accounts[0];
      assert.equal(a.status, 'throttled');
      assert.ok(Math.abs(a.rateLimitedUntil - before - expectMs) < 5_000, `${retryAfter}: ${a.rateLimitedUntil - before}`);
    } finally {
      await closeServer(proxy);
      await closeServer(upstream.server);
    }
  }
});

test('with every account throttled the upstream 429 passes through unchanged, and a later request gets the pool dead end', async () => {
  const upstream = await grokUpstream((call, res) => {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '90' });
    res.end('{"error":"Rate limit reached for grok-4.7"}');
  });
  const { manager, proxy, url } = await grokProxy([grokAccount('a'), grokAccount('b')], upstream.url);
  try {
    const response = await send(url, '/v1/responses', { method: 'POST', body: '{}' });
    assert.equal(response.status, 429);
    assert.equal(response.body.toString(), '{"error":"Rate limit reached for grok-4.7"}');
    assert.equal(response.headers['retry-after'], '90');
    assert.equal(upstream.calls.length, 2);
    assert.ok(manager.accounts.every(a => a.status === 'throttled'));

    const deadEnd = await send(url, '/v1/responses', { method: 'POST', body: '{}' });
    assert.equal(deadEnd.status, 429);
    assert.match(JSON.parse(deadEnd.body.toString()).error, /TeamGrok pool exhausted/);
    assert.ok(Number(deadEnd.headers['retry-after']) > 60);
    assert.equal(upstream.calls.length, 2, 'no upstream call while every account is throttled');
  } finally {
    await closeServer(proxy);
    await closeServer(upstream.server);
  }
});

test('a 429 outside inference paths passes through and leaves the account alone', async () => {
  const upstream = await grokUpstream((call, res) => {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end('{"error":"slow down"}');
  });
  const { manager, proxy, url } = await grokProxy([grokAccount('a'), grokAccount('b')], upstream.url);
  try {
    const response = await send(url, '/v1/traces', { method: 'POST', body: 'otlp' });
    assert.equal(response.status, 429);
    assert.equal(response.body.toString(), '{"error":"slow down"}');
    assert.equal(upstream.calls.length, 1);
    assert.equal(manager.accounts[0].status, 'active');
  } finally {
    await closeServer(proxy);
    await closeServer(upstream.server);
  }
});

test('a grok session stays on its account across connections: x-grok-session-id, x-grok-conv-id, /v1/sessions/<id>', async () => {
  const upstream = await grokUpstream((call, res) => ok(res));
  const { manager, proxy, url } = await grokProxy([grokAccount('a'), grokAccount('b')], upstream.url);
  try {
    await send(url, '/v1/responses', { method: 'POST', headers: { 'x-grok-session-id': 's1' }, body: '{}' });
    await send(url, '/v1/storage', { method: 'POST', headers: { 'x-grok-conv-id': 'c1' }, body: '{}' });
    await send(url, '/v1/sessions/p1/signals', { method: 'POST', body: '{}' });
    manager.currentIndex = 1; // new work now starts on b
    await send(url, '/v1/responses', { method: 'POST', headers: { 'x-grok-session-id': 's1' }, body: '{}' });
    await send(url, '/v1/storage', { method: 'POST', headers: { 'x-grok-conv-id': 'c1' }, body: '{}' });
    await send(url, '/v1/sessions/p1/turn-deltas', { method: 'POST', body: '{}' });
    await send(url, '/v1/responses', { method: 'POST', headers: { 'x-grok-session-id': 's2' }, body: '{}' });
    assert.deepEqual(upstream.calls.map(call => call.headers.authorization), [
      'Bearer tok-a', 'Bearer tok-a', 'Bearer tok-a',
      'Bearer tok-a', 'Bearer tok-a', 'Bearer tok-a',
      'Bearer tok-b',
    ]);
  } finally {
    await closeServer(proxy);
    await closeServer(upstream.server);
  }
});

test('a zstd request body and an SSE response pass through byte-identical', async () => {
  const sse = [
    'event: response.created\ndata: {"type":"response.created"}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"안녕"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2}}}\n\n',
  ];
  const upstream = await grokUpstream((call, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    // split mid-frame on purpose
    const whole = sse.join('');
    res.write(whole.slice(0, 17));
    res.end(whole.slice(17));
  });
  const { proxy, url } = await grokProxy([grokAccount('a')], upstream.url);
  try {
    const json = Buffer.from(JSON.stringify({ model: 'grok-4.7', input: 'hi', stream: true }));
    const body = typeof zlib.zstdCompressSync === 'function' ? zlib.zstdCompressSync(json) : Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3]);
    const response = await send(url, '/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'zstd', accept: 'text/event-stream' },
      body,
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.toString(), sse.join(''));
    assert.ok(upstream.calls[0].body.equals(body), 'request body forwarded byte for byte');
    assert.equal(upstream.calls[0].headers['content-encoding'], 'zstd');
  } finally {
    await closeServer(proxy);
    await closeServer(upstream.server);
  }
});

test('reload re-reads every account tier from /v1/user?include=subscription', async () => {
  const upstream = await grokUpstream((call, res) => ok(res, JSON.stringify({
    userId: `user-${call.headers.authorization.slice('Bearer tok-'.length)}`,
    subscriptionTier: 'SuperGrokPro',
  })));
  const { manager, proxy } = await grokProxy([grokAccount('a'), grokAccount('b', { enabled: false })], upstream.url);
  try {
    assert.deepEqual(await proxy.refreshQuotaAll(), { targets: 1, measured: 1 });
    assert.equal(manager.accounts[0].planType, 'SuperGrokPro');
    assert.equal(upstream.calls[0].url, '/v1/user?include=subscription');
    assert.equal(upstream.calls[0].headers['x-grok-client-version'], GROK_DEFAULT_CLIENT_VERSION);
  } finally {
    await closeServer(proxy);
    await closeServer(upstream.server);
  }
});
