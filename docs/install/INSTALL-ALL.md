# teamclaude · teamcodex · teamagy · teamgrok · 상태라인 2종 — 새 머신 설치 프롬프트

새 머신의 Claude Code(또는 Codex)에 이 문서 전체를 붙여 넣거나, 한 줄로 이렇게 시킨다:

> https://raw.githubusercontent.com/cineraria01/teamproxy/main/docs/install/INSTALL-ALL.md 를 읽고 그 절차를 순서대로 수행해. 업스트림 저장소에서는 절대 설치하지 마.

---

당신은 이 머신에 Claude·Codex·Antigravity(agy) 다계정 프록시와 상태라인 두 개를 설치한다(teamagy·teamgrok은 선택). **모든 소스는
GitHub `cineraria01` 계정의 포크에서만 가져온다.** `sangrokjung/teamclaude`,
`jung-wan-kim/teamclaude`, npm의 `@karpeleslab/teamclaude`는 **절대 설치하지 말 것**
(같은 이름의 원본이지만 우리 수정이 없다). 다른 머신의 `~/.config/teamclaude.json`·
`teamcodex.json`·`teamagy.json`(토큰 포함)을 복사해 오지 말고 이 머신에서 새로 로그인한다.

구성요소 셋과 출처(모두 `cineraria01/teamproxy` 포크 하나에 있다. 2026-10-10 저장소 이름을 `teamclaude`에서 `teamproxy`로 바꿨다):

| 구성요소 | 저장소 | 설치 위치 |
|---|---|---|
| 프록시 본체(Claude :3456 · Codex :3457 · agy :3458, 세 프록시가 같은 코드) | `cineraria01/teamproxy` 브랜치 `main`의 최신 커밋(설치기가 브랜치 tip을 받는다) | 프록시마다 따로: `~/.local/share/{teamcodex,teamclaude,teamagy}-global/lib/node_modules/teamcodex` |
| Codex·agy 실행기 + 하단 줄(`src/hud/`), 프록시 설치기(`scripts/install.py`) | 같은 포크(2026-10-10 옛 `cineraria01/teamcodex`를 합침) | 프록시 설치본 안 `…/node_modules/teamcodex/src/hud` |
| Claude 상태라인 + 계정 선택기(`statusline/`) | 같은 포크(2026-10-10 옛 `cineraria01/teamclaude-statusline`을 합침) | `~/.claude/statusline-*.py`, `~/.claude/teamclaude-selector.sh` |

## 0. 전제 조건 확인

macOS 기준(Homebrew). Linux면 §4의 launchd 대신 `python3 scripts/install.py --service`(systemd)와
`docs/install/HUD.md`의 Linux 절을 따른다.

```sh
brew install tmux node git python3   # 없는 것만
node -v; npm -v; git --version; tmux -V; python3 --version   # node 20+, python 3.9+
command -v claude; command -v codex   # Claude Code·Codex CLI가 먼저 설치돼 있어야 한다
command -v agy                        # teamagy를 쓸 때만: Antigravity CLI, agy에서 한 번 로그인해 둔다
ls ~/.grok/bin/grok                   # teamgrok을 쓸 때만: Grok Build CLI, grok에서 한 번 로그인해 둔다
echo "$PATH" | tr ':' '\n' | grep -x "$HOME/.local/bin" || echo 'PATH에 ~/.local/bin 추가 필요'
```

`~/.local/bin`이 PATH에 없으면 셸 rc에 `export PATH="$HOME/.local/bin:$PATH"`를 추가하고
새 셸을 연다.

## 1. 프록시 본체 + Codex 실행기 설치 (포크의 scripts/install.py)

```sh
mkdir -p ~/src && cd ~/src
git clone https://github.com/cineraria01/teamproxy.git
cd teamproxy
grep -n 'UPSTREAM' scripts/install_teamcodex.py   # cineraria01/teamproxy.git#main 인지 확인
python3 scripts/install.py
```

이 한 번으로 생기는 것:
- `~/.local/share/teamcodex-global/…/teamcodex` — 포크 소스(npm 글로벌, 브랜치 tip)
- `~/.local/bin/teamcodex` — Codex 풀 래퍼(`TEAMCLAUDE_CONFIG=~/.config/teamcodex.json`).
  인자 없이 또는 Codex 옵션만 주면 상태줄 붙은 Codex(설치본 안 `src/hud/launcher.py`)를 띄운다

