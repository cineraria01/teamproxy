# teamclaude · teamcodex · teamagy · teamgrok 하단 줄

2026-10-10부터 프록시 포크 `cineraria01/teamproxy`의 `src/hud/`에 들어 있습니다(옛 `cineraria01/teamcodex`, 그 전 `tcodex` 저장소를 합침).
프록시 설치본마다 함께 들어가므로 따로 설치하지 않습니다. Claude Code 상태줄은 같은 포크의 [`statusline/`](../../statusline/README.md)입니다.

Codex CLI를 실행하면서 하단에 여러 계정의 사용률과 선택 상태를 보여주는 터미널 실행기입니다.
계정 전환은 외부 TeamCodex 프록시가 담당합니다. 하단에는 구독 기간 종료일과 D-day도 표시합니다.

![teamcodex terminal preview](../assets/terminal-preview.svg)

실제 터미널 캡처를 SVG로 옮긴 미리보기입니다. 작업 경로는 `~/project`로 치환했습니다.

Claude 상태줄([`statusline/`](../../statusline/README.md))의 표시 방식을
[TeamCodex](https://github.com/sangrokjung/teamclaude)용으로 옮긴 읽기 전용 상태줄입니다.

```text
TeamCodex | 2 accounts | switch 98% | > selected, * busy
  FLEET      x2       avg   5h [    -     ] 7d [ 34% 5d5h ]
> 1.codex-1  pro      ready 5h [    -     ] 7d [ 69% 5d5h ] End [ 09/14 D-3  ]
  2.codex-2  pro      ready 5h [    -     ] 7d [ 0% 6d23h ] End [ 10/08 D-27 ]
Cache last: 98.9% | 148,864/150,566 in | new 1,702
```

예시는 사용률이며 잔여량이 아닙니다. 시간은 쿼터 초기화까지 남은 시간입니다.
컬러 터미널에서는 사용률에 따라 막대가 초록·노랑·빨강으로 채워집니다.
계정 행은 Claude 상태바처럼 짙은 회색과 밝은 회색 배경을 번갈아 사용합니다.

`Cache last`는 해당 teamcodex 창의 가장 최근 요청에서 캐시로 읽은 입력 비율과
캐시/전체 입력 토큰, 비캐시 입력(`new`)을 표시합니다. 응답 사용량이 기록되면
2초마다 갱신하며, 요청 진행 중에는 직전 수치를 유지합니다. 구독 한도 절감률은 아닙니다.
해당 CLI 프로세스가 연 대화 로그만 읽으며 다른 창과 서브에이전트는 제외합니다.
대화 안에서 재로그인이나 별도 Codex 명령이 실행돼도 원래 대화의 사용량을 표시합니다.
첫 요청 전처럼 세션 로그나 사용량 기록이 아직 없으면 `waiting for usage`를 표시합니다.
대화를 하나로 식별할 수 없거나 로그 읽기·사용량 검증에 실패하면 `unavailable`을 표시합니다.
이 표시는 `lsof`와 `ps`가 필요하며, `statusline.py` 단독 실행에는 나타나지 않습니다.

### teamclaude (Claude 풀)

`teamclaude`와 `claude` 함수(계정 선택기)도 같은 실행기를 씁니다(래퍼가 `launcher.py --claude`로 부름, 2026-10-10).
인자 없이 또는 Claude 옵션만 주면 Claude Code 아래에 계정 줄이 붙습니다. 줄은 Claude Code 상태줄
(`~/.claude/statusline-teamclaude.py`, [`statusline/`](../../statusline/README.md))이 그리는 표 그대로이고 2초마다 갱신합니다.
하단 줄 안에서 뜬 Claude Code에는 `TEAMCLAUDE_HUD=1`이 붙어, Claude 안의 상태줄은 표를 숨기고 모델 줄만 보입니다.
인쇄 모드(`-p`·`--print`)·`--version`, 터미널이 아닌 실행은 하단 줄 없이 바로 가고, Claude 하위 명령은 `teamclaude -- mcp list`
(`claude mcp list`)처럼 하단 줄 없이 실행됩니다. `claude N`은 N번 계정에 고정하고 하단 줄에도 그 계정에 `>`가 붙습니다.
tmux 소켓은 `teamclaude-hud`입니다.

```text
     FLEET         x5      pooled  Ses    2% 9m     Wk   51% 4h9m   Fbl      -
> 2. lt-2                  active  Ses   10% 4h9m   Wk    60% 3d    Fbl      -       End       -
  1. lt-1                  active  Ses   0% 1h29m   Wk   0% 6d23h   Fbl      -       End       -
```

### 세 명령 공통 `--yolo`

`teamclaude --yolo`·`claude --yolo`·`teamcodex --yolo`·`teamagy --yolo`는 승인 없이 실행합니다(2026-10-10 사용자 요청 "--yolo 로 하자 3개모두").
실행기가 Claude Code·agy에는 `--dangerously-skip-permissions`, Codex에는 `--dangerously-bypass-approvals-and-sandbox`로 바꿔 넘깁니다.
`teamgrok --yolo`는 grok의 `--always-approve`가 됩니다(2026-10-15).
인쇄 모드(`teamagy --yolo -p …`)에도 적용됩니다. `--keep-alive`도 이제 인자 어디에 두어도 됩니다.

### Claude 대화 세션은 추론 max

`teamclaude`로 띄운 Claude Code 대화 세션에는 `--effort`가 없으면 실행기가 `--effort max`를 더합니다. settings.json `effortLevel`은 max를 저장하지 못하고 `CLAUDE_CODE_EFFORT_LEVEL`은 서브에이전트까지 덮어써서 실행기가 맡습니다. `--effort high` 같은 값을 주면 그대로 두며, 인쇄 모드와 `--` 하위 명령에는 더하지 않습니다.

### 세 하단 줄 공통 tmux 설정

하단 줄 tmux 서버는 [`src/hud/tmux.conf`](../../src/hud/tmux.conf)로 뜹니다(평소 tmux 설정과 무관). Esc가 바로 CLI에 가고
(`escape-time 0`), 스크롤 기록은 5만 줄입니다. Shift+Enter는 tmux가 CLI 쪽 방식 그대로 넘기지 못해 풀마다 그 CLI가 줄바꿈으로 읽는
키로 바꿔 보냅니다(Claude Code·agy·grok은 Alt+Enter, Codex는 Ctrl+J). 바깥 터미널이 Shift+Enter를 따로 보내야(확장 키) 동작합니다.
마우스로 글자를 고를 때는 option(macOS)이나 shift를 누른 채 끕니다.

### teamagy (Antigravity agy 풀)

`teamagy`도 같은 실행기를 씁니다(래퍼가 `launcher.py --agy`로 부름). 인자 없이 또는 agy 옵션만 주면 agy 화면 아래에
계정 줄이 붙습니다. 5h·7d 막대는 Gemini 그룹, `3p`는 Claude/GPT 그룹에서 더 찬 창(5h·주간 중)입니다.
agy에는 구독 종료일이 없어 `End` 칸과 `Cache last` 줄이 없습니다. 인쇄 모드(`-p`·`--print`·`--prompt`)와
터미널이 아닌 실행은 하단 줄 없이 `teamagy run -- …`으로 바로 넘어가고, agy 하위 명령은 `teamagy -- models`처럼
`--` 뒤에 두면 하단 줄 없이 실행됩니다. tmux 소켓은 `teamagy-hud`입니다.

```text
TeamAgy | 1 accounts | switch 98% | 5h 7d Gemini, 3p Claude/GPT | > selected, * busy
> 1.pro-1          -       ready      5h [   20% 10m   ] 7d [      -      ] 3p [   60% 1d0h  ]
```

### teamgrok (xAI Grok 풀, 2026-10-15)

`teamgrok`도 같은 실행기를 씁니다(래퍼가 `launcher.py --grok`로 부름). 막대는 하나(`RL`)로, 응답 헤더
`x-ratelimit-{limit,remaining}-{requests,tokens}`에서 요청·토큰 중 더 찬 쪽입니다(초기화 시각은 모름). 플랜 칸은 구독 등급
(`SuperGrokPro` 등)이고 `End` 칸은 없습니다. 인쇄·버전 옵션(`-p`·`--single`·`--prompt-file`·`--prompt-json`·`-v`·`--version`)과
하위 명령 `agent`·`models`·`version`, 터미널이 아닌 실행은 하단 줄 없이 `teamgrok run -- …`으로 바로 넘어갑니다.
탭 제목은 `Grok`, tmux 소켓은 `teamgrok-hud`입니다.

```text
TeamGrok | 1 accounts | switch 98% | RL rate limit | > selected, * busy
> 1.grok-1         SuperGr ready      RL [    1%       ]
```

## 사용

### OmO Native 연결

`omo-ai`와 두 프록시가 설치·로그인되어 있다면 다음 명령으로 연결합니다.

```sh
python3 scripts/configure_omo.py
omo
```

기본 모델은 `teamclaude/claude-opus-5-5`이며 `/model`에서 `teamcodex/gpt-6-astra`도
선택할 수 있습니다. 로그인·계정 전환은 기존 프록시가 관리합니다. OMO에는 계정 토큰을
복사하지 않고 요청할 때 프록시 설정의 접속 키를 읽습니다. 기존 OMO 로그인은 보존하며,
모델 선택 범위는 두 프록시로 제한하고 OMO 자체 모델 폴백은 끕니다.

설정은 `~/.omo/agent/models.json`과 `settings.json`에 적용하며 기존 파일은 백업합니다.
실행 중인 OMO는 재시작하세요. 기본 설치 경로는 Bun 전역 설치이며 다른 위치라면
`--senpi-dir /path/to/@code-yeongyu/senpi`를 지정합니다. Node.js와 Python 3가 필요합니다.

TeamClaude의 구독 인증 요청에는 일반 API 키 요청과 다른 헤더·시스템 메시지·도구 형식이
필요합니다. 스크립트의 `sk-ant-oat-teamclaude-proxy`는 Senpi의 OAuth 요청 형식을 선택하는
식별값이며 실제 토큰이 아닙니다. 실제 Authorization은 프록시 접속 키로 덮어씁니다.
이 호환 처리는 OmO 5.0.0 / Senpi 2026.9.26에서 검증했으며 엔진 업데이트 후 재검증이
필요합니다. TeamCodex는 `/codex` Responses 경로와 해당 요청 제약을 사용합니다.

### Codex CLI 설치

macOS의 기존 실행기와 Linux의 로그인·상시 서비스를 검증했습니다. Python 3.9 이상과 공식 Codex CLI가 필요하며, Codex 실행 화면에는 실행 중인 TeamCodex가 필요합니다.
설치기는 TeamCodex가 없으면 포크 `cineraria01/teamproxy`(브랜치 `main`)의 최신 커밋을 별도 경로에 함께 설치합니다. Node.js/npm과 Git이 필요하며, 하단 고정 실행에는 tmux도 필요합니다. 자세한 안내는 [설치 및 계정 등록](SETUP.md)을 참고하세요.

```sh
brew install tmux                 # macOS, 최초 한 번
git clone https://github.com/cineraria01/teamproxy.git
cd teamproxy
python3 scripts/install.py       # 없는 경우 TeamCodex(프록시 + 실행기) 설치
# Linux에서 프록시를 상시 실행하려면:
python3 scripts/install.py --service  # 사용자 systemd 서비스 + 로그인 종료 후 유지
teamcodex login --name codex-1
teamcodex login --name codex-2      # 추가할 계정마다 반복
python3 ~/.local/share/teamcodex-global/lib/node_modules/teamcodex/src/hud/statusline.py   # 현재 상태 한 번 표시(--watch: 2초마다, --agy: teamagy)
teamcodex                        # Codex와 계정 상태줄을 같은 화면에 표시
teamcodex -- resume SESSION_ID          # 지정한 기존 대화 재개
```

`teamcodex login`은 tmux나 실행 중인 프록시 없이 사용할 수 있습니다. 출력된 인증 링크를
브라우저에서 열고 로그인하세요. 다른 계정은 시크릿 창을 사용하면 편합니다.
원격 서버에서 마지막 `localhost` 페이지가 열리지 않으면 주소창의
`http://localhost:1455/auth/callback?...` 전체를 **로그인 중인 터미널에 붙여넣고 Enter**를 누릅니다.
입력은 화면에 표시되지 않으며, 현재 로그인과 일치하는 로컬 주소만 전달합니다.
주소를 다른 사람에게 전달하거나 채팅에 붙여넣을 필요가 없습니다. 로컬 브라우저가 직접
콜백에 연결하면 자동으로 완료되고, `Ctrl-C`는 로그인 프로세스까지 정리합니다.
`teamcodex login --device-auth`도 사용할 수 있습니다.

Linux의 `--service`는 `teamcodex.service`를 활성화하고 `Restart=always`로 재시작합니다.
설치 시 `loginctl enable-linger`가 거절되면 출력된 관리자 명령을 실행해야 로그아웃 뒤에도
유지됩니다. 상태는 `systemctl --user status teamcodex`, 로그는
`journalctl --user -u teamcodex -f`로 확인합니다. 서비스는 수동 `teamcodex server`와
동시에 실행하지 마세요. macOS 자동 시작은 [launchd 안내](SETUP.md#3-macos-로그인-시-자동-시작-선택)를 따릅니다.
자동 시작을 설정하지 않은 경우 별도 터미널에서 `teamcodex server`를 켜두세요.

`~/.local/bin`이 PATH에 있어야 합니다. 인자 없는 `teamcodex`는 현재 폴더에서 `teamcodex run`을
실행합니다. 실제 Codex 화면 아래에 tmux 패널을 배치하며, 기존 Codex·Claude 설정 파일을
수정하지 않습니다. 기본적으로 터미널을 닫거나 `Ctrl-b d`로 마지막 연결을 끊으면
해당 세션도 종료되며 진행 중인 작업은 중단됩니다. 저장된 대화는
`teamcodex -- resume SESSION_ID`로 재개할 수 있습니다.

창을 닫아도 작업을 계속 실행하려면 시작할 때 `--keep-alive`를 첫 인수로 지정하세요.
이 경우에만 `Ctrl-b d`로 분리한 뒤 다시 연결할 수 있습니다.

```sh
teamcodex --keep-alive               # 명시적으로 백그라운드 유지
tmux -L teamcodex-hud attach
```

Codex 인수는 그대로 전달됩니다. 예: `teamcodex -m MODEL`,
`teamcodex --dangerously-bypass-approvals-and-sandbox`. 마지막 옵션은 승인 확인과 샌드박스를
해제합니다. 실행기가 기본으로 추가하지 않으며, 생략 시 기존 Codex 설정을 따릅니다.

Codex를 종료하면 해당 tmux 세션도 종료됩니다. 기존 일반 tmux 세션은 별도 소켓으로
분리됩니다. 창 폭은 상관없습니다(좁으면 계정 줄의 오른쪽이 잘립니다). 높이가 계정 수 + 12행보다 낮으면
하단 줄 없이 CLI만 띄웁니다(2026-10-10, 예전에는 70열·12행 미만이면 실행을 거절했습니다).

### 명령은 `teamcodex` 하나 (2026-10-10)

예전의 `tcodex` 명령은 `teamcodex`로 합쳤습니다. 래퍼가 첫 인수를 보고 나눕니다.

- 인수 없음, Codex 옵션(`-`로 시작, `--keep-alive` 포함), 터미널에서 친 `login` → 상태줄 실행기
- 그 밖의 명령(`run`, `server`, `status`, `resume` …)과 `-h`/`--help` → 프록시
- Codex 하위 명령을 상태줄과 함께 쓰려면 `--` 뒤에 둡니다. 예: `teamcodex -- resume SESSION_ID`

설치기는 새로 만드는 래퍼에 이 분기를 넣고, 분기가 있으면 옛 `~/.local/bin/tcodex`·`teamcodex-statusline` 링크와
`~/.local/share/teamcodex-statusline` 사본을 지웁니다.
이미 쓰던 `teamcodex` 래퍼를 그대로 두는 경우에는 `exec` 줄보다 앞에 다음을 넣으세요(경로는 설치 위치).

```sh
LAUNCHER="$HOME/.local/share/teamcodex-global/lib/node_modules/teamcodex/src/hud/launcher.py"
case "${1-}" in
  -h|--help) ;;
  ''|-*) exec python3 "$LAUNCHER" "$@" ;;
  login) if [ -t 0 ]; then exec python3 "$LAUNCHER" "$@"; fi ;;
esac
```

`login`은 터미널에서 칠 때만 실행기로 갑니다. 실행기는 입력을 닫은 채 `teamcodex login`을
부르므로 다시 실행기로 돌아오지 않습니다.

### 에이전트·스크립트에서 쓰기 (`teamcodex run -- exec`)

화면 없이 한 번 실행하고 결과만 받는 경우(에이전트·스크립트)는 인자 없는 `teamcodex` 대신
`teamcodex run -- exec`를 씁니다. 평범한 `codex exec`는 프록시를 거치지 않아 401이 납니다.

```sh
teamcodex run -- -c model_reasoning_effort=high \
  exec --ignore-user-config -m gpt-6-astra -s read-only -C /path/to/git-repo -o out.md - < prompt.md
```

- **`-c` 설정은 반드시 `exec` 앞에 둡니다.** 추론 단계(`model_reasoning_effort`)나 MCP 서버처럼
  `-c`로 주는 설정이 모두 해당합니다.
  - TeamCodex는 요청을 프록시로 보내는 설정(`-c model_provider="teamcodex_proxy"` 등)을 사용자 인수
    맨 앞에 붙입니다.
  - `exec` 뒤에 `-c`를 하나라도 주면 Codex가 그 앞 설정을 버리고 로컬 로그인으로 직접 나갑니다.
    그러면 `Reconnecting... 5/5` 뒤에 `workspace routing discovery unauthorized (401)`로 끝납니다.
  - 래퍼(`teamcodex`)는 이 순서를 만나면 실행하지 않고 고칠 방법을 알려 줍니다(종료 코드 2).
  - 2026-10-07 실측: `exec … -c model_reasoning_effort=max`는 401로 실패했고,
    `run -- -c model_reasoning_effort=max exec …`는 정상 응답했습니다.
- `-c`가 없으면(추론 단계 기본값) 이 문제가 생기지 않습니다.
- `-C`에는 git 저장소를 줍니다. 저장소가 아니면 `--skip-git-repo-check`를 더합니다.
- 로그의 `Failed to refresh token … refresh token was already used`·`refresh_token_reused`는 로컬
  `~/.codex` 로그인 쪽 잡음입니다. 프록시가 풀 계정 토큰으로 바꿔 보내므로 응답에는 영향이 없고,
  `codex login`을 다시 할 필요도 없습니다.
- 모델 이름과 추론 단계 값은 모델 목록을 따릅니다. 예: `gpt-6.1-sol`, `gpt-6-astra`.
  추론 단계는 `low`·`medium`·`high`·`xhigh`·`ultra`·`max`입니다.

### Fast 모드 표시와 시작 기본값

`/fast`로 모드를 전환해도 입력창 아래에 상태가 보이지 않으면 Codex의
`tui.status_line` 목록에 `"fast-mode"`가 있는지 확인하세요. `/statusline`에서
해당 항목을 선택하거나, `~/.codex/config.toml`의 기존 `[tui]` 섹션을 수정합니다.
`CODEX_HOME`을 지정했다면 해당 디렉터리의 `config.toml`을 사용합니다.
기존 항목을 유지하면서 `"fast-mode"`만 추가하세요. 다음은 예시입니다.

```toml
[tui]
status_line = ["model-with-reasoning", "fast-mode", "git-branch", "context-remaining", "total-input-tokens", "total-output-tokens", "five-hour-limit", "weekly-limit"]
```

파일을 직접 수정했다면 `teamcodex`를 다시 실행하세요. Codex CLI 0.153.4에서
`gpt-6-astra medium · Fast on` 표시를 확인했습니다. 이 항목은 현재 모드 설정을
표시하며, 모드를 켜거나 서버의 실제 우선 처리를 검증하지 않습니다.
설치기는 개인 Codex 설정을 변경하지 않으므로 이 설정은 별도로 적용합니다.

Codex CLI 0.155.1에서는 인수 없는 `/fast`로 On/Off를 전환하며, 선택은 실행 중인
Codex가 사용하는 `config.toml`에 저장됩니다. 새 `teamcodex` 실행이 같은 설정 파일을 사용하면
Off도 유지됩니다. 파일에서 시작 기본값을 Off로 설정하려면 최상위 `service_tier`와
기존 `[features]`를 아래처럼 갱신하세요. 키나 섹션을 중복 추가하지 마세요.

```toml
service_tier = "default" # Fast off. 최상위: [tui] 등 다른 섹션보다 위

[features]
fast_mode = true
```

Fast on의 저장값은 `service_tier = "fast"`입니다. `fast_mode = true`는 Fast 선택 기능을
활성화하는 설정이므로, 이 값이 켜져 있어도 모드는 Off일 수 있습니다.

일반 터미널의 기본 경로는 `~/.codex/config.toml`입니다. Orca 등에서 `CODEX_HOME`을
지정한 실행은 별도 설정 파일을 사용하며 두 파일은 자동으로 동기화되지 않습니다.
Off로 바꿨는데 새 실행이 On이면, 모드를 바꾼 실행과 새 `teamcodex` 실행의 `CODEX_HOME`이
같은지 확인하고 새 실행이 읽는 설정의 `service_tier`를 확인하세요.

2026-09-20: Codex CLI 0.155.1에서 On → Off 전환 후 `default` 저장과 종료·재실행 시
Fast off 표시를 확인했습니다.

## 표시 의미

- `>`: 프록시가 선택한 계정. 해당 Codex 대화에 고정된 계정이라는 뜻은 아닙니다.
- `*` / `busy`: 현재 요청 처리 중. 여러 대화가 동시에 사용하면 여러 계정이 표시될 수 있습니다.
- `ready`, `off`, `wait`, `limit`, `error`: 사용 가능, 제외, 제한 대기, 쿼터/용량 제한, 인증 등 오류.
- `cool 8m`: 모델 용량 오류 뒤 냉각까지 남은 시간. 냉각 중인 계정에는 선택 표시 `>`를 붙이지 않습니다. `*`는 이미 진행 중인 요청이며 냉각 상태보다 우선하지 않습니다. `back`은 최근 정상 응답을 완료한 계정입니다.
- `End`: 프록시가 보고한 종료일을 우선하고, 없으면 같은 계정의 로컬 로그인 ID 토큰에 기록된 `chatgpt_subscription_active_until`을 표시합니다. OAuth 토큰 만료 시각은 쓰지 않습니다. 날짜는 현지 시간 기준이며 3일 이하 빨강·7일 이하 노랑·나머지 초록입니다. 시작일도 있으면 구독 기간 경과 비율만큼 막대를 채웁니다.
- 로그인 정보의 날짜는 실시간 결제 조회가 아닙니다. 토큰이 갱신돼도 이전 구독 날짜가 남을 수 있으므로, 그 날짜가 지나면 `check date`(현재 종료일 확인 필요)를 표시합니다. 기록된 해지 종료일이 지났을 때는 `past`, 날짜가 없으면 `-`입니다. 이 표시만으로 계정 사용 가능 여부를 판정하지 않습니다.
- `check date`가 나오면 `teamcodex reauth <계정 이름>`으로 재로그인할 수 있습니다. 새 로그인 정보의 구독 날짜는 다음 화면 갱신 때 반영됩니다. 매달 갱신일을 별도로 자동 조회하는 기능은 아닙니다.
- `subscription cancel --ends-on`으로 기록한 종료일은 마지막 사용 가능 날짜로 표시합니다. 내부에 저장된 다음 날 자정을 종료 날짜로 표시하지 않습니다.
- `5h`, `7d`: 프록시가 보고하는 세션·주간 사용률과 리셋 시간. 미보고 값은 `-`입니다.
- `FLEET avg`: 활성화되고 오류가 없는 계정 중 측정된 값의 단순 평균. 요금제별 용량 가중 합계가 아닙니다.
- 주간 리셋 순으로 표시하되 원래 계정 번호는 유지합니다. 상태줄은 실제 라우팅 순서를 변경하지 않습니다.

Codex가 제공하지 않는 Fable 쿼터는 표시하지 않습니다. 사용량 값은 TeamCodex의
관측 주기에 따르며, 화면의 2초 갱신이 OpenAI 쿼터를 새로 조회한다는 뜻은 아닙니다.
응답 오류 시 오래된 값을 현재 상태처럼 표시하지 않습니다.

## 연결 범위

Codex CLI의 기본 `tui.status_line`은 내장 항목만 지원합니다. 이 프로젝트는 공식 CLI를
수정하지 않고 하단 패널로 표시합니다. Orca의 그래픽 채팅 화면에 직접 삽입하는 기능은
없으며, Orca 안의 터미널에서는 `teamcodex`로 사용할 수 있습니다.

`~/.config/teamcodex.json`의 로컬 프록시 포트와 프록시 인증키를 읽고
`/teamclaude/status`를 조회합니다. 구독 날짜는 동일 설정 파일의 ID 토큰을 로컬에서
해석해 표시용 메타데이터만 사용합니다. OAuth 토큰은 전송하지 않으며 별도 캐시도 저장하지
않습니다. 환경 HTTP 프록시와 HTTP 리다이렉트를 사용하지 않습니다.

## 검증 / 제거

두 계정 사이에서 같은 CLI 프로세스의 대화가 유지되는 것을 수동 계정 제외로 확인했습니다.
실제 한도를 소진한 시험은 아니며, 429 자동 전환은 검증한 upstream의 모의 서버 테스트 범위입니다.
계정 전환 후 모든 도구 호출의 중복 실행 방지까지 보장하는 것은 아닙니다.
아래 검사는 계정 로그인이나 모델 호출 없이 렌더링, 로컬 HTTP 인증, 리다이렉트 거부,
설치 재실행 및 기존 명령 보존을 확인합니다.

```sh
npm run test:hud                  # test/hud/*.py + statusline/ 검사. test_lifecycle.py는 tmux 필요
```

기존 TeamCodex가 있으면 그대로 사용합니다(래퍼에 실행기 분기가 없으면 위 블록을 넣으라고 안내합니다).

실행기는 프록시 설치본 안(`…/node_modules/teamcodex/src/hud/`)에 있어 따로 지울 것이 없습니다.
TeamCodex 서버와 계정 설정은 별개입니다. Linux 자동 시작을 제거하려면 먼저
`systemctl --user disable --now teamcodex`를 실행하고 자신이 설치한
`~/.config/systemd/user/teamcodex.service`를 제거한 뒤 `systemctl --user daemon-reload`를 실행합니다. 설치 테스트는 `TEAMCODEX_HUD_PREFIX`로
별도 경로를 지정할 수 있습니다.

MIT([`src/hud/LICENSE`](../../src/hud/LICENSE)). 막대 표시 방식과 FLEET 설계는 Claude 상태줄(`statusline/`)에서 가져왔습니다.
