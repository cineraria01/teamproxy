# 앱용 설치 (비대화형, `install-app.mjs`)

셀비 같은 앱이 사용자 동의를 받은 뒤 프록시를 설치·확인·제거하는 모드다. 사람이 새 머신을 꾸리는 절차는
[INSTALL-ALL.md](INSTALL-ALL.md)이고, 이 모드는 그것과 따로 간다(기존 수동 설치를 덮지 않는다).

## 하는 일과 하지 않는 일

필요한 것은 **Node 하나**다(Python·tmux·git 불필요). 설치기도 Node 스크립트이고, 앱이 전용 Node를 내려받아 `--node`로 넘기면 시스템 Node가 없어도 된다.

하는 일(사용자 권한으로만, 네트워크 없이. `--with-codex-cli`만 npm 레지스트리를 쓴다):
- 풀(`claude`·`codex`·`agy`)마다 설치 폴더 `~/.local/share/teamproxy-app/<풀>`(npm prefix)에 설치.
  원천은 **이 설치기가 들어 있는 폴더**다: `<node> <npm-cli.js> install --global --prefix … --ignore-scripts --install-links <이 폴더>`.
  npm은 시스템 것이 아니라 `--node`와 같은 배포본의 `lib/node_modules/npm/bin/npm-cli.js`(node가 심볼릭 링크면 실제 경로 쪽도 찾는다)를 그 node로 실행한다.
  브랜치 tip을 받지 않는다. 런타임 의존성은 0이다.
- `~/.local/bin/{teamclaude,teamcodex,teamagy}` 래퍼(둘째 줄에 `# teamproxy-app` 표식). 하단 줄(tmux)·HUD 없이, **`--node` 절대 경로의 node**로 프록시를 바로 실행한다. 래퍼 PATH와 launchd PATH는 그 node 폴더로 시작한다(사용자 PATH·셸 rc는 건드리지 않는다).
- 설정 `~/.config/{teamclaude,teamcodex,teamagy}.json`이 없으면 만들고(`0600`) `proxy.apiKey`를 생성, `proxy.host`를 `127.0.0.1`, `proxy.allowNoAccounts`를 `true`로 적는다.
  앱 설치 전부터 있던 설정은 **바꾸지 않는다**(끝 줄과 단계 줄에 `"config":"existing_kept"`, 매니페스트에도 기록). 앱이 만든 설정만 새 키를 채우고 `--purge`로 지운다.
- launchd 사용자 에이전트 `kr.selvi.teamproxy.<풀>`: `<래퍼> server`, `RunAtLoad`·`KeepAlive`·`ThrottleInterval 10`,
  로그 `~/Library/Logs/teamproxy/<풀>.log`. 설치 기록은 `~/.local/share/teamproxy-app/manifest.json`.

- `--with-codex-cli <버전>`이면(실제 npm으로 0.162.1을 `--ignore-scripts`로 설치해 플랫폼 선택 의존성 `@openai/codex-darwin-arm64`가 깔리고 `codex --version`이 도는 것을 확인했다) 같은 node·npm으로 `@openai/codex@<버전>`을 `~/.local/share/teamproxy-app/codex-cli`(npm prefix)에 설치하고, teamcodex 래퍼가 `TEAMCODEX_CODEX_BIN=<그 폴더>/bin/codex`를 쓴다(사용자가 이미 `TEAMCODEX_CODEX_BIN`을 정해 두면 그 값이 우선). 이 CLI의 `#!/usr/bin/env node`가 같은 node를 찾도록 래퍼 PATH가 node 폴더로 시작한다.

하지 않는 일: 셸 rc, `~/.claude/settings.json`, 상태줄, tmux 하단 줄, 계정 로그인, sudo.

설정에 `proxy.allowNoAccounts: true`를 적으므로 계정이 0개여도 서버가 떠 있다(launchd 재기동 없음). `/teamclaude/status`는 200과 `totalCount: 0`, API 요청은 503 "계정이 없습니다. 로그인하세요"를 준다. `<풀> login`이 끝나면 실행 중인 서버에 SIGHUP을 보내 재시작 없이 새 계정을 쓴다. 플래그가 없는 설정은 지금처럼 "No accounts configured"로 종료한다.

## 명령

모두 `<node> scripts/install-app.mjs <옵션> --json`이고, 표준 출력에 **한 줄에 JSON 하나**를 쓴다. 마지막 줄이 결과(`done`)다. 종료 코드는 성공 0, 실패 1.

| 명령 | 뜻 |
|---|---|
| `--app [--pools claude,codex,agy] [--node 절대경로] [--with-codex-cli 버전] [--prefix 홈]` | 설치(기본 세 풀). `--node` 기본값은 설치기를 실행한 node. 같은 버전이면 `skip`, 다른 버전이면 갱신하고 에이전트를 다시 올린다 |
| `--status` | 설치 여부·버전·풀별 로드·응답·계정 수 |
| `--uninstall [--purge]` | 에이전트·래퍼·설치 폴더 제거. 설정(토큰)은 `--purge`일 때만 지운다 |
| `--login-command <풀>` | 로그인에 쓸 argv와 비어 있는 첫 `<풀>-N` 이름 |