세 래퍼(§1·§1-2·§1-3)는 같은 규칙을 따른다. 인자 없음이나 `-`로 시작하는 옵션은 CLI를 띄우고
(Claude Code·Codex·agy), CLI 하위 명령은 `--` 뒤에 둔다(`teamclaude -- mcp list`). `status`·`login`
같은 명령은 프록시로 가고, 서버는 §4의 launchd가 `… server`로 띄운다.

프록시마다 설치 폴더를 따로 둔다. 그래야 한쪽을 업데이트해도 다른 쪽 코드가 바뀌지 않는다.
CLI는 자기 설치 폴더에서 뜬 서버만 알아본다. 래퍼의 경로를 바꾸면 그 프록시를 재시작한다.

이미 `teamcodex` 명령이 PATH에 있으면 installer가 그것을 그대로 쓰고 설치를 건너뛴다
(`Using existing TeamCodex`). 그 경우 그것이 원본인지 확인하고 지운 뒤 다시 돌린다.

### 1-1. Codex 실행 옵션

포크에 기존 로컬 패치 05가 반영되어 별도 패치가 필요 없다.
추론 요청은 `model_providers.teamcodex_proxy.base_url`로 보내고,
`chatgpt_base_url`은 덮어쓰지 않아 Codex의 ChatGPT 부가 기능 주소를 유지한다.

### 1-2. Claude 풀 래퍼 `~/.local/bin/teamclaude` 만들기

포크 `package.json`의 `bin.teamclaude`(`src/teamclaude.js`)를 자기 설치 폴더·설정 파일로 띄우는 래퍼다.

```sh
rsync -a ~/.local/share/teamcodex-global/ ~/.local/share/teamclaude-global/
cat > ~/.local/bin/teamclaude <<EOF
#!/bin/sh
# Claude pool (:3456). Own install (~/.local/share/teamclaude-global), cineraria01/teamproxy fork.
PKG=\$HOME/.local/share/teamclaude-global/lib/node_modules/teamcodex
# No args or Claude flags open Claude Code with the account footer (src/hud/launcher.py --claude runs teamclaude run -- …;
# -p and non-terminal runs skip the footer). A Claude subcommand goes after -- and runs without it.
case "\${1-}" in
  -h|--help) ;;
  --) shift; set -- run -- "\$@" ;;
  ''|-*) exec python3 "\$PKG/src/hud/launcher.py" --claude "\$@" ;;
esac
exec env TEAMCLAUDE_CONFIG=\$HOME/.config/teamclaude.json $(command -v node) "\$PKG/src/teamclaude.js" "\$@"
EOF
chmod 755 ~/.local/bin/teamclaude
teamclaude --help | head -3
```

### 1-3. agy 풀 래퍼 `~/.local/bin/teamagy` 만들기 (선택)

Antigravity CLI(`agy`) 계정 풀이다. Gemini CLI는 개인 계정을 더 받지 않아 agy를 쓴다.
agy에서 한 번 로그인해 두어야 한다(프록시가 요청의 인증을 풀 계정 것으로 바꾼다).
설정 경로와 `agy` 접두를 함께 고정해 Claude·Codex 설정을 건드리지 않게 한다.

```sh
rsync -a ~/.local/share/teamcodex-global/ ~/.local/share/teamagy-global/
cat > ~/.local/bin/teamagy <<EOF
#!/bin/sh
# Antigravity (agy) pool (:3458). Own install (~/.local/share/teamagy-global), cineraria01/teamproxy fork.
if [ "\${1-}" = agy ]; then shift; fi
PKG=\$HOME/.local/share/teamagy-global/lib/node_modules/teamcodex
# No args or agy flags open agy with the account footer (src/hud/launcher.py --agy runs teamagy run -- …;
# print mode and non-terminal runs skip the footer). An agy subcommand goes after -- and runs without it.
case "\${1-}" in
  -h|--help) ;;
  --) shift; set -- run -- "\$@" ;;
  ''|-*) exec python3 "\$PKG/src/hud/launcher.py" --agy "\$@" ;;
esac
exec env -u TEAMCLAUDE_SESSION_SUPERVISED TEAMCLAUDE_PROVIDER=agy TEAMCLAUDE_CONFIG=\$HOME/.config/teamagy.json TEAMAGY_AGY_BIN=$(command -v agy) $(command -v node) "\$PKG/src/index.js" agy "\$@"
EOF
chmod 755 ~/.local/bin/teamagy
teamagy --help | head -3
```

### 1-4. grok 풀 래퍼 `~/.local/bin/teamgrok` 만들기 (선택)

xAI Grok Build CLI(`grok`)의 SuperGrok 계정 풀이다(:3459). grok에서 한 번 로그인해 두어야 한다(어느 계정이든;
프록시가 요청의 인증과 신원 헤더를 풀 계정 것으로 바꾼다). Selvi 앱 같은 다른 클라이언트도 이 풀을 쓸 수 있다.

