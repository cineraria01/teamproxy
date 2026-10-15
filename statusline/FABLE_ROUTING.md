# Fable 초기화 순서로 사용하기

상태줄 정렬은 표시만 바꾼다. `teamclaude-fable-routing.mjs`는 실행 중인
TeamClaude의 계정 선택에 Fable 초기화 순서를 적용하는 Node 시작 모듈이다.
검증 대상은 로컬 TeamClaude 1.4.3이다. npm 패키지 파일은 수정하지 않는다.

- 수동 priority는 이 모드에서 무시한다. 기존 연결도 매 요청마다 다시 선택한다.
- Fable 초기화가 가장 가까운 사용 가능한 계정을 먼저 쓴다.
- 만료·미확인 Fable 초기화는 뒤로 보낸다. 같은 시간이면 기존 세션 기준으로 정렬한다.
- 동시 요청 한도, 비활성화, 오류, 할당량 및 429/5xx 대체 전환은 그대로 유지한다.
- 아직 할당량을 모르는 계정의 최초 측정과 백그라운드 probe는 다른 계정도 사용할 수 있다.

## 설치·검증

```sh
python3 install-fable-routing.py
```

설치기는 실제 설치 패키지로 회귀 테스트를 먼저 실행한다. 통과하면
`~/.claude/teamclaude-fable-routing.mjs`를 복사하고 기존 TeamClaude LaunchAgent plist에
`--import`를 추가한다. plist는 `--plist`, `TEAMCLAUDE_PLIST`, 그다음
`~/Library/LaunchAgents/*teamclaude*.plist` 순으로 정하며, 마지막 경우 하나가 아니면(없거나 여럿)
아무것도 바꾸지 않고 멈춘다. 최초 plist 백업은
같은 경로의 `.pre-fable-routing` 파일이다. 설치 자체는 재시작하지 않는다.
진행 중 요청이 끝나면 launchctl bootout/bootstrap으로 변경된 plist를 다시 로드한다
(`kickstart`만으로는 변경된 ProgramArguments가 반영되지 않는다).
이후 재시작은 `launchctl kickstart -k gui/$(id -u)/<라벨>`로(`<라벨>`은 그 plist의 `Label`) 한다.
맨 `teamclaude restart`는 CLI 프로세스 안에서 별도 서버를 시작하므로 시작 모듈을
우회한다. 수동 서버 실행이 필요하면 반드시 위 모듈의 `node --import …` 형식을 사용한다.

`GET /teamclaude/status`의 `routingPolicy: "fable-reset"`로 모듈 적용을 확인한다.
`currentAccount`는 마지막 주 선택 상태이므로 재시작 직후에는 이전 snapshot 값일 수 있다.
첫 요청 이후 Fable 순서와 일치하는지 확인한다. 상태줄도 이 모드에서는
`TEAMCLAUDE_STATUSLINE_INDEX`보다 서버의 실제 `currentAccount`를 표시한다.

일반 npm 패키지 재설치는 시작 모듈을 지우지 않는다. Node 경로나 LaunchAgent 자체를
다시 만드는 업데이트 후에는 설치기를 재실행한다. 내부 선택 메서드를 사용하는 만큼
TeamClaude 업데이트 후에는 `node test_fable_routing.mjs "$(command -v teamclaude)"`로
호환성을 확인한다. 자동 호환을 보장하지 않으며 필요한 메서드가 사라지면 시작 오류를 낸다.

복구하려면 백업 plist를 복원한 뒤 해당 LaunchAgent를 다시 로드한다.

## 2026-09-06 적용 확인

로컬 서비스에 적용하고 모든 수동 priority를 해제했다. 격리된 실제 프록시 테스트에서
시간순 선택, 기존 연결 고정, 한도 초과, 큐 해제, 429 대체 전환과 복귀를 확인했다.
라이브 `/v1/models` 조회는 `anthropic-version` 헤더를 포함해 HTTP 200이었고,
`currentAccount`와 상태줄은 Fable 초기화가 가장 빠른 5번 계정을 가리켰다.