`--prefix`는 홈 디렉터리 기준을 바꾸는 **시험 전용** 옵션이다(래퍼는 실행 때의 `$HOME/.config/…`를 읽으므로 운영에서 쓰지 않는다). 기존 대화형 `scripts/install.py`는 그대로이고 앱 모드와 무관하다.

### 진행 줄

```json
{"step": "preflight", "status": "ok", "detail": "node, npm, launchctl을 찾았습니다"}
{"step": "npm:codex", "status": "start", "detail": "teamcodex 1.3.0 설치 중"}
{"step": "launchd:codex", "status": "skip", "detail": "kr.selvi.teamproxy.codex가 이미 실행 중입니다"}
```

`status`는 `start|ok|skip|fail`, `detail`은 한국어 한 줄. 단계 id: `preflight`·`conflicts`·`codex-cli`(옵션을 줬을 때)·`npm:<풀>`·`wrapper:<풀>`·`config:<풀>`·`launchd:<풀>`·`health:<풀>`·`error`.
`health:<풀>`은 서버가 아직 안 떠도 `skip`일 뿐 실패가 아니다(계정이 없으면 정상).

### 끝 줄

```json
{"done": true, "ok": true, "version": "1.3.0", "pools": {"codex": {"port": 3457, "label": "kr.selvi.teamproxy.codex", "installed": true, "running": false}}}
{"done": true, "ok": false, "version": "1.3.0", "pools": {...}, "error": "conflict_existing_install", "detail": "codex: 포트 3457를 다른 프로세스가 쓰고 있습니다. 덮어쓰지 않고 멈춥니다."}
```

오류 코드: `missing_node`(`--node`가 없거나 그 옆에 npm이 없음)·`conflict_existing_install`·`npm_failed`·`config_failed`·`launchd_failed`·`install_failed`·`usage`(잘못된 인자, 종료 코드 2).
충돌 검사는 파일을 쓰기 전에 모든 풀을 먼저 본다. 아래면 아무것도 쓰지 않고 멈춘다.
- 래퍼 이름(`~/.local/bin/teamcodex` 등)에 표식 없는 파일이 있다.
- 다른 라벨의 launchd 에이전트(`com.local.*`, `com.hyeongsu.*` 등)가 그 풀의 명령(`teamcodex` 등)을 실행한다.
- 이 설치가 아닌 프로세스가 풀의 포트(설정이 있으면 그 포트, 없으면 3456/3457/3458)를 쓰고 있다.

### `--status`

```json
{"done": true, "ok": true, "installed": true, "version": "1.3.0", "pools": {"codex": {"port": 3457, "label": "kr.selvi.teamproxy.codex", "installed": true, "loaded": true, "running": true, "accounts": 2, "usable": 1}, "claude": {...}, "agy": {...}}}
```

`running`은 포트가 응답, `accounts`는 설정 파일의 계정 수, `usable`은 서버가 말하는 지금 쓸 수 있는 계정 수(응답이 없으면 0).

### `--login-command`

```json
{"done": true, "ok": true, "pool": "codex", "account": "codex-2", "argv": ["/Users/me/.local/bin/teamcodex", "login", "--name", "codex-2"]}
```

앱은 이 argv를 셸 문자열로 합치지 않고 터미널에 그대로 넘긴다. claude·codex·agy 모두 `login --name`을 받는다.

### 제거

`--uninstall --json`은 풀마다 `launchctl bootout`, plist·래퍼(표식 있는 것만)·설치 폴더를 지우고 `{"done":true,"ok":true,"removed":["codex"],"purged":false}`를 쓴다.
`--purge`는 설정과 `.server.json`·`.quota.json`, 로그 폴더까지 지운다(로그인한 계정을 잃는다).
설치기가 만들지 않은 파일은 지우지 않는다.

## 앱이 쓰는 관리 명령 (`--json`)

설치된 래퍼(`~/.local/bin/team<풀>`)에 `--json`을 주면 표준 출력에 **JSON 객체 하나**만 쓴다(사람용 문구는 표준 오류). 토큰·refresh 값·이메일 원문은 없다(이메일은 `a***@gmail.com`). 실패는 `{"ok":false,"error":"<코드>","message":"…"}`와 종료 코드 1.
래퍼가 `LC_ALL=C`를 걸어 launchd 서버와 CLI의 프로세스 시각 표기가 같아야 라이브 반영이 된다(다르면 `restart_required`).