```sh
rsync -a ~/.local/share/teamcodex-global/ ~/.local/share/teamgrok-global/
cat > ~/.local/bin/teamgrok <<EOF
#!/bin/sh
# Grok pool (:3459). Own install (~/.local/share/teamgrok-global), cineraria01/teamproxy fork.
if [ "\${1-}" = grok ]; then shift; fi
PKG=\$HOME/.local/share/teamgrok-global/lib/node_modules/teamcodex
# No args or grok flags open grok with the account footer (src/hud/launcher.py --grok runs teamgrok run -- …;
# print mode and non-terminal runs skip the footer). A grok subcommand goes after -- and runs without it.
case "\${1-}" in
  -h|--help) ;;
  --) shift; set -- run -- "\$@" ;;
  ''|-*) exec python3 "\$PKG/src/hud/launcher.py" --grok "\$@" ;;
esac
exec env -u TEAMCLAUDE_SESSION_SUPERVISED TEAMCLAUDE_PROVIDER=grok TEAMCLAUDE_CONFIG=\$HOME/.config/teamgrok.json TEAMGROK_GROK_BIN=\$HOME/.grok/bin/grok GROK_DISABLE_AUTOUPDATER=1 $(command -v node) "\$PKG/src/index.js" grok "\$@"
EOF
chmod 755 ~/.local/bin/teamgrok
teamgrok --help | head -3
```

## 2. 계정 로그인

각 계정을 **도구당 한 번만** 로그인한다(재로그인은 세션을 하나씩 누적시키므로 일시 오류에
재로그인하지 말 것). 서버가 떠 있지 않아도 로그인은 된다.

```sh
teamcodex login --name codex-1      # Codex 계정마다 반복, 이름은 codex-1, codex-2 …
teamcodex accounts
teamagy import --name pro-1         # (teamagy) agy에 로그인된 계정을 가져온다
teamagy login --name pro-2          # (teamagy) 다른 계정은 브라우저 로그인, agy 로그인은 그대로
teamagy accounts
teamgrok login --name grok-1        # (teamgrok) 브라우저에서 기기 코드를 확인해 xAI 로그인, grok 로그인은 그대로
teamgrok accounts
```

teamagy의 OAuth 클라이언트 비밀값은 저장소에 없다. 처음 가져올 때 agy 바이너리에서 찾아
`~/.config/teamagy.json`에 캐시한다.

### 2-1. Claude 계정은 장기 토큰(`claude setup-token`)으로 넣는다 (2026-10-07부터)

`teamclaude login`(refresh 방식)은 **약 한 달 만에** `invalid_grant: Refresh token expired`로 끊긴다
(2026-10-03~05에 서버 쪽 5계정이 차례로 끊겨 4일간 무음 장애). 그래서 Claude 계정은 갱신이 없는
장기 토큰으로 넣는다. 토큰은 회전하지 않으므로 **같은 토큰을 모든 머신에 넣어도 서로 끊지 않는다**
(refresh 토큰과 반대 — Codex는 여전히 머신마다 따로 로그인, 아래 "하지 말 것").

1. 발급(계정마다, Claude Code 세션 밖의 일반 터미널에서 — `claude`가 teamclaude 래퍼 함수라 원본 경로로):
   ```sh
   env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_API_KEY ~/.local/bin/claude setup-token
   ```
   브라우저에서 그 계정으로 승인 → 출력된 `sk-ant-oat01-…`를 복사.
2. **길이 확인 — 108자여야 한다.** 터미널 줄바꿈에서 끝 글자가 빠져 107자 무효 토큰이 실제로 두 번 나왔다:
   ```sh
   pbpaste | tr -d '[:space:]' | wc -c     # 108
   ```
   유효성은 `curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer <토큰>" https://api.anthropic.com/api/oauth/profile`
   → **403이면 정상**(조회 권한이 없을 뿐), 401이면 무효.
3. 넣기: 토큰을 JSON으로 표준 입력에 넣어 `scripts/claude-setup-tokens-apply.mjs`로 계정 목록을 통째로
   교체한다(이름 `lt-1`~`lt-N`, 토큰을 명령 인자·출력에 남기지 않는다). 사용법은 스크립트 머리 주석.
4. 실행 중 서버에 반영: 포크 설치본은 `~/.config/teamclaude.server.json`의 `workerPid`에 `kill -HUP`
   (무중단). 서비스 재시작도 된다.

