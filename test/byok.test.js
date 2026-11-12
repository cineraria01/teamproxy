import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAUDE_CODE_SYSTEM_MARKER,
  normalizeByokConfig,
  matchByokSurface,
  scrubBrowserHeaders,
  hasUnsafeSegments,
  applyByokRequest,
  applyLocalByokKey,
  applyRemoteByokKey,
  answerByokPreflight,
  admitByok,
} from '../src/byok.js';

// Long enough to satisfy the minimum-length rule in normalizeByokConfig.
const VALID_KEY = 'byok-test-secret-0123456789';

function makeReq(headers = {}, method = 'POST', url = '/v1/messages') {
  return { method, url, headers: { 'content-type': 'application/json', ...headers } };
}

function makeRes() {
  const res = {
    statusCode: null,
    headers: null,
    body: null,
    ended: false,
    writeHead(code, headers) { res.statusCode = code; res.headers = headers; return res; },
    end(payload) { res.body = payload ?? null; res.ended = true; return res; },
  };
  return res;
}

function bodyOf(json) {
  return Buffer.from(JSON.stringify(json));
}

// --- normalizeByokConfig ---------------------------------------------------

test('byok is disabled when config is absent', () => {
  assert.equal(normalizeByokConfig(undefined).enabled, false);
  assert.equal(normalizeByokConfig(null).enabled, false);
  assert.equal(normalizeByokConfig({}).enabled, false);
  assert.equal(normalizeByokConfig({ enabled: false, apiKey: VALID_KEY }).enabled, false);
});

test('byok refuses to enable without an api key', () => {
  const result = normalizeByokConfig({ enabled: true });
  assert.equal(result.enabled, false);
  assert.match(result.error, /apiKey/);
  assert.equal(normalizeByokConfig({ enabled: true, apiKey: '   ' }).enabled, false);
});

test('byok normalizes an enabled config with defaults', () => {
  const result = normalizeByokConfig({ enabled: true, apiKey: VALID_KEY });
  assert.equal(result.enabled, true);
  assert.equal(result.prefix, '/byok');
  assert.equal(result.apiKey, VALID_KEY);
  assert.equal(result.allowLocalWithoutKey, false);
  assert.ok(result.minUsableAccounts >= 1);
  assert.ok(result.maxConcurrent >= 1);
});

test('local automatic BYOK authentication is explicitly opt-in', () => {
  for (const value of [undefined, false, 'true', 1]) {
    const config = normalizeByokConfig({ enabled: true, apiKey: VALID_KEY, allowLocalWithoutKey: value });
    const req = { ...makeReq(), socket: { remoteAddress: '127.0.0.1' } };
    assert.equal(applyLocalByokKey(req, config), false);
    assert.equal(req.headers['x-api-key'], undefined);
  }
});

test('local native JSON Messages requests use the stored BYOK key', () => {
  const config = normalizeByokConfig({ enabled: true, apiKey: VALID_KEY, allowLocalWithoutKey: true });
  for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    const req = { ...makeReq({}, 'POST', '/byok/v1/messages'), socket: { remoteAddress } };
    assert.equal(applyLocalByokKey(req, config), true);
    assert.equal(req.headers['x-api-key'], VALID_KEY);
  }
});

test('automatic BYOK authentication rejects remote and browser requests and preserves supplied credentials', () => {
  const config = normalizeByokConfig({ enabled: true, apiKey: VALID_KEY, allowLocalWithoutKey: true });
  const cases = [
    { remoteAddress: '192.0.2.1' },
    { remoteAddress: '::ffff:192.0.2.1' },
    { headers: { origin: 'https://example.test' } },
    { headers: { Origin: 'null' } },
    { headers: { referer: 'https://example.test' } },
    { headers: { cookie: 'a=1' } },
    { headers: { 'sec-fetch-mode': 'cors' } },
    { headers: { 'sec-ch-ua': 'browser' } },
    { headers: { 'x-forwarded-for': '127.0.0.1' } },
    { headers: { 'content-type': 'text/plain' } },
    { headers: { 'x-api-key': 'wrong-key' } },
    { headers: { 'x-api-key': '' } },
    { headers: { authorization: 'Bearer wrong-key' } },
    { method: 'GET' },
    { url: '/v1/messages' },
    { url: '/byok/teamclaude/status' },
    { url: '/byok/v1/oauth/token' },
  ];
  for (const value of cases) {
    const req = { ...makeReq(value.headers, value.method, value.url),
      socket: { remoteAddress: value.remoteAddress || '127.0.0.1' } };
    const headers = { ...req.headers };
    assert.equal(applyLocalByokKey(req, config), false, JSON.stringify(value));
    assert.deepEqual(req.headers, headers);
  }
});

