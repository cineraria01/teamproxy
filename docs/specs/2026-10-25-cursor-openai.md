# Cursor pool — OpenAI-compatible address (`/openai/v1`) — 2026-10-25

Owner request (2026-10-25, via the Selvi lead): give the Cursor pool (`teamcursor`, port 3460) an OpenAI-compatible
address so the Selvi app can list Cursor in 설정 › AI 연결 next to the other pools. Builds on Cursor mode
(`docs/specs/2026-10-24-cursor-mode.md`). Code: `src/cursor-openai.js`, wiring in `src/server.js` (worker) and
`src/index.js` (supervisor fence). Tests: `test/cursor-openai.test.js`, plus one dead-end test in
`test/server-cursor.test.js`.

## Why it runs cursor-agent

Cursor has no public inference API: its inference is a private Connect/protobuf bidi stream
(`agent.v1.AgentService/Run`, see the Cursor-mode spec). So every completion runs **`cursor-agent -p --mode ask`**
once, with the OpenAI conversation rendered into one prompt, and maps the reply back. The child talks to this same
pool, so it uses the pool's accounts like `teamcursor run` does.

## Contract (Selvi builds against this)

- **Address** `http://127.0.0.1:3460/openai/v1` (`localhost` and `[::1]` work too). Loopback needs **no key** (same rule
  as every pool). A remote peer follows the pool's normal proxy-key rule (`proxy.apiKey` in `x-api-key` or
  `Authorization: Bearer`); app installs listen on loopback only anyway.
- **`GET /openai/v1/models`** → `{object:"list", data:[{id, object:"model", created:0, owned_by:"cursor", name}]}`,
  the output of `cursor-agent --list-models` (265 models on 2026-10-25), cached 10 min.
  **First = the pool's default: `composer-2.5`** (Cursor's own model) when listed, then the CLI's order (`auto` first).
  Why: measured text + tool calls in 3.6–5.8 s and the tool call came back every time; `auto` routes to a model of
  Cursor's choice, and one of those (Claude Sonnet) refused the JSON framing because of the account's Cursor user
  rules. When Cursor stops listing `composer-2.5` the CLI's own order stands.
- **`POST /openai/v1/chat/completions`** — OpenAI Chat Completions: `model` (default `auto` when absent), `messages`
  (`system`/`developer`/`user`/`assistant` with `tool_calls`/`tool`), `tools` (`function` only), `tool_choice`
  (`none`/`auto`/`required`/a named function), `response_format` (`json_object`/`json_schema` become an instruction),
  `stream`, `stream_options.include_usage`.
  - Answer: `chat.completion`, `choices[0].message` = `{role:"assistant", content}` with `finish_reason:"stop"`, or
    `{role:"assistant", content:null, tool_calls:[{id:"call_<24 hex>", type:"function", function:{name, arguments
    (JSON string)}}]}` with `finish_reason:"tool_calls"`. Only offered tools can be called.
  - `usage`: `prompt_tokens` = input + cache read + cache write, `completion_tokens` = output,
    `prompt_tokens_details.cached_tokens` = cache read (cursor-agent's own count, which includes its system prompt).
  - `stream: true` → `text/event-stream`: one `chat.completion.chunk` delta with the whole content (or all tool calls,
    each with its `index`), one chunk with the `finish_reason`, a usage chunk (`choices: []`) when
    `stream_options.include_usage`, then `data: [DONE]`. **Not incremental**: the events are sent when cursor-agent
    has finished.
  - Images are not sent: each `image_url`/`input_image` part becomes the line `[N image(s) omitted: this connection
    cannot send images]`. Reasoning parameters (`reasoning_effort`, …), `max_completion_tokens`, `temperature` and
    other sampling fields are ignored (pick an effort through the model id, e.g. `gpt-5.3-codex-high`).
  - Extra response headers: `x-teamcursor-run-ms` (whole run) and `x-teamcursor-model-ms` (cursor-agent's
    `duration_ms`); the difference is cursor-agent starting up.
- **Errors** are `{error:{message, type, code:null}}`:

  | status | `type` | when | `retry-after` |
  |---|---|---|---|
  | 400 | `invalid_request_error` | body not JSON, no `messages`, model id not `[A-Za-z0-9][A-Za-z0-9._:[\]=,-]*` | — |
  | 401 | `authentication_error` | no enabled account, or every enabled account is parked (`error`) or past its token `exp` — checked **before** cursor-agent runs | — |
  | 404 | `not_found_error` | any other path under `/openai/v1` | — |
  | 413 | `invalid_request_error` | body over `maxRequestBytes` | — |
  | 429 | `insufficient_quota` | every working account is throttled (out of usage) — checked before the run | soonest throttle end, s (60 when unknown) |
  | 429 | `rate_limit_error` | this pool already runs `cursorOpenAI.maxConcurrent` (4) completions | `5` |
  | 502 | `upstream_error` | cursor-agent failed (its message after `TeamCursor: `) | — |
  | 503 | `cursor_cli_not_found` | cursor-agent is not installed (`TEAMCURSOR_CURSOR_BIN` → `~/.local/bin/cursor-agent` → `PATH`) | — |
  | 504 | `timeout_error` | no answer within `cursorOpenAI.timeoutMs` (10 min); the child is killed | — |

  After a failed run the pool is checked again (the run may have parked or throttled the last account), so a login
  that expires mid-run is a 401, not a 502. A failed run whose text says usage/rate limit is 429 `insufficient_quota`,
  one that says unauthenticated is 401. The supervisor's own answers stay as they are (503 while draining, 429 when
  its queue is full).
