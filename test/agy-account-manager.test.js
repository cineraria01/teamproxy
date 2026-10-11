import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { parseAgyQuotaSummary } from '../src/agy.js';

const HOUR = 60 * 60 * 1000;

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

function summary({ gemini5h = 1, geminiWeekly = 1, p5h = 1, pWeekly = 1 } = {}) {
  const bucket = (bucketId, window, remainingFraction, resetMs) => ({
    bucketId,
    window,
    resetTime: new Date(Date.now() + resetMs).toISOString(),
    ...(remainingFraction == null ? {} : { remainingFraction }),
  });
  return parseAgyQuotaSummary({
    groups: [
      { displayName: 'Gemini Models', buckets: [
        bucket('gemini-weekly', 'weekly', geminiWeekly, 100 * HOUR),
        bucket('gemini-5h', '5h', gemini5h, 3 * HOUR),
      ] },
      { displayName: 'Claude and GPT models', buckets: [
        bucket('3p-weekly', 'weekly', pWeekly, 90 * HOUR),
        bucket('3p-5h', '5h', p5h, 2 * HOUR),
      ] },
    ],
  });
}

test('selection follows the request group; a model-less call stays on the active account', async () => {
  const manager = new AccountManager([agyAccount('a'), agyAccount('b')], 0.98, 0);
  const [a, b] = manager.accounts;
  manager.updateAgyQuota(a, summary({ gemini5h: 0 }));   // a: Gemini spent, Claude/GPT fresh
  manager.updateAgyQuota(b, summary());
  manager.currentIndex = a.index;

  const gemini = await manager.acquireAccount(null, 0, null, null, 'gemini-3.6-flash-low');
  assert.equal(gemini, b, 'a Gemini request skips the account whose Gemini group is spent');
  manager.releaseAccount(gemini);

  manager.currentIndex = a.index;
  const thirdParty = await manager.acquireAccount(null, 0, null, null, 'claude-opus-5-5-high');
  assert.equal(thirdParty, a, 'the Claude/GPT group of the same account still serves');
  manager.releaseAccount(thirdParty);

  manager.currentIndex = a.index;
  const control = await manager.acquireAccount(null, 0, null, null, null);
  assert.equal(control, a, 'loadCodeAssist / fetchAvailableModels are never quota-gated');
  manager.releaseAccount(control);

  // Headline meters (status / TUI) mirror the Gemini group.
  assert.equal(a.quota.unified5h, 1);
  assert.equal(a.quota.unified7d, 0);
  assert.equal(manager.getStatus().accounts[0].usable, false);
  assert.equal(manager.getStatus().accounts[0].quota.agyGroups['3p'].fiveHour.utilization, 0);
});

test('a 3p request orders candidates by the 3p group, not by the Gemini meters', () => {
  const manager = new AccountManager([agyAccount('a'), agyAccount('b'), agyAccount('c')], 0.98, 0);
  const [a, b, c] = manager.accounts;
  manager.updateAgyQuota(a, summary());
  manager.updateAgyQuota(b, summary());
  manager.updateAgyQuota(c, summary());
  // c's Claude/GPT week renews soonest → drained first for a 3p request even
  // though its Gemini week renews last.
  c.quota.agyGroups['3p'].weekly.reset = Date.now() + 10 * HOUR;
  c.quota.unified7dReset = Date.now() + 200 * HOUR;
  a.quota.unified7dReset = Date.now() + 1 * HOUR;
  manager.blockAgyGroup(b, '3p', HOUR);

  assert.equal(manager._selectBest(new Set([b]), 'claude-sonnet-5-5-low'), c);
  assert.equal(manager._selectBest(new Set([b]), 'gemini-3.6-flash-low'), a);
});

test('an exhaustion 429 blocks only that group, until the summary\'s exhausted bucket resets', () => {
  const manager = new AccountManager([agyAccount('a')], 0.98, 0);
  const [a] = manager.accounts;
  manager.updateAgyQuota(a, summary());

  manager.blockAgyGroup(a, 'gemini', 30_000);
  assert.equal(manager._isAvailable(a, 'gemini-3.6-flash-low'), false);
  assert.equal(manager._isAvailable(a, 'gpt-oss-120b-medium'), true);
  const fallbackUntil = a.quota.agyGroups.gemini.blockedUntil;
  assert.ok(fallbackUntil > Date.now() + 29_000 && fallbackUntil <= Date.now() + 30_000);

  // The post-429 summary omits remainingFraction on the spent 5h bucket (proto3 zero).
  manager.updateAgyQuota(a, summary({ gemini5h: null }), 'gemini');
  const until = a.quota.agyGroups.gemini.blockedUntil;
  assert.ok(until > Date.now() + 2.9 * HOUR && until <= Date.now() + 3 * HOUR, 'blocked until the 5h bucket reset');
  assert.ok(manager.agyRecoveryMs('gemini-3.6-flash-low') > 2.9 * HOUR);
  assert.equal(manager.agyRecoveryMs('claude-opus-5-5-low'), null);

  // A later routine summary keeps the still-future block.
  manager.updateAgyQuota(a, summary());
  assert.equal(a.quota.agyGroups.gemini.blockedUntil, until);
});