test('byok normalizes a custom prefix into a leading-slash, no-trailing-slash form', () => {
  assert.equal(normalizeByokConfig({ enabled: true, apiKey: VALID_KEY, prefix: 'ext/' }).prefix, '/ext');
  assert.equal(normalizeByokConfig({ enabled: true, apiKey: VALID_KEY, prefix: '/ext/' }).prefix, '/ext');
  assert.equal(normalizeByokConfig({ enabled: true, apiKey: VALID_KEY, prefix: '/' }).enabled, false);
});

test('byok refuses the shipped placeholder key and short keys', () => {
  const placeholder = normalizeByokConfig({ enabled: true, apiKey: 'byok-change-me-to-a-secret' });
  assert.equal(placeholder.enabled, false);
  assert.match(placeholder.error, /placeholder/);

  assert.equal(
    normalizeByokConfig({ enabled: true, apiKey: 'anything-CHANGE-ME-here-padded' }).enabled,
    false,
    'any change-me variant is refused',
  );

  const short = normalizeByokConfig({ enabled: true, apiKey: 'short-key' });
  assert.equal(short.enabled, false);
  assert.match(short.error, /at least/);

  assert.equal(normalizeByokConfig({ enabled: true, apiKey: 'a'.repeat(24) }).enabled, true);
});

test('matchByokSurface collapses duplicate slashes so downstream checks are exact', () => {
  assert.equal(matchByokSurface('/byok//teamclaude/status', '/byok').path, '/teamclaude/status');
  assert.equal(matchByokSurface('/byok///v1//messages', '/byok').path, '/v1/messages');
  assert.equal(matchByokSurface('/byok/v1/messages?a=b//c', '/byok').path, '/v1/messages?a=b//c');
});

test('scrubBrowserHeaders removes whole browser header families', () => {
  const headers = {
    origin: 'https://x', cookie: 'a=1', 'sec-ch-ua': '"Chromium"',
    'sec-ch-ua-platform-version': '"15"', 'x-forwarded-for': '10.0.0.1',
    'sec-fetch-mode': 'cors', 'anthropic-version': '2023-06-01',
  };
  const removed = scrubBrowserHeaders(headers);
  assert.deepEqual(Object.keys(headers), ['anthropic-version']);
  assert.ok(removed.includes('cookie'));
  assert.ok(removed.includes('sec-ch-ua-platform-version'));
  assert.ok(removed.includes('x-forwarded-for'));
});

test('byok refuses a prefix that collides with a path the proxy already owns', () => {
  for (const prefix of ['/v1', '/v1/messages', 'v1', '/teamclaude', '/teamclaude/status']) {
    const result = normalizeByokConfig({ enabled: true, apiKey: VALID_KEY, prefix });
    assert.equal(result.enabled, false, `${prefix} must not be accepted as a byok prefix`);
  }
});

test('hasUnsafeSegments rejects dot-segments, raw or percent-encoded', () => {
  assert.equal(hasUnsafeSegments('/v1/messages'), false);
  assert.equal(hasUnsafeSegments('/v1/messages?a=..'), false);
  assert.equal(hasUnsafeSegments('/../teamclaude/rotate'), true);
  assert.equal(hasUnsafeSegments('/v1/../../etc'), true);
  assert.equal(hasUnsafeSegments('/%2e%2e/teamclaude/rotate'), true);
  assert.equal(hasUnsafeSegments('/./v1/messages'), true);
  assert.equal(hasUnsafeSegments('/v1/%ZZ'), true, 'undecodable input fails closed');
  assert.equal(hasUnsafeSegments(''), true);
});

test('byok clamps numeric limits to sane values', () => {
  const result = normalizeByokConfig({
    enabled: true, apiKey: VALID_KEY, minUsableAccounts: -5, maxConcurrent: 0,
  });
  assert.ok(result.minUsableAccounts >= 0);
  assert.ok(result.maxConcurrent >= 1);
});

// --- matchByokSurface ------------------------------------------------------