- **`GET /teamclaude/status`** is unchanged (no new fields).
- Config (optional, `~/.config/teamcursor.json`): `cursorOpenAI: { enabled (true), timeoutMs (600000),
  maxConcurrent (4), dir (<config without .json>.openai) }`. Only in cursor mode; other pools forward `/openai/v1/*`
  upstream like any path.

## How a completion runs

1. Pool check (above). Concurrency check.
2. The lane folder `<dir>` (`home/`, `workspace/`, 0700) is made if missing **before every run** — it is kept across
   requests and restarts so only the first run is cold, and deleting it while idle is safe (the next request
   rebuilds it). Then the tool fence is written where it differs (see Security): `home/.config/cursor/cli-config.json`
   and `home/.cursor/hooks.json`.
3. `cursor-agent --disable-codebase-ref --disable-indexing --disable-auto-update --disable-project-configs -p
   --output-format json --mode ask --trust [--model <id>] --workspace <dir>/workspace`, prompt on stdin. The env is
   **an allowlist** of the proxy's own (`PATH`, `TMPDIR`/`TMP`/`TEMP`, `LANG`, `LANGUAGE`, `LC_*`, `TZ`, `USER`,
   `LOGNAME`, `SHELL`, the `*_proxy` variables, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`/`_DIR`, and the Windows system
   variables; case-insensitive), plus `HOME`/`XDG_*` = lane home, `CURSOR_CONFIG_DIR=<home>/.config/cursor`,
   `CURSOR_DATA_DIR=<home>/.cursor`, `CURSOR_API_ENDPOINT=http://localhost:<public port>/teamcursor-lane`,
   `CURSOR_API_KEY=<per-process random key>`, `AGENT_CLI_CREDENTIAL_STORE=memory`, `DIRENV_DISABLE=1`, `NO_COLOR=1`.
   Why an allowlist: the bundle reads 100+ `CURSOR_*` / `AGENT_CLI_*` / `EXEC_DAEMON_*` switches, and
   `CURSOR_CONFIG_DIR` / `CURSOR_DATA_DIR` win over `XDG_CONFIG_HOME` / `HOME` (`cursor-config/dist/paths.js`), so an
   inherited one would have moved the lane's config — and the fence — to the user's `~/.cursor` (2026-10-25 audit).
   Measured: a dev pool started with `CURSOR_CONFIG_DIR=CURSOR_DATA_DIR=~/.cursor` and
   `AGENT_CLI_CREDENTIAL_STORE=file` left `~/.cursor` byte-identical and wrote no `auth.json` anywhere.
   A spawn `ENOENT` while the workspace is gone (deleted mid-run) is a 502 about the lane folder, not
   `cursor_cli_not_found` (spawn reports a missing cwd as ENOENT too).
