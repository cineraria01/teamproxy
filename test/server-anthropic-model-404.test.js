// A model one account is not entitled to (2026-11-21: claude-mythos-5-2 on
// one of six) answers `404 not_found_error "model: <id>"` on the others. The
// proxy marks that account unsupported for the model and replays on another.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

const MYTHOS = 'claude-mythos-5-2';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  });
}

function makeAccounts() {
  return new AccountManager(['a', 'b'].map((name, priority) => ({
    name, type: 'apikey', apiKey: `key-${name}`, priority,
  })), 0.98);
}

function modelNotFound(res, model) {
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `model: ${model}` } }));
}

async function withProxy(handler, fn) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const account = req.headers['x-api-key'] === 'key-a' ? 'a' : 'b';
    seen.push(account);
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => handler(account, JSON.parse(Buffer.concat(chunks).toString()).model, res));
  });
  const am = makeAccounts();
  let proxy;
  try {
    const upstreamPort = await listen(upstream);
    proxy = createProxyServer(am, {
      upstream: `http://127.0.0.1:${upstreamPort}`,
      activeWarmup: false,
      sessionAffinity: false,
    });
    const port = await listen(proxy);
    const post = (model = MYTHOS, path = '/v1/messages') => fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'x' }] }),
    });
    await fn({ post, seen, am });
  } finally {
    await Promise.all([close(proxy), close(upstream)]);
  }
}

test('model 404 on A replays on B, marks A, and the next request skips A', async () => {
  await withProxy((account, model, res) => {
    if (account === 'a' && model.startsWith(MYTHOS)) return modelNotFound(res, MYTHOS);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'message', content: [] }));
  }, async ({ post, seen, am }) => {
    const first = await post(`${MYTHOS}[1m]`);
    assert.equal(first.status, 200);
    await first.text();
    assert.deepEqual(seen, ['a', 'b']);
    assert.equal(am._isModelUnsupported(am.accounts[0], `${MYTHOS}[1m]`), true);
    assert.equal(am._isModelUnsupported(am.accounts[1], `${MYTHOS}[1m]`), false);
    assert.deepEqual(am.getStatus().accounts[0].unsupportedModels, [`${MYTHOS}[1m]`]);

    const second = await post(`${MYTHOS}[1m]`);
    assert.equal(second.status, 200);
    await second.text();
    assert.deepEqual(seen, ['a', 'b', 'b']);

    // Other models still use A.
    const other = await post('claude-opus-5-5');
    assert.equal(other.status, 200);
    await other.text();
    assert.deepEqual(seen, ['a', 'b', 'b', 'a']);
  });
});

test('every account answering model 404 returns the last 404 unchanged', async () => {
  await withProxy((_account, _req, res) => modelNotFound(res, MYTHOS), async ({ post, seen, am }) => {
    const res = await post();
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(),
      { type: 'error', error: { type: 'not_found_error', message: `model: ${MYTHOS}` } });
    assert.deepEqual(seen, ['a', 'b']);
    assert.equal(am.accounts.every(a => am._isModelUnsupported(a, MYTHOS)), true);

    // A later request while every account is marked: still a 404, not a 429.
    const again = await post();
    assert.equal(again.status, 404);
    assert.equal((await again.json()).error.type, 'not_found_error');
    assert.deepEqual(seen, ['a', 'b']);
  });
});

test('a 404 that is not about the requested model is neither marked nor replayed', async () => {
  await withProxy((_account, _req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'Not Found' } }));
  }, async ({ post, seen, am }) => {
    const res = await post();
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.message, 'Not Found');
    assert.deepEqual(seen, ['a']);
    assert.equal(am._isModelUnsupported(am.accounts[0], MYTHOS), false);
  });
  // A model 404 naming a DIFFERENT model (e.g. an advisor tool's) is not this request's.
  await withProxy((_account, _req, res) => modelNotFound(res, 'claude-other'), async ({ post, seen, am }) => {
    const res = await post();
    assert.equal(res.status, 404);
    await res.text();
    assert.deepEqual(seen, ['a']);
    assert.equal(am._isModelUnsupported(am.accounts[0], MYTHOS), false);
  });
});