test('matchByokSurface canonicalizes a prefixed path', () => {
  assert.equal(matchByokSurface('/byok/v1/messages', '/byok').path, '/v1/messages');
  assert.equal(matchByokSurface('/byok/v1/messages?beta=true', '/byok').path, '/v1/messages?beta=true');
  assert.equal(matchByokSurface('/byok', '/byok').path, '/');
  assert.equal(matchByokSurface('/byok/', '/byok').path, '/');
});

test('matchByokSurface only matches on a segment boundary', () => {
  assert.equal(matchByokSurface('/byokish/v1/messages', '/byok'), null);
  assert.equal(matchByokSurface('/v1/messages', '/byok'), null);
  assert.equal(matchByokSurface('/other/byok/v1', '/byok'), null);
  assert.equal(matchByokSurface('', '/byok'), null);
  assert.equal(matchByokSurface(undefined, '/byok'), null);
});

// --- applyByokRequest: marker injection ------------------------------------

test('applyByokRequest injects the marker when system is absent', () => {
  const req = makeReq();
  const original = bodyOf({ model: 'claude-sonnet-5', messages: [] });
  const result = applyByokRequest(req, original);
  assert.equal(result.injected, true);
  const parsed = JSON.parse(result.body.toString());
  assert.equal(parsed.system, CLAUDE_CODE_SYSTEM_MARKER);
  assert.equal(req.headers['content-length'], String(result.body.length));
});

test('applyByokRequest gives a string system a standalone marker block and keeps the original text', () => {
  const req = makeReq();
  const result = applyByokRequest(req, bodyOf({ model: 'm', system: 'You are Aside.' }));
  assert.equal(result.injected, true);
  const parsed = JSON.parse(result.body.toString());
  assert.deepEqual(parsed.system, [
    { type: 'text', text: CLAUDE_CODE_SYSTEM_MARKER },
    { type: 'text', text: 'You are Aside.' },
  ]);
  assert.equal(req.headers['content-length'], String(result.body.length));
});

test('applyByokRequest unshifts a marker block into an array system', () => {
  const req = makeReq();
  const result = applyByokRequest(req, bodyOf({
    model: 'm',
    system: [{ type: 'text', text: 'You are Aside.' }],
  }));
  assert.equal(result.injected, true);
  const parsed = JSON.parse(result.body.toString());
  assert.equal(parsed.system.length, 2);
  assert.equal(parsed.system[0].type, 'text');
  assert.equal(parsed.system[0].text, CLAUDE_CODE_SYSTEM_MARKER);
  assert.equal(parsed.system[1].text, 'You are Aside.');
});

test('applyByokRequest is idempotent when the marker already exists anywhere in the array', () => {
  const req = makeReq();
  const original = bodyOf({
    model: 'm',
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=1;' },
      { type: 'text', text: CLAUDE_CODE_SYSTEM_MARKER },
    ],
  });
  const result = applyByokRequest(req, original);
  assert.equal(result.injected, false);
  assert.equal(result.body, original, 'unchanged requests must reuse the original buffer');
  assert.equal(req.headers['content-length'], undefined);
});

test('applyByokRequest is idempotent for the exact marker string', () => {
  const req = makeReq();
  const original = bodyOf({ model: 'm', system: CLAUDE_CODE_SYSTEM_MARKER });
  const result = applyByokRequest(req, original);
  assert.equal(result.injected, false);
  assert.equal(result.body, original);
});

test('an embedded marker still gets a standalone block and the normalized request is idempotent', () => {
  const embedded = `${CLAUDE_CODE_SYSTEM_MARKER}\n\n셀비 AI 연결 시험입니다.`;
  for (const system of [embedded, [{ type: 'text', text: embedded }]]) {
    const req = makeReq();
    const result = applyByokRequest(req, bodyOf({ model: 'm', system }));
    assert.equal(result.injected, true);
    assert.deepEqual(JSON.parse(result.body).system, [
      { type: 'text', text: CLAUDE_CODE_SYSTEM_MARKER },
      { type: 'text', text: embedded },
    ]);
    const repeated = applyByokRequest(req, result.body);
    assert.equal(repeated.injected, false);
    assert.equal(repeated.body, result.body);
  }
});

test('applyByokRequest leaves an unparseable body untouched', () => {
  const req = makeReq();
  const original = Buffer.from('not json at all');
  const result = applyByokRequest(req, original);
  assert.equal(result.injected, false);
  assert.equal(result.body, original);
  assert.equal(req.headers['content-length'], undefined);
});

