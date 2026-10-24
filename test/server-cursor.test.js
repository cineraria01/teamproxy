import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import http2 from 'node:http2';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { connectErrorFrame } from '../src/cursor.js';

const HOUR = 60 * 60 * 1000;
const RUN = '/agent.v1.AgentService/Run';
const STREAM_HEADERS = { 'content-type': 'application/connect+proto', 'connect-protocol-version': '1' };

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function cursorAccount(name, extra = {}) {
  return {
    name, provider: 'cursor', type: 'oauth', accountUuid: `uid-${name}`, email: `${name}@example.com`,
    accessToken: `tok-${name}`, refreshToken: `tok-${name}`, expiresAt: Date.now() + HOUR, ...extra,
  };
}

function frame(payload, flags = 0) {
  const body = Buffer.from(payload);
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

/**
 * Fake agent upstream (h2c). `route({headers, account, stream, received})` answers each stream; the default
 * echoes every request chunk back as a data frame (`echo:<bytes>`) and ends with a clean end-of-stream.
 */
async function agentUpstream(route = null) {
  const calls = [];
  const server = http2.createServer();
  server.on('stream', (stream, headers) => {
    const call = { headers, account: String(headers.authorization).replace('Bearer tok-', ''), chunks: [] };
    calls.push(call);
    stream.on('data', chunk => call.chunks.push(chunk));
    if (route?.(call, stream) === true) return;
    stream.respond({ ':status': 200, 'content-type': 'application/connect+proto', 'x-served-by': call.account });
    stream.on('data', chunk => stream.write(frame(`echo:${chunk.toString('latin1')}`)));
    stream.on('end', () => stream.end(frame('{}', 2)));
  });
  const port = await listen(server);
  return { server, calls, url: `http://127.0.0.1:${port}` };
}

async function apiUpstream(route) {
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

async function cursorProxy(accounts, { agent, api = 'http://127.0.0.1:9', extra = {}, maxConcurrent = 8 }) {
  const manager = new AccountManager(accounts, 0.98, 0, maxConcurrent);
  const proxy = createProxyServer(manager, {
    provider: 'cursor', proxy: { apiKey: 'local-proxy-key' }, cursorUpstream: api, cursorAgentUpstream: agent,
    cursorUsageRefresh: false, ...extra,
  });
  const port = await listen(proxy);
  const h2Port = await listen(proxy.cursorH2);
  return { manager, proxy, url: `http://127.0.0.1:${port}`, h2: `http://127.0.0.1:${h2Port}` };
}

async function closeAll(...servers) {
  for (const server of servers) {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(() => resolve()));
  }
}

/** One agent stream: send `parts` (each after the previous echo arrived), collect the response. */
function runStream(sessionUrl, { parts = ['hello'], headers = {}, session = null } = {}) {
  const own = session ?? http2.connect(sessionUrl);
  return new Promise((resolve, reject) => {
    const req = own.request({ ':method': 'POST', ':path': RUN, ...STREAM_HEADERS, authorization: 'Bearer client-own', ...headers });
    const chunks = [];
    let response = null;
    let sent = 0;
    const sendNext = () => {
      if (sent < parts.length) req.write(parts[sent++]);
      if (sent === parts.length) req.end();
    };
    req.on('response', h => { response = h; });
    req.on('data', chunk => {
      chunks.push(chunk);
      if (sent < parts.length) sendNext(); // bidi: the next message only after the previous answer
    });
    req.on('end', () => {
      if (!session) own.close();
      resolve({ headers: response, body: Buffer.concat(chunks) });
    });
    req.on('error', reject);
    req.write(parts[sent++]);
    if (parts.length === 1) req.end();
  });
}

test('agent stream: bidi bytes pass through untouched, the pool bearer replaces the client one', async () => {
  const agent = await agentUpstream();
  const { manager, proxy, h2 } = await cursorProxy([cursorAccount('a')], { agent: agent.url });
  try {
    const result = await runStream(h2, { parts: ['one', 'two', 'three'], headers: { cookie: 'c=1', 'x-api-key': 'k', 'x-keep': 'yes' } });
    assert.equal(result.headers[':status'], 200);
    assert.equal(result.headers['x-served-by'], 'a');
    assert.deepEqual(result.body, Buffer.concat([frame('echo:one'), frame('echo:two'), frame('echo:three'), frame('{}', 2)]));
    const [call] = agent.calls;
    assert.equal(call.headers.authorization, 'Bearer tok-a');
    assert.equal(call.headers.cookie, undefined);
    assert.equal(call.headers['x-api-key'], undefined);
    assert.equal(call.headers['x-keep'], 'yes');
    assert.equal(call.headers[':path'], RUN);
    assert.equal(Buffer.concat(call.chunks).toString(), 'onetwothree');
    assert.equal(manager.accounts[0].inflight, 0, 'the slot is released');
    assert.equal(manager.accounts[0].usage.totalRequests, 1);
  } finally {
    await closeAll(proxy.cursorH2, proxy, agent.server);
  }
});

test('an end-of-stream resource_exhausted before any byte reached the client: throttle, replay on the next account', async () => {
  const agent = await agentUpstream((call, stream) => {
    if (call.account !== 'a') return false;
    stream.respond({ ':status': 200, 'content-type': 'application/connect+proto' });
    stream.end(connectErrorFrame('resource_exhausted', 'usage limit'));
    return true;
  });
  const { manager, proxy, h2 } = await cursorProxy([cursorAccount('a'), cursorAccount('b')], { agent: agent.url });
  try {
    // The client's request is still open (bidi): the kept bytes are replayed, then the rest follows live.
    const result = await runStream(h2, { parts: ['first', 'second'] });
    assert.equal(result.headers['x-served-by'], 'b');
    assert.deepEqual(result.body, Buffer.concat([frame('echo:first'), frame('echo:second'), frame('{}', 2)]));
    assert.deepEqual(agent.calls.map(c => c.account), ['a', 'b']);
    assert.equal(Buffer.concat(agent.calls[1].chunks).toString(), 'firstsecond');
    const a = manager.accounts[0];
    assert.equal(a.status, 'throttled');
    assert.ok(a.rateLimitedUntil > Date.now() + 4 * 60 * 1000, 'five minutes without a retry hint');
    assert.equal(a.inflight, 0);
  } finally {
    await closeAll(proxy.cursorH2, proxy, agent.server);
  }
});

test('an HTTP 429 with retry-after spends the account for that long and fails over', async () => {
  const agent = await agentUpstream((call, stream) => {
    if (call.account !== 'a') return false;
    stream.respond({ ':status': 429, 'content-type': 'application/json', 'retry-after': '120' });
    stream.end('{"code":"resource_exhausted"}');
    return true;
  });
  const { manager, proxy, h2 } = await cursorProxy([cursorAccount('a'), cursorAccount('b')], { agent: agent.url });
  try {
    const result = await runStream(h2);
    assert.equal(result.headers['x-served-by'], 'b');
    const until = manager.accounts[0].rateLimitedUntil - Date.now();
    assert.ok(until > 100_000 && until <= 120_000, String(until));
  } finally {
    await closeAll(proxy.cursorH2, proxy, agent.server);
  }
});

test('no account left: the upstream answer passes through; nothing left before dispatch: a Connect error frame', async () => {
  const spent = connectErrorFrame('resource_exhausted', 'You have hit your usage limit');
  const agent = await agentUpstream((call, stream) => {
    stream.respond({ ':status': 200, 'content-type': 'application/connect+proto', 'x-upstream': '1' });
    stream.end(spent);
    return true;
  });
  const { manager, proxy, h2 } = await cursorProxy([cursorAccount('a')], { agent: agent.url });
  try {
    const first = await runStream(h2);
    assert.equal(first.headers['x-upstream'], '1');
    assert.deepEqual(first.body, spent, 'the upstream bytes, unchanged');
    assert.equal(manager.accounts[0].status, 'throttled');
    const second = await runStream(h2);
    assert.equal(agent.calls.length, 1, 'a throttled pool dispatches nothing');
    assert.equal(second.headers[':status'], 200);
    assert.ok(Number(second.headers['retry-after']) > 200);
    const end = JSON.parse(second.body.subarray(5).toString());
    assert.equal(second.body[0], 2);
    assert.equal(end.error.code, 'resource_exhausted');
    assert.match(end.error.message, /TeamCursor pool exhausted/);
  } finally {
    await closeAll(proxy.cursorH2, proxy, agent.server);
  }
});

test('unauthenticated: the account is parked and the stream moves on; an expired token never dispatches', async () => {
  const agent = await agentUpstream((call, stream) => {
    if (call.account !== 'a') return false;
    stream.respond({ ':status': 401, 'content-type': 'application/json' });
    stream.end('{"code":"unauthenticated"}');
    return true;
  });
  const { manager, proxy, h2 } = await cursorProxy([
    cursorAccount('a'), cursorAccount('old', { expiresAt: Date.now() - 1000 }), cursorAccount('b'),
  ], { agent: agent.url });
  try {
    const result = await runStream(h2);
    assert.equal(result.headers['x-served-by'], 'b');
    assert.deepEqual(manager.accounts.map(a => [a.name, a.status, a.errorReason ?? null]), [
      ['a', 'error', 'auth-revoked'], ['old', 'error', 'refresh-failed'], ['b', 'active', null],
    ]);
    assert.ok(!agent.calls.some(c => c.account === 'old'));
  } finally {
    await closeAll(proxy.cursorH2, proxy, agent.server);
  }
});

test('a chat stays on its account: affinity by x-blob-encryption-key across sessions', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const agent = await agentUpstream((call, stream) => {
    if (!call.headers['x-hold']) return false;
    stream.respond({ ':status': 200, 'content-type': 'application/connect+proto', 'x-served-by': call.account });
    gate.then(() => stream.end(frame('{}', 2)));
    return true;
  });
  const { proxy, h2 } = await cursorProxy([cursorAccount('a'), cursorAccount('b')], { agent: agent.url, maxConcurrent: 1 });
  const chat = key => ({ 'x-blob-encryption-key': key.repeat(64) });
  try {
    // Chat 1 holds a's only slot, so chat 2 lands on b.
    const held = runStream(h2, { headers: { ...chat('1'), 'x-hold': '1' } });
    await new Promise(resolve => setTimeout(resolve, 100));
    const second = await runStream(h2, { headers: chat('2') });
    assert.equal(second.headers['x-served-by'], 'b');
    release();
    assert.equal((await held).headers['x-served-by'], 'a');
    // Both free now: each chat goes back to its own account, on a fresh connection each time.
    assert.equal((await runStream(h2, { headers: chat('2') })).headers['x-served-by'], 'b');
    assert.equal((await runStream(h2, { headers: chat('1') })).headers['x-served-by'], 'a');
  } finally {
    await closeAll(proxy.cursorH2, proxy, agent.server);
  }
});

