# TeamCodex 프록시 준비

인자 없이(또는 Codex 옵션만 붙여) 실행하는 `teamcodex`가 실행기와 상태줄입니다. OAuth 로그인과 계정 자동 전환은
이 저장소(`cineraria01/teamproxy`)의 프록시가 담당합니다. 업스트림(`sangrokjung/teamclaude`)에서는 설치하지 않습니다.
이 안내는 이 포크의 `main` 브랜치를 설치합니다.
Node.js/npm, Python 3.9 이상, 공식 `codex` 명령이 먼저 설치되어 있어야 합니다.

이미 `teamcodex status`가 정상이고 설정이 `~/.config/teamcodex.json`에 있다면
이 단계는 건너뛰고 [실행기 설치](HUD.md#사용)로 돌아가세요.

## 1. 실행기와 프록시 함께 설치

저장소에서 아래 명령을 실행하면 TeamCodex가 없는 경우 아래 고정 버전을
별도 npm prefix에 설치하고 `teamcodex` 명령만 노출합니다. 기존 `teamclaude`와
Codex 설정은 변경하지 않습니다.

```sh
export PATH="$HOME/.local/bin:$PATH"
python3 scripts/install.py
# Linux 상시 서비스까지 설정:
python3 scripts/install.py --service
```

`--service`는 `systemctl --user enable --now teamcodex.service`와
`loginctl enable-linger`를 실행합니다. 로그인 종료와 재부팅 후에도 프록시를 유지하며,
프로세스가 종료되면 5초 후 재시작합니다. linger 권한이 없으면 설치기에 표시된
`sudo loginctl enable-linger 사용자ID` 명령을 관리자가 실행해야 합니다.
기존 이름이 같은 사용자 서비스는 덮어쓰지 않습니다.

```sh
systemctl --user status teamcodex
journalctl --user -u teamcodex -f
systemctl --user restart teamcodex  # 필요할 때 재시작
```

수동 서버가 이미 실행 중이면 먼저 그 터미널에서 종료한 뒤 `--service`를 실행하세요.

### 수동 프록시 설치 (선택)

아래는 자동 설치 대신 직접 설치할 때 사용하는 명령입니다.

이 포크의 패키지는 `teamclaude` 명령도 포함하므로 별도 npm prefix에 설치합니다.
아래 PATH를 셸 시작 파일에도 추가하세요.

```sh
export PATH="$HOME/.local/bin:$PATH"
mkdir -p "$HOME/.local/bin"
npm install --global --prefix "$HOME/.local/share/teamcodex-global" --ignore-scripts \
  git+https://github.com/cineraria01/teamproxy.git#main
```

`teamcodex` 명령만 노출합니다. 아래 블록은 기존 파일이 있으면 덮어쓰지 않고 실패합니다.
기존 명령이 있다면 해당 설치를 먼저 확인하세요.

```sh
(
  set -euC
  cat > "$HOME/.local/bin/teamcodex" <<'SH'
#!/bin/sh
if [ "${1-}" = codex ]; then shift; fi
# exec 뒤의 -c는 TeamCodex가 맨 앞에 붙이는 프록시 설정을 지워 401로 끝난다. 그 꼴이면 실행하지 않는다.
if [ "${1-}" = run ] && [ "${2-}" = -- ]; then
  sub= skip=
  for arg in "$@"; do
    if [ -n "$skip" ]; then skip=; continue; fi
    if [ -z "$sub" ]; then
      case $arg in
        run|--) ;;
        -c|--config) skip=1 ;;
        -*) ;;
        *) sub=$arg ;;
      esac
      continue
    fi
    case $sub in exec|e) ;; *) break ;; esac
    case $arg in
      --) break ;;
      -c|-c?*|--config|--config=*)
        printf '%s\n' "teamcodex: exec 뒤의 '$arg' 설정은 TeamCodex 프록시 설정을 지워 401로 실패합니다." \
          "teamcodex: -c 설정은 exec 앞에 두세요. 예: teamcodex run -- -c model_reasoning_effort=high exec --ignore-user-config -m MODEL ..." >&2
        exit 2 ;;
    esac
  done
fi
exec env LC_ALL=C TEAMCLAUDE_PROVIDER=codex \
  TEAMCLAUDE_CONFIG="$HOME/.config/teamcodex.json" \
  TEAMCODEX_CODEX_BIN="$(command -v codex)" \
  node "$HOME/.local/share/teamcodex-global/lib/node_modules/teamcodex/src/index.js" codex "$@"
SH
  chmod 755 "$HOME/.local/bin/teamcodex"
)
```

가운데 `if` 블록은 `teamcodex run -- … exec … -c KEY=VALUE`처럼 `exec` 뒤에 둔 `-c`·`--config`를 막는
검사입니다(종료 코드 2). 이 순서면 TeamCodex의 프록시 설정이 지워져 401로 끝나기 때문입니다.
설정은 `teamcodex run -- -c KEY=VALUE exec …`처럼 `exec` 앞에 둡니다. 자세한 사용법은
[HUD.md의 에이전트·스크립트 절](HUD.md#에이전트스크립트에서-쓰기-teamcodex-run----exec)을 보세요.

## 2. 계정 등록과 서버 실행

```sh
teamcodex login --name codex-1
teamcodex login --name codex-2
teamcodex accounts
teamcodex server  # --service 또는 launchd를 사용하지 않는 경우만
```

각 로그인 화면에서 서로 다른 본인 계정을 선택합니다. 원격 서버에서는 인증 후 브라우저의
`localhost` 페이지가 열리지 않을 수 있습니다. 마지막 콜백 주소 전체를 `teamcodex login`이
기다리는 터미널에 붙여넣고 Enter를 누르면 서버에서 로그인을 마칩니다. 다른 사람에게
주소를 전달할 필요가 없습니다. 입력은 숨겨지고 현재 로그인 state와 로컬 주소를 검증합니다.
잘못된 주소는 다시 입력할 수 있고, 취소는 `Ctrl-C`입니다.

별도 로그인 디렉터리에서 인증하므로
기존 Codex의 인증 파일을 복사할 필요가 없습니다. 계정 설정 파일에는 토큰이 들어 있으므로
Git에 추가하지 마세요. 기본 프록시 포트는 `3457`, 전환 임계치는 사용률 `98%`입니다.

서비스를 설정했다면 바로 `teamcodex`를 실행하세요. 수동 서버는 해당 터미널을 유지하고 다른 터미널에서 실행합니다.
`teamcodex status`로 연결을 확인할 수 있습니다. 모든 계정의 한도가 소진되면
즉시 계속 응답할 수 있는 것은 아닙니다. 대화 재개는 `teamcodex -- resume SESSION_ID`입니다.

실행기는 `LC_ALL=C`로 프로세스 시작 시각의 표기를 통일합니다. 서버와 제어 터미널의
언어 설정이 다르면 기존 실행기는 `lifecycle identity unverified`로 표시하고 재시작을
거절할 수 있습니다. 기존 실행기를 사용하는 경우 같은 설정으로 상태를 확인하세요:
`LC_ALL=C teamcodex status`. 중지·재시작 명령은 실행 중인 Codex 대화 밖의 별도 터미널에서 실행합니다.

## 3. macOS 로그인 시 자동 시작 (선택)

수동 서버를 `teamcodex stop`으로 종료한 뒤 아래를 실행합니다.
현재 PATH를 저장하므로 Node.js 설치 경로를 바꿨다면 plist를 갱신해야 합니다.
기존 동일 이름의 서비스 파일은 덮어쓰지 않습니다.

```sh
python3 - <<'PY'
import os
from pathlib import Path
import plistlib

home = Path.home()
logs = home / '.local/state/teamcodex'
logs.mkdir(parents=True, exist_ok=True, mode=0o700)
path = home / 'Library/LaunchAgents/io.github.cineraria01.tcodex.plist'
path.parent.mkdir(parents=True, exist_ok=True)
with path.open('xb') as stream:
    plistlib.dump({
        'Label': 'io.github.cineraria01.tcodex',
        'ProgramArguments': [str(home / '.local/bin/teamcodex'), 'server'],
        'RunAtLoad': True,
        'KeepAlive': True,
        'ThrottleInterval': 10,
        'EnvironmentVariables': {'HOME': str(home), 'PATH': os.environ['PATH']},
        'StandardOutPath': str(logs / 'server.log'),
        'StandardErrorPath': str(logs / 'server-error.log'),
    }, stream)
path.chmod(0o600)
PY
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/io.github.cineraria01.tcodex.plist"
teamcodex status
```

자동 시작 서비스를 정지할 때는 아래 명령을 사용하세요. `KeepAlive` 때문에
`teamcodex stop`만 실행하면 다시 시작됩니다.

```sh
launchctl bootout "gui/$(id -u)/io.github.cineraria01.tcodex"
```

자동 시작 설정까지 제거하려면 bootout 후 위 plist 파일만 제거합니다.
프록시의 별도 npm prefix, 실행기 설치 폴더, 계정 설정 파일은 각각 독립적입니다.
계정 설정 파일을 지우면 저장한 로그인을 잃으므로 실행기 제거와 구분하세요.