test('applyByokRequest leaves a non-object JSON body untouched', () => {
  const req = makeReq();
  const original = Buffer.from(JSON.stringify([1, 2, 3]));
  const result = applyByokRequest(req, original);
  assert.equal(result.injected, false);
  assert.equal(result.body, original);
});

// --- applyByokRequest: browser header scrub --------------------------------

test('applyByokRequest strips browser-context headers that upstream rejects', () => {
  const req = makeReq({
    origin: 'https://app.example.com',
    referer: 'https://app.example.com/chat',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'cross-site',
    'user-agent': 'Aside/1.0',
  });
  const result = applyByokRequest(req, bodyOf({ model: 'm', system: CLAUDE_CODE_SYSTEM_MARKER }));
  assert.equal(req.headers.origin, undefined);
  assert.equal(req.headers.referer, undefined);
  assert.equal(req.headers['sec-fetch-mode'], undefined);
  assert.equal(req.headers['sec-fetch-site'], undefined);
  assert.equal(req.headers['user-agent'], 'Aside/1.0', 'unrelated headers survive');
  assert.equal(result.scrubbed.includes('origin'), true);
});

// --- answerByokPreflight ---------------------------------------------------

test('answerByokPreflight answers OPTIONS locally and never forwards it', () => {
  const req = makeReq({ origin: 'https://app.example.com' }, 'OPTIONS');
  const res = makeRes();
  assert.equal(answerByokPreflight(req, res), true);
  assert.equal(res.statusCode, 204);
  assert.equal(res.ended, true);
  assert.ok(res.headers['access-control-allow-headers']);
});

test('answerByokPreflight ignores non-OPTIONS methods', () => {
  const res = makeRes();
  assert.equal(answerByokPreflight(makeReq({}, 'POST'), res), false);
  assert.equal(res.ended, false);
});

// --- admitByok -------------------------------------------------------------

test('admitByok rejects while usable accounts are below the floor', () => {
  const config = { minUsableAccounts: 3, maxConcurrent: 2 };
  const verdict = admitByok({ usableCount: 2, byokInflight: 0, config });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'headroom');
  assert.ok(verdict.retryAfter >= 1);
});

test('admitByok rejects when the byok concurrency cap is reached', () => {
  const config = { minUsableAccounts: 1, maxConcurrent: 2 };
  const verdict = admitByok({ usableCount: 10, byokInflight: 2, config });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'concurrency');
});

test('admitByok admits when there is headroom and a free slot', () => {
  const config = { minUsableAccounts: 1, maxConcurrent: 2 };
  assert.equal(admitByok({ usableCount: 4, byokInflight: 1, config }).ok, true);
});

// --- applyRemoteByokKey ----------------------------------------------------

test('remote (serve-admitted) Messages requests get the stored BYOK key without allowLocalWithoutKey', () => {
  const config = normalizeByokConfig({ enabled: true, apiKey: VALID_KEY });
  const req = makeReq({ 'tailscale-user-login': 'me@example.com' }, 'POST', '/byok/v1/messages?beta=true');
  assert.equal(applyRemoteByokKey(req, config), true);
  assert.equal(req.headers['x-api-key'], VALID_KEY);
  assert.equal(applyRemoteByokKey(makeReq({}, 'POST', '/byok/v1/messages'), normalizeByokConfig(undefined)), false);
});

test('remote BYOK fill keeps supplied credentials and refuses browser or non-Messages requests', () => {
  const config = normalizeByokConfig({ enabled: true, apiKey: VALID_KEY });
  const cases = [
    { headers: { 'x-api-key': 'own-key' } },
    { headers: { authorization: 'Bearer own-key' } },
    { headers: { origin: 'https://example.test' } },
    { headers: { 'sec-fetch-site': 'cross-site' } },
    { headers: { 'content-type': 'text/plain' } },
    { method: 'GET' },
    { url: '/v1/messages' },
    { url: '/byok/v1/models' },
  ];
  for (const c of cases) {
    const req = makeReq(c.headers, c.method || 'POST', c.url || '/byok/v1/messages');
    const before = req.headers['x-api-key'];
    assert.equal(applyRemoteByokKey(req, config), false, JSON.stringify(c));
    assert.equal(req.headers['x-api-key'], before, JSON.stringify(c));
  }
});