알아 둘 제약:
- 장기 토큰은 inference 권한만 있다 — `/api/oauth/profile`·`/api/oauth/usage`가 403이라 계정 이메일을
  알 수 없고(토큰 ↔ 계정 대응은 발급 순서로 직접 기록), 상태라인 `Fbl` 칸은 그 계정으로 Fable 요청이 지나가기
  전까지 비며, 상태라인 정렬은 주간 리셋으로 대신한다(옛 teamclaude-statusline 1760d33). 프록시의 계정 선택은
  원래 주간 리셋 기준이라 영향이 없고, 사용량 조회 실패는 계정을 격리하지 않는다(로그만 남는다).
- 실제 만료일은 표시되지 않는다(약 1년). 발급일을 기록해 11개월쯤 미리 교체한다.
- ⚠ 이 환경의 `teamclaude import|disable|remove`는 설정을 쓴 뒤 서버 재적재 단계에서 멈출 수 있다
  (설정은 이미 써짐) — 그때는 위 SIGHUP으로 반영한다. `teamclaude reload`는 사용량을 다시 재는 명령이라 설정 재적재 대신 쓸 수 없다.

### 2-2. 계정 제거 (Codex)

`scripts/codex-remove-account.mjs`가 설정에서 계정을 지우고 그 머신의 refresh 토큰을 OpenAI에서
폐기한다(`revokeCodexRefreshToken` — 포크 설치본에만 있다. 없으면 구판이니 §1로 갱신). 반영은 Codex 풀
워커(`~/.config/teamcodex.server.json`의 `workerPid`)에 `kill -HUP`.

원격 머신이라 브라우저가 못 열리면 출력된 인증 URL을 로컬 브라우저에서 열고, 마지막
`http://localhost:…/auth/callback?...` 전체 주소를 로그인 중인 터미널에 붙여 넣는다.

## 3. 프록시 설정값 (우리 운영값)

로그인이 설정 파일을 만든 뒤에 아래 키를 덧붙인다. 토큰이 든 파일이므로 git에 넣지 말 것.

```sh
python3 - <<'PY'
import json, os
def patch(path, updates):
    p = os.path.expanduser(path); d = json.load(open(p))
    d.update(updates); json.dump(d, open(p, 'w'), indent=2, ensure_ascii=False); os.chmod(p, 0o600)
    print(p, {k: d[k] for k in updates})
patch('~/.config/teamclaude.json', {
    'switchThreshold': 0.98,
    'rateLimitFailovers': 3,        # 429 때 계정 4개를 다 돌아본다(기본 1)
    'continuityMode': False,        # 제한 응답을 15분 내부 재시도하며 다른 세션까지 세우던 것 해제
    'quotaProbeSeconds': 300,
    'launchModel': 'claude-fable-5-1[1m]',   # 새 claude 세션 기본 모델(없으면 sonnet 주입)
})
patch('~/.config/teamcodex.json', {
    'switchThreshold': 0.98,
    'rateLimitFailovers': 3,        # Claude와 같은 요청별 계정 전환 범위
    'continuityMode': False,        # 제한 응답을 프록시 안에서 장시간 재시도하지 않음
    'modelFallbacks': {},            # 계정 전환 시 요청 모델을 바꾸지 않음
})
PY
```

포트는 기본값(Claude 3456 · Codex 3457 · agy 3458 · grok 3459)을 그대로 쓴다. `teamgrok.json`도 `"provider": "grok"`로 같은 규칙이다. `teamagy.json`에는 `"provider": "agy"`가 들어가며,
다른 풀의 설정 파일로는 teamagy가 실행되지 않는다. Claude 쪽 `proxy.apiKey`는 로그인이
만든 값을 유지한다(상태라인이 이 키로 status를 읽는다).

## 4. 상시 실행 — launchd + tmux (macOS)

프록시를 tmux 세션 안에서 띄워 TUI 대시보드를 볼 수 있게 한다.

