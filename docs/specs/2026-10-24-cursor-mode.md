# Cursor mode (`teamcursor`) — 2026-10-24

Owner request (2026-10-24): "teamproxy 에 cursor-agent 부분도 다른것들과 같이 teamcursor 로 해서 다른것들처럼 지원하자".
A fifth, fully isolated provider pool next to Anthropic, Codex, agy and Grok mode, in this same codebase and install:
Cursor accounts used by the **Cursor CLI (`cursor-agent`)**, rotated like the other pools. Pattern to copy: Grok mode
(`docs/specs/2026-10-15-grok-mode.md`, `src/grok.js`).

## Facts (verified 2026-10-24 against cursor-agent 2026.10.22-27dcf5f and a real Cursor Ultra account)

Measured with a local pass-through recorder (HTTP/1.1 + h2c on loopback, forwarding to the real hosts, logging method,
path, headers with tokens cut to 8–15 chars, status and byte counts) and by reading the CLI's JS bundle
(`~/.local/share/cursor-agent/versions/<v>/index.js` and chunks). A handful of `-p "say ok"` runs, nothing more.

### Redirecting cursor-agent
- `CURSOR_API_ENDPOINT=<url>` (or `-e/--endpoint`, default `https://api2.cursor.sh`) moves the **API backend**: every
  `aiserver.v1.*` Connect call (`DashboardService/GetMe`, `ServerConfigService/GetServerConfig`,
  `AiService/AvailableModels|GetUsableModels|GetDefaultModelForCli`, `AnalyticsService/*`, `/v1/traces`, …) went to it.
- **The agent (inference) backend is chosen separately** (`service-urls.ts` `bd`): when the endpoint string contains
  `localhost` (or `staging.cursor.sh`, `lclhst.build`), or the agent transport is HTTP/1.1, the agent uses the
  endpoint itself; otherwise it uses `agentUrlConfig.{agentUrl,agentnUrl}` from `GetServerConfig` — measured
  `https://agentn.global.api5.cursor.sh`. So `CURSOR_API_ENDPOINT=http://127.0.0.1:<port>` sends only the API calls to
  the proxy (inference went **direct** to api5, the answer still came back), while
  **`CURSOR_API_ENDPOINT=http://localhost:<port>` sends inference to the proxy too**. A hidden `--agent-endpoint <url>`
  flag also exists.
- With `localhost`, the CLI connected over **IPv6 `::1`** first (both protocols). With a listener on `127.0.0.1` only,
  the HTTP/2 agent connection never fell back to IPv4 ("Connection lost, reconnecting to http://localhost:… (attempt N)"
  forever); HTTP/1.1 calls did reach `::1` when it listened there. A proxy for cursor-agent must accept on `::1`.
- Other direct hosts in the bundle: `api3.cursor.sh` (metrics, HTTP/2, a fixed bearer — not the user token),
  `repo42.cursor.sh` (repo index), `downloads.cursor.com`, `cursor.com` (login page). None carries inference.

### Transport and protocol
- API calls: **HTTP/1.1**, Connect unary, `content-type: application/proto` (binary), `connect-protocol-version: 1`,
  `user-agent: connect-es/1.6.1`, `accept-encoding: gzip,br`. The same RPCs accept **Connect JSON**
  (`content-type: application/json`, body `{}`) — verified for `GetMe`, `GetPlanInfo`, `GetCurrentPeriodUsage`.
- Inference: **`POST /agent.v1.AgentService/Run` over HTTP/2 cleartext (h2c, prior knowledge)**, Connect
  **bidirectional streaming** (`content-type: application/connect+proto`, `connect-content-encoding: gzip`,
  `connect-accept-encoding: gzip,br`). One "say ok" turn: 88.6 KB up, 28 KB down, ~6 s, HTTP 200, no trailers.
  The CLI keeps a pool of 4 HTTP/2 sessions (`http2_agent_connection_pool_config.poolSize`) and round-robins streams.
  An HTTP/1.1 agent transport (`useHttp1ForAgent` in `~/.cursor/cli-config.json`, or a server
  `serverHttp2Config` force) exists but is off for this account (`serverHttp2Config: 0`).
