<p align="center">
  <img src="docs/assets/teamcodex-hero.png" alt="여러 계정이 로컬 프록시 하나를 거쳐 CLI로 이어지는 그림" width="100%">
</p>

# teamproxy

Claude Code, Codex CLI, Antigravity CLI(`agy`), Grok Build CLI(`grok`), Cursor CLI(`cursor-agent`)를 각각 여러 계정 풀에 물리는 로컬 프록시 다섯 개다.
다섯 프록시는 한 저장소의 같은 코드로 돌고, 설정·포트·설치본·래퍼·서버는 풀마다 따로 둔다.
한 계정이 5시간·주간 한도에 가까워지면 다음 요청부터 다른 계정으로 넘긴다. CLI는 주소 하나에만 붙어 있으면 된다.

- 런타임 의존성 0(Node.js 18+ 내장 모듈만). 빌드 단계 없음.
- 다섯 명령 `teamclaude` · `teamcodex` · `teamagy` · `teamgrok` · `teamcursor`. 인자 없이 치면 CLI 아래에 계정별 사용량 하단 줄이 붙는다.
- 서버는 launchd(macOS)나 systemd(Linux)가 띄우고, tmux 안의 대시보드로 계정을 본다.

> 자기 구독 계정만 넣는다. 한 좌석을 여러 사람이 나눠 쓰는 용도는 지원하지 않는다.
> 한도를 늘리거나 우회하지 않는다. 이미 낸 한도를 버리지 않고 쓰게 할 뿐이다.

## 목차

