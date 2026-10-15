# Claude 계정을 장기 토큰(`claude setup-token`)으로 운영하기

2026-10-07부터 오너가 관리하는 모든 머신(로컬 맥과 서버 5대)과
UUP 상담 초안 워커의 Claude 풀은 같은 장기 토큰 5개(`lt-1`~`lt-5`)를 쓴다. 넣는 절차·스크립트는
이 포크의 `docs/install/INSTALL-ALL.md` §2-1이 정본이고(2026-10-10 옛 `cineraria01/teamcodex`에서 옮김), 이 문서는 프록시가 그 계정을 어떻게
다루는지를 적는다.

## 왜 바꿨나

`teamclaude login`(refresh 방식) 계정은 8시간마다 갱신이 성공하다가 **로그인 후 약 한 달**에
`invalid_grant: Refresh token expired`로 끊긴다. 2026-10-03~05에 서버 쪽 5계정이 차례로 끊겼고,
같은 시기 서버 2대의 계정은 9월 중순부터 이미 전부 만료된 채 돌고 있었다. 장기 토큰은
refresh 토큰이 없어 이 만료가 없다(약 1년).

## 프록시가 refresh 없는 계정을 다루는 방식

- `AccountManager.ensureTokenFresh`는 `refreshToken`이 없으면 바로 돌아간다 — 주기 갱신·요청 경로
  갱신 모두 건너뛴다. karpeleslab 1.4.2도 같다.
- 계정 선택(`_selectBest` → `autoCompare`)은 **주간(7d) 리셋이 가장 이른 계정**을 먼저 쓰고, 그 값은
  응답 헤더(`anthropic-ratelimit-unified-7d-*`)로 채워진다 — 장기 토큰에서도 정상이다.
- 사용량 조회(`refreshAnthropicUsage`, `/api/oauth/usage`)와 프로필 조회는 **403**
  (`scope requirement any_of(user:profile, …)`)이다. 실패는 로그만 남고 계정을 격리하지 않는다. 그 결과
  모델별 주간 창(Fable `7d_oi`)은 그 계정으로 Fable 요청이 지나가기 전까지 비고, 계정 이메일·
  `accountUuid`를 알 수 없어 토큰 ↔ 계정 대응은 발급 순서로 직접 기록해야 한다.
- 장기 토큰 계정이 401을 받으면 갱신 재시도 없이 오류 계정으로 빠지고 다른 계정으로 넘어간다
  (재시작 전까지 유지). 무효 토큰(복사하다 끝 글자가 빠진 107자)은 이렇게 보인다.

## 반영과 확인

- 계정 교체 후 무중단 반영: `kill -HUP $(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.config/teamclaude.server.json")))["workerPid"])')`.
  `workerPid`가 없는 설치본(karpeleslab)은 서비스 재시작.
- 확인: `/teamclaude/status`(헤더 `x-api-key` = 설정의 `proxy.apiKey`)에서 `lt-*`가 `active`.
- ⚠ Claude Code 세션 안에서 `teamclaude import|disable|remove|status --json`이 설정을 쓴 뒤
  서버 재적재 단계에서 멈출 수 있다(2026-10-07 로컬 맥). 설정은 이미 써졌으니 SIGHUP으로 반영한다.

## 교체

토큰은 발급일 기준 약 1년이다(만료일이 표시되지 않는다). 11개월쯤 같은 절차로 다시 발급해 교체한다.
한 개가 무효가 되면 그 계정 하나만 재발급해 목록 전체를 다시 넣는다(순서 유지).