- Connect streaming framing: 5-byte envelope (flags, uint32 BE length); flag `0x01` = compressed, `0x02` = end of
  stream whose payload is JSON `{"error": {"code": "<connect code>", "message": …}, "metadata": {…}}` or `{}`.

### Request headers (agent `Run`)
`authorization: Bearer <JWT>`, `x-cursor-client-type: cli`, `x-cursor-client-version: cli-2026.10.22-27dcf5f`,
`x-cursor-timezone`, `x-ghost-mode`, `x-request-id` = `x-original-request-id` (per turn), `traceparent`,
`backend-traceparent`, and **`x-blob-encryption-key`** (64 hex). API calls carry only `authorization` plus the Connect
headers. **No checksum, machine id, client key or session header is sent**, so nothing besides `authorization` is tied
to the account. `x-blob-encryption-key` differed between two fresh chats and was **identical on `--resume` of the same
chat** (one value per conversation) — a natural affinity key; it is a secret (it encrypts the chat's server-side blobs)
and must never be logged.

### Credentials
- macOS: keychain generic passwords, account **`cursor-user`**, services **`cursor-access-token`** and
  **`cursor-refresh-token`** (also `cursor-api-key`, `cursor-bedrock-*`). Linux: `$XDG_CONFIG_HOME/cursor/auth.json`;
  Windows `%APPDATA%\Cursor\auth.json`; JSON `{accessToken, refreshToken, apiKey?}`.
- The token is an **HS256 JWT** (`iss https://authentication.cursor.sh`, `aud https://cursor.com`, `type: "session"`,
  scope `openid profile email offline_access`, `sub` = `<idp>|user_…`, `time` = issue time) living **60 days**
  (`exp − time = 5 184 000`). **The stored access token and refresh token are the same string.**
- **The CLI never refreshes an OAuth login.** Its refresh path (`auth-refresh.ts`, `dashboard.js`) only re-exchanges an
  API key (`POST /auth/exchange_user_api_key`); without one an expiring token is used as is, and an expired one means
  `cursor-agent login` again. `logout` only deletes the local keychain items (no server revoke).
- Login (`cursor-config/dist/auth/login.js`): verifier = 32 random bytes base64url, challenge =
  base64url(sha256(verifier)), uuid = random UUID; open
  `https://cursor.com/loginDeepControl?challenge=<c>&uuid=<u>&mode=login&redirectTarget=cli` (plus
  `supportsSelectedTeamLogin=true`); poll **`GET https://api2.cursor.sh/auth/poll?uuid=<u>&verifier=<v>`** — `404` =
  pending (backoff `1 s × 1.2^n`, max 10 s, 150 tries), `200` = `{accessToken, refreshToken, selectedTeamId?, …}`,
  `403 {"error":"sign_in_policy_violation"}` = refused by device policy; three non-404 failures in a row give up.
- Identity: `DashboardService/GetMe` → `{userId (number), email, firstName, lastName, authId, workosId, …}`.

### Usage and plan
- `DashboardService/GetPlanInfo` → `{planInfo: {planName: "Ultra", price, billingCycleEnd (ms string), …}}`.
- `DashboardService/GetCurrentPeriodUsage` → `{billingCycleStart, billingCycleEnd (ms strings), planUsage: {totalSpend,
  includedSpend, remaining, limit (cents), autoPercentUsed, apiPercentUsed, totalPercentUsed}, enabled,
  displayMessage}`. Measured: spend 21 / limit 40000, `apiPercentUsed 0.21`, `totalPercentUsed 0.0068`.
- No rate-limit or usage header on any response (agent or API).
- **Exhaustion not observed.** The bundle maps Connect `resource_exhausted` ↔ HTTP 429 and treats it as non-retryable;
  the usage-limit message shape is unknown. Designed defensively below ("미관측").

### Models
- `--list-models` / `cursor-agent models`: `AiService/AvailableModels` + `GetUsableModels` (HTTP/1.1, through the
  endpoint).

### Newline key
cursor-agent: "`\` + Enter or Ctrl+J (works everywhere)", Shift+Enter only in terminals it configured, Option+Enter
in Terminal.app with Meta. Inside tmux, **Ctrl+J** is the reliable newline.

## Requirements

### Provider wiring
Provider id `cursor`. Selected by `TEAMCLAUDE_PROVIDER=cursor`, the `cursor` subcommand prefix, or config
`provider: "cursor"` — same mechanics and mode/config agreement as `agy`/`grok`. Own config `~/.config/teamcursor.json`,
default port **3460**, own state files; pool label "TeamCursor". Anthropic, Codex, agy and Grok behaviour must not
change. Zero runtime dependencies (`node:http2` only).

### CLI (`src/index.js`, mirror the `grok` prefix)
- `cursor server|stop|restart|status|accounts|remove|reload|enable|disable|priority|env|login|import|run|update`,
  with the `--json` forms app mode uses (`app-json.js`). Default names `cursor-1`, `cursor-2`, …
- `cursor login [--name N] [--json]`: the CLI's own browser flow (above) run by the proxy — never `cursor-agent login`,
  which would overwrite the user's local login. `--json` emits `auth_url` then `waiting`.
- After login/import: `GetMe` → `userId` (identity key; re-login of the same user updates in place), `email`;
  `GetPlanInfo` → `planType`.
- `cursor import [--name N] [--file P]`: macOS keychain (`cursor-user` / `cursor-access-token`, `cursor-refresh-token`),
  or a `{accessToken, refreshToken}` JSON file. The token is shared with the local login (no rotation, so neither side
  signs the other out); warn that it is not refreshed and expires on its JWT `exp` (60 days), and recommend `login`.
- `cursor run [-- <cursor-agent args>]`: auto-start the server, spawn cursor-agent with
  `CURSOR_API_ENDPOINT=http://localhost:<port>` and the user's normal environment. Binary: `TEAMCURSOR_CURSOR_BIN` →
  `$HOME/.local/bin/cursor-agent` → bare `cursor-agent`; ENOENT names the resolved path. cursor-agent must be signed in
  locally once.
- Never revoke or delete anyone's tokens.

### Proxy
- API upstream `https://api2.cursor.sh` (`cursorUpstream`, falls back to `upstream`); agent upstream
  `https://agentn.global.api5.cursor.sh` (`cursorAgentUpstream`). Paths under `/agent.v1.` go to the agent upstream,
  everything else to the API upstream. Forward every path generically.
- HTTP/1.1 requests use the existing buffered forwarding path. HTTP/2 (h2c) connections are accepted on the same
  public port: the supervisor recognises the h2 preface and pipes the raw connection to an h2c listener in the worker,
  which relays each stream to the upstream over HTTPS/HTTP2 with the bodies untouched in both directions (bidi).
- Strip client `authorization`, `x-api-key`, `cookie`; inject `Bearer <account token>`. Keep everything else.
- Loopback only: an h2 connection from a non-loopback peer is refused (it cannot present the proxy key per request).
  The public listener also accepts on `::1` when it is pinned to a loopback address.
- Token: no refresh exists. `expiresAt` = JWT `exp`. Past it the account is parked `refresh-failed` (re-login heals);
  an upstream 401 / Connect `unauthenticated` before any response byte was delivered → park that account
  (`auth-revoked`) and fail over.
- Quota: poll `GetCurrentPeriodUsage` (+ `GetPlanInfo` for the plan name) per enabled, un-parked account at startup,
  every `warmupIntervalMs` (default 10 min), after a completed agent stream once the data is older than
  `cursorUsageActiveMs` (default 2 min), and on `reload`. Meter = max(totalSpend/limit, autoPercentUsed/100,
  apiPercentUsed/100), display only (mirrored into `unified5h`, reset = billing cycle end); never gates selection.
- Exhaustion (**미관측** — defensive): on an agent stream, before any response byte reached the client, an HTTP 429 or
  an end-of-stream error with Connect code `resource_exhausted` → throttle that account (5 min) and replay the
  buffered request bytes on another account at once. Nothing left → the upstream response passes through unchanged.
  An HTTP/1.1 429 → no account state, pass through.
- Stickiness: an agent stream's affinity key is a hash of `x-blob-encryption-key` (one per chat), else the h2 session.
  HTTP/1.1 keeps socket affinity. `reevalIntervalMs` 0, accounts always "measured", `maxConcurrentPerAccount` 8.
- Bodies and stream frames pass through byte-identical; no synthetic frames, no mid-stream recovery.

### Footer and app mode
- `src/hud/launcher.py --cursor`: `teamcursor` with no args or `-` flags opens cursor-agent in tmux `teamcursor-hud`
  with the account footer (one usage bar, plan, account name); tab title "Cursor". Print/one-shot forms skip the
  footer: `-p`, `--print`, `--list-models`, `-v`, `--version`, `-h`, `--help`, and the subcommands. `--yolo` is
  cursor-agent's own flag and passes through. Shift+Enter → `C-j`.
- `scripts/install-app.mjs`: pool `cursor` (`teamcursor`, 3460, `teamcursor.json`, launchd `kr.selvi.teamproxy.cursor`),
  `--login-command cursor` → `teamcursor login --name cursor-N`. `src/update.js` knows `teamcursor`.

### Out of scope (say so in docs)
API-key mode (`--api-key` / `CURSOR_API_KEY`), the Cursor desktop editor, streaming over the HTTP/1.1 agent transport
(`useHttp1ForAgent`; its RPCs are forwarded but buffered), mid-stream recovery, usage-based billing / spend-limit management, a token refresh endpoint.

## Tests (`node --test`, `test/*cursor*.test.js`, fake upstreams and fake auth endpoints only)
Config isolation (file, port 3460, state files); header strip/inject; 401 → park + failover; expired token → park;
login flow (pending → success, timeout, policy refusal, `--json` events); re-login same `userId` updates in place;
import from a fake keychain / file; usage → meter; exhaustion (`resource_exhausted` end-stream and HTTP 429) →
throttle + replay on another account; all exhausted → upstream response through; affinity by
`x-blob-encryption-key`; h2c bidi stream byte-identical both ways (through the supervisor); `cursor run` env and
binary resolution; install-app pool `cursor`; footer launcher `--cursor` argument handling.

## Ops (outside the repo, done by the coordinator)
`~/.local/bin/teamcursor` wrapper (`TEAMCLAUDE_PROVIDER=cursor`, `TEAMCLAUDE_CONFIG=~/.config/teamcursor.json`,
`TEAMCURSOR_CURSOR_BIN=~/.local/bin/cursor-agent`; no args or `-` flags → `src/hud/launcher.py --cursor`), own install
`~/.local/share/teamcursor-global/lib/node_modules/teamcodex`, `teamcursor-tmux-server`, launchd `com.example.teamcursor`,
tmux socket `teamcursor`. Account login is a browser sign-in by the owner (`teamcursor login --name cursor-N`); a token
lasts 60 days, then the same command again. Risk note for the owner: this pools Cursor subscription accounts behind one
machine; Cursor may treat that like other providers treated OAuth reuse.

## Implementation decisions (2026-10-24, as built)

- **Public port = h2c sniffer.** In cursor mode the supervisor listens with a `net` server (`h2cSniffer` in cursor.js):
  a connection whose first bytes are `PRI ` (the h2 preface) is piped byte for byte to the worker's loopback h2c
  listener (`server.cursorH2`, port reported as `internalH2Port` in `teamcodex:ready`); anything else is emitted into
  the usual HTTP/1.1 `listener`, so status, control, buffering and replay for HTTP/1.1 are unchanged. A non-loopback
  h2 peer, or no ready worker, is closed (cursor-agent reconnects by itself). With `proxy.host` `127.0.0.1`/`localhost`
  (app installs) a second listener on `[::1]` is added; unset host already listens dual-stack.
- **Relay, not buffering.** Each h2 stream gets its own upstream stream on one shared `http2.connect` session per origin
  (agent paths → `cursorAgentUpstream`, others → `cursorUpstream`). Request chunks are forwarded as they arrive and also
  kept (up to `maxRequestBytes`) until the response is committed; the response is held until its status is known and,
  for a 200 Connect stream on an agent path, until the first envelope is readable. Then it is committed (headers, held
  bytes, live piping, upstream trailers forwarded). Backpressure is not managed (`ponytail`: fine for chat-sized frames).
- **Failover before commit only.** HTTP 429 / end-stream `resource_exhausted` → `markRateLimited(retry-after or 5 min)`,
  replay the kept bytes on another account if one is usable or capped and this request has failed over for exhaustion
  fewer than `max(1, rateLimitFailovers)` times (one odd request cannot bench the pool), else pass the answer through.
  HTTP 401 / `unauthenticated` → park `auth-revoked` and replay; a second distinct account refusing the same request
  trips the HTTP/1.1 cascade guard rule (`AUTH_401_CASCADE_THRESHOLD`): this request's parks are undone (ownership stamp
  `_authParkSeq`) and the answer passes through. A network error, or an upstream stream that ends or resets before its
  headers, → another account, no account state. After commit nothing is replayed; a broken upstream resets the client
  stream. Request bytes past `maxRequestBytes` arriving while no upstream stream carries them end the client stream.