test('agy quota survives the restart snapshot', () => {
  const before = new AccountManager([agyAccount('a')], 0.98, 0);
  before.updateAgyQuota(before.accounts[0], summary({ pWeekly: 0.5 }));
  before.blockAgyGroup(before.accounts[0], '3p', HOUR);

  const after = new AccountManager([agyAccount('a')], 0.98, 0);
  after.importQuotaState(JSON.parse(JSON.stringify(before.exportQuotaState())));
  assert.equal(after.accounts[0].quota.agyGroups['3p'].weekly.utilization, 0.5);
  assert.equal(after._isAvailable(after.accounts[0], 'claude-opus-5-5-high'), false);
  assert.equal(after._isAvailable(after.accounts[0], 'gemini-3.6-flash-low'), true);
});

function tokenEndpoint(respond) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
    requests.push({ contentType: req.headers['content-type'], form });
    respond(res, form);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    server,
    requests,
    url: `http://127.0.0.1:${server.address().port}/token`,
  })));
}

test('agy refresh goes to the Google token endpoint with the resolved client', async () => {
  const { server, requests, url } = await tokenEndpoint(res => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ access_token: 'ya29.new', expires_in: 3599, id_token: 'id.new.sig' }));
  });
  try {
    const manager = new AccountManager([agyAccount('a', { expiresAt: Date.now() + 60_000 })], 0.98, 0);
    manager.agyOAuth = { clientId: 'fake-client', clientSecret: 'fake-secret', tokenUrl: url };
    const persisted = [];
    manager.onTokenRefresh((index, tokens) => { persisted.push(tokens); });

    await manager.ensureTokenFresh(manager.accounts[0]);

    assert.deepEqual(requests, [{
      contentType: 'application/x-www-form-urlencoded',
      form: {
        grant_type: 'refresh_token',
        refresh_token: 'refresh-a',
        client_id: 'fake-client',
        client_secret: 'fake-secret',
      },
    }]);
    const account = manager.accounts[0];
    assert.equal(account.credential, 'ya29.new');
    assert.equal(account.refreshToken, 'refresh-a', 'Google refresh tokens do not rotate');
    assert.ok(account.expiresAt > Date.now() + 3500_000);
    assert.equal(persisted.length, 1);
  } finally {
    server.close();
  }
});

test('invalid_grant parks the agy account; a transient refresh failure does not', async () => {
  let reply = 'invalid_grant';
  const { server, url } = await tokenEndpoint(res => {
    if (reply === 'invalid_grant') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }));
    } else {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{"error":"backend_error"}');
    }
  });
  try {
    const parked = new AccountManager([agyAccount('a', { expiresAt: Date.now() - 1000 })], 0.98, 0);
    parked.agyOAuth = { clientId: 'fake-client', clientSecret: 'fake-secret', tokenUrl: url };
    await parked.ensureTokenFresh(parked.accounts[0]);
    assert.equal(parked.accounts[0].status, 'error');
    assert.equal(parked.accounts[0].errorReason, 'refresh-failed');

    reply = 'transient';
    const kept = new AccountManager([agyAccount('b', { expiresAt: Date.now() - 1000 })], 0.98, 0);
    kept.agyOAuth = { clientId: 'fake-client', clientSecret: 'fake-secret', tokenUrl: url };
    await kept.ensureTokenFresh(kept.accounts[0]);
    assert.equal(kept.accounts[0].status, 'active');
  } finally {
    server.close();
  }
});

// Runtime-assembled fake secrets (public repository).
const RIGHT_SECRET = ['GOCSPX', 'R'.repeat(28)].join('-');
const WRONG_SECRET = ['GOCSPX', 'D'.repeat(28)].join('-');

