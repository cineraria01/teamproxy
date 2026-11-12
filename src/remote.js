// Remote access through `tailscale serve` (tailnet-only HTTPS) and the phone
// status surface (`/teamproxy/status`, `/teamproxy/hud`, account actions).
// The proxy itself keeps listening where it always did; serve forwards from
// loopback and marks the request with Tailscale identity headers, which is how
// a remote request is told apart from a local one. Guide:
// docs/install/INSTALL-ALL.md (원격 접속). No proxy state lives here.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';

// Tailnet HTTPS port per pool (fixed by the contract; `remote.port` overrides).
export const REMOTE_PORTS = { claude: 8456, codex: 8457, agy: 8458, grok: 8459, cursor: 8460 };

// Headers `tailscale serve` adds. Their presence makes a loopback request remote,
// and they are dropped before the worker so they never reach an upstream API.
export const SERVE_HEADERS = [
  'tailscale-user-login', 'tailscale-user-name', 'tailscale-user-profile-pic',
  'tailscale-headers-info', 'tailscale-app-capabilities',
  'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host',
];

export function isTeamproxyPath(url) {
  return typeof url === 'string' && url.startsWith('/teamproxy/');
}

export function remotePort(pool, remote) {
  const port = remote?.port;
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : REMOTE_PORTS[pool];
}

export function newRemoteToken() {
  return randomBytes(32).toString('base64url');
}

export function isServeRequest(headers) {
  return headers['tailscale-user-login'] != null || headers['x-forwarded-for'] != null;
}

// Constant time whatever the lengths: both sides are hashed first.
export function tokenMatches(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !expected) return false;
  const digest = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

export function presentedKeys(headers) {
  const auth = headers.authorization;
  return [
    headers['x-api-key'],
    typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null,
  ];
}

/**
 * Verdict for a request that came through `tailscale serve`.
 * `shellOnly`: the HUD page itself (static, no data) needs the allowed login but no token.
 * @returns {{ok: true} | {ok: false, status: number, type: string, message: string, counts: boolean}}
 */
export function remoteVerdict(headers, remote, { shellOnly = false } = {}) {
  if (remote?.enabled !== true || typeof remote.token !== 'string' || !remote.token) {
    return { ok: false, status: 403, type: 'permission_error', message: 'Remote access is off on this proxy.', counts: false };
  }
  const login = headers['tailscale-user-login'];
  const allowed = Array.isArray(remote.allowLogins) ? remote.allowLogins : [];
  if (typeof login !== 'string' || !allowed.includes(login)) {
    return { ok: false, status: 403, type: 'permission_error', message: 'This Tailscale login is not allowed.', counts: true };
  }
  if (shellOnly) return { ok: true };
  if (!presentedKeys(headers).some(key => tokenMatches(key, remote.token))) {
    return { ok: false, status: 401, type: 'authentication_error', message: 'Invalid remote token', counts: true };
  }
  return { ok: true };
}

// Consecutive failures slow the answer down: 250 ms, 500 ms, … capped at 5 s.
export function failureDelayMs(consecutiveFailures) {
  return Math.min(5000, 250 * Math.max(1, consecutiveFailures));
}

// ── status ──────────────────────────────────────────────────