- **Deployment drain.** The worker reports its live h2 stream count over IPC (`teamcodex:h2-streams`); the supervisor adds
  it to `x-teamcodex-active-requests` and the drain reply, and forwards its drain state (`teamcodex:draining`) so the
  worker answers new h2 streams with an `unavailable` end frame (unary: 503) while draining.
- **HTTP/1.1 front.** The `net` front (`h2cFrontServer`) emits `listening` on the HTTP/1.1 server so its connection
  tracking (headersTimeout/requestTimeout, closeAllConnections) runs; the sniffer decides on the first four bytes however
  they are split. `proxy.host: localhost` binds 127.0.0.1 and ::1 explicitly; `0.0.0.0`/`::` logs a warning.
- **HTTP/1.1 agent RPCs** (`/agent.v1.*`, cursor-agent's `useHttp1ForAgent`) go to `cursorAgentUpstream` too, through the
  buffered HTTP/1.1 path (a long server stream there is delivered when it ends — streaming UX over HTTP/1.1 is out of
  scope). End frames are decompressed with the response's `connect-content-encoding` (gzip or br). `--log-to` redacts
  `x-blob-encryption-key`.
- **Dead ends** answer in Connect's shape: a streaming request gets HTTP 200 + one end-of-stream frame
  `{"error":{"code","message"}}` (`resource_exhausted` with `retry-after` = soonest throttle, 1 s when only capped, else
  60 s; `unauthenticated` when every account is parked; `unavailable` when only network errors happened); a unary request
  gets HTTP 429/401/503 `{"code","message"}`. HTTP/1.1 dead ends use the same `{"code","message"}` JSON.
- **Tokens.** No refresh call exists (the CLI has none for OAuth logins and its access token == refresh token).
  `ensureTokenFresh` for a cursor account only parks it `refresh-failed` once `expiresAt` (JWT `exp`) has passed; a 401
  forced refresh is a no-op, so the generic HTTP/1.1 path retries once and then parks. `accounts` without a running
  server never tries to refresh a cursor token. Import refuses an already expired login.
- **Accounts.** Identity = `GetMe` `userId` (string), else the JWT `sub`; the `sub` is also stored (`cursorSub`) and a
  login matching either value updates that account (a re-login while `GetMe` fails no longer duplicates it); email from `GetMe`; `planType` = `GetPlanInfo`
  `planName`. Names: `--name` → the existing name of the same `userId` → first free `cursor-N`. `GetMe`/usage failing only
  warns. `import` on macOS reads the keychain with `security find-generic-password … -w` (read only); `--file` or other
  platforms read `{accessToken, refreshToken}` JSON (default `$XDG_CONFIG_HOME/cursor/auth.json`, Windows
  `%APPDATA%\Cursor\auth.json`). Unparsable files get a fixed message that never quotes a token.
- **Login.** The CLI's own flow, run by the proxy (`loginCursorBrowser`): `cursorWebsiteUrl` (default `https://cursor.com`)
  for the page, `cursorUpstream` for `/auth/poll`; 404 pending with the CLI's backoff, 150 polls, three other failures
  in a row stop. App mode emits `auth_url` (`browser_opened: false`) then `waiting`; a policy 403 maps to `oauth_denied`,
  the poll limit to `login_timeout` (existing `errorCode` patterns). `cursor-agent login` is never run.
- **Usage.** Connect JSON `GetCurrentPeriodUsage` + `GetPlanInfo` per enabled, un-parked account; meter = max(spend/limit,
  auto %/100, API %/100) → `quota.cursorUsage` and `unified5h`/`unified5hReset` (= cycle end); `_isNearQuota` returns
  false for cursor. `warmupIntervalMs` defaults to 10 min for cursor; `cursorUsageRefresh: false` turns polling off;
  `cursorUsageActiveMs` (2 min) gates the after-stream refresh.
- **Affinity.** `x-blob-encryption-key` → `chat:<sha256 prefix>` (the raw key is never stored or logged) through the
  existing string-key LRU (`agyAffinityObject`); without it the h2 session object.
- **Footer.** `launcher.py --cursor`: one `Use` bar with the cycle-end countdown, plan = `planType`, no 7d/End; oneshot
  flags `-p --print --list-models -v --version -h`; oneshot subcommands (`about bedrock create-chat generate-rule help
  install-shell-integration login logout mcp models persist plugin rule status team uninstall-shell-integration update
  whoami worker`), while `agent`, `ls`, `resume` keep the footer; `--yolo` stays `--yolo`; Shift+Enter → `C-j`; title
  `Cursor`; socket `teamcursor-hud`.
- **App mode.** `install-app.mjs` pool `cursor` (`teamcursor`, 3460, `teamcursor.json`, `kr.selvi.teamproxy.cursor`,
  wrapper `-u TEAMCLAUDE_SESSION_SUPERVISED TEAMCLAUDE_PROVIDER=cursor … src/index.js cursor`). `--app` without
  `--pools` now installs all five pools. The bundle needs no change (it ships every tracked `src/` file). The app
  bundle version is not bumped here (the coordinator decides). `update.js` probes `teamcursor` with a Connect JSON
  `GetMe`. `scripts/install.py` lists no agy/grok pool either, so it is unchanged.

## Verified (2026-10-24, owner's Mac, real Ultra account, temporary config on port 3460)
- `node src/index.js cursor import --name cursor-1` (keychain read only) → account `<userId>`, plan `Ultra`, config `0600`.
- `node src/index.js cursor run -- -p "reply with the single word ok" --output-format text --trust` → `ok` through the
  proxy (25 requests counted on the account; status `Usage: 0.4% of included usage`).
- `cursor run -- --list-models` → the full model list (269 lines) through the proxy.
- With `cursorAgentUpstream` pointed at a closed port the same `-p` run failed, i.e. inference really goes through the
  proxy and not straight to api5.
- **Not verified:** a second real account (switching between accounts — the token carries no device binding and no other
  account header was seen, so it is expected to work), a real exhaustion answer, and `teamcursor login` against the real
  site (the flow is the CLI's own, exercised against a fake endpoint).