```sh
TMUX_BIN=$(command -v tmux)
for pool in teamclaude teamcodex teamagy teamgrok; do
[ -x ~/.local/bin/$pool ] || continue   # teamagy·teamgrok은 §1-3·§1-4를 했을 때만
cat > ~/.local/bin/$pool-tmux-server <<EOF
#!/bin/sh
# Run the $pool proxy inside a detached tmux session so its TUI can be viewed:
#   tmux -L $pool attach -t proxy   (Ctrl-b d detaches; 'q' in the TUI stops the proxy — launchd restarts it)
# Restart: tmux -L $pool kill-session -t proxy
TMUX=$TMUX_BIN; SOCK=$pool; SES=proxy
export TERM=xterm-256color LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
if ! "\$TMUX" -L "\$SOCK" has-session -t "\$SES" 2>/dev/null; then
  "\$TMUX" -L "\$SOCK" -f /dev/null new-session -d -s "\$SES" -x 170 -y 48 \\
    "exec \$HOME/.local/bin/$pool server" || exit 1
  "\$TMUX" -L "\$SOCK" set-option -t "\$SES" mouse on >/dev/null 2>&1
  "\$TMUX" -L "\$SOCK" set-option -t "\$SES" status off >/dev/null 2>&1
  "\$TMUX" -L "\$SOCK" set-option -t "\$SES" remain-on-exit off >/dev/null 2>&1
fi
while "\$TMUX" -L "\$SOCK" has-session -t "\$SES" 2>/dev/null; do sleep 3; done
exit 0
EOF
chmod 755 ~/.local/bin/$pool-tmux-server
done

mkdir -p ~/.local/state/teamcodex ~/.local/state/teamagy ~/.local/state/teamgrok ~/Library/Logs
python3 - <<'PY'
import os, plistlib
from pathlib import Path
home = Path.home(); uid = os.getuid()
node_dir = str(Path(os.popen('command -v node').read().strip()).parent)
path_env = f"/opt/homebrew/bin:{home}/.local/bin:{node_dir}:/usr/local/bin:/usr/bin:/bin"
for label, wrapper, out in [
    ('com.local.teamclaude', 'teamclaude-tmux-server', home/'Library/Logs/teamclaude.log'),
    ('com.local.teamcodex',  'teamcodex-tmux-server',  home/'.local/state/teamcodex/server.log'),
    ('com.local.teamagy',    'teamagy-tmux-server',    home/'.local/state/teamagy/server.log'),
    ('com.local.teamgrok',   'teamgrok-tmux-server',   home/'.local/state/teamgrok/server.log'),
]:
    if not (home/'.local/bin'/wrapper).exists():
        continue
    p = home/'Library/LaunchAgents'/f'{label}.plist'
    p.parent.mkdir(parents=True, exist_ok=True)
    plistlib.dump({
        'Label': label,
        'ProgramArguments': [str(home/'.local/bin'/wrapper)],
        'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 10,
        'ProcessType': 'Standard',
        'EnvironmentVariables': {'HOME': str(home), 'PATH': path_env},
        'StandardOutPath': str(out), 'StandardErrorPath': str(out),
    }, p.open('wb'))
    p.chmod(0o600); print('wrote', p)
PY
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.local.teamclaude.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.local.teamcodex.plist
[ -f ~/Library/LaunchAgents/com.local.teamagy.plist ] && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.local.teamagy.plist
[ -f ~/Library/LaunchAgents/com.local.teamgrok.plist ] && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.local.teamgrok.plist
sleep 3
curl -s -o /dev/null -w 'claude %{http_code}\n' http://127.0.0.1:3456/teamclaude/status
curl -s -o /dev/null -w 'codex  %{http_code}\n' http://127.0.0.1:3457/teamclaude/status
curl -s -o /dev/null -w 'agy    %{http_code}\n' http://127.0.0.1:3458/teamclaude/status   # teamagy를 했을 때
curl -s -o /dev/null -w 'grok   %{http_code}\n' http://127.0.0.1:3459/teamclaude/status   # teamgrok을 했을 때
teamclaude status; teamcodex status; teamagy status
```

운영 요령:
- 재시작은 `tmux -L teamclaude kill-session -t proxy`(launchd가 다시 띄움). Codex 쪽 재시작은
  실행 중인 teamcodex 화면 세션을 죽이니 주의. `teamclaude restart`는 포그라운드라 쓰지 않는다.
- `enable|disable|priority|login|reauth`는 살아 있는 서버에 즉시 반영되므로 재시작 불필요.
- 대시보드: `tmux -L teamclaude attach -t proxy` / `tmux -L teamcodex attach -t proxy` /
  `tmux -L teamagy attach -t proxy`, `Ctrl-b d`로 분리. TUI에서 `q`는 서버 종료(launchd가 재기동).

## 5. Claude 상태라인 + 계정 선택기 (포크의 statusline/)

`teamclaude`가 PATH에 있고 계정이 하나 이상 있어야 installer가 진행된다(§1-2·§2 완료 후).

```sh
cd ~/src/teamproxy/statusline && NO_PROBE=1 NO_RELOAD_PATCH=1 ./install.sh   # §1에서 받은 포크
```

- `NO_PROBE=1`·`NO_RELOAD_PATCH=1`: `probe` 명령과 reload 패치는 karpeleslab 원본용이다. 포크
  빌드에는 그 명령이 없고 enable/disable/priority가 이미 라이브 반영된다.