function iso(value) {
  if (value == null || value === '') return null;
  const date = new Date(typeof value === 'number' ? value : String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function gauge(utilization, reset) {
  if (typeof utilization !== 'number' || !Number.isFinite(utilization)) return null;
  return { pct: Math.round(Math.min(1, Math.max(0, utilization)) * 100), resetsAt: iso(reset) };
}

const time = value => {
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

// The footer's state column (src/hud/statusline.py account_state).
export function accountState(account, now = Date.now()) {
  if (account.enabled === false) return 'off';
  if (account.status === 'error') return 'error';
  const limited = time(account.rateLimitedUntil);
  if (limited != null && limited > now) return 'wait';
  if (Object.values(account.capacityCooling || {}).some(until => (time(until) || 0) > now)) return 'cool';
  if (account.inflight > 0) return 'busy';
  if (account.usable === false) return 'limit';
  if (Object.values(account.capacityRecovered || {}).some(at => {
    const t = time(at) || 0;
    return now - 600_000 <= t && t <= now;
  })) return 'back';
  return 'ready';
}

/**
 * `/teamproxy/status` from AccountManager.getStatus({ includeIdentity: true }) —
 * the same snapshot the footer reads from /teamclaude/status, reshaped. Cells a
 * pool does not have are null.
 */
export function buildTeamproxyStatus(snapshot, { pool, version = null, now = Date.now() }) {
  const accounts = snapshot.accounts.map((a, index) => {
    const q = a.quota || {};
    const fable = pool === 'claude' ? q.modelWeekly?.['7d_oi'] : null;
    // agy's Claude/GPT group: the fuller of its 5h and weekly buckets binds, as in the footer.
    const group = pool === 'agy' ? q.agyGroups?.['3p'] : null;
    const third = group
      ? [group.fiveHour, group.weekly].filter(w => typeof w?.utilization === 'number')
        .sort((x, y) => y.utilization - x.utilization)[0]
      : null;
    return {
      n: index + 1,
      name: a.name ?? null,
      tag: a.planType || null,
      enabled: a.enabled !== false,
      active: Boolean(snapshot.currentAccount) && a.name === snapshot.currentAccount,
      priority: a.priority ?? null,
      state: accountState(a, now),
      // grok's rate-limit meter and cursor's included usage ride the footer's first bar too.
      session: q.sessionWindowStated === false ? null : gauge(q.unified5h, q.unified5hReset),
      weekly: pool === 'grok' || pool === 'cursor' ? null : gauge(q.unified7d, q.unified7dReset),
      fable: fable ? gauge(fable.utilization, fable.reset) : null,
      thirdParty: third ? gauge(third.utilization, third.reset) : null,
      end: pool === 'claude' || pool === 'codex' ? iso(a.subscription?.endsAt) : null,
      stale: a.quotaStale === true,
    };
  });
  return {
    pool,
    version,
    accounts,
    requests: { active: snapshot.accounts.reduce((sum, a) => sum + (a.inflight || 0), 0) },
    updatedAt: new Date(now).toISOString(),
  };
}

// CLI `priority <name> <n|auto>` and POST /teamproxy/accounts/<n>/priority share this.
export function parsePriority(raw) {
  if (raw === 'auto' || raw === 'clear' || raw === 'none' || raw === 'null' || raw === null) return { clear: true };
  const n = Number(raw);
  if (raw === '' || typeof raw === 'boolean' || !Number.isFinite(n)) return null;
  return { clear: false, value: Math.floor(n) };
}

// The config edit each action makes — the same one `<pool> enable|disable|priority` writes.
export function applyAccountAction(account, action, priority) {
  if (action === 'enable') account.enabled = true;
  else if (action === 'disable') account.enabled = false;
  else if (priority.clear) delete account.priority;
  else account.priority = priority.value;
}

// ── tailscale serve (CLI side) ──────────────────────────────

const MAC_TAILSCALE = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

export function tailscaleBin(env = process.env) {
  if (env.TEAMPROXY_TAILSCALE_BIN) return env.TEAMPROXY_TAILSCALE_BIN;
  return process.platform === 'darwin' && existsSync(MAC_TAILSCALE) ? MAC_TAILSCALE : 'tailscale';
}

// Never `funnel`: serve keeps the address inside the tailnet.
export function serveArgs(on, port, localPort) {
  return on
    ? ['serve', '--bg', `--https=${port}`, `http://127.0.0.1:${localPort}`]
    : ['serve', `--https=${port}`, 'off'];
}

// `tailscale status --json` → this machine's login and MagicDNS name.
export function selfFromStatus(status) {
  const self = status?.Self || {};
  const login = status?.User?.[self.UserID]?.LoginName || null;
  const dnsName = typeof self.DNSName === 'string' ? self.DNSName.replace(/\.$/, '') : null;
  return { login, dnsName: dnsName || null };
}

// `tailscale serve status --json` → is <port> served, and does it point at this proxy?
export function serveState(status, port, localPort) {
  const web = Object.entries(status?.Web || {}).find(([host]) => host.endsWith(`:${port}`))?.[1];
  const proxies = Object.values(web?.Handlers || {}).map(handler => handler?.Proxy).filter(Boolean);
  return {
    served: Boolean(status?.TCP?.[port]) && proxies.length > 0,
    target: proxies[0] || null,
    matches: proxies.some(proxy => proxy.replace(/\/$/, '') === `http://127.0.0.1:${localPort}`),
    funnel: Object.keys(status?.AllowFunnel || {}).some(host => host.endsWith(`:${port}`)),
  };
}

// ── HUD page ────────────────────────────────────────────────

// Static: carries no account data. The token is typed once and kept in this
// browser's localStorage; every data call sends it as x-api-key.
export const HUD_HTML = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<title>Teamproxy 상태</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#16181d;--dim:#6b7280;--line:#e5e7eb;--ok:#16a34a;--warn:#d97706;--bad:#dc2626;--track:#e5e7eb;--accent:#2563eb}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#181b21;--fg:#e8eaed;--dim:#9aa0a6;--line:#2a2e36;--track:#2a2e36;--accent:#60a5fa}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.4 -apple-system,system-ui,sans-serif;padding:16px;padding-bottom:calc(16px + env(safe-area-inset-bottom))}
header{display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap}h1{font-size:18px;margin:0}
.dim{color:var(--dim);font-size:13px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;margin-top:12px}
.row{display:flex;justify-content:space-between;gap:8px;align-items:center}.name{font-weight:600;overflow-wrap:anywhere}
.badge{font-size:12px;padding:2px 8px;border-radius:999px;border:1px solid var(--line);color:var(--dim)}.badge.on{color:var(--accent);border-color:var(--accent)}
.g{display:grid;grid-template-columns:44px 1fr auto;gap:6px;align-items:center;margin-top:6px;font-size:13px}
.bar{height:10px;background:var(--track);border-radius:5px;overflow:hidden}.bar i{display:block;height:100%}
.btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}button{font:inherit;font-size:14px;padding:8px 12px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg);min-height:40px}
button.primary{background:var(--accent);color:#fff;border-color:var(--accent)}input{font:inherit;width:100%;padding:10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg);margin:8px 0}
#msg{min-height:20px;margin-top:8px}.err{color:var(--bad)}
</style></head><body>
<header><h1 id="title">Teamproxy</h1><span class="dim" id="meta"></span></header>
<div id="login" class="card" hidden><div>원격 토큰을 넣으세요. 프록시가 도는 PC에서 <code id="cmd">teamclaude remote token</code>으로 봅니다. 이 브라우저에만 저장됩니다.</div>
<input id="token" type="password" autocomplete="off" placeholder="원격 토큰"><button class="primary" id="save">저장</button></div>
<div id="tools" class="btns" hidden><button id="reload">사용량 다시 불러오기</button><button id="forget">토큰 지우기</button></div>
<div id="msg" class="dim"></div><main id="list"></main>
<script>
(function(){
var KEY='teamproxy-token',timer=null;
function token(){try{return localStorage.getItem(KEY)||''}catch(e){return''}}
function setToken(v){try{v?localStorage.setItem(KEY,v):localStorage.removeItem(KEY)}catch(e){}}
function $(id){return document.getElementById(id)}
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}
function msg(t,bad){$('msg').textContent=t||'';$('msg').className=bad?'err':'dim'}
function left(at){if(!at)return'';var s=(Date.parse(at)-Date.now())/1000;if(!(s>0))return'곧';var m=Math.floor(s/60),d=Math.floor(m/1440),h=Math.floor(m%1440/60);return d?d+'일 '+h+'시간':h?h+'시간 '+m%60+'분':Math.max(1,m)+'분'}
function gauge(label,g){var w=el('div','g');w.appendChild(el('span','dim',label));var b=el('div','bar'),f=el('i');if(g){f.style.width=g.pct+'%';f.style.background=g.pct<70?'var(--ok)':g.pct<90?'var(--warn)':'var(--bad)'}b.appendChild(f);w.appendChild(b);w.appendChild(el('span','dim',g?g.pct+'% '+left(g.resetsAt):'-'));return w}
var STATE={ready:'대기',busy:'사용 중',off:'꺼짐',error:'오류',wait:'한도 대기',cool:'식는 중',limit:'한도',back:'복구됨'};
function call(method,path,body){var h={'x-api-key':token()};if(body)h['content-type']='application/json';return fetch(path,{method:method,headers:h,body:body?JSON.stringify(body):undefined,cache:'no-store'})}
function needLogin(){$('login').hidden=false;$('tools').hidden=true;$('list').textContent=''}
function act(path,body,done){msg('보내는 중…');call('POST',path,body).then(function(r){return r.json().catch(function(){return{}}).then(function(j){if(r.status===401){needLogin();msg('토큰이 맞지 않습니다.',true);return}if(!r.ok){msg((j.error&&j.error.message)||('실패: HTTP '+r.status),true);return}msg(done);load()})}).catch(function(){msg('연결 실패',true)})}
function render(d){$('title').textContent='Teamproxy · '+d.pool;$('meta').textContent='요청 '+d.requests.active+'개 · '+new Date(d.updatedAt).toLocaleTimeString('ko-KR')+(d.version?' · '+d.version:'');$('cmd').textContent='team'+d.pool+' remote token';var list=$('list');list.textContent='';
if(!d.accounts.length){list.appendChild(el('div','card','계정이 없습니다.'))}
d.accounts.forEach(function(a){var c=el('div','card'),top=el('div','row');top.appendChild(el('span','name',a.n+'. '+(a.name||'-')+(a.tag?' · '+a.tag:'')));var s=el('span','badge'+(a.active?' on':''),(a.active?'선택 · ':'')+(STATE[a.state]||a.state)+(a.priority!=null?' · 우선 '+a.priority:''));top.appendChild(s);c.appendChild(top);
c.appendChild(gauge(d.pool==='grok'?'RL':d.pool==='cursor'?'사용':'5h',a.session));if(d.pool!=='grok'&&d.pool!=='cursor')c.appendChild(gauge('7d',a.weekly));if(d.pool==='claude')c.appendChild(gauge('Fable',a.fable));if(d.pool==='agy')c.appendChild(gauge('3p',a.thirdParty));
if(a.end)c.appendChild(el('div','dim','구독 끝 '+new Date(a.end).toLocaleDateString('ko-KR')));if(a.stale)c.appendChild(el('div','dim','오래된 값 — 다시 재는 중'));
var b=el('div','btns'),t=el('button',null,a.enabled?'끄기':'켜기');t.onclick=function(){act('/teamproxy/accounts/'+a.n+'/'+(a.enabled?'disable':'enable'),null,a.name+(a.enabled?' 끔':' 켬'))};b.appendChild(t);
var p=el('button',null,'우선 1');p.onclick=function(){act('/teamproxy/accounts/'+a.n+'/priority',{priority:1},a.name+' 우선 1')};b.appendChild(p);
var q=el('button',null,'자동 순서');q.onclick=function(){act('/teamproxy/accounts/'+a.n+'/priority',{priority:'auto'},a.name+' 자동 순서')};b.appendChild(q);c.appendChild(b);list.appendChild(c)})}
function load(){if(!token()){needLogin();return}call('GET','/teamproxy/status').then(function(r){if(r.status===401){needLogin();msg('토큰이 맞지 않습니다.',true);return}if(!r.ok){msg('상태를 못 읽었습니다: HTTP '+r.status,true);return}return r.json().then(function(d){$('login').hidden=true;$('tools').hidden=false;render(d)})}).catch(function(){msg('연결 실패 — Tailscale이 켜져 있는지 보세요.',true)})}
$('save').onclick=function(){setToken($('token').value.trim());$('token').value='';msg('');load()};
$('forget').onclick=function(){setToken('');needLogin();msg('토큰을 지웠습니다.')};
$('reload').onclick=function(){act('/teamproxy/reload',null,'다시 불러왔습니다.')};
load();timer=setInterval(function(){if(!document.hidden)load()},10000);
})();
</script></body></html>`;