test('HTTP/1.1 API calls: client credentials stripped, the pool bearer injected; a 429 passes through with no account state', async () => {
  const api = await apiUpstream((call, res) => {
    if (call.url.endsWith('/Spent')) {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end('{"code":"resource_exhausted","message":"slow down"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/proto' });
    res.end(Buffer.from([1, 2, 3]));
  });
  const { manager, proxy, url } = await cursorProxy([cursorAccount('a'), cursorAccount('b')], { agent: 'http://127.0.0.1:9', api: api.url });
  const post = path => new Promise((resolve, reject) => {
    const req = http.request(`${url}${path}`, {
      method: 'POST', agent: false,
      headers: { authorization: 'Bearer client-own', cookie: 'c=1', 'x-api-key': 'local-proxy-key', 'content-type': 'application/proto' },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(Buffer.from([9]));
  });
  try {
    const ok = await post('/aiserver.v1.DashboardService/GetMe');
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, Buffer.from([1, 2, 3]));
    assert.equal(api.calls[0].headers.authorization, 'Bearer tok-a');
    assert.equal(api.calls[0].headers.cookie, undefined);
    assert.equal(api.calls[0].headers['x-api-key'], undefined);
    assert.deepEqual(api.calls[0].body, Buffer.from([9]));
    const spent = await post('/aiserver.v1.AiService/Spent');
    assert.equal(spent.status, 429);
    assert.match(spent.body.toString(), /slow down/);
    assert.equal(api.calls.length, 2, 'no failover for an API 429');
    assert.ok(manager.accounts.every(a => a.status === 'active'));
  } finally {
    await closeAll(proxy.cursorH2, proxy, api.server);
  }
});

test('usage poll: GetCurrentPeriodUsage + GetPlanInfo fill the meter (display only) and the plan', async () => {
  const api = await apiUpstream((call, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (call.url.endsWith('/GetCurrentPeriodUsage')) {
      res.end(JSON.stringify({ billingCycleEnd: '4102444800000', planUsage: { totalSpend: 39500, limit: 40000 } }));
    } else {
      res.end(JSON.stringify({ planInfo: { planName: 'Pro' } }));
    }
  });
  const { manager, proxy } = await cursorProxy([cursorAccount('a')], {
    agent: 'http://127.0.0.1:9', api: api.url, extra: { cursorUsageRefresh: true },
  });
  try {
    const result = await proxy.refreshQuotaAll();
    assert.deepEqual(result, { targets: 1, measured: 1 });
    const a = manager.accounts[0];
    assert.equal(a.quota.unified5h, 39500 / 40000);
    assert.equal(a.quota.unified5hReset, 4102444800000);
    assert.equal(a.planType, 'Pro');
    assert.equal(api.calls[0].headers.authorization, 'Bearer tok-a');
    assert.equal(api.calls[0].headers['content-type'], 'application/json');
    // 98.75% used is still served: Cursor keeps serving past the included usage.
    assert.equal(manager.getStatus().accounts[0].usable, true);
  } finally {
    await closeAll(proxy.cursorH2, proxy, api.server);
  }
});

const settle = ms => new Promise(resolve => setTimeout(resolve, ms));

test('the client cancels before the upstream answered: no crash, the slot is released', async () => {
  let seen;
  const arrived = new Promise(resolve => { seen = resolve; });
  const agent = await agentUpstream((call, stream) => {
    if (!call.headers['x-hold']) return false;
    seen();
    stream.on('error', () => {});
    return true; // never answers
  });
  const { manager, proxy, h2 } = await cursorProxy([cursorAccount('a')], { agent: agent.url });
  try {
    const session = http2.connect(h2);
    const req = session.request({ ':method': 'POST', ':path': RUN, ...STREAM_HEADERS, 'x-hold': '1' });
    req.on('error', () => {});
    req.write(frame('hi'));
    await arrived;
    req.close(http2.constants.NGHTTP2_CANCEL);
    await settle(150);
    session.close();
    assert.equal(manager.accounts[0].inflight, 0);
    const next = await runStream(h2);
    assert.equal(next.headers['x-served-by'], 'a', 'the worker still serves');
  } finally {
    await closeAll(proxy.cursorH2, proxy, agent.server);
  }
});

test('the upstream resets the stream before its headers: no crash, the next account serves', async () => {
  for (const code of [http2.constants.NGHTTP2_INTERNAL_ERROR, http2.constants.NGHTTP2_CANCEL, http2.constants.NGHTTP2_NO_ERROR]) {
    const agent = await agentUpstream((call, stream) => {
      if (call.account !== 'a') return false;
      stream.on('error', () => {});
      setTimeout(() => stream.close(code), 20);
      return true;
    });
    const { manager, proxy, h2 } = await cursorProxy([cursorAccount('a'), cursorAccount('b')], { agent: agent.url });
    try {
      const result = await runStream(h2, { parts: ['once'] });
      assert.equal(result.headers['x-served-by'], 'b', `code ${code}`);
      await settle(50);
      assert.deepEqual(manager.accounts.map(a => [a.inflight, a.status]), [[0, 'active'], [0, 'active']], `code ${code}`);
    } finally {
      await closeAll(proxy.cursorH2, proxy, agent.server);
    }
  }
});

test('a request every account refuses (unauthenticated) parks no one: the second refusal undoes the first park', async () => {
  const agent = await agentUpstream((call, stream) => {
    stream.respond({ ':status': 200, 'content-type': 'application/connect+proto' });
    stream.end(connectErrorFrame('unauthenticated', 'bad request token'));
    return true;
  });
  const { manager, proxy, h2 } = await cursorProxy([cursorAccount('a'), cursorAccount('b'), cursorAccount('c')], { agent: agent.url });
  try {
    for (let i = 0; i < 3; i++) await runStream(h2);
    assert.deepEqual(manager.accounts.map(a => a.status), ['active', 'active', 'active']);
  } finally {
    await closeAll(proxy.cursorH2, proxy, agent.server);
  }
});

test('one request cannot bench the whole pool: exhaustion failovers are capped by rateLimitFailovers', async () => {
  const agent = await agentUpstream((call, stream) => {
    stream.respond({ ':status': 200, 'content-type': 'application/connect+proto' });
    stream.end(connectErrorFrame('resource_exhausted', 'spent'));
    return true;
  });
  const { manager, proxy, h2 } = await cursorProxy([cursorAccount('a'), cursorAccount('b'), cursorAccount('c'), cursorAccount('d')], { agent: agent.url });
  try {
    await runStream(h2);
    assert.equal(agent.calls.length, 2, 'the first account plus rateLimitFailovers (default 1)');
    assert.equal(manager.accounts.filter(a => a.status === 'throttled').length, 2);
  } finally {
    await closeAll(proxy.cursorH2, proxy, agent.server);
  }
});

test('request bytes past maxRequestBytes while no upstream carries them end the stream instead of being lost', async () => {
  let releaseHold;
  const hold = new Promise(resolve => { releaseHold = resolve; });
  const agent = await agentUpstream((call, stream) => {
    if (!call.headers['x-hold']) return false;
    stream.respond({ ':status': 200, 'content-type': 'application/connect+proto' });
    hold.then(() => stream.end(frame('{}', 2)));
    return true;
  });
  const { proxy, h2 } = await cursorProxy([cursorAccount('a')], { agent: agent.url, maxConcurrent: 1, extra: { maxRequestBytes: 16 } });
  try {
    const held = runStream(h2, { headers: { 'x-hold': '1' } }); // takes the only slot
    await settle(100);
    const session = http2.connect(h2);
    const outcome = await new Promise(resolve => {
      const req = session.request({ ':method': 'POST', ':path': RUN, ...STREAM_HEADERS });
      req.on('response', () => resolve('answered'));
      req.on('error', err => resolve(err.code));
      req.on('close', () => resolve(`closed ${req.rstCode}`));
      req.write(Buffer.alloc(40, 1)); // queued for a slot, over the cap
    });
    session.destroy();
    releaseHold();
    await held;
    assert.notEqual(outcome, 'answered');
    await settle(100);
    assert.equal(agent.calls.length, 1, 'the truncated request never reached the upstream');
  } finally {
    await closeAll(proxy.cursorH2, proxy, agent.server);
  }
});

test('deployment drain: new h2 streams get an unavailable end frame; the worker reports its live stream count', async () => {
  let releaseHold;
  const hold = new Promise(resolve => { releaseHold = resolve; });
  const agent = await agentUpstream((call, stream) => {
    stream.respond({ ':status': 200, 'content-type': 'application/connect+proto' });
    hold.then(() => stream.end(frame('{}', 2)));
    return true;
  });
  const counts = [];
  const manager = new AccountManager([cursorAccount('a')], 0.98, 0, 8);
  const proxy = createProxyServer(manager, {
    provider: 'cursor', proxy: { apiKey: 'k' }, cursorAgentUpstream: agent.url, cursorUsageRefresh: false,
  }, { onCursorStreams: n => counts.push(n) });
  await listen(proxy);
  const h2 = `http://127.0.0.1:${await listen(proxy.cursorH2)}`;
  try {
    const open = runStream(h2);
    await settle(100);
    assert.deepEqual(counts, [1]);
    proxy.setDraining(true);
    const refused = await runStream(h2);
    assert.equal(refused.headers[':status'], 200);
    assert.equal(JSON.parse(refused.body.subarray(5).toString()).error.code, 'unavailable');
    assert.equal(agent.calls.length, 1);
    releaseHold();
    await open;
    await settle(50);
    assert.deepEqual(counts, [1, 0]);
  } finally {
    await closeAll(proxy.cursorH2, proxy, agent.server);
  }
});

test('HTTP/1.1 agent RPCs go to the agent upstream; --log-to never writes x-blob-encryption-key', async () => {
  const agentH1 = await apiUpstream((call, res) => { res.writeHead(200, { 'content-type': 'application/proto' }); res.end('agent'); });
  const api = await apiUpstream((call, res) => { res.writeHead(200, { 'content-type': 'application/proto' }); res.end('api'); });
  const logDir = await mkdtemp(join(tmpdir(), 'teamcursor-log-'));
  const { proxy, url } = await cursorProxy([cursorAccount('a')], { agent: agentH1.url, api: api.url, extra: { logDir } });
  const post = path => new Promise((resolve, reject) => {
    const req = http.request(`${url}${path}`, {
      method: 'POST', agent: false, headers: { 'content-type': 'application/proto', 'x-blob-encryption-key': 'SECRETKEY'.repeat(7) },
    }, res => { let body = ''; res.on('data', c => { body += c; }); res.on('end', () => resolve(body)); });
    req.on('error', reject);
    req.end('x');
  });
  try {
    assert.equal(await post('/agent.v1.AgentService/RunSSE'), 'agent');
    assert.equal(await post('/aiserver.v1.DashboardService/GetMe'), 'api');
    await settle(100);
    const logs = await Promise.all((await readdir(logDir)).map(name => readFile(join(logDir, name), 'utf8')));
    assert.ok(logs.length > 0, 'requests were logged');
    assert.ok(logs.every(text => !text.includes('SECRETKEY')), 'the chat key is redacted');
  } finally {
    await closeAll(proxy.cursorH2, proxy, api.server, agentH1.server);
    await rm(logDir, { recursive: true, force: true });
  }
});

test('headers but no byte before the upstream ends: not an empty 200 — the next account serves', async () => {
  for (const code of [http2.constants.NGHTTP2_NO_ERROR, http2.constants.NGHTTP2_CANCEL]) {
    const agent = await agentUpstream((call, stream) => {
      if (call.account !== 'a') return false;
      stream.on('error', () => {});
      stream.respond({ ':status': 200, 'content-type': 'application/connect+proto' });
      setTimeout(() => (code === http2.constants.NGHTTP2_NO_ERROR ? stream.end() : stream.close(code)), 20);
      return true;
    });
    const { manager, proxy, h2 } = await cursorProxy([cursorAccount('a'), cursorAccount('b')], { agent: agent.url });
    try {
      const result = await runStream(h2, { parts: ['once'] });
      assert.equal(result.headers['x-served-by'], 'b', `code ${code}`);
      assert.deepEqual(result.body, Buffer.concat([frame('echo:once'), frame('{}', 2)]));
      await settle(50);
      assert.deepEqual(manager.accounts.map(a => a.inflight), [0, 0]);
    } finally {
      await closeAll(proxy.cursorH2, proxy, agent.server);
    }
  }
});

test('every attempt ended without a byte: the dead end says the upstream answered empty, not "could not reach"', async () => {
  const agent = await agentUpstream((call, stream) => {
    stream.respond({ ':status': 200, 'content-type': 'application/connect+proto' });
    setTimeout(() => stream.end(), 10);
    return true;
  });
  const { proxy, h2 } = await cursorProxy([cursorAccount('a')], { agent: agent.url });
  try {
    const result = await runStream(h2);
    const end = JSON.parse(result.body.subarray(5).toString());
    assert.equal(end.error.code, 'unavailable');
    assert.match(end.error.message, /ended every attempt without an answer/);
  } finally {
    await closeAll(proxy.cursorH2, proxy, agent.server);
  }
});
