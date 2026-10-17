import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

// Codex's chatgpt_base_url (codex_apps MCP, plugins, analytics) points at
// <proxy>/backend-api/; the proxy must send it to chatgpt.com/backend-api/*
// with the pool account's credentials.
async function withProxy(handler, run) {
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({
      method: req.method,
      path: req.url,
      authorization: req.headers.authorization,
      accountId: req.headers['chatgpt-account-id'],
      body: Buffer.concat(chunks).toString(),
    });
    handler(req, res);
  });
  let proxy;
  try {
    const upstreamPort = await listen(upstream);
    const manager = new AccountManager([{
      name: 'codex-pro',
      provider: 'codex',
      type: 'oauth',
      accessToken: 'pooled-access-token',
      refreshToken: 'refresh-token',
      accountId: 'workspace-123',
      expiresAt: Date.now() + 3_600_000,
    }]);
    proxy = createProxyServer(manager, {
      provider: 'codex',
      upstream: `http://127.0.0.1:${upstreamPort}/backend-api/codex`,
      activeWarmup: false,
      codexUsageRefresh: false,
      maxRetries: 2,
    });
    const proxyPort = await listen(proxy);
    await run({ base: `http://127.0.0.1:${proxyPort}`, seen, manager });
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
}

const localAuth = {
  authorization: 'Bearer expired-local-token',
  'chatgpt-account-id': 'local-account',
};

test('/backend-api/* reaches the upstream origin with the pool token, path and query intact', async () => {
  await withProxy((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"apps":[]}');
  }, async ({ base, seen }) => {
    const response = await fetch(`${base}/backend-api/ps/plugins/installed?scope=GLOBAL&limit=5`, {
      headers: localAuth,
    });

    assert.equal(response.status, 200);
    assert.equal(await response.text(), '{"apps":[]}');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].path, '/backend-api/ps/plugins/installed?scope=GLOBAL&limit=5');
    assert.equal(seen[0].authorization, 'Bearer pooled-access-token');
    assert.equal(seen[0].accountId, 'workspace-123');
  });
});

test('/backend-api/* streams SSE (codex_apps MCP) through unchanged', async () => {
  await withProxy((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-1' });
    res.write('event: message\ndata: {"id":1}\n\n');
    setTimeout(() => res.end('event: message\ndata: {"id":2}\n\n'), 20);
  }, async ({ base, seen }) => {
    const response = await fetch(`${base}/backend-api/wham/apps`, {
      method: 'POST',
      headers: { ...localAuth, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('mcp-session-id'), 'sess-1');
    assert.equal(await response.text(), 'event: message\ndata: {"id":1}\n\nevent: message\ndata: {"id":2}\n\n');
    assert.equal(seen[0].path, '/backend-api/wham/apps');
    assert.equal(seen[0].body, '{"jsonrpc":"2.0","id":1,"method":"initialize"}');
    assert.equal(seen[0].authorization, 'Bearer pooled-access-token');
  });
});

test('/backend-api/* 401 and 429 pass through without parking or throttling the account', async () => {
  let status = 401;
  await withProxy((req, res) => {
    res.writeHead(status, { 'content-type': 'application/json', 'retry-after': '30' });
    res.end('{"detail":"nope"}');
  }, async ({ base, seen, manager }) => {
    const unauthorized = await fetch(`${base}/backend-api/codex/analytics-events/events`, {
      method: 'POST', headers: localAuth, body: '{}',
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(await unauthorized.text(), '{"detail":"nope"}');

    status = 429;
    const limited = await fetch(`${base}/backend-api/codex/analytics-events/events`, {
      method: 'POST', headers: localAuth, body: '{}',
    });
    assert.equal(limited.status, 429);
    assert.equal(await limited.text(), '{"detail":"nope"}');

    // one upstream hit each: no refresh retry, no failover replay
    assert.equal(seen.length, 2);
    const [account] = manager.accounts;
    assert.notEqual(account.status, 'error');
    assert.notEqual(account.status, 'throttled');
    assert.equal(manager.getActiveAccount() === account, true);
  });
});