4. The child exchanges its key at the lane (`POST /teamcursor-lane/auth/exchange_user_api_key`, answered by the
   worker with an unsigned look-alike session JWT, `sub teamcursor|lane`), then every API call and its agent stream
   come back through `/teamcursor-lane/…`: the worker strips the prefix and relays them exactly like `teamcursor run`
   traffic — `authorization` (the look-alike token) is dropped and the account bearer injected on both HTTP/1.1 and
   h2. The look-alike token never leaves the machine (test: only the account bearer reaches the fake upstream).
   `DashboardService/GetEffectiveUserPlugins|ListMarketplaces|GetManagedSkills` are answered empty on the lane: the
   account's plugins were 164 MB and 4 min on a fresh home, and their hooks/rules would ride every turn.
5. Reply = cursor-agent's `result` text: the first JSON object `{"tool_calls":[…]}` with offered names, or
   `{"content":"…"}`, found anywhere in the text (Cursor user rules prepend a header such as `현재 사용 모델: …`);
   no usable JSON → the text itself. One pass finds the balanced `{…}` spans (quotes count only inside braces),
   outermost first, and at most 64 are tried with `JSON.parse` — linear time. The first draft rescanned from every
   `{` (quadratic: 80 000 `{` took 5.4 s on the worker's event loop, enough for a reply provoked by web text to stall
   every other stream); four 80 000-character floods now parse in 62 ms together (test).
6. Chats (`home/.config/cursor/chats/<hash>/<id>`) and transcripts (`home/.cursor/projects/<ws>/agent-transcripts/<id>`)
   older than 1 h are deleted after each run (they hold the prompts).
7. The client hanging up aborts the run: SIGTERM, SIGKILL after 5 s. `cursor-agent` is a bash script that `exec`s
   node, so the signal reaches the process itself; no grandchildren were seen in ask mode (measured).

## The macOS keychain dialog (root cause and fix)

Symptom (owner, 2026-10-25 01:51): while an earlier draft's dev server ran, macOS kept showing
"키체인 발견할 수 없음 — 'cursor-user'을(를) 저장할 키체인을 찾을 수 없습니다. [취소] [기본값으로 재설정]", and runs took ~30 s longer.

Cause (cursor-agent 2026.10.22 bundle): after the API-key exchange cursor-agent saves the token through its
credential store. On macOS the default store is the keychain class in `../cli-credentials` /
`../keychain/dist/index.js`, which spawns `/usr/bin/security add-generic-password -a cursor-user -s
cursor-access-token …` with a 30 s timeout. The child's `HOME` is the lane home, which has no
`Library/Keychains`, so macOS shows "Keychain Not Found" for `cursor-user` and the run waits out the timeout.
(Answer such a leftover dialog with [취소]; [기본값으로 재설정] touches keychain settings.)

Fix: `AGENT_CLI_CREDENTIAL_STORE=memory` in the lane env (cursor-agent's own switch, `src/utils/credential-store.ts`:
`file` | `memory` | default). With `memory` the credential manager is an in-memory class and the bundle has no other
`security` call except `keychain-check.ts`, which only runs for the default store over SSH. Linking the user's
`~/Library/Keychains` into the lane home was rejected: cursor-agent would overwrite the user's own `cursor-user`
login with the lane token.

Checked 2026-10-25 on the owner's Mac (dev pool on 3470, ~25 cursor-agent runs: models, text, tool calls, streams,
probes): a watcher polling `ps` every 0.1 s for `/usr/bin/security` saw **0** runs, and the on-screen window list
(CGWindowList owners: SecurityAgent, UserNotificationCenter, security, coreautha, Keychain Access) showed **0**
dialog candidates before and after. `screencapture -x` could not be used: this session (Claude Code in tmux) has no
screen-recording permission ("could not create image from display"). Test: `laneEnv` keeps
`AGENT_CLI_CREDENTIAL_STORE=memory`. Risk: a cursor-agent release that renames the switch brings the dialog back;
the lane test will not catch that, the run time (+30 s) and the dialog will.

## Security

- **The lane is local-only.** `/teamcursor-lane/*` from a non-loopback peer is 403 at the supervisor (the worker only
  ever sees loopback, so the fence must be on the public port; the worker keeps the same check). h2 from a
  non-loopback peer was already closed. The lane key is per process and only the lane's exchange accepts it.