- 설치되는 것: `~/.claude/statusline-teamclaude.py`·`statusline-wrapper.py`·
  `statusline-autoupdate.sh`·`teamclaude-selector.sh`, `settings.json`의 `statusLine`,
  셸 rc의 `claude` 함수 블록(`teamclaude`와 같이 하단 줄 붙은 Claude Code, `claude N`은 N번 계정 고정).
- 자동 업데이트는 기본 꺼짐(`~/.claude/teamclaude-statusline-config.json`의 `autoUpdate: false`).

Claude Code 설정에 도구 검색을 켠다(비 Anthropic base URL에서는 기본 꺼져 있어 MCP 도구
정의가 매 요청 27만 토큰을 먹는다):

```sh
python3 - <<'PY'
import json, os
p = os.path.expanduser('~/.claude/settings.json'); d = json.load(open(p))
d.setdefault('env', {})['ENABLE_TOOL_SEARCH'] = 'true'
json.dump(d, open(p, 'w'), indent=2, ensure_ascii=False); print(d['env'])
PY
```

새 셸을 열고 `type claude`가 함수로 나오는지, `claude`를 띄웠을 때 Claude Code 아래 tmux 하단 줄에
계정별 Ses/Wk/Fbl 막대가 그려지는지(Claude 안의 상태줄에는 모델 줄만) 확인한다.

## 6. Codex 상태라인 (teamcodex) 확인

§1에서 이미 설치됐다. 확인만 한다:

```sh
cd ~/some-project && teamcodex # Codex 화면 아래 tmux 패널로 상태줄
```

`teamcodex`는 `--dangerously-bypass-approvals-and-sandbox` 같은 Codex 인자를 그대로 넘긴다.
창을 닫아도 유지하려면 `teamcodex --keep-alive`.

teamagy를 설치했다면:

```sh
teamagy -p "Reply with exactly: OK" --model gemini-3.8-flash-medium   # 프록시를 거친 agy 응답
cd ~/some-project && teamagy                                         # agy 화면 + 하단 계정 줄(Gemini 5h·7d, 3p)
```

teamgrok을 설치했다면:

```sh
teamgrok -p "Reply with exactly: OK"                                 # 프록시를 거친 grok 응답
cd ~/some-project && teamgrok                                        # grok 화면 + 하단 계정 줄(RL 사용률, 등급)
```

## 7. 최종 점검표

- [ ] `grep -c isOverloadEvent ~/.local/share/teamcodex-global/lib/node_modules/teamcodex/src/server.js` ≥ 1 — 포크에만 있는 수정이 들어 있다(원본이면 0). `npm ls -g --prefix ~/.local/share/teamcodex-global`은 `teamcodex@1.5.0`
- [ ] `buildCodexProxyArgs`가 `chatgpt_base_url` 옵션을 추가하지 않음 — 포크의 `test/codex.test.js`, `test/codex-run.test.js`로 검증
- [ ] `launchctl list | grep -E 'teamclaude|teamcodex|teamagy'` 두 줄(teamagy를 했으면 세 줄), 상태 0
- [ ] `teamclaude status`·`teamcodex status`에 계정이 보이고 `curl` status 200
- [ ] `claude -p "OK" --model claude-fable-5-1` 응답, 하단 상태라인 표시
- [ ] `teamcodex` 실행 시 하단 상태줄 표시
- [ ] `teamagy status`에 계정이 보이고 `teamagy -p …`가 응답(teamagy를 했을 때)
- [ ] `teamgrok status`에 계정이 보이고 `teamgrok -p …`가 응답(teamgrok을 했을 때)
- [ ] `~/.config/teamclaude.json`·`teamcodex.json`·`teamagy.json`·`teamgrok.json`이 0600이고 어떤 git 저장소에도 없음

## 8. 최신판으로 갱신 — `<풀> update`

설치한 뒤 포크 main이 바뀌면 풀 명령 하나로 갱신한다. 맥(launchd + tmux)과 Linux(systemd 사용자 서비스) 모두 같은 명령이다.

```sh
teamclaude update --dry-run      # 무엇을 바꾸고 무엇을 다시 띄울지만 본다
teamclaude update                # 이 풀의 설치본 하나
teamcodex update --all           # 이 기계에서 찾은 설치본 모두
teamagy update --ref <브랜치|태그|커밋> --wait 900 --json
```

