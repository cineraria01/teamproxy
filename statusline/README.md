# teamclaude-statusline

한국어 · [English](#english)

> 2026-10-10부터 [cineraria01/teamproxy](https://github.com/cineraria01/teamproxy) 포크의 `statusline/` 폴더다(옛 `cineraria01/teamclaude-statusline` 저장소를 합침). Codex·agy 하단 줄은 같은 포크의 `src/hud/`([docs/install/HUD.md](../docs/install/HUD.md)).
> `teamclaude`·`claude`로 띄우면 이 표가 Claude Code 아래 tmux 하단 줄로 옮겨 가고(2초마다 갱신), Claude 안의 상태줄에는 모델 줄만 남는다(`TEAMCLAUDE_HUD=1`). `claude`는 인자 없음·옵션이면 하단 줄로, 첫 낱말(`claude mcp list`)이면 하단 줄 없이 실행한다.

[teamclaude](https://github.com/jung-wan-kim/teamclaude) 다계정 Claude 프록시의 계정별 사용량을 Claude Code 상태줄에 실시간으로 표시합니다.

```
Fable 5
     FLEET         x4      pooled  Ses [   7% 6m    ] Wk [ 11% 6h10m  ] Fbl [ 37% 6h10m  ]
  1. alice@exampl  Max 20x active  Ses [  0% 1h30m  ] Wk [ 14% 1d14h  ] Fbl [ 27% 1d14h  ]   D-8
> 2. bob@example.  Max 20x active  Ses [  27% 5m    ] Wk [  8% 6h10m  ] Fbl [ 15% 6h10m  ]  D-25
  3. carol@exampl  Max 20x active  Ses [  0% 3h40m  ] Wk [     -      ] Fbl [ 97% 2d16h  ]   D-9
```

teamclaude TUI를 반영한 대시보드입니다. 최상단 `FLEET` 줄은 활성 계정들을 풀링합니다(창별 평균 사용률, 가장 빠른 리셋 시각, 비활성 계정이 제외되면 `+N off` 표기). 각 계정 줄에는 요금제(`Max 20x` / `Pro`), 상태 컬럼, 세 개의 쿼터 게이지 — `Ses` 5시간 세션, `Wk` 전체 7일, `Fbl` 모델별 7일(Fable, 해당 창이 없으면 Sonnet 창) — 이 `사용률% 리셋까지-남은-시간` 형태로 표시됩니다. 오른쪽 `End` 막대는 날짜와 D-day를 함께 표시하며 추정 결제일에는 `~`를 붙입니다.

컬러 터미널에서는 게이지가 사용률만큼 배경색이 채워진 막대로 그려집니다(위 예시의 대괄호는 `NO_COLOR` 폴백 표기). 회색 `-` 막대는 teamclaude가 해당 창을 보고하지 않았다는 뜻입니다. 모호폭 문자(`▶ × ⛔`)가 2칸을 차지하는 CJK 터미널에서도 칸이 어긋나지 않도록 모든 표시는 ASCII만 사용합니다(아래 낡은 값 표시의 `전`만 예외로, 늘 2칸이라 2칸으로 셉니다).

- `>` — 현재 요청을 처리 중인 계정
- 상태 컬럼의 `!HH:MM` — 해당 시각까지 레이트리밋에 걸린 계정
- `off` — 로테이션에서 제외된 계정
- 막대 색상: 초록 < 70% < 노랑 < 90% < 빨강
- 색이 빠진 회색 막대와 줄 끝의 `2h 전` — 프록시가 그 계정의 숫자를 그만큼 전에 마지막으로 갱신했다(30분 넘게 오래됨, 다른 기기의 사용분이 빠졌을 수 있음). 프록시는 쉬는 계정을 15분마다 다시 잰다(`quotaMaxAgeMs`, 2026-11-10)
- `TC down` — 프록시가 실행 중이 아님, `teamclaude not installed` — CLI가 설치되지 않음

### 2026-09-11 날짜 표시 복구

오른쪽 `End` 색상 막대에 날짜와 `D-N`을 함께 표시합니다. 명시된 구독 종료일이 없으면 구독 생성일의 월 단위 기념일로 다음 결제일을 추정하고 `~09/24 D-13`처럼 `~`를 붙입니다. 추정 결제일은 해지·종료 확정일이 아닙니다. 3일 이하 빨강·7일 이하 노랑·나머지 초록이며 미확인 날짜는 `-`입니다.

새 TeamCodex 기반 Claude 프록시가 `profile`을 생략하면 로컬 계정 UUID가 일치하는 OAuth 프로필을 Anthropic의 고정 HTTPS 주소에서 읽습니다. 구독 상태·생성일·요금제만 1시간 캐시하고 토큰은 캐시에 저장하지 않습니다. 환경 HTTP 프록시·리다이렉트는 사용하지 않으며 실패한 조회는 60초 뒤 재시도합니다. `TEAMCLAUDE_CONFIG`가 있으면 해당 설정을 사용합니다. 기존 프록시가 프로필을 제공하면 추가 조회하지 않습니다.

이 상태줄은 구독을 해지하거나 계정 라우팅을 변경하지 않습니다.

### 2026-10-07 장기 토큰(`claude setup-token`) 계정

계정 줄은 Fable 주간 리셋이 이른 순서로 올라오고, Fable 리셋을 모르는 계정은 **주간(`Wk`) 리셋이 이른 순서**로
그 뒤에 놓입니다 — 프록시가 계정을 고르는 순서와 같습니다. 장기 토큰은 사용량·프로필 조회 권한이 없어서
(`/api/oauth/usage`·`/api/oauth/profile` 403) 그 계정으로 Fable 요청이 지나가기 전까지 `Fbl`이 `-`로, `End`가
`-`로 보이고 이름은 `lt-1`처럼 나옵니다. `Ses`·`Wk`는 응답 헤더로 정상 표시됩니다.

## 요구 사항

- [teamclaude](https://github.com/jung-wan-kim/teamclaude) 설치·실행 — active warm-up과 `restart` 명령이 있는 [jung-wan-kim/teamclaude](https://github.com/jung-wan-kim/teamclaude) 포크를 권장합니다(`npm install -g github:jung-wan-kim/teamclaude`). npm 원본 [@karpeleslab/teamclaude](https://www.npmjs.com/package/@karpeleslab/teamclaude)(`npm install -g @karpeleslab/teamclaude`)도 동작합니다
- Claude Code
- `python3` (표준 라이브러리만 사용, 3.8+)

상태줄을 설치하기 전에 계정을 하나 이상 추가하세요:

```sh
teamclaude login       # 브라우저 OAuth
# 또는: teamclaude import
# 또는: teamclaude login --api
```

TeamClaude가 없거나 계정이 없으면 설치 스크립트는 Claude 설정을 건드리지 않고 중단합니다. 계정은 있는데 프록시가 꺼져 있으면 설치는 완료되고, 프록시를 시작하는 명령을 안내합니다.

`status --json`이 없는 teamclaude 빌드(예: [jung-wan-kim/teamclaude](https://github.com/jung-wan-kim/teamclaude) 포크)에서도 동작합니다: 상태줄과 번호 선택기는 실행 중인 프록시의 `/teamclaude/status` HTTP 엔드포인트로 폴백하고 필드 이름을 정규화합니다(`modelWeekly` → 모델별 7일 창, `enabled` → `disabled`). 선택 기능인 쿼터 프로브만 `probe` 명령이 있는 빌드를 필요로 합니다.

## 설치

```sh
curl -fsSL "https://raw.githubusercontent.com/cineraria01/teamproxy/main/statusline/install.sh?$(date +%s)" | bash
```

또는 클론해서:

```sh
git clone https://github.com/cineraria01/teamproxy
cd teamproxy/statusline && ./install.sh
```

설치 스크립트는:

1. TeamClaude 상태줄과 호환용 래퍼를 `~/.claude/`에 복사하고
2. 래퍼를 `~/.claude/settings.json`의 `statusLine`으로 등록합니다(먼저 `settings.json.bak`으로 백업). Orca 같은 기존 상태줄은 보존되어 TeamClaude 위에 함께 표시됩니다
3. 번호 계정 선택기를 설치하고 `~/.bashrc` 또는 `~/.zshrc`에서 불러오게 합니다(기존 alias·설정은 건드리지 않음)
4. 유휴 계정의 쿼터가 최신으로 유지되도록 `teamclaude probe 300`을 켭니다 — 프로브는 사용량 엔드포인트를 읽기만 하며 **쿼터를 소모하지 않습니다** (`NO_PROBE=1`로 생략 가능)

Claude Code를 재시작하면(또는 새 세션을 열면) 상태줄이 나타납니다.

## 번호로 계정 선택

계정 번호는 상태줄과 `teamclaude status`에 표시되는 위→아래 순서를 따릅니다:

```sh
claude       # 자동 로테이션
claude 1     # 새 세션을 1번 계정에 고정
claude 2 -c  # 2번 계정에 고정된 최근 세션 이어가기
```

선택기는 실행 시점에 실제 계정 목록을 읽으므로 이메일이 하드코딩되지 않습니다. `>`는 TeamClaude의 전역 자동 라우팅 포인터가 아니라 해당 Claude 세션에 고정된 번호를 따라갑니다. 실행 중인 Claude 세션은 계정을 바꿀 수 없으니, 원하는 번호로 세션을 새로 시작하거나 이어가세요.

## 재시작 없는 계정 전환 (라이브 리로드 패치)

npm 원본(`@karpeleslab/teamclaude`)은 headless 서버에 설정 변경을 반영할 방법이
재시작뿐입니다 — 리로드 로직은 있지만 TUI의 `R` 키에서만 닿습니다. 설치 스크립트가
그 배선만 뚫는 작은 패치를 함께 적용합니다 (새 로직 없음, 1.4.2 기준):

```sh
teamclaude switch 1                   # 1번 계정으로 지금 전환 — 돌고 있던 세션도 다음 요청부터 이동
teamclaude disable some@account.com   # → "Applied to the running server (no restart needed)"
teamclaude priority main@account.com 1  # 즉시 반영
teamclaude reload                     # 설정 파일을 직접 고친 뒤 수동 반영
```

`switch <번호|계정>`은 대상 계정을 활성 + 우선순위 1로 올리고 나머지는 자동
순서로 되돌린 뒤, 실행 중인 서버의 세션-계정 고정(affinity)까지 풀어 **이미 돌고
있던 Claude 세션도 다음 요청부터** 그 계정으로 옮긴다. 번호는 `teamclaude
accounts` 순서다. (계정이 바뀌면 프롬프트 캐시는 새로 쌓인다.)

- 적용 대상은 `@karpeleslab/teamclaude`뿐이며, 이미 리로드가 있는 빌드(포크 등)는
  자동으로 건너뜁니다. `NO_RELOAD_PATCH=1`로 끌 수 있습니다.
- 패치 파일은 `~/.claude/teamclaude-patches/`에 남습니다. `npm update -g`가
  패키지를 덮어쓰면 `~/.claude/teamclaude-patches/teamclaude-reload-patch.sh`
  한 번으로 재적용됩니다 (`--check` 적용 확인 · `--revert` 원복).
- 적용/원복 후 한 번만 `teamclaude restart`가 필요합니다.

## 자동 업데이트

자동 업데이트는 기본적으로 꺼져 있습니다. 켜면 상태줄 래퍼가 **하루에 한 번** 백그라운드에서
GitHub `main`의 최신 커밋을 확인하고, 설치본과 다를 때만 `install.sh`를 다시 실행합니다.

- 확인·설치는 상태줄 렌더와 완전히 분리된 백그라운드 프로세스라 표시 지연이 없고,
  실패(오프라인 등)는 조용히 넘어가 다음 날 다시 시도합니다.
- 기록은 `~/.claude/teamclaude-statusline-update.log`에 남습니다.
- 켜려면 `~/.claude/teamclaude-statusline-config.json`에 `"autoUpdate": true`를 추가하세요.

## 설정

스크립트가 읽는 환경변수:

| 변수 | 기본값 | 의미 |
|---|---|---|
| `TC_SL_CACHE_TTL` | `15` | `teamclaude status --json` 출력 캐시 시간(초) |
| `TC_SL_CACHE_FILE` | `$TMPDIR/tc-statusline-cache-$UID.json` | 캐시 파일 경로 |
| `TC_SL_BAR_WIDTH` | `12` | 쿼터 게이지 폭(문자 수, 최소 6) |
| `TC_SL_ROW_COLORS` | `36,32,33,35,34,91` | 계정 줄별 강조색(ANSI SGR 코드, 쉼표 구분·순환). 빈 값이면 단색(흐림) |
| `TC_SL_ROW_GAP` | `0` | `1`이면 대시보드 줄 사이에 빈 구분 줄 삽입(기본은 붙여서 표시, 줄 구분은 뒷배경색이 담당) |
| `TC_SL_ROW_BG` | `48;5;235,48;5;239` | 대시보드 줄 뒷배경색(ANSI SGR 코드, 쉼표 구분·순환, `-`는 그 칸 미적용). 빈 값이면 배경 없음. 256색 회색이면 게이지 빈 구간도 그 줄보다 3단계 밝은 회색으로 따라감 |
| `NO_COLOR` | 미설정 | ANSI 색상 비활성화 ([no-color.org](https://no-color.org)) |

설치 스크립트 전용 환경변수:

| 변수 | 기본값 | 의미 |
|---|---|---|
| `CLAUDE_DIR` | `~/.claude` | Claude Code 설정 디렉터리 |
| `TEAMCLAUDE_SHELL_RC` | Bash/Zsh rc 자동 감지 | 수정할 셸 rc 파일 |
| `NO_PROBE` | 미설정 | `1`이면 `teamclaude probe 300` 생략 |
| `NO_RELOAD_PATCH` | 미설정 | `1`이면 라이브 리로드 패치 생략 |

갱신 주기(유휴 상태에서도 기본 30초)는 `~/.claude/settings.json`의 `statusLine.refreshInterval` 필드에 있습니다.

## 제거

```sh
curl -fsSL "https://raw.githubusercontent.com/cineraria01/teamproxy/main/statusline/uninstall.sh?$(date +%s)" | bash
```

스크립트, 선택기 소스 블록, 자신이 등록한 `statusLine` 항목(여전히 이 스크립트를 가리키는 경우에만)을 제거합니다. 이전에 쓰던 상태줄은 복원되고, 기존 셸 alias·설정은 보존됩니다. 라이브 리로드 패치도 백업으로 원복합니다. 쿼터 프로브는 그대로 두며 `teamclaude probe off`로 끌 수 있습니다.

---

## English

Live per-account quota usage for the [teamclaude](https://github.com/jung-wan-kim/teamclaude) multi-account Claude proxy, right in your Claude Code status line.

```
Fable 5
     FLEET         x4      pooled  Ses [   7% 6m    ] Wk [ 11% 6h10m  ] Fbl [ 37% 6h10m  ]
  1. alice@exampl  Max 20x active  Ses [  0% 1h30m  ] Wk [ 14% 1d14h  ] Fbl [ 27% 1d14h  ]   D-8
> 2. bob@example.  Max 20x active  Ses [  27% 5m    ] Wk [  8% 6h10m  ] Fbl [ 15% 6h10m  ]  D-25
  3. carol@exampl  Max 20x active  Ses [  0% 3h40m  ] Wk [     -      ] Fbl [ 97% 2d16h  ]   D-9
```

A TUI-style dashboard mirroring the teamclaude TUI. The `FLEET` row pools the
enabled accounts the way the TUI does (average utilization per window, soonest
reset, `+N off` when disabled accounts were excluded). Each account row shows
its billing plan (`Max 20x` / `Pro`), a status column, three quota gauges —
`Ses` 5h session, `Wk` overall 7d, `Fbl` model 7d (Sonnet window when that is
all there is) — with `usage% reset-countdown` inside. The `End` gauge shows
the local date and `D-N`; a `~` prefix marks an estimated next billing date
from the monthly subscription anniversary, not a confirmed cancellation.
Explicit subscription end dates take precedence. Missing dates show `-`.
The gauge is red at 3 days or less, yellow at 7 or less, otherwise green.
In a color terminal the gauges are background-filled bars proportional to
usage (the brackets above are the `NO_COLOR` fallback); a gray `-` bar means
teamclaude did not report that window. Every glyph is ASCII so the columns
stay aligned in CJK terminals where ambiguous-width characters (`▶ × ⛔`)
occupy two cells; the one exception, the stale tag's `전`, is always two
cells wide and counted as such.

- `>` — the account currently serving your requests
- `!HH:MM` in the status column — the account is rate-limited until that time
- `off` — the account is excluded from rotation
- bar colors: green < 70% < yellow < 90% < red
- gray bars with `2h 전` at the end of the row — the proxy last refreshed
  that account's numbers that long ago (over 30 minutes; usage from other
  machines may be missing). The proxy re-measures idle accounts every 15
  minutes (`quotaMaxAgeMs`, 2026-11-10)
- `TC down` — the proxy isn't running; `teamclaude not installed` — the CLI is missing

### Requirements

- [teamclaude](https://github.com/jung-wan-kim/teamclaude) installed and running — recommended: the [jung-wan-kim/teamclaude](https://github.com/jung-wan-kim/teamclaude) fork with active warm-up and `restart` (`npm install -g github:jung-wan-kim/teamclaude`); the npm original [@karpeleslab/teamclaude](https://www.npmjs.com/package/@karpeleslab/teamclaude) (`npm install -g @karpeleslab/teamclaude`) also works
- Claude Code
- `python3` (stdlib only, 3.8+)

Add at least one account before installing the status line:

```sh
teamclaude login       # browser OAuth
# or: teamclaude import
# or: teamclaude login --api
```

The installer stops without changing Claude settings when TeamClaude is missing or has no accounts. If accounts exist but the proxy is stopped, installation succeeds and prints the command needed to start it.

teamclaude builds without `status --json` (e.g. the [jung-wan-kim/teamclaude](https://github.com/jung-wan-kim/teamclaude) fork) also work: the status line and the numbered selector fall back to the running proxy's `/teamclaude/status` HTTP endpoint and normalize its field names (`modelWeekly` → model 7d bucket, `enabled` → `disabled`). Only the optional quota probe requires a build with the `probe` command.

### Install

```sh
curl -fsSL "https://raw.githubusercontent.com/cineraria01/teamproxy/main/statusline/install.sh?$(date +%s)" | bash
```

Or from a clone:

```sh
git clone https://github.com/cineraria01/teamproxy
cd teamproxy/statusline && ./install.sh
```

The installer:

1. copies the TeamClaude status line and its small compatibility wrapper to `~/.claude/`
2. registers the wrapper as `statusLine` in `~/.claude/settings.json` (backing the file up to `settings.json.bak` first); an existing status line such as Orca is preserved and rendered before TeamClaude
3. installs the numbered account selector and sources it from `~/.bashrc` or `~/.zshrc` without removing existing aliases/settings
4. enables `teamclaude probe 300` so idle accounts' quota stays fresh — the probe only reads the usage endpoint and **does not spend quota** (skip with `NO_PROBE=1`)

Restart Claude Code (or start a new session) and the status line appears.

### Numbered account selection

Account numbers follow the top-to-bottom order shown in the status line and `teamclaude status`:

```sh
claude       # automatic rotation
claude 1     # pin a new session to account 1
claude 2 -c  # continue the latest session pinned to account 2
```

The selector resolves the live account list at launch time, so it contains no hardcoded emails. `>` follows the number pinned for that Claude session instead of TeamClaude's global automatic-route pointer. A running Claude session cannot change accounts in place; start or resume a session with the desired number.

### Account switching without a restart (live-reload patch)

The upstream npm package (`@karpeleslab/teamclaude`) can only apply config
changes to a headless server via a full restart — the reload logic exists, but
only the TUI "R" key reaches it. The installer applies a small patch that wires
it up (no new logic; written against 1.4.2):

```sh
teamclaude switch 1                     # switch to account 1 NOW — running sessions move too
teamclaude disable some@account.com     # → "Applied to the running server (no restart needed)"
teamclaude priority main@account.com 1  # instant
teamclaude reload                       # manual apply after editing the config file
```

`switch <number|name>` enables the target, gives it priority 1, returns every
other account to automatic ordering, and resets the running server's
session-account affinity so **already-running Claude sessions move over on
their next request**. Numbers follow the `teamclaude accounts` order. (Prompt
cache re-warms on the new account.)

- Only `@karpeleslab/teamclaude` is patched; builds that already have a reload
  (forks, or a future upstream) are skipped automatically. Opt out with
  `NO_RELOAD_PATCH=1`.
- Patch files stay in `~/.claude/teamclaude-patches/`. When `npm update -g`
  overwrites the package, re-run
  `~/.claude/teamclaude-patches/teamclaude-reload-patch.sh` once
  (`--check` to inspect, `--revert` to restore stock sources).
- One `teamclaude restart` is needed after apply/revert.

### Auto-update

Auto-update is disabled by default. When enabled, the status-line wrapper checks
the latest commit on GitHub `main` **once a day** in a detached background process
and re-runs `install.sh` only when it differs from the installed commit.
Failures (offline, rate limits) are silent and retried the next day; activity
is logged to `~/.claude/teamclaude-statusline-update.log`. Enable it by adding
`"autoUpdate": true` to `~/.claude/teamclaude-statusline-config.json`.

### Configuration

Environment variables read by the script:

| Variable | Default | Meaning |
|---|---|---|
| `TC_SL_CACHE_TTL` | `15` | seconds to cache `teamclaude status --json` output |
| `TC_SL_CACHE_FILE` | `$TMPDIR/tc-statusline-cache-$UID.json` | cache file path |
| `TC_SL_BAR_WIDTH` | `12` | width of each quota gauge in characters (min 6) |
| `TC_SL_ROW_COLORS` | `36,32,33,35,34,91` | per-account-row accent colors (comma-separated ANSI SGR codes, cycled). Empty = single-tone (dim) rows |
| `TC_SL_ROW_GAP` | `0` | `1` inserts a blank spacer row between dashboard rows (packed by default; the row backgrounds already separate them) |
| `TC_SL_ROW_BG` | `48;5;235,48;5;239` | dashboard row background colors (comma-separated ANSI SGR codes, cycled; `-` leaves that slot unpainted). Empty = no backgrounds. For 256-color grays the unfilled gauge track follows the row, three steps lighter |
| `NO_COLOR` | unset | disable ANSI colors ([no-color.org](https://no-color.org)) |

Installer-only environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `CLAUDE_DIR` | `~/.claude` | Claude Code config directory |
| `TEAMCLAUDE_SHELL_RC` | detected Bash/Zsh rc | shell rc file to update |
| `NO_PROBE` | unset | set to `1` to skip `teamclaude probe 300` |
| `NO_RELOAD_PATCH` | unset | set to `1` to skip the live-reload patch |

The refresh interval (default 30s even when idle) lives in the `statusLine.refreshInterval` field of `~/.claude/settings.json`.

### Uninstall

```sh
curl -fsSL "https://raw.githubusercontent.com/cineraria01/teamproxy/main/statusline/uninstall.sh?$(date +%s)" | bash
```

Removes the scripts, selector source block, and the `statusLine` entry it registered (only if it still points at this script). A previously configured status line is restored, and existing shell aliases/settings are preserved. The live-reload patch is reverted from its backup. The quota probe is left as-is; `teamclaude probe off` disables it.

## License

MIT