- **cursor-agent's tools are fenced.** Ask mode is "read-only", but it still reads any file on the machine: measured,
  a canary file outside the workspace came back through `Read` and through `Grep`. A Selvi prompt carries text taken
  from the web (titles, transcripts), so a prompt injection could have asked for `~/.config/teamcursor.json` (every
  pooled token) or `~/.ssh/*` and put it in the answer. The lane's `cli-config.json` therefore holds
  `permissions: {allow: [], deny: ["Read(**)", "Write(**)"]}` (written before each run when it differs; cursor-agent
  keeps a list it finds). Measured after the change: `Read` → "Permission denied" (also for a dot directory), `Grep`
  → "No matches found", `Shell` (`ls`, `cat`) → "Rejected" (the CLI's default allowlist `Shell(ls)` is gone). The
  model still sees the tool list; only execution is refused.
- **Second layer: a hook that blocks every local tool.** `home/.cursor/hooks.json` (cursor-agent's user hooks file,
  `homedir()/.cursor/hooks.json`) holds `{"version":1,"hooks":{"preToolUse":[{"command":"exit 2","failClosed":true}]}}`
  — no matcher, so every tool cursor-agent executes locally is refused before it runs (exit code 2 = block). The lane
  needs no local tool; this also covers tools the permission list does not name. Measured: `Read` and `Grep` now
  answer `Hook "exit 2" blocked this action`, and a logging hook confirmed that preToolUse fires in the lane for
  local tools.
- **Web fetch (2026-10-25 audit).** The bundle registers a local Fetch executor that calls `fetch(url)` with no
  permission check (`this.register(a.IGA, yl(new Ea))`, `LocalFetchExecutor`). Measured with a loopback bait HTTP
  server (random port, logs every request) and five probes asking to fetch and quote it: **0 requests reached the
  bait**. The model's web fetch is a server-side dynamic tool (`GetDynamicTools` / `CallDynamicTool` `WebFetch`):
  `http://127.0.0.1:<port>` → "Cannot fetch from localhost … this tool runs from an isolated server";
  `http://127.0.0.1.nip.io:<port>` (resolves to 127.0.0.1) and `https://example.com` → "Web fetch rejected: User
  Rejected" — print mode cannot approve, and the lane pins `approvalMode: "allowlist"` and
  `autoAcceptWebSearch: false` in `cli-config.json` to keep it that way; `gpt-5.3-codex-low` and
  `claude-opus-5-thinking-high` reported no web fetch tool at all. The preToolUse hook saw no `Fetch` in those runs,
  so the local executor never ran; if it ever does, the hook above blocks it. What a server-side fetch can reach is
  only what the prompt already contains.
- The lane home holds cursor-agent's settings, `authInfo` (email, user id from `GetMe`), chats ≤ 1 h old; `0700`.

## Measured (2026-10-25, owner's Mac, real Ultra account, dev pool on 3470 with a copied config)

| step | time |
|---|---|
| `GET /models`, fresh lane home | 1.6 s (265 models, `composer-2.5` first) |
| text (Selvi's 연결 시험 sentence), first run on a fresh home | 5.8 s (model 2.2 s) |
| tool call (Selvi's `ping` tool) | 3.8–4.4 s |
| tool result follow-up (`assistant.tool_calls` + `tool`) | 3.8 s |
| `stream: true` text / tool call | 4.2 / 4.6 s |
| text / tool, `auto` | 6.0 / 3.6 s |
| text / tool, `gpt-5.3-codex-low` | 5.7 / 5.7 s |
| text / tool, `claude-opus-5-thinking-high` | 5.1 / 3.9 s |

The earlier draft measured 26 s for a first run on a new home and 263 s before the plugin RPCs were emptied.

## Not done / limits

- No real streaming (cursor-agent `--output-format stream-json` exists; add it when a client needs first-token latency).
- One cursor-agent process per completion: ~2 s of start-up on top of the model time; at most `maxConcurrent` at once.
- Tool calls are prompted, not native: a model can still answer in text when a call was required.
- Windows lane paths (chat pruning) are not measured.
