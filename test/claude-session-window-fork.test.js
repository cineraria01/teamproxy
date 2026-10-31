// Fork-only parts of the "no 5-hour window" (verified Ultra, 2026-10-30) flag:
// the flag is Anthropic-only (grok/cursor/codex reuse unified5h for their own
// meters), and the app-mode JSON carries it as a new field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { accountViews } from '../src/app-json.js';

const HOUR = 3600_000;
const futureSec = ms => String(Math.floor((Date.now() + ms) / 1000));
const WEEKLY_ONLY = () => ({
  'anthropic-ratelimit-unified-7d-utilization': '0.4',
  'anthropic-ratelimit-unified-7d-reset': futureSec(24 * HOUR),
  'anthropic-ratelimit-unified-status': 'allowed',
});
const acct = (name, extra = {}) => ({
  name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + HOUR, ...extra,
});

test('non-Anthropic providers never get the flag, from headers or a snapshot', () => {
  for (const provider of ['codex', 'grok', 'cursor', 'agy']) {
    const am = new AccountManager([acct('x', { provider })], 0.98, 0, 5);
    am.updateQuota(0, WEEKLY_ONLY(), { status: 200 });
    assert.equal(am.accounts[0].quota.sessionWindowStated, null, provider);
    am.importQuotaState([{ name: 'x', quota: { unified5h: 0.5, sessionWindowStated: false } }]);
    assert.equal(am.accounts[0].quota.sessionWindowStated, null, provider);
    assert.equal(am.accounts[0].quota.unified5h, 0.5, `${provider} meter kept`);
  }
});

test('a snapshot flag that is not a boolean restores as unknown', () => {
  const am = new AccountManager([acct('a')], 0.98, 0, 5);
  am.importQuotaState([{ name: 'a', quota: { sessionWindowStated: 'false' } }]);
  assert.equal(am.accounts[0].quota.sessionWindowStated, null);
});

test('app JSON adds fiveHourWindow next to the unchanged fiveHour window', () => {
  const am = new AccountManager([acct('u'), acct('m')], 0.98, 0, 5);
  am.updateQuota(0, WEEKLY_ONLY(), { status: 200 });
  const live = am.getStatus({ includeIdentity: true });
  const [u, m] = accountViews([{ name: 'u' }, { name: 'm' }], live);
  assert.equal(u.fiveHourWindow, false);
  assert.deepEqual(u.fiveHour, { usedPct: null, resetsAt: null });
  assert.equal(m.fiveHourWindow, null);
  assert.equal(accountViews([{ name: 'u' }], null)[0].fiveHourWindow, null);
});
