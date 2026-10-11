// Machine-readable output for app-managed installs (docs/install/APP-INSTALL.md):
// account views for `<pool> accounts|status --json` and the line-JSON login events.
import { createInterface } from 'node:readline';

export const machine = { json: false, needCodeMs: Number(process.env.TEAMPROXY_NEED_CODE_MS) || 20_000, cleanups: [] };

export const emit = fields => process.stdout.write(`${JSON.stringify(fields)}\n`);

/** a***@gmail.com — the app never needs the full address. */
export function maskEmail(email) {
  if (typeof email !== 'string' || !email.includes('@')) return null;
  const [local, domain] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}

const pct = util => (Number.isFinite(util) ? Math.round(util * 1000) / 10 : null);
const iso = ms => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);
const window = (util, reset) => ({ usedPct: pct(util), resetsAt: iso(reset) });

/** One entry per configured account, enriched with the running server's view when there is one. No secrets. */
export function accountViews(configAccounts, liveStatus) {
  const live = new Map((liveStatus?.accounts ?? []).filter(a => a.name).map(a => [a.name, a]));
  return configAccounts.map(c => {
    const l = live.get(c.name);
    const q = l?.quota;
    const view = {
      name: c.name,
      type: c.type === 'apikey' ? 'api' : 'oauth',
      provider: c.provider ?? l?.provider ?? null,
      plan: l?.planType ?? c.planType ?? c.tierId ?? null,
      email: maskEmail(c.email),
      enabled: c.enabled !== false,
      usable: l ? l.usable === true : null,
      priority: c.priority ?? null,
      fiveHour: q ? window(q.unified5h, q.unified5hReset) : null,
      sevenDay: q ? window(q.unified7d, q.unified7dReset) : null,
      rateLimitedUntil: l?.rateLimitedUntil ?? null,
      error: l?.errorReason ?? (c.subscriptionDisabled ? 'subscription-disabled' : null),
    };
    const g3 = q?.agyGroups?.['3p'];
    if (g3) view.claudeGpt = { fiveHour: window(g3.fiveHour?.utilization, g3.fiveHour?.resetsAt), sevenDay: window(g3.weekly?.utilization, g3.weekly?.resetsAt) };
    return view;
  });
}

export function errorCode(err) {
  const text = String(err?.message ?? err);
  if (err?.code === 'cancelled') return 'cancelled';
  if (/timed out/i.test(text)) return 'login_timeout';
  if (/state mismatch/i.test(text)) return 'state_mismatch';
  if (/OAuth error/i.test(text)) return 'oauth_denied';
  if (/token exchange/i.test(text)) return 'token_exchange_failed';
  if (/Codex CLI not found/i.test(text)) return 'codex_not_found';
  if (/already exists/i.test(text)) return 'account_exists';
  return 'login_failed';
}

/** Switch a login run to line-JSON: events on stdout, human chatter to stderr, SIGTERM cleans up. */
export function enableMachineLogin() {
  machine.json = true;
  console.log = (...parts) => console.error(...parts);
  const cancel = async () => {
    for (const cleanup of machine.cleanups.splice(0)) await Promise.resolve(cleanup()).catch(() => {});
    emit({ done: true, ok: false, error: 'cancelled' });
    process.exit(1);
  };
  process.once('SIGTERM', cancel);
  process.once('SIGINT', cancel);
}

/** The app opens the browser itself: hand it the URL and say we are waiting. */
export function announceAuthUrl(url, extra = {}) {
  emit({ event: 'auth_url', url, ...extra });
  emit({ event: 'waiting' });
}

function parseCodeInput(text, expectedState) {
  try {
    const url = new URL(text);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (code) {
      if (expectedState && state && state !== expectedState) throw new Error('OAuth state mismatch');
      return code;
    }
  } catch (err) {
    if (/state mismatch/.test(err.message)) throw err;
  }
  return text;
}

/**
 * Wait for the loopback callback; also take a pasted code or callback URL (one line) on stdin.
 * If nothing arrives for a while, say so with `need_code` so the app can ask the user.
 */
export function machineCodeRace(callbackPromise, expectedState) {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: process.stdin });
    let settled = false;
    const timer = setTimeout(() => { if (!settled) emit({ event: 'need_code' }); }, machine.needCodeMs);
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      fn(value);
    };
    lines.on('line', line => {
      const text = line.trim();
      if (!text) return;
      try { settle(resolve, parseCodeInput(text, expectedState)); } catch (err) { settle(reject, err); }
    });
    callbackPromise.then(code => settle(resolve, code), err => settle(reject, err));
  });
}
