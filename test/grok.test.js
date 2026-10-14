import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { join } from 'node:path';
import {
  GROK_CLIENT_ID,
  GROK_SCOPES,
  buildGrokRunEnv,
  grokAffinityKey,
  grokAuthFilePath,
  isGrokInferencePath,
  loginGrokDevice,
  parseGrokAuthFile,
  parseGrokRateLimit,
  refreshGrokAccessToken,
  resolveGrokBin,
  rewriteGrokIdentityHeaders,
} from '../src/grok.js';

const jwt = payload => `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

/** Fake auth.x.ai: device code + token endpoint. `answers` is the queue of token-endpoint replies. */
async function fakeAuth(answers, device = {}) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
    calls.push({ url: req.url, form });
    if (req.url === '/oauth2/device/code') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        device_code: 'dev-code', user_code: 'F2PW-4F88', verification_uri: 'https://accounts.x.ai/oauth2/device',
        verification_uri_complete: 'https://accounts.x.ai/oauth2/device?user_code=F2PW-4F88', expires_in: 1800, interval: 5,
        ...device,
      }));
      return;
    }
    const [status, body] = answers.shift();
    if (status === 'drop') { req.socket.destroy(); return; } // network failure mid-poll
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  return { server, calls, deviceUrl: `${base}/oauth2/device/code`, tokenUrl: `${base}/oauth2/token` };
}

const ACCESS = jwt({ sub: 'sub-1', email: 'me@example.com', team_id: 'team-1', exp: 2_000_000_000 });

test('device login polls through authorization_pending and slow_down (+5 s) to a token', async () => {
  const auth = await fakeAuth([
    [400, { error: 'authorization_pending' }],
    [400, { error: 'slow_down' }],
    [200, { access_token: ACCESS, refresh_token: 'rt-1', expires_in: 21600 }],
  ]);
  const sleeps = [];
  const opened = [];
  try {
    const creds = await loginGrokDevice({
      clientId: 'client-x', deviceUrl: auth.deviceUrl, tokenUrl: auth.tokenUrl,
      open: url => opened.push(url), sleep: async ms => { sleeps.push(ms); },
    });
    assert.deepEqual(sleeps, [5000, 5000, 10000]);
    assert.deepEqual(opened, ['https://accounts.x.ai/oauth2/device?user_code=F2PW-4F88']);
    assert.deepEqual(auth.calls[0].form, { client_id: 'client-x', scope: GROK_SCOPES.join(' ') });
    assert.deepEqual(auth.calls[1].form, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: 'dev-code', client_id: 'client-x',
    });
    assert.equal(creds.accessToken, ACCESS);
    assert.equal(creds.refreshToken, 'rt-1');
    assert.equal(creds.expiresAt, 2_000_000_000_000);
    assert.equal(creds.accountUuid, 'sub-1');
    assert.equal(creds.email, 'me@example.com');
    assert.equal(creds.teamId, 'team-1');
  } finally {
    auth.server.close();
  }
});

test('device login fails on expired_token and access_denied', async () => {
  for (const [error, pattern] of [['expired_token', /timed out/], ['access_denied', /OAuth error: access_denied/]]) {
    const auth = await fakeAuth([[400, { error }]]);
    try {
      await assert.rejects(loginGrokDevice({
        deviceUrl: auth.deviceUrl, tokenUrl: auth.tokenUrl, open: () => {}, sleep: async () => {},
      }), pattern);
    } finally {
      auth.server.close();
    }
  }
});

test('device login uses 5 s for a non-numeric interval and retries a network error or 5xx until the deadline', async () => {
  const auth = await fakeAuth([
    ['drop'],
    [503, { error: 'unavailable' }],
    [200, { access_token: ACCESS, refresh_token: 'rt-2' }],
  ], { interval: 'soon' });
  const sleeps = [];
  try {
    const creds = await loginGrokDevice({
      deviceUrl: auth.deviceUrl, tokenUrl: auth.tokenUrl, open: () => {}, sleep: async ms => { sleeps.push(ms); },
    });
    assert.equal(creds.refreshToken, 'rt-2');
    assert.deepEqual(sleeps, [5000, 5000, 5000]);
  } finally {
    auth.server.close();
  }
  const dead = await fakeAuth([[503, {}], [503, {}], [503, {}]], { expires_in: 2 });
  let clock = 0;
  try {
    await assert.rejects(loginGrokDevice({
      deviceUrl: dead.deviceUrl, tokenUrl: dead.tokenUrl, open: () => {},
      now: () => clock, sleep: async ms => { clock += ms; },
    }), /timed out/);
  } finally {
    dead.server.close();
  }
});

test('refresh stores a rotated refresh token, keeps the old one when none comes back, and flags invalid_grant', async () => {
  const auth = await fakeAuth([
    [200, { access_token: ACCESS, refresh_token: 'rt-new', expires_in: 21600 }],
    [200, { access_token: ACCESS, expires_in: 21600 }],
    [400, { error: 'invalid_grant' }],
  ]);
  try {
    const rotated = await refreshGrokAccessToken('rt-old', { tokenUrl: auth.tokenUrl });
    assert.equal(rotated.refreshToken, 'rt-new');
    assert.deepEqual(auth.calls[0].form, { grant_type: 'refresh_token', refresh_token: 'rt-old', client_id: GROK_CLIENT_ID });
    const kept = await refreshGrokAccessToken('rt-old', { tokenUrl: auth.tokenUrl });
    assert.equal(kept.refreshToken, 'rt-old');
    const err = await refreshGrokAccessToken('rt-old', { tokenUrl: auth.tokenUrl }).catch(e => e);
    assert.equal(err.terminalAuthentication, true);
  } finally {
    auth.server.close();
  }
});

test('grok auth.json: the entry of our client id, identity from the login, expiry from the JWT', () => {
  const file = {
    'https://auth.x.ai::someone-else': { key: 'other', refresh_token: 'x' },
    [`https://auth.x.ai::${GROK_CLIENT_ID}`]: {
      key: ACCESS, refresh_token: 'rt-file', expires_at: '2020-01-01T00:00:00Z', auth_mode: 'oidc',
      user_id: 'user-1', email: 'file@example.com', team_id: 'team-file', oidc_client_id: GROK_CLIENT_ID,
    },
  };
  const creds = parseGrokAuthFile(JSON.stringify(file));
  assert.equal(creds.accessToken, ACCESS);
  assert.equal(creds.refreshToken, 'rt-file');
  assert.equal(creds.accountUuid, 'user-1');
  assert.equal(creds.email, 'file@example.com');
  assert.equal(creds.teamId, 'team-file');
  assert.equal(creds.expiresAt, 2_000_000_000_000);
  assert.throws(() => parseGrokAuthFile('{}'), /no login/);
  // the lone-entry fallback never takes another client's login
  assert.throws(() => parseGrokAuthFile({
    'https://auth.x.ai::other-client': { key: ACCESS, refresh_token: 'x', oidc_client_id: 'other-client' },
  }), /OAuth client other-client, not b1a00492/);
  // a parse error never quotes the file (it holds tokens)
  assert.throws(() => parseGrokAuthFile('{"secret-token-start'), err => {
    assert.equal(err.message, 'grok auth.json is not valid JSON');
    return true;
  });
  assert.equal(grokAuthFilePath({ GROK_HOME: '/g' }), '/g/auth.json');
  assert.equal(grokAuthFilePath({ HOME: '/h' }), '/h/.grok/auth.json');
});