| 옵션 | 뜻 |
|---|---|
| (없음) | 그 풀의 서버가 실제로 돌고 있는 설치본(`ps -ww`로 본 서버 명령의 경로)을 갱신한다. 서버가 없으면 명령을 실행한 설치본 |
| `--all` | 네 풀 서버의 설치본, `~/.local/share/*/lib/node_modules/teamcodex`, 명령을 실행한 설치본을 모두 |
| `--dry-run` | 바꿀 파일 수와 재시작 방법만 출력한다(포크 `fetch`는 한다) |
| `--no-restart` | 파일만 바꾼다. 다음 재시작 때 반영된다(나중에 `update`를 다시 돌리면 옛 코드로 도는 서버만 다시 띄운다) |
| `--ref` | 기본 `main`. `origin/<브랜치>`가 있으면 그것, 없으면 태그·커밋 |
| `--wait` | 진행 중 요청이 0이 되기를 기다리는 최대 초(기본 600) |
| `--json` | 사람용 줄은 stderr, stdout 끝 줄에 `{"ok":…,"installs":[…]}` |

설치본마다 하는 일:

1. 받기: `~/src/teamproxy`가 있으면 그 클론(깨끗하고 그 브랜치에 있을 때만 fast-forward), 없으면
   `~/.cache/teamproxy-update`에 clone. 설치할 내용은 대상 커밋의 `git archive`라 클론의 수정 중 파일은 섞이지 않는다.
   `~/src/teamproxy`의 origin이 포크가 아니면 경고한다(`--json`의 `warnings: ["origin_not_fork"]`). 그 저장소의 커밋을 그대로 설치하니 확인한다.
2. 로컬 수정 검사: 설치본 `src/`의 파일(`__pycache__`·`.pyc` 제외)마다 git blob id가 포크 이력에 있는지 본다. 이력은 대상 커밋,
   `origin/main`, 그리고 그 설치본에 마지막으로 설치한 커밋(`<설치본>/.teamproxy-commit`, `--ref <기능 브랜치>`로 올렸어도 다음 main 갱신이 막히지 않게)이다.
   없는 파일이 하나라도 있으면 그 목록을 보이고 멈춘다(`local_changes`, 아무것도 바꾸지 않는다).
   파일이 같고 서버의 `x-teamcodex-source-hash`도 같으면 "이미 최신"이다. 파일만 같고 서버가 옛 코드로 돌면 재시작만 한다.
3. 재시작 방법 확인: 감독자가 다시 띄워 주는 풀만 재시작한다. Linux는 systemd 사용자 단위 `<풀>`이 active일 때 `systemctl --user restart <풀>`만,
   맥은 tmux 소켓 `<풀>`의 세션 `proxy`가 있고 launchd 작업(라벨이 `.<풀>`로 끝나거나 그 프로세스가 `<풀>-tmux-server`)이 떠 있을 때
   그 세션을 끊는다. 없으면 바꾸기 전에 멈춘다(`no_restart_method`. `--no-restart`로 파일만 바꾸고 손으로 다시 띄운다).
4. 잠금: `<설치본>/.update.lock`(pid). 살아 있는 다른 update가 쥐고 있으면 멈춘다(`locked`), 죽은 pid의 잠금은 넘겨받는다.
5. 요청 0 대기와 drain(runbook [teamcodex-runtime-deployment](../runbooks/teamcodex-runtime-deployment.md)의 순서):
   감독자의 `x-teamcodex-active-requests`(없는 옛 서버는 계정 `inflight` 합)가 2초 간격 두 번 연속 0이 되면
   `POST /teamclaude/deployment/drain`(lifecycle id + `x-api-key`, 15초 뒤 자동 해제)으로 새 요청을 503으로 돌린다. 그 순간 진행 중이 0이 아니면
   drain을 풀고 다시 기다린다. `--wait`를 넘기면 "진행 중 요청 N개"를 보이고 아무것도 바꾸지 않고 멈춘다(`wait_timeout`).
   그 풀을 다른 세션·에이전트가 계속 쓰고 있으면 0이 오지 않으니 그들이 쉴 때 다시 실행한다. 재시작 직전에 풀마다 다시 확인한다.
6. 백업과 덮기: 새 판을 같은 폴더의 `src.new-<YYYYMMDD-HHMMSS>`에 먼저 다 복사한 뒤 이름 바꾸기 두 번(`src`→`src.pre-…`, `src.new-…`→`src`)만 한다.
   `package.json`도 같은 방식(`package.json.pre-…`). 대상 `package.json`에 런타임 의존성이 있으면 덮지 않는다.