- [teamproxy란](#teamproxy란)
- [빠른 시작](#빠른-시작)
- [명령 쓰는 법](#명령-쓰는-법)
- [하단 줄과 Claude 상태줄](#하단-줄과-claude-상태줄)
- [풀별 위치](#풀별-위치)
- [계정 관리](#계정-관리)
- [서버 운영](#서버-운영)
- [동작 요약](#동작-요약)
- [문서](#문서)
- [개발과 검사](#개발과-검사)
- [원본과의 관계와 라이선스](#원본과의-관계와-라이선스)

## teamproxy란

| 풀 | 붙는 CLI | 계정 | 업스트림 | 쿼터 창 |
|---|---|---|---|---|
| teamclaude | Claude Code | Claude Max/Pro OAuth, API 키, 장기 토큰(`claude setup-token`) | Anthropic API | 5h · 7d · Fable 주간 |
| teamcodex | Codex CLI | ChatGPT OAuth(Codex) | ChatGPT Codex 백엔드 | 5h · 7d |
| teamagy | Antigravity CLI(`agy`) | Google AI Pro/Ultra | Cloud Code(agy용) | Gemini 그룹 5h·주간, Claude/GPT 그룹(`3p`) 5h·주간 |
| teamgrok | Grok Build CLI(`grok`), 다른 로컬 클라이언트(Selvi 앱) | xAI SuperGrok(OIDC 기기 코드 로그인) | `cli-chat-proxy.grok.com` | `x-ratelimit` 요청·토큰 사용률(초기화 시각 없음) |
| teamcursor | Cursor CLI(`cursor-agent`) | Cursor(브라우저 로그인, 60일 세션 토큰) | `api2.cursor.sh`(API) · `agentn.global.api5.cursor.sh`(추론, h2c 양방향 스트림) | 결제 주기의 포함 사용량(표시만) |

진입점은 하나다. `src/index.js`가 명령을 나누고, `codex`·`agy`·`grok`·`cursor` 접두가 붙으면 그 풀로 돈다
(`node src/index.js codex …`, `node src/index.js agy …`, `node src/index.js grok …`, `node src/index.js cursor …`). `src/teamclaude.js`는 물려받은
`TEAMCLAUDE_PROVIDER`를 지운 뒤 `index.js`를 불러, 셸이나 launchd에 남은 값이 Claude 명령을 다른 풀로 끌고 가지 못하게 한다.
다섯 풀은 설정 파일·쿼터 상태·서버 상태 파일을 공유하지 않는다. agy·grok·cursor 풀은 `"provider"`가 자기 것이 아닌 설정을 읽지 않고,
다른 풀도 agy·grok·cursor 설정을 거부한다.

이 저장소에는 프록시 말고 두 가지가 더 있다.

- `src/hud/`: 하단 줄. `launcher.py`(CLI를 tmux 안에 띄우는 실행기), `statusline.py`(하단 줄),
  `codex_login.py`(Codex 브라우저 로그인). 프록시 설치본에 함께 들어간다.
- `statusline/`: Claude Code 상태줄과 계정 선택기(`claude` 셸 함수). `statusline/install.sh`가 `~/.claude`에 설치한다.
  npm 패키지에는 들어가지 않는다.

## 빠른 시작

설치 절차의 정본은 [`docs/install/INSTALL-ALL.md`](docs/install/INSTALL-ALL.md)다. 세 풀, 래퍼, 계정 로그인,
운영 설정값, launchd, 상태줄까지 순서대로 들어 있다. 앱(셀비 등)이 동의를 받은 뒤 설치하는 비대화형 모드는
[`docs/install/APP-INSTALL.md`](docs/install/APP-INSTALL.md)다. 새 머신의 Claude Code나 Codex에게 이렇게 시키면 된다.

> https://raw.githubusercontent.com/cineraria01/teamproxy/main/docs/install/INSTALL-ALL.md 를 읽고 그 절차를 순서대로 수행해. 업스트림 저장소에서는 절대 설치하지 마.

손으로 할 때의 흐름은 이렇다(세부는 INSTALL-ALL의 각 절).

```sh
brew install tmux node git python3        # macOS. node 20+, python 3.9+, claude·codex(·agy) CLI는 미리 설치
git clone https://github.com/cineraria01/teamproxy.git ~/src/teamproxy
cd ~/src/teamproxy
python3 scripts/install.py                # Codex 풀 설치본 + ~/.local/bin/teamcodex  (INSTALL-ALL §1)
# teamclaude·teamagy 래퍼                  (§1-2, §1-3)
# 계정 로그인                               (§2)
# 운영 설정값                               (§3)
# launchd + tmux로 상시 실행                (§4)
cd statusline && NO_PROBE=1 NO_RELOAD_PATCH=1 ./install.sh   # Claude 상태줄 (§5)
```

끝나면 확인한다.

```sh
teamclaude status; teamcodex status; teamagy status
teamclaude                                # Claude Code + 하단 줄
```

설치하지 말 것: 업스트림 `sangrokjung/teamclaude`·`jung-wan-kim/teamclaude`, npm `@karpeleslab/teamclaude`,
npm 레지스트리의 `teamcodex`. 이름은 같지만 이 포크의 수정이 없다. 다른 머신의 설정 파일(토큰 포함)도 복사해 오지 않는다.

## 명령 쓰는 법

다섯 래퍼는 첫 인자를 보고 같은 규칙으로 나눈다.

| 첫 인자 | 가는 곳 |
|---|---|
| 없음, 또는 `-`로 시작하는 옵션 | 그 CLI(Claude Code·Codex·agy·grok·cursor-agent)를 tmux 안에 띄우고 아래에 하단 줄을 붙인다. 옵션은 CLI에 그대로 넘긴다 |
| `--` | 뒤의 것은 CLI 하위 명령. 하단 줄 없이 실행한다 |
| 그 밖의 낱말(`server`, `status`, `accounts`, `login`, `import`, `enable`, `disable`, `priority`, `reload`, `run`, `env`, `remove` …)과 `-h`/`--help` | 프록시 명령 |

하단 줄 없이 바로 실행하는 경우: 인쇄 모드(`-p`/`--print`, agy는 `--prompt`도, grok은 `--single`·`--prompt-file`·`--prompt-json`도, cursor-agent는 `--list-models`도)와 `--version`, 터미널이 아닌 실행,
높이가 계정 수 + 12줄보다 낮은 창. 폭이 좁은 창은 하단 줄 오른쪽이 잘린다.
창을 닫으면 CLI 세션도 끝난다. `--keep-alive`를 주면 남고, `tmux -L <풀>-hud attach`로 다시 붙는다.
`--yolo`를 주면 승인 없이 실행한다. 세 명령 모두 같은 낱말이고, 실행기가 각 CLI의 플래그로 바꿔 넘긴다
(Claude Code·agy `--dangerously-skip-permissions`, Codex `--dangerously-bypass-approvals-and-sandbox`, grok `--always-approve`, cursor-agent는 자기 `--yolo`).
실행기는 `--effort`를 더하지 않는다. Claude Code 대화 세션의 추론 단계는 Claude Code 설정(`/effort`가 저장하는 `modelSettings.<모델>.effortLevel`)을 따르고, 그 세션만 다르게 하려면 `--effort max`처럼 직접 준다.

```sh
# Claude
teamclaude                          # Claude Code + 하단 줄
teamclaude -c                       # Claude Code 옵션은 그대로 넘어간다
teamclaude --yolo                   # 승인 없이(세 명령 공통)
teamclaude -p "이 저장소 요약"        # 인쇄 모드: 하단 줄 없이
teamclaude -- mcp list              # Claude Code 하위 명령
teamclaude status                   # 프록시 명령

# Codex
teamcodex                           # Codex + 하단 줄
teamcodex --keep-alive              # 창을 닫아도 유지 → tmux -L teamcodex-hud attach
teamcodex -- resume SESSION_ID      # 기존 대화 재개

# agy
teamagy                             # agy + 하단 줄
teamagy -p "Reply with exactly: OK" # 인쇄 모드
teamagy -- models                   # agy 하위 명령
eval "$(teamagy env)"               # 직접 띄운 agy를 프록시로(CLOUD_CODE_URL)

# grok
teamgrok                            # grok + 하단 줄
teamgrok -p "Reply with exactly: OK" # 인쇄 모드
teamgrok -- models                  # grok 하위 명령
eval "$(teamgrok env)"              # 직접 띄운 grok을 프록시로(GROK_CLI_CHAT_PROXY_BASE_URL)

# cursor-agent
teamcursor                          # cursor-agent + 하단 줄
teamcursor -p "Reply with exactly: OK" # 인쇄 모드
teamcursor -- models                # cursor-agent 하위 명령
eval "$(teamcursor env)"            # 직접 띄운 cursor-agent를 프록시로(CURSOR_API_ENDPOINT=http://localhost:<포트>)
```

프록시 명령 `run`은 서버가 없으면 띄운 뒤 CLI를 프록시에 물려 실행한다. `teamclaude run`은 `ANTHROPIC_BASE_URL`만 넣어
Claude Code를 구독 모드로 둔다. `teamcodex run`은 Codex에 프록시 provider 설정을 붙인다. `teamagy run`은 agy에
`CLOUD_CODE_URL`을 준다(agy는 한 번 로컬 로그인돼 있어야 한다). `teamgrok run`은 grok에
`GROK_CLI_CHAT_PROXY_BASE_URL=http://127.0.0.1:<포트>/v1`을 준다(grok도 한 번 로컬 로그인돼 있어야 한다, 어느 계정이든).
`teamcursor run`은 cursor-agent에 `CURSOR_API_ENDPOINT=http://localhost:<포트>`를 준다. 주소는 꼭 `localhost`여야 한다 —
IP로 주면 cursor-agent가 추론을 Cursor로 바로 보낸다(cursor-agent도 한 번 로컬 로그인돼 있어야 한다, 어느 계정이든).

### 에이전트·스크립트에서 Codex 쓰기

화면 없이 한 번 돌리고 결과만 받을 때는 `teamcodex run -- exec`를 쓴다. 평범한 `codex exec`는 프록시를 거치지 않는다.

```sh
teamcodex run -- -c model_reasoning_effort=high \
  exec --ignore-user-config -m MODEL -s read-only -C /path/to/git-repo -o out.md - < prompt.md
```

`-c` 설정은 반드시 `exec` 앞에 둔다. `exec` 뒤의 `-c`는 프록시 설정을 지워 401로 끝나고, 래퍼가 그 순서를 종료 코드 2로 막는다.
자세한 내용은 [HUD.md의 에이전트·스크립트 절](docs/install/HUD.md#에이전트스크립트에서-쓰기-teamcodex-run----exec).

## 하단 줄과 Claude 상태줄

하단 줄은 CLI 화면 아래 tmux 칸에서 자기 풀의 `GET /teamclaude/status`를 2초마다 읽어 계정 행을 그린다.
tmux 소켓은 풀마다 따로(`teamclaude-hud`·`teamcodex-hud`·`teamagy-hud`·`teamgrok-hud`·`teamcursor-hud`)라 평소 쓰는 tmux와 섞이지 않는다.
이 tmux 서버는 [`src/hud/tmux.conf`](src/hud/tmux.conf)로 뜬다. Esc는 지연 없이 CLI에 가고(실행 중인 턴 중단), 스크롤 기록은 5만 줄이다.
Shift+Enter는 그 CLI가 줄바꿈으로 읽는 키로 바꿔 보낸다(Claude Code·agy·grok은 Alt+Enter, Codex·cursor-agent는 Ctrl+J). 바깥 터미널이 Shift+Enter를
따로 보내야 한다. 마우스로 글자를 고를 때는 option(macOS)이나 shift를 누른 채 끈다.
계정이 둘 이상이면 맨 위에 FLEET(평균) 행이 붙는다.

| 풀 | 계정 행의 막대 |
|---|---|
| teamclaude | `Ses`(5h) · `Wk`(7d) · `Fbl`(Fable 주간) · `End`(다음 결제일 추정, 장기 토큰 계정은 `-`). Claude 상태줄이 그리는 표를 그대로 쓴다 |
| teamcodex | `5h` · `7d` · `End`, 맨 아래 `Cache last`(그 창의 최근 요청 캐시 비율) |
| teamagy | `5h` · `7d`(Gemini 그룹) · `3p`(Claude/GPT 그룹에서 더 찬 창) |
| teamgrok | `RL`(요청·토큰 중 더 찬 `x-ratelimit` 사용률), 플랜 칸은 구독 등급 |
| teamcursor | `Use`(이번 결제 주기 포함 사용량, 초기화 = 주기 끝), 플랜 칸은 요금제(`Ultra` 등) |

Codex 하단 줄:

```text
TeamCodex | 2 accounts | switch 98% | > selected, * busy
  FLEET      x2       avg   5h [    -     ] 7d [ 34% 5d5h ]
> 1.codex-1  pro      ready 5h [    -     ] 7d [ 69% 5d5h ] End [ 09/14 D-3  ]
  2.codex-2  pro      ready 5h [    -     ] 7d [ 0% 6d23h ] End [ 10/08 D-27 ]
Cache last: 98.9% | 148,864/150,566 in | new 1,702
```

agy 하단 줄:

```text
TeamAgy | 1 accounts | switch 98% | 5h 7d Gemini, 3p Claude/GPT | > selected, * busy
> 1.pro-1          -       ready      5h [   20% 10m   ] 7d [      -      ] 3p [   60% 1d0h  ]
```

읽는 법:

- 숫자는 사용률이고 잔여량이 아니다. 뒤의 시간은 그 창이 초기화될 때까지 남은 시간이다. `-`는 프록시가 아직 보고하지 않은 값이다.
- `>` 선택된 계정, `*`/`busy` 요청 처리 중. 상태는 `ready`·`off`(제외)·`wait`·`limit`·`error`.
- 컬러 터미널에서는 막대가 사용률만큼 초록·노랑·빨강으로 찬다.
- `End`는 날짜와 D-day. 3일 이하 빨강, 7일 이하 노랑.
- `FLEET avg`는 켜져 있고 오류가 없는 계정 중 측정된 값의 단순 평균이다.

표시 항목의 전체 의미, Codex `Cache last`·`End` 판정, OmO 연결은 [`docs/install/HUD.md`](docs/install/HUD.md)에 있다.

### Claude 상태줄과 `claude` 함수

`statusline/install.sh`는 `~/.claude`에 상태줄을 설치하고 `settings.json`의 `statusLine`에 등록한다.
셸 rc에는 계정 선택기인 `claude` 함수를 넣는다.

```sh
claude          # teamclaude와 같다: 하단 줄을 붙여 띄우고 계정은 자동 회전
claude 1        # 새 세션을 1번 계정에 고정
claude 2 -c     # 2번 계정에 고정해 최근 세션 이어 가기
```

번호는 상태줄과 `teamclaude status`의 위에서 아래 순서다. 하단 줄 안에서 돌 때 Claude 상태줄은 표를 숨기고
모델 줄만 보인다. 하단 줄 없이 돈 세션(인쇄 모드, 낮은 창 등)에서는 상태줄에 같은 계정 표가 나온다.

```text
Fable 5
     FLEET         x4      pooled  Ses [   7% 6m    ] Wk [ 11% 6h10m  ] Fbl [ 37% 6h10m  ]
  1. alice@exampl  Max 20x active  Ses [  0% 1h30m  ] Wk [ 14% 1d14h  ] Fbl [ 27% 1d14h  ]   D-8
> 2. bob@example.  Max 20x active  Ses [  27% 5m    ] Wk [  8% 6h10m  ] Fbl [ 15% 6h10m  ]  D-25
  3. carol@exampl  Max 20x active  Ses [  0% 3h40m  ] Wk [     -      ] Fbl [ 97% 2d16h  ]   D-9
```

설치 옵션, 자동 업데이트, 제거는 [`statusline/README.md`](statusline/README.md).

## 풀별 위치

| | teamclaude | teamcodex | teamagy | teamgrok | teamcursor |
|---|---|---|---|---|---|
| 포트 | 3456 | 3457 | 3458 | 3459 | 3460 |
| 설정 | `~/.config/teamclaude.json` | `~/.config/teamcodex.json` | `~/.config/teamagy.json` | `~/.config/teamgrok.json` | `~/.config/teamcursor.json` |
| 설치본 | `~/.local/share/teamclaude-global/lib/node_modules/teamcodex` | `~/.local/share/teamcodex-global/lib/node_modules/teamcodex` | `~/.local/share/teamagy-global/lib/node_modules/teamcodex` | `~/.local/share/teamgrok-global/lib/node_modules/teamcodex` | `~/.local/share/teamcursor-global/lib/node_modules/teamcodex` |
| 래퍼 | `~/.local/bin/teamclaude` | `~/.local/bin/teamcodex` | `~/.local/bin/teamagy` | `~/.local/bin/teamgrok` | `~/.local/bin/teamcursor` |
| 실행 | `src/teamclaude.js` | `src/index.js codex …` | `src/index.js agy …` | `src/index.js grok …` | `src/index.js cursor …` |
| 대시보드 | `tmux -L teamclaude attach -t proxy` | `tmux -L teamcodex attach -t proxy` | `tmux -L teamagy attach -t proxy` | `tmux -L teamgrok attach -t proxy` | `tmux -L teamcursor attach -t proxy` |
| 하단 줄 소켓 | `teamclaude-hud` | `teamcodex-hud` | `teamagy-hud` | `teamgrok-hud` | `teamcursor-hud` |
| launchd(INSTALL-ALL §4) | `com.local.teamclaude` | `com.local.teamcodex` | `com.local.teamagy` | `com.local.teamgrok` | `com.local.teamcursor` |

- 설치본을 풀마다 따로 두므로 한 풀을 갱신해도 다른 풀 코드는 그대로다. CLI는 자기 설치본에서 뜬 서버만 알아본다.
- 설정 파일 옆에 `<설정>.server.json`(supervisor pid·`workerPid`·포트)과 `<설정>.quota.json`(쿼터 스냅숏)이 생긴다.
- 설정 파일은 토큰이 들어 있어 `0600`으로 쓴다. git에 넣지 않는다.

## 계정 관리

다섯 풀이 같은 명령을 쓴다. 서버가 떠 있지 않아도 로그인·가져오기는 된다.

| 명령 | 하는 일 |
|---|---|
| `login [--name 이름]` | 브라우저 로그인으로 계정 추가. Claude는 OAuth, Codex는 임시 `CODEX_HOME`에서 공식 로그인, agy는 Google 로그인(agy 자체 로그인은 그대로), grok은 xAI 기기 코드 로그인(이름 기본값 `grok-1`, `grok-2` …), cursor는 Cursor 브라우저 로그인(cursor-agent 자체 로그인은 그대로, `cursor-1` …) |
| `login --api` | (Claude) API 키 계정 추가 |
| `import [--name 이름]` | 이미 로그인된 CLI에서 가져오기. Claude Code 자격 증명, `~/.codex/auth.json`, agy 키체인(`--file`로 JSON), grok `~/.grok/auth.json`(refresh 토큰을 grok과 나눠 쓰게 되니 `login`을 권함), cursor-agent 키체인(`--file`로 JSON, 토큰을 나눠 쓰고 갱신이 없으니 `login`을 권함) |
| `accounts [-v]` | 설정된 계정 목록. `-v`는 토큰 만료 시각까지 |
| `status` | 실행 중인 서버의 계정·쿼터·오류 |
| `disable <이름>` / `enable <이름>` | 회전에서 빼기·되돌리기. 진행 중 요청은 마저 끝난다 |
| `priority <이름> <n\|auto>` | 순서 고정(작을수록 먼저). `auto`는 자동 순서로 돌린다 |
| `reload` | 모든 유휴 계정의 사용량을 지금 다시 재고 status를 보인다(대시보드 `R`). agy는 쿼터 요약을, grok은 구독 등급을, cursor는 사용량과 요금제를 다시 읽는다 |
| `remove <이름>` | 계정 삭제 |
| `reauth <이름>` | (Claude·Codex) 기존 계정 재인증. 돌아온 계정 ID가 맞을 때만 토큰을 바꾼다 |
| `subscription …` | Claude `<이름> <disabled\|ok>`, Codex `cancel\|clear`(해지 예정 기록) |

`enable`·`disable`·`priority`·`login`·`reauth`는 살아 있는 서버에 바로 반영된다.

풀별로 알아 둘 것:

- Claude: 2026-10-07부터 장기 토큰(`claude setup-token`)으로 넣는다. `teamclaude login`의 refresh 토큰은 약 한 달 만에
  끊긴다. 장기 토큰은 회전하지 않아 여러 머신에 같은 값을 넣어도 된다. 절차는 INSTALL-ALL §2-1과
  `scripts/claude-setup-tokens-apply.mjs`.
- Codex: 머신마다 따로 로그인한다(refresh 토큰이 회전하고 재사용을 감지해 서로를 로그아웃시킨다).
  계정을 지울 때는 `scripts/codex-remove-account.mjs`가 설정에서 빼고 그 refresh 토큰을 폐기한다.
- agy: agy를 한 번 로컬 로그인해 둔다. 토큰 갱신에 쓰는 OAuth 클라이언트는 저장소에 없고, 설치된 `agy` 바이너리에서 찾아
  검증한 뒤 설정에 캐시한다. 계정을 지워도 Google 권한은 취소하지 않는다.
- grok: grok을 한 번 로컬 로그인해 둔다(어느 계정이든). OAuth 클라이언트는 grok의 공개 클라이언트(비밀값 없음)라 코드에 있고
  `grokOAuthClientId`로 바꿀 수 있다. 같은 xAI 사용자(`userId`)를 다시 로그인하면 그 계정을 갱신한다. 계정을 지워도 권한은 취소하지 않는다.
- cursor: cursor-agent를 한 번 로컬 로그인해 둔다(어느 계정이든). Cursor 토큰은 60일짜리 세션 토큰이고 갱신 수단이 없다
  (cursor-agent도 만료되면 다시 로그인한다). `teamcursor accounts`가 만료 시각을 보이고, 지나면 그 계정은 `refresh-failed`로
  빠지니 `teamcursor login --name <같은 이름>`으로 다시 로그인한다. 같은 Cursor 사용자(`userId`)는 그 자리에서 갱신된다.
- 공통: 같은 계정을 한 풀에 두 번 로그인하지 않는다. 일시 오류에 재로그인하지 말고, 재인증은 `reauth`로 한다.

## 서버 운영

INSTALL-ALL §4대로 설치하면 launchd가 `~/.local/bin/<풀>-tmux-server`를 띄우고, 그 스크립트가 tmux 세션 `proxy` 안에서
`<풀> server`를 돌린다. 서버가 죽으면 launchd가 다시 띄운다.

```sh
tmux -L teamclaude attach -t proxy          # 대시보드. Ctrl-b d로 분리
launchctl list | grep -E 'teamclaude|teamcodex|teamagy|teamgrok|teamcursor'
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3456/teamclaude/status
tmux -L teamclaude kill-session -t proxy    # 재시작(launchd가 다시 띄운다)
```

<p align="center">
  <img src="docs/assets/teamcodex-dashboard.png" alt="데모 계정 세 개가 보이는 프록시 대시보드" width="100%">
</p>

대시보드 키:

| 키 | 동작 |
|---|---|
| `↑`/`↓` | 계정 선택 |
| `s` | 선택한 계정으로 전환 |
| `e` | 선택한 계정 켜기·끄기 |
| `o` | 순서 바꾸기: `↑`/`↓` 이동, `a` 전체 자동 순서로, `c` 이 계정만 순서 해제 |
| `a` / `d` | 계정 추가 / 삭제(`DELETE <계정 이름>`을 쳐야 지워진다) |
| `r` | 인증 오류 계정 재인증(`재인증 필요 [r]` 표시 행) |
| `R` | 설정에서 계정을 다시 읽고 유휴 계정 사용량을 다시 잰다 |
| `q` | 서버 종료(launchd가 다시 띄운다) |

재시작할 때 주의:

- 재시작하면 그 프록시를 거치던 진행 중 요청이 끊기고, Codex 쪽은 실행 중인 teamcodex 화면 세션까지 죽는다.
  계정 설정만 바뀐 것이면 재시작하지 말고 위 명령이나 `R`로 반영한다.
- 설정 파일을 직접 고쳤으면 워커에 SIGHUP을 보내 무중단으로 다시 읽힌다. 워커 pid는 `<설정>.server.json`의 `workerPid`다.
- `<풀> restart`는 포그라운드로 서버를 띄우므로 launchd 운영에서는 쓰지 않는다. 프록시를 거치는 Claude Code 세션 안에서는
  자기 프록시의 `stop`·`restart`가 거부된다.

### 업데이트

포크 main의 최신판으로 올릴 때는 풀 명령 하나면 된다. 받기 → 로컬 수정 검사 → 요청 0 대기·drain → 백업 → 덮기 → 다시 띄우기 → 확인
순서로 하고, 확인이 실패하면 백업으로 되돌려 다시 띄운다. 맥(launchd + tmux)·Linux(systemd 사용자 서비스) 같은 명령이다.

```sh
teamclaude update --dry-run     # 할 일만 보기
teamclaude update               # 이 풀의 설치본
teamcodex update --all          # 이 기계의 설치본 모두
```

옵션(`--ref`·`--no-restart`·`--wait`·`--json`), 단계별 동작, 비상용 손 절차는
[INSTALL-ALL §8](docs/install/INSTALL-ALL.md#8-최신판으로-갱신--풀-update). 셀비 앱 모드 설치본(`~/.local/share/teamproxy-app`)은 앱이 갱신하므로 건드리지 않는다.

Linux는 launchd 대신 `python3 scripts/install.py --service`가 Codex 풀용 사용자 systemd 서비스(`teamcodex.service`)를 만든다.
나머지는 [`docs/install/HUD.md`](docs/install/HUD.md)와 [`docs/install/SETUP.md`](docs/install/SETUP.md)의 Linux 안내를 따른다.

`GET /teamclaude/status`는 토큰 없는 상태 JSON이다(계정 이름·ID는 로컬에서 프록시 키와 전용 헤더를 함께 보낼 때만 나온다).
`usableCount`가 0이면 배관 문제가 아니라 쿼터·구독 문제다. 재시작해도 바뀌지 않는다.
증상별 복구는 [`docs/runbooks/`](docs/runbooks/)에 있다.

## 동작 요약

근거와 세부는 [`CLAUDE.md`](CLAUDE.md)(아키텍처)와 [`docs/specs/`](docs/specs/)에 있다. 여기 적은 것은 그 요약이다.

**프로세스.** supervisor가 공개 포트를 잡고 요청을 버퍼링해 loopback 워커로 넘긴다. 워커가 응답 헤더 전에 죽으면
요청은 새 워커를 기다렸다가 다시 간다. 공개 리스너는 사라지지 않는다.

**계정 고르기.**
- 처음에는 아직 측정 안 된 계정부터 돌려 쿼터를 잰다. active warm-up이 마지막으로 받아들여진 요청 모양으로 1토큰 요청을 보내
  나머지 계정도 바로 잰다(Claude 풀 기본 켜짐).
- 그 뒤로는 use-or-lose다. `switchThreshold`(기본 0.98) 아래인 계정 중 주간 한도가 가장 빨리 초기화되는 계정을 먼저 쓴다.
  동률이면 세션 초기화가 빠른 쪽, 그다음 세션 사용률이 낮은 쪽이다. `priority`로 고정한 계정이 이보다 앞선다.
- 고른 계정은 프롬프트 캐시를 위해 붙어 있는다. 우선순위는 `reevalIntervalMs`(기본 5분)마다, 그리고 지금 계정을 못 쓰게 되면
  바로 다시 고른다. 같은 연결의 연속 요청은 같은 계정으로 간다(연결 친화).

**동시성.** 계정마다 동시 요청 상한(`maxConcurrentPerAccount`, 기본 3, agy·grok·cursor 8)이 있고, 모두 차면 대기열에서 최대 15초 기다린다.
상한은 순간 몰림 429를 막는 것이고 쿼터 소진 429는 아래 경로가 맡는다.

**429와 오류.**
- 계정 쿼터 소진: 그 계정을 `retry-after`(1초~5분)만큼 쉬게 하고 바로 다른 계정으로 보낸다. 모든 계정이 막히면 429를 돌려준다.
- 소진이 아닌 429: `rateLimitFailovers`만큼 다른 계정을 시도한다. `continuityMode`가 켜져 있으면 프록시 안에서 기다렸다 재시도한다
  (Claude 기본 꺼짐, Codex 기본 켜짐. INSTALL-ALL 운영값은 둘 다 끔).
- 401: 토큰을 강제로 갱신해 다시 시도하고, 그래도 거절되면 그 계정을 세운다. 같은 요청을 두 계정이 연달아 거절하면 요청 쪽 문제로 보고
  계정을 세우지 않는다(401 연쇄 방지).
- 네트워크 오류로 다른 계정에 다시 보내는 것은 `GET`·`HEAD`·`OPTIONS`뿐이다. 업스트림이 이미 받았을 수 있는 POST는 프록시 안에서
  다시 보내지 않고 재시도 가능한 오류로 돌려줘 클라이언트가 정하게 한다.
- `modelFallbacks`를 설정하면 풀 전체가 그 모델 한도에 막혔을 때 정해 둔 다음 모델로 바꿔 보낸다.

**스트림 복구(Claude 풀).** SSE는 완전한 이벤트 단위로만 전달해 클라이언트가 반쪽 JSON을 받지 않게 한다. 스트림이 끝 이벤트 없이
끊기면 재시도 가능한 `overloaded_error` 이벤트로 깔끔하게 끝내, 아직 본문이 나오기 전이면 Claude Code가 스스로 다시 요청한다.
워커가 응답 도중 죽어도 supervisor가 같은 방식으로 끝낸다. `streamRecovery: false`로 끈다.

**토큰과 상태 보존.** 5분 안에 만료될 OAuth 토큰은 요청 전에 갱신하고, 5분마다 유휴·비활성 계정 토큰도 돌려 refresh 체인이
끊기지 않게 한다. 계정별 쿼터와 warm-up 요청 모양은 1분마다와 종료 때 `<설정>.quota.json`에 남겨 재시작 뒤에 복원한다.
클라이언트의 `/v1/oauth/token` 요청은 손대지 않고 그대로 넘긴다.

**Codex 풀.**
- 사용량은 계정별 `wham/usage` 조회와 `x-codex-*` 응답 헤더로 잰다.
- usage 조회가 401/403을 연속 3번 받으면 갱신과 재조회로 확인한 뒤에야 계정을 세운다. 그 결과 풀이 비게 되면 세우지 않는다.
- 모든 계정이 알려진 초기화까지 막히면 Codex가 자체 "usage limit" 문구로 보여 주는 429 본문으로 바로 답한다.
- 무료 한도 초기화 크레딧 자동 사용은 `codexResetCredits: true`일 때만 한다.

**agy 풀.**
- 쿼터 헤더가 없어 계정별 쿼터 요약을 시작 때, 10분마다, 사용 뒤, 소진 429 직후에 읽는다.
- 요청 모델로 그룹을 정하고(`claude-*`·`gpt-*`는 `3p`, 나머지는 Gemini) 그 그룹이 막힌 계정만 피한다.
- agy는 계정별로 서버 쪽 상태를 가지므로 대화는 그 계정이 모델을 못 쓸 때까지 같은 계정에 남는다.

**grok 풀.** 명세 [`docs/specs/2026-10-15-grok-mode.md`](docs/specs/2026-10-15-grok-mode.md).
- 클라이언트의 `authorization`·`x-api-key`·`cookie`를 빼고 풀 계정 bearer를 넣는다. 로컬 로그인의 신원 헤더(`x-userid`·`x-grok-user-id`·
  `x-email`·`x-teamid`)가 있으면 고른 계정 것으로 바꾼다(없으면 더하지 않는다). 경로는 가리지 않고 그대로 넘긴다.
- grok이 아닌 클라이언트(Selvi 앱, curl)에 `x-grok-client-version`이 없으면 grok에서 마지막으로 본 값(없으면 `1.0.46`)을 채운다.
- 사용률은 응답의 `x-ratelimit-*` 헤더로만 잰다(조회 없음). 이 값으로 계정을 빼지는 않고, 추론 경로의 429만 그 계정을
  `retry-after`(초·HTTP 날짜, 없으면 5분)만큼 쉬게 하고 바로 다른 계정으로 보낸다. 남은 계정이 없으면 업스트림 429 본문을 그대로 준다.
- 세션(`x-grok-session-id`, `x-grok-conv-id`, `/v1/sessions/<id>`)은 그 계정이 못 쓸 때까지 같은 계정에 남는다.
- 범위 밖: 로그인 없는 실행, xAI API 키 모드(`api.x.ai`), 스트림 복구, 구독 결제·종량 한도, macOS 밖 키체인.

**cursor 풀.** 명세 [`docs/specs/2026-10-24-cursor-mode.md`](docs/specs/2026-10-24-cursor-mode.md).
- cursor-agent의 추론(`/agent.v1.AgentService/Run`)은 HTTP/2 평문(h2c) Connect 양방향 스트림이다. 공개 포트가 h2 머리말을 알아보고
  그 연결을 워커의 h2c 수신기로 그대로 넘기면, 워커가 스트림마다 계정 bearer를 넣어 `agentn.global.api5.cursor.sh`로 중계한다.
  양쪽 바이트는 손대지 않는다. 그 밖의 API 호출(HTTP/1.1)은 기존 경로로 `api2.cursor.sh`에 간다. h2 연결은 루프백에서만 받는다.
- 클라이언트의 `authorization`·`x-api-key`·`cookie`를 빼고 풀 계정 bearer를 넣는다. 계정에 묶인 다른 머리는 없다.
- 사용량은 계정별 `GetCurrentPeriodUsage`·`GetPlanInfo`를 시작 때, 10분마다, 추론 뒤(2분 넘게 묵었으면), `reload` 때 읽는다. 표시만 하고
  계정을 빼지는 않는다(Cursor는 포함 사용량을 넘어도 계속 쓴다).
- 응답 바이트가 클라이언트에 가기 전에 HTTP 429나 스트림 끝 오류 `resource_exhausted`가 오면 그 계정을 5분(또는 `retry-after`) 쉬게 하고
  받아 둔 요청 바이트를 다른 계정으로 다시 보낸다. `unauthenticated`(401)면 그 계정을 세우고 넘기되, 같은 요청을 두 계정이 거절하면 요청 쪽 문제로 보고 세운 것을 되돌린다. 한 요청이 소진으로 넘기는 횟수는 `rateLimitFailovers`(최소 1)까지다. 남은 계정이 없으면 업스트림 응답을
  그대로 준다. 실제 한도 소진 응답 모양은 아직 못 봤다(방어적 설계).
- 대화(`x-blob-encryption-key`, 대화마다 하나)는 그 계정이 못 쓸 때까지 같은 계정에 남는다.
- 범위 밖: API 키 모드(`--api-key`/`CURSOR_API_KEY`), Cursor 데스크톱 편집기, HTTP/1.1 에이전트 전송(`useHttp1ForAgent`)의 스트리밍(경로는 에이전트 상류로 넘기지만 다 받은 뒤 전달), 스트림 복구,
  종량 과금 한도 관리, 토큰 갱신.

**BYOK(선택).** `byok` 설정을 넣었을 때만 `/byok/v1/…` 경로로 외부 "자기 키" 클라이언트를 받는다. Claude Code가 쓰는 `/v1/…`
요청은 바이트 그대로다. 세부와 위험은 [원본 README 사본](docs/reference/upstream-README.md)의 BYOK 절.

설정 키 전체 목록은 [원본 README 사본의 Configuration 절](docs/reference/upstream-README.md#configuration),
이 포크의 운영값은 INSTALL-ALL §3.

## 문서

| 문서 | 내용 |
|---|---|
| [`docs/install/INSTALL-ALL.md`](docs/install/INSTALL-ALL.md) | 새 머신에 네 풀과 상태줄 전부 설치(정본) |
| [`docs/install/APP-INSTALL.md`](docs/install/APP-INSTALL.md) | 앱용 비대화형 설치(`install-app.mjs --app --json`, Node만 필요), 묶음, `proxy.host` |
| [`docs/install/HUD.md`](docs/install/HUD.md) | 하단 줄 상세, 에이전트용 `teamcodex run -- exec`, OmO 연결 |
| [`docs/install/SETUP.md`](docs/install/SETUP.md) | Codex 프록시 준비, Linux systemd, macOS 자동 시작 |
| [`statusline/README.md`](statusline/README.md) | Claude 상태줄과 계정 선택기 |
| [`docs/README.md`](docs/README.md) | 문서 목차(스펙·계획·런북·증거) |
| [`docs/runbooks/`](docs/runbooks/) | 증상별 진단과 복구 |
| [`docs/specs/`](docs/specs/) · [`docs/plans/`](docs/plans/) | 동작 변경마다 스펙과 구현 계획 |
| [`docs/reference/upstream-README.md`](docs/reference/upstream-README.md) | 원본 영문 README 사본(설정 키, Codex 세부, BYOK) |
| [`CLAUDE.md`](CLAUDE.md) | 아키텍처와 지켜야 할 제약 |

## 개발과 검사

```sh
node src/index.js <명령>                                # 빌드 없이 소스로 실행
TEAMCLAUDE_CONFIG=./config.json node src/index.js server  # 임시 설정으로(config.json은 gitignore)
npm test                                               # node --test, test/
npm run test:hud                                       # 하단 줄·상태줄 Python 검사(tmux 필요)
npm run lint                                           # eslint
```

지킬 것:

- 런타임 의존성 0. `dependencies`에 아무것도 넣지 않는다.
- ES 모듈, Node 18+. 새 전역(타이머, `crypto` 같은 Web API)을 쓰면 `eslint.config.js`의 `globals`에 더한다.
- 설정 파일은 서버, 대시보드, 외부 CLI가 함께 쓴다. 쓰기 전에 항상 디스크를 다시 읽고(`atomicConfigUpdate`),
  계정은 `accountUuid` 다음 `name`으로 맞춘다. 자세한 규칙은 `CLAUDE.md`.
- 문서 예시에 계정 주소, 토큰, 프록시 키를 넣지 않는다.

## 원본과의 관계와 라이선스

- 계보: [KarpelesLab/teamclaude](https://github.com/KarpelesLab/teamclaude)(npm `@karpeleslab/teamclaude`)
  → [jung-wan-kim/teamclaude](https://github.com/jung-wan-kim/teamclaude)
  → [sangrokjung/teamclaude](https://github.com/sangrokjung/teamclaude)(Codex 풀, 모델 폴백, 네트워크 복구)
  → 이 저장소 `cineraria01/teamproxy`.
- 2026-10-10 저장소 이름을 `cineraria01/teamclaude`에서 `cineraria01/teamproxy`로 바꿨다. 기본 브랜치는 `main`(옛 `qjc/resilient-routing`).
  같은 날 옛 `cineraria01/teamcodex`(하단 줄)와 `cineraria01/teamclaude-statusline`(Claude 상태줄)을 `src/hud/`·`statusline/`으로 합쳤다.
- npm 패키지 이름은 그대로 `teamcodex`다(bin `teamclaude` → `src/teamclaude.js`, `teamcodex` → `src/index.js`). 레지스트리에 올리지 않고
  이 저장소에서 설치한다.
- 오너 포크 전용이다. 원본 저장소에는 PR·이슈·푸시를 보내지 않는다.

라이선스는 MIT다. [`LICENSE`](LICENSE)는 원 저작권(KarpelesLab, Sangrok Jung) 표기를 그대로 유지한다.
`src/hud/`와 `statusline/`은 각 폴더의 `LICENSE`(MIT)를 따른다.