test('paths, affinity keys, rate-limit meter, identity rewrite', () => {
  assert.ok(isGrokInferencePath('/v1/responses'));
  assert.ok(isGrokInferencePath('/v1/chat/completions?x=1'));
  assert.ok(isGrokInferencePath('/v1/messages'));
  assert.ok(!isGrokInferencePath('/v1/responsesx'));
  assert.ok(!isGrokInferencePath('/v1/storage'));

  assert.equal(grokAffinityKey('/v1/responses', { 'x-grok-session-id': 's', 'x-grok-conv-id': 'c' }), 'session:s');
  assert.equal(grokAffinityKey('/v1/responses', { 'x-grok-session-id': '', 'x-grok-conv-id': 'c' }), 'conv:c');
  assert.equal(grokAffinityKey('/v1/sessions/abc/signals', {}), 'session:abc');
  assert.equal(grokAffinityKey('/v1/sessions/a%20b/signals', {}), 'session:a b');
  assert.equal(grokAffinityKey('/v1/sessions/%E0%A4%A/signals', {}), 'session:%E0%A4%A');
  assert.equal(grokAffinityKey('/v1/models', {}), null);

  assert.equal(parseGrokRateLimit({}), null);
  assert.deepEqual(parseGrokRateLimit({ 'x-ratelimit-limit-requests': '100', 'x-ratelimit-remaining-requests': '10' }),
    { requestsLimit: 100, requestsRemaining: 10, tokensLimit: null, tokensRemaining: null, utilization: 0.9 });

  const headers = { 'X-UserId': 'local', 'x-email': 'me@local', 'x-teamid': 'local-team', other: 'kept' };
  rewriteGrokIdentityHeaders(headers, { accountUuid: 'u', email: null, teamId: null });
  assert.deepEqual(headers, { other: 'kept', 'x-userid': 'u' });
});

test('grok run binary and environment', () => {
  const none = () => false;
  assert.equal(resolveGrokBin({ env: { TEAMGROK_GROK_BIN: '/x/grok', HOME: '/h' }, exists: none }), '/x/grok');
  assert.equal(resolveGrokBin({ env: { HOME: '/h' }, exists: p => p === '/h/.grok/bin/grok' }), '/h/.grok/bin/grok');
  assert.equal(resolveGrokBin({ env: { HOME: '/h', GROK_HOME: '/g' }, exists: p => p === '/g/bin/grok' }), '/g/bin/grok');
  assert.equal(resolveGrokBin({ env: { HOME: '/h' }, exists: p => p === join('/h', '.local/bin/grok') }), '/h/.local/bin/grok');
  assert.equal(resolveGrokBin({ env: { HOME: '/h' }, exists: none }), 'grok');
  assert.deepEqual(buildGrokRunEnv({ A: '1', TEAMCLAUDE_PROVIDER: 'grok', TEAMCLAUDE_CONFIG: '/c' }, 3459),
    { A: '1', GROK_CLI_CHAT_PROXY_BASE_URL: 'http://127.0.0.1:3459/v1' });
});