test('a cached secret refused with invalid_client is re-resolved once and the refresh succeeds; the account stays healthy', async () => {
  const { server, requests, url } = await tokenEndpoint((res, form) => {
    if (form.client_secret !== RIGHT_SECRET) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"invalid_client","error_description":"Unauthorized"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ access_token: `ya29.${form.refresh_token}`, expires_in: 3599 }));
  });
  try {
    const manager = new AccountManager([
      agyAccount('a', { expiresAt: Date.now() - 1000 }),
      agyAccount('b', { expiresAt: Date.now() - 1000 }),
    ], 0.98, 0);
    manager.agyOAuth = { clientId: 'fake-client', clientSecret: WRONG_SECRET, tokenUrl: url };
    const rejected = [];
    manager.agyOAuthRecover = async secret => {
      rejected.push(secret);
      return { clientId: 'fake-client', clientSecret: RIGHT_SECRET, tokenUrl: url };
    };

    await Promise.all(manager.accounts.map(account => manager.ensureTokenFresh(account)));

    assert.deepEqual(rejected, [WRONG_SECRET], 're-resolved once, not once per account');
    assert.equal(manager.agyOAuth.clientSecret, RIGHT_SECRET);
    for (const account of manager.accounts) {
      assert.equal(account.status, 'active');
      assert.equal(account.credential, `ya29.refresh-${account.name}`);
    }
    assert.equal(requests.filter(request => request.form.client_secret === RIGHT_SECRET).length, 2);
  } finally {
    server.close();
  }
});

test('a client that stays refused fails only the refresh: no auth-revoked park, a lapsed token is a healable refresh-failed', async () => {
  const { server, url } = await tokenEndpoint(res => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":"invalid_client"}');
  });
  try {
    let recoveries = 0;
    const manager = new AccountManager([
      agyAccount('valid', { expiresAt: Date.now() + 60_000 }),
      agyAccount('lapsed', { expiresAt: Date.now() - 1000 }),
    ], 0.98, 0);
    manager.agyOAuth = { clientId: 'fake-client', clientSecret: WRONG_SECRET, tokenUrl: url };
    manager.agyOAuthRecover = async () => {
      recoveries += 1;
      throw new Error('None of 2 candidate OAuth client pairs were accepted');
    };
    const [valid, lapsed] = manager.accounts;

    await manager.ensureTokenFresh(valid);
    assert.equal(valid.status, 'active', 'a still-valid token keeps serving');

    await manager.ensureTokenFresh(lapsed);
    assert.equal(lapsed.status, 'error');
    assert.equal(lapsed.errorReason, 'refresh-failed', 'not auth-revoked: the client, not the account, was refused');
    assert.equal(lapsed._errorFromRefresh, true, 'a later successful refresh heals it');
    assert.equal(recoveries, 1, 'a failed re-resolve pauses further attempts');

    // Fixed client (e.g. agyOAuthClientSecret set by hand): the next refresh heals the account.
    manager.agyOAuth = { clientId: 'fake-client', clientSecret: RIGHT_SECRET, tokenUrl: url };
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'ya29.healed', expires_in: 3599 }));
    });
    await manager.ensureTokenFresh(lapsed);
    assert.equal(lapsed.status, 'active');
    assert.equal(lapsed.credential, 'ya29.healed');
  } finally {
    server.close();
  }
});

test('a client saved to the config after a client-less start is adopted and used by the refresh', async () => {
  const { adoptAgyClientFromConfig } = await import('../src/agy.js');
  const seen = [];
  const token = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      seen.push(new URLSearchParams(body).get('client_id'));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ access_token: 'new', expires_in: 3600 }));
    });
  });
  await new Promise(resolve => token.listen(0, '127.0.0.1', resolve));
  const tokenUrl = `http://127.0.0.1:${token.address().port}/token`;
  try {
    const manager = new AccountManager([agyAccount('a')]);
    manager.agyOAuth = { tokenUrl }; // the server started before any client existed
    await assert.rejects(manager._refreshAgy('r'), /not configured/);
    assert.equal(adoptAgyClientFromConfig(manager, {}), false); // nothing on disk yet
    assert.equal(adoptAgyClientFromConfig(manager, { agyOAuthClientId: 'cid', agyOAuthClientSecret: 'sec' }), true);
    await manager._refreshAgy('r');
    assert.deepEqual(seen, ['cid']);
    assert.equal(adoptAgyClientFromConfig(manager, { agyOAuthClientId: 'other', agyOAuthClientSecret: 'x' }), false); // never replaces a working client
  } finally {
    token.close();
  }
});