7. 다시 띄우기와 확인: 새 서버 pid가 뜰 때까지(최대 120초) 기다린 뒤 `<풀> status --json`이 `ok`·`running`,
   계정 이름·활성 상태가 설정 파일과 같은지, 모델 목록이 200인지 본다. 모델 목록은 갱신 **전에도** 200이던 풀만 요구한다.
   - Claude `GET /v1/models` + `anthropic-version: 2023-06-01`, Codex `GET /codex/models?client_version=<codex --version>`,
     agy `POST /v1internal:fetchAvailableModels`, grok `GET /v1/models`
8. 확인이 실패하면 새 판을 `src.failed-…`·`package.json.failed-…`로 옮기고 백업을 제자리로 돌린 뒤, 이미 재시작한 풀만 다시 띄운다
   (`restored`, 종료 코드 1). 되돌리기도 실패하면 `restore_failed`와 설치본 상태(`state`)를 낸다. 파일은 그대로이고 재시작만 실패했으면 `restart_failed`.
9. 백업(`src.pre-*`·`package.json.pre-*`·`*.failed-*`)은 종류마다 최근 2개만 남긴다.

Ctrl-C·SIGTERM으로 끊으면 덮은 뒤일 때 옛 파일로 되돌리고 이미 재시작한 풀을 다시 띄운 뒤 끝낸다(종료 코드 130, `interrupted_restored`).

한 설치본을 여러 풀이 같이 쓰면(예: `teamcodex-global` 하나로 teamclaude·teamcodex) 그 풀들을 모두 다시 띄운다.
셀비 앱 모드 설치본(`~/.local/share/teamproxy-app`, launchd `kr.selvi.teamproxy.*`)은 건드리지 않고 안내만 한다. 그건 앱이 고정 묶음으로 갱신한다.
git 클론(`.git`이 있는 폴더)도 설치본이 아니라 건너뛴다.

`--ref`로 `update` 명령이 없는 옛 판(이 명령이 생기기 전 커밋)으로 내리면 그 설치본에서는 이 명령이 사라진다. 그때는 경고를 내고,
다음 갱신은 다른 설치본의 `update`나 §8-1 손 절차로 한다.

다시 띄우는 동안 그 프록시를 거치던 스트림은 끊긴다. drain 동안(최대 15초) 새 요청은 503 + `retry-after: 1`을 받는다.

### 8-1. 손 절차 (비상용)

`update`를 쓸 수 없을 때(이 명령이 없는 옛 설치본을 처음 올릴 때 등)만 쓴다. `<설치본>`은 서버의 실제 경로로 확인한다
(`ps -ww -o command= -p <pid>`, pid는 `<설정>.server.json`. `-ww` 없이 보면 경로가 잘린다).

```sh
git -C ~/src/teamproxy pull --ff-only
cd <설치본>/src && for f in $(find . -type f ! -path '*__pycache__*'); do
  [ -n "$(git -C ~/src/teamproxy log origin/main --find-object=$(git hash-object "$f") -1 --format=%h)" ] || echo "로컬 전용: $f"
done                                    # 하나라도 나오면 멈춘다
d=$(date +%Y%m%d)
cp -a <설치본>/src <설치본>/src.pre-$d && cp <설치본>/package.json <설치본>/package.json.pre-$d
rsync -a --delete ~/src/teamproxy/src/ <설치본>/src/ && cp ~/src/teamproxy/package.json <설치본>/package.json
curl -s -D - -o /dev/null http://127.0.0.1:<포트>/teamclaude/status | grep -i x-teamcodex-active-requests   # 0일 때
tmux -L <풀> kill-session -t proxy      # 맥. Linux는 systemctl --user restart <풀>
<풀> status --json                      # ok:true, 계정 수·이름·활성 상태가 전과 같은지
curl -s -o /dev/null -w '%{http_code}\n' -H 'anthropic-version: 2023-06-01' http://127.0.0.1:3456/v1/models   # 200
```

확인이 실패하면 `src`·`package.json`을 `.pre-$d`로 되돌리고 같은 방법으로 다시 띄운다.

## 하지 말 것

- 업스트림(sangrokjung·jung-wan-kim·karpeleslab)에서 설치하거나 그쪽에 PR·이슈를 보내지 않는다.
- 토큰이 든 설정 파일을 다른 머신에서 복사하지 않는다(refresh 토큰은 회전+재사용 감지라 서로를 로그아웃시킨다).
  예외는 Claude 장기 토큰(§2-1)뿐이다 — 회전하지 않아 여러 머신이 같은 값을 써도 된다. Codex(ChatGPT 로그인)는
  refresh 방식이라 지금도 머신마다 따로 로그인한다.
- 같은 계정을 한 도구에서 두 번 로그인하지 않는다. 재인증은 `teamclaude reauth <이름>`·`teamcodex login --name <기존이름>`으로만.
