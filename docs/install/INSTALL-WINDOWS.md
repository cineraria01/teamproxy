# Windows 설치 — teamclaude · teamcodex · teamagy · teamgrok · teamcursor

맥·리눅스의 [INSTALL-ALL.md](INSTALL-ALL.md)와 같은 결과(풀마다 래퍼 명령 + 로그온 때 뜨는 서버 + 설정)를 Windows에 한 명령으로 만든다.
Windows 코드는 따로 된 파일에만 있다(2026-11-18 사용자 「맥이랑 윈도우 코드 섞이면 안된다」): 설치기 `scripts/install-win.mjs`,
풀 진입점 `src/teamproxy-win32.js`, Windows 동작 `src/win32.js`(래퍼 규칙·teamcodex 가드·작업 스케줄러 stop/restart),
Windows `update` `src/win32-update.js`. 공통 코드는 `src/platform.js` 한 곳에서 고른다. 맥·리눅스의 sh 래퍼·`install.py`·
launchd·systemd는 이 파일들을 쓰지 않는다. 셀비 앱 모드(앱이 서버를 띄움)는 [APP-INSTALL.md](APP-INSTALL.md#windows)로 따로다.

## 0. 전제

- Windows 10/11, 관리자 권한은 보통 필요 없다(작업 만들기가 「액세스가 거부되었습니다」로 막히면 관리자 PowerShell에서 설치기를 한 번).
- **Node 18+**(`winget install OpenJS.NodeJS.LTS`)와 **Git**(`winget install Git.Git`)이 PATH에. 설치기를 돌린 그 `node.exe`의 경로가
  래퍼·서버에 박힌다 — Node를 다른 곳으로 옮기면 설치기를 다시 돌린다.
- 쓸 CLI는 먼저 깔고 한 번 로그인해 둔다: Claude Code 네이티브(`irm https://claude.ai/install.ps1 | iex` → `%USERPROFILE%\.local\bin\claude.exe`),
  Codex(`npm i -g @openai/codex` — teamproxy가 `%APPDATA%\npm`과 node 옆의 `@openai\codex-win32-<arch>\…\codex.exe`를 찾는다),
  agy·grok(`%USERPROFILE%\.grok\bin\grok.exe`)·cursor-agent는 쓸 때만. 없으면 설치기가 「주의」로 알려 준다.
- **PowerShell 5.1 주의**: BOM 없는 UTF-8 `.ps1`은 ANSI(CP949)로 읽혀 한국어가 깨진다. 이 설치는 `.ps1`을 쓰지 않는다.
  아래 명령은 창에 그대로 붙여 넣고, 스크립트로 저장할 거면 「UTF-8 with BOM」으로 저장한다. 설치기가 쓰는 `.cmd`는 cmd가
  OEM 코드 페이지로 읽어 ASCII만 넣는다(경로는 `%USERPROFILE%`·`%LOCALAPPDATA%`로 적어 한글 사용자 이름도 괜찮다. 그 밖의 경로에
  ASCII 밖 글자나 `%`·`"`가 있으면 설치기가 멈추고 알려 준다).

## 1. 설치

```powershell
git clone https://github.com/cineraria01/teamproxy.git "$env:USERPROFILE\src\teamproxy"
node "$env:USERPROFILE\src\teamproxy\scripts\install-win.mjs" --dry-run        # 무엇을 만들고 바꿀지만 본다
node "$env:USERPROFILE\src\teamproxy\scripts\install-win.mjs"                  # 기본 묶음: teamclaude + teamcodex
node "$env:USERPROFILE\src\teamproxy\scripts\install-win.mjs" --pools all      # 다섯 풀 (또는 --pools claude,codex,agy)
```

설치본은 **그 git 클론 자체**다(권장 자리 `%USERPROFILE%\src\teamproxy`. 다른 자리에서 돌리면 그 클론이 설치본이 된다). 풀마다 생기는 것:

| 무엇 | 자리 | 내용 |
|---|---|---|
| 래퍼 | `%USERPROFILE%\.local\bin\team<풀>.cmd` | CRLF·ASCII. `TEAMCLAUDE_CONFIG`를 그 풀 설정으로 고정하고 `node <클론>\src\teamproxy-win32.js <풀> %*` |
| 서버 | `%LOCALAPPDATA%\teamproxy\team<풀>-server.cmd` | `node <클론>\src\index.js [<풀>] server`, 로그 `%LOCALAPPDATA%\teamproxy\logs\team<풀>.log`(10 MB 넘으면 `.log.1` 하나로 돌림) |
| 창 없이 | `%LOCALAPPDATA%\teamproxy\team<풀>-server.vbs` | `wscript`가 위 `.cmd`를 숨긴 창으로 띄우고 끝날 때까지 기다린다 |
| 작업 | 작업 스케줄러 `team<풀>` | 로그온 트리거, InteractiveToken(그 사용자), 실패 시 1분마다 다시(9999번), 겹치면 새것 무시(IgnoreNew), 실행 시간 제한 없음. 만든 XML은 `%LOCALAPPDATA%\teamproxy\team<풀>.task.xml` |
| 설정 | `%USERPROFILE%\.config\team<풀>.json` | **없을 때만** 만든다: `proxy.host` `127.0.0.1`(이 PC 밖에 안 열림), `allowNoAccounts`(계정 넣기 전에도 서버가 떠 있음). 있던 설정·계정은 손대지 않는다(host가 루프백이 아니면 「주의」만) |

설치기는 서버가 안 떠 있는 풀의 작업을 바로 한 번 띄운다(`--no-start`면 안 띄움 — 다음 로그온 때 뜬다). 이미 그 포트에서 서버가
응답하면(손 설치·전 작업) 그대로 두고 「새 작업으로 바꾸려면 `team<풀> restart`」를 알린다.
`%USERPROFILE%\.local\bin`이 PATH에 없으면 넣는 명령을 알려 준다(Claude Code 네이티브 설치가 보통 넣어 둔다).

### 1-1. 래퍼 규칙 (맥 sh 래퍼와 같은 뜻)

- 인자 없음·`-`로 시작 → 그 CLI 실행(`run --`): `teamclaude`, `teamcodex --yolo`, `teamclaude -p "…"`.
- `--` 뒤 → CLI 하위 명령: `teamclaude -- mcp list`, `teamcodex -- exec "…"`.
- 그 밖의 말·`-h`·`--help` → 프록시 명령: `teamcodex status`, `teamagy login`, `teamclaude accounts`.
- teamcodex: `exec` 뒤의 `-c`·`--config`는 프록시 설정을 지워 401로 끝나므로 실행하지 않고 종료 2(맥 래퍼와 같은 가드).
  `-c`는 `exec` 앞에 둔다: `teamcodex -- -c model_reasoning_effort=high exec …`.
- 맥과 다른 점: 하단 줄(Herdr)·`--effort xhigh` 기본값·중복 재개 가드가 없다. Ctrl+C 뒤 cmd가 「일괄 작업을 끝내시겠습니까(Y/N)?」를 물을 수 있다.

## 2. 계정 넣기와 확인

계정은 맥과 같은 명령이다([INSTALL-ALL §2](INSTALL-ALL.md#2-계정-로그인)). 다른 기계의 설정 파일(토큰)을 복사해 오지 않는다.

```powershell
teamclaude status            # 서버·계정 표
teamcodex login --name codex-1
Get-Content "$env:LOCALAPPDATA\teamproxy\logs\teamcodex.log" -Tail 50
```

## 3. 다시 띄우기·끄기·갱신

- `team<풀> restart` = 작업 `team<풀>`을 끝내고(작업 스케줄러가 그 작업이 띄운 프로세스 트리를 끝낸다) 포트가 비면 다시 띄워
  응답할 때까지(최대 120초) 기다린다. `team<풀> stop` = 끝내기만(다음 로그온·`restart`·`schtasks /Run /TN team<풀>` 때 다시 뜬다).
  작업을 끝내도 서버가 계속 응답하면(예: `team<풀> run`이 작업 밖에서 자동으로 띄운 서버) pid에 신호를 보내지 않고 손 절차를 알린 뒤 종료 1.
  작업이 없는 기계(앱 모드·옛 손 설치)는 전처럼 안내만 한다([INSTALL-ALL §9-5](INSTALL-ALL.md#9-5-windows--teamclaudecmd와-windows에서만-다른-것)).
- `team<풀> update` — 어느 풀에서 불러도 같다(클론 하나를 다섯 풀이 같이 쓴다. `--all`도 같은 뜻):
  1. 클론이 깨끗하고(추적 파일 수정 없음) `main`에 있어야 한다. 아니면 아무것도 바꾸지 않고 멈춘다(`local_changes`·`not_on_branch`).
  2. `git fetch` 뒤 `origin/main`이 같으면 「이미 최신」(단 `--no-restart` 뒤 옛 코드로 도는 서버는 다시 띄운다). 갈라졌으면 멈춘다(`diverged`).
  3. 작업이 있고 서버가 떠 있는 풀마다 요청 0과 drain을 기다린다(맥 `update`와 같은 순서, `--wait` 기본 600초). 넘기면 아무것도 바꾸지 않는다.
  4. `git merge --ff-only`로 클론을 옮기고, 풀마다 작업으로 다시 띄운 뒤 `status --json` ok·running, 계정 목록 같음,
     모델 목록 200(갱신 전에도 200이던 풀만)을 본다.
  5. 하나라도 실패하면 `git reset --keep <전 커밋>`으로 되돌리고 이미 다시 띄운 풀을 옛 코드로 다시 띄운다(`restored`, 종료 1).
  옵션: `--dry-run`, `--no-restart`, `--ref <브랜치>`, `--wait <초>`, `--json`(사람용 줄은 stderr, stdout 끝 줄에 결과 JSON).
  Ctrl+C로 중간에 끊으면 클론은 끊긴 자리에 남는다 — `update`를 다시 돌리거나 위 「되돌리기」 줄의 명령을 쓴다.
- 설치기 자체가 바뀌었을 때(새 풀·래퍼 모양)는 `update` 뒤 설치기를 다시 돌린다. 같은 내용이면 아무것도 바꾸지 않는다.

## 4. 원격 풀 모드 (이 PC에 Claude 계정 없이)

다른 기계의 Claude 풀을 쓰는 PC는 teamclaude를 로컬 풀 대신 원격 풀로 설치한다([INSTALL-ALL §9-4](INSTALL-ALL.md#9-4-다른-기계의-풀-쓰기--클라이언트-모드-teamclaude-remote-use-맥리눅스windows)):

```powershell
# 토큰 파일은 ASCII/UTF-8로 (메모장 기본값 그대로. PowerShell이면 Set-Content -Encoding ascii)
node "$env:USERPROFILE\src\teamproxy\scripts\install-win.mjs" --remote https://<풀 기계>.<tailnet>.ts.net:8456 --token-file "$env:USERPROFILE\token.txt"
Remove-Item "$env:USERPROFILE\token.txt"
```

teamclaude 래퍼만 만들고 작업·서버는 만들지 않은 채 `teamclaude remote use <주소>`로 연결한다(토큰은 화면·명령줄에 안 나온다.
`--token-file`이 없으면 붙여 넣기를 묻는다. 연결 전에 저장만 하려면 `--no-check`). `--pools codex,…`를 같이 주면 그 풀들은 로컬로 깐다.
손으로 만든 로컬 teamclaude 작업이 남아 있으면 지우는 명령을 알려 준다. 끄기: `teamclaude remote use --off`.

## 5. 손 설치를 넘겨받기

같은 이름(래퍼 `team<풀>.cmd`, `team<풀>-server.cmd/.vbs`, 작업 `team<풀>`)이 이미 있으면 중복을 만들지 않고 그 자리를 넘겨받는다:
내용이 다른 파일은 `<파일>.bak-install-<YYYYMMDD-HHMMSS>`로 남긴 뒤 쓰고, 작업은 기존 XML을
`%LOCALAPPDATA%\teamproxy\team<풀>.task.bak-install-<…>.xml`로 남긴 뒤 바꾼다. 설정 파일은 그대로다. 돌고 있는 서버는 끄지 않는다 —
새 작업으로 옮기려면 넘겨받은 뒤 `team<풀> restart`. 옛 손 설치의 한 줄 shim(`@call …\scripts\win32\teamclaude.cmd`)도 같은 이름이라 바뀐다.

## 6. 되돌리기·지우기

```powershell
# 한 풀 지우기 (계정이 든 설정 %USERPROFILE%\.config\team<풀>.json은 남긴다)
schtasks /End /TN teamcodex; schtasks /Delete /TN teamcodex /F
Remove-Item "$env:USERPROFILE\.local\bin\teamcodex.cmd", "$env:LOCALAPPDATA\teamproxy\teamcodex-*"
# 넘겨받기 전으로: 백업 파일 이름을 되돌리고, 작업은 백업 XML로 다시 만든다
schtasks /Create /TN teamcodex /XML "$env:LOCALAPPDATA\teamproxy\teamcodex.task.bak-install-<…>.xml" /F
# 코드만 전 판으로: git -C "$env:USERPROFILE\src\teamproxy" reset --keep <커밋>; teamcodex restart
```

## 7. 시험

`test/install-win.test.js`(설치기: 래퍼·서버·작업 XML·설정·넘겨받기·시작·원격 모드), `test/win32.test.js`(진입점·teamcodex 가드·작업으로
stop/restart), `test/win32-update.test.js`(git 클론 갱신·되돌리기), `test/codex.test.js`(npm 전역 codex.exe). 어느 OS에서나 돈다:
`TEAMPROXY_APP_PLATFORM=win32`와 가짜 schtasks(`test/helpers/fake-schtasks.mjs`, `TEAMPROXY_WIN_SCHTASKS`)는 `node --test` 안에서만
먹는다. 실제 작업 스케줄러·실제 풀은 건드리지 않는다. CI `windows-latest`에서도 같은 시험이 돈다.