| 명령 | 출력 |
|---|---|
| `accounts --json` | `{"ok":true,"running":true,"accounts":[…]}` |
| `status --json` | `{"ok":true,"running":true,"port":3457,"pid":123,"currentAccount":"codex-1","usableCount":1,"totalCount":2,"switchThreshold":0.98,"accounts":[…]}` (서버가 없어도 `running:false`로 ok) |
| `enable <이름> --json`, `disable …` | `{"ok":true,"account":"codex-1","enabled":false,"applied":"live"}` |
| `priority <이름> <숫자\|auto> --json` | `{"ok":true,"account":"codex-1","priority":5,"applied":"live"}` (`auto`는 `priority:null`) |
| `remove <이름> --json` | `{"ok":true,"account":"codex-1","applied":"live"}` |
| `reload --json` | `{"ok":true,"measured":2,"targets":2,"total":2}` (서버가 없으면 `not_running`, 트래픽이 아직 없으면 `reload_failed`) |

`applied`: `live`(실행 중 서버에 SIGHUP으로 반영) · `config_only`(서버가 없어 설정만 바꿈) · `restart_required`(서버가 라이브 반영을 못 함).
계정 항목: `name`, `type`(`oauth`|`api`), `provider`, `plan`, `email`(가림), `enabled`, `usable`(서버가 없으면 `null`), `priority`, `fiveHour`/`sevenDay`(`{"usedPct":12.3,"resetsAt":"ISO"}`, 서버가 없으면 `null`), `rateLimitedUntil`, `error`(짧은 코드: `subscription-disabled`·`auth-revoked`·`refresh-failed`·`auth-rejected`). agy는 `claudeGpt`(Claude/GPT 그룹 5시간·주간)도 준다.
오류 코드: `account_not_found`·`usage`·`not_running`·`reload_unsupported`·`reload_failed`.

## 앱용 로그인 (`login --name <이름> --json`)

터미널 없이 앱이 브라우저를 열고 결과를 기다리는 모드다. 표준 출력은 줄마다 JSON이다.

```json
{"event":"auth_url","url":"https://claude.ai/oauth/authorize?…"}
{"event":"waiting"}
{"event":"need_code"}
{"done":true,"ok":true,"account":"claude-2"}
{"done":true,"ok":false,"error":"login_timeout","message":"Login timed out after 10 minutes"}
```

- `auth_url`: 앱이 이 주소를 브라우저로 연다(claude·agy는 CLI가 직접 열지 않는다). 콜백은 CLI가 띄운 루프백 서버가 받는다.
  - **teamcodex**는 공식 `codex login`을 감싸 그 출력의 URL을 옮긴다. macOS에서 Codex CLI는 브라우저를 스스로 연다(막을 수 없음). 그래서 이벤트에 `"browser_opened":true`가 붙고 앱은 다시 열지 않는다.
  - `--device-auth`를 주면 `{"event":"auth_url","url":"…","user_code":"ABCD-12345","browser_opened":false}`로 코드를 함께 준다(앱이 코드를 보여 주고 URL을 연다).
- `need_code`: 20초(`TEAMPROXY_NEED_CODE_MS`) 안에 콜백이 없을 때 한 번. 이때 표준 입력으로 **인증 코드 또는 콜백 URL 한 줄**을 받는다(코드는 늘 받을 수 있다). teamcodex에는 이 경로가 없다.
- 끝 줄 `done`. 오류 코드: `name_taken`(이미 있는 `--name`, 덮어쓰기·토큰 폐기를 막으려 거절)·`cancelled`·`login_timeout`·`state_mismatch`·`oauth_denied`·`token_exchange_failed`·`codex_not_found`·`login_failed`. 종료 코드는 성공 0, 실패 1.
- SIGTERM/SIGINT: 자식 `codex`를 끄고 임시 `CODEX_HOME`을 지운 뒤 `{"done":true,"ok":false,"error":"cancelled"}`.
- 로그인이 끝나면 실행 중인 서버에 SIGHUP을 보내 재시작 없이 새 계정을 쓴다(계정 0개로 떠 있던 서버도 같다).

## 묶음 만들기

```sh
node scripts/build-app-bundle.mjs [출력 폴더]   # 기본 dist/
# 출력: <sha256>  dist/teamproxy-app-<버전>.tar.gz
```

정렬된 항목, 고정 mtime·소유자·모드, gzip 이름·시각 없음이라 같은 소스는 늘 같은 SHA-256이다.
담는 것: `package.json`·`LICENSE`·`README.md`·`config*.example.json`·`src/`·`scripts/install*`(`install-app.mjs` 포함). 압축을 푼 폴더에서 `<node> scripts/install-app.mjs --app --json --node <node>`를 실행한다.

## `proxy.host` (서버 설정)

설정의 `proxy.host`가 서버(supervisor)의 바인딩 주소다. 앱 설치는 `127.0.0.1`로 적어 같은 PC에서만 받는다.
제약: 값을 루프백이 아닌 주소나 `::1`로 두면 CLI(`status`·`stop`·`--json` 명령)가 `127.0.0.1`만 찾으므로 서버를 못 찾는다. 앱 설치는 `127.0.0.1`이다.
값이 없으면 지금처럼 호스트를 지정하지 않아 모든 인터페이스에서 받는다(원격 사용자 호환). 원격에 열려면 값을 지우거나 `0.0.0.0`으로 둔다.
