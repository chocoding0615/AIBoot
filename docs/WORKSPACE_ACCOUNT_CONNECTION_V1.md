# AIWorkspace 계정 연결 계약 v1 — Codex 기술 검증본

작성 2026-11-20. 기준 AIBoot main: `26b3663e9338b7b83f51e505a74a43830274c450`. 기존 [CURRENT](../CURRENT.md), [WORKSPACE_CONNECTION](WORKSPACE_CONNECTION.md), [AIWorkspace API_CONTRACT](https://github.com/chocoding0615/AIWorkspace/blob/main/docs/API_CONTRACT.md)의 권한을 확대하지 않는다. **계약 PR #35는 Draft 유지. 기술 검증은 운영 활성화·사용자 인수 또는 Antigravity 독립 검토 완료를 뜻하지 않는다.**

## 1. 실제 코드 검증 및 초안 보완

| 초안의 모호점·충돌 | 확인 근거·최소 보완 |
|---|---|
| '자동 토큰 갱신 금지'와 기존 OAuth 재사용 | 설치 googleapis 144.0.0 / google-auth-library 9.15.1은 만료 access token을 기존 refresh grant로 메모리 갱신한다. sources.clients는 토큰 파일 읽기·setCredentials만 하며 tokens 저장 listener가 없다. **기존 grant의 메모리 access token 갱신은 허용하되 파일 교체·새 승인·refresh token 저장·scope 확대는 금지**한다. |
| SDK refresh도 취소되는지 불명 | SDK refreshTokenNoCache는 별도 POST이며 자체 retry 기본값이 있다. 검사 전용 OAuth 인스턴스의 transporter에 동일 AbortSignal·남은 예산·retry=false를 적용하고 같은 자원/refresh 재시도를 차단한다. 전역 SDK·정기 보고 인스턴스는 바꾸지 않는다. |
| '둘 중 하나만'과 두 서비스 예시 | sources는 sheets/chat 중 1개 또는 2개이며 중복·추가 필드는 거절한다. |
| Sheets가 어느 범위까지 connected인지 불명 | 승인 파일4개·gid8개를 기존 공식 원본 검증기로 메타데이터만 확인한다. Chat은 지정 공간2개에서 메시지 목록의 nextPageToken 필드만 조회한다. 본문·업무 행은 읽지 않는다. |
| 401과 token expiry 혼동·UI 세션 로그아웃 위험 | 토큰 endpoint의 구조화된 invalid_grant만 reauth_required다. 일반 401·원인 불명403은 error/CHECK_FAILED. Google 오류는 items 안에 표시하며 UI 로그인 AUTH_REQUIRED HTTP401과 구분한다. |
| '부분 실패'·전부 실패 HTTP 의미 불명 | 분류된 서비스 결과가 있으면 항상 HTTP200이고, 전부 connected인 경우만 status=ok. 그 외 status=partial이며 서비스별 실패를 보존한다. HTTP200 자체를 연결 성공으로 표시하지 않는다. 전체 요청 차단·서버 준비 실패·세션 오류는 별도 HTTP 오류다. |
| 현행 프록시는 GET4종/예약 경로만 허용 | 기존 인증·Host·Origin·CSRF를 통과한 정확한 POST /api/connections/verify 한 경로만 추가한다. GET4종·예약 계약·UI 로그인 방식은 바꾸지 않는다. |

설치 SDK + 합성 토큰·가짜 전송 시험에서 refresh1회/자원1회, 메모리 access token 갱신, 기존 refresh token 유지, 인증 파일 바이트 불변, tokens listener0, refresh retry=false·signal·timeout 적용을 확인했다. 실제 Google 갱신·재승인 시험으로 과장하지 않는다.

## 2. 범위·기존 구성

동일 PC UI `127.0.0.1:5173 → 세션 백엔드17842 → 서버 내부 Bearer → 제어 API17841`를 유지한다. 기존 일회용 코드·HttpOnly 세션·CSRF·Origin·Host·Windows 제어 토큰 ACL을 재사용한다. 브라우저에는 OAuth·제어 Bearer·웹훅·계정 주소·Google ID·인증 경로·오류 원문을 주지 않는다.

기존 OAuth 파일은 현재 운영 설정의 경로에서 읽기만 한다. 파일 ACL 확인 결과 현재 사용자 소유, SYSTEM/관리자 권한 및 Codex 도구의 읽기 전용 권한이 존재했다. 이를 임의 제거하거나 새 계정에 권한을 주지 않는다. 검사 프로세스는 같은 Windows 사용자로만 실행한다. 제어 API의 사용자 전용 access 파일 검증은 그대로 유지한다.

09:30/16:00 정기 보고·Antigravity·원장·완료 이력·Chat 커서·스케줄러·추가 예약 allowDispatch는 변경하지 않는다. 신규 OAuth/계정 전환·scope 확대·LAN/iPhone·실발송·Sheets 쓰기·보호 시간30분·최대2회·오류 알림은 제외한다.

## 3. API 및 인증

`POST /api/connections/verify`
```json
{"sources":["sheets","chat"]}
```
sources는 1~2개, 정확한 소문자 문자열만 허용한다. 쿼리·다른 필드·중복·임의 ID/공간/URL/파일 경로는 거절한다. JSON 최대32768바이트. 새 Idempotency-Key나 사용자 승인 기록은 만들지 않는다.

브라우저는 기존 로그인 후 쿠키 + X-CSRF-Token, 승인 UI Origin으로17842만 호출한다. 제어 API17841은 서버 간 Bearer만 허용하며 브라우저 Origin/Sec-Fetch 요청을 거절한다. 사용자 버튼 외 자동 polling/probe는 금지다.

기능은 기본 비활성이다. 구현 PR 승인·운영 설치 및 안전 검토 후 관리자가 기존 serve에 `--enable-account-verification`을 명시해야 한다. 이번 작업은 운영 서버 설치·이 플래그 상시 활성화·자동 시작을 하지 않는다. GET /api/connections는 설정 근거의 not_checked를 유지하며 verify 결과를 저장/덮어쓰지 않는다.

## 4. 응답·상태

```json
{
  "requestId":"verify:opaque",
  "apiVersion":"v1",
  "status":"ok",
  "data":{"items":[
    {"provider":"google","service":"sheets","configured":true,"state":"connected",
     "checkedAt":"2026-11-20T02:30:00.000Z","verifiedAccess":true,
     "scopeStatus":"sufficient","accountLabel":null,"action":"none","errorCode":null}
  ]},
  "meta":{"requestedAt":"2026-11-20T02:29:59.000Z","completedAt":"2026-11-20T02:30:00.000Z"}
}
```

| state | 실제 근거 | verifiedAccess / scopeStatus | action / errorCode |
|---|---|---|---|
| not_configured | 필수 운영 설정·gid·인증 파일 미설정/부재 | null / unknown | contact_admin / NOT_CONFIGURED |
| not_checked | 아직 검사하지 않은 UI 초기 상태·기존 GET 근거. disabled를 connected로 바꾸지 않음 | null / unknown | none (또는 관리자 조치 안내) |
| connected | Sheets4파일·8gid 또는 Chat2공간의 **모든** 최소 검사 성공 | true / sufficient | none / null |
| reauth_required | OAuth refresh endpoint의 구조화된 invalid_grant | false / unknown | local_reauth_required / AUTH_REQUIRED |
| access_denied | 구조화된 명시 권한 거부 | false / unknown. 명시적 scope 부족일 때만 insufficient | contact_admin / PERMISSION_DENIED |
| unavailable | 네트워크·429·5xx·시간 초과 | null / unknown | retry_verify / NETWORK_ERROR 또는 TIMEOUT |
| error | 일반401·원인 불명403·API 비활성·원본/gid 불일치·파손·검증 실패 | null / unknown | contact_admin / CHECK_FAILED |

checkedAt은 RFC3339 문자열 또는 null이다. 전체 예산 부족 등으로 해당 서비스의 설정/접근 검사를 시작하지 못했으면 null이며 임의 시각을 만들지 않는다.

configured는 접근 성공이 아니다. checkedAt은 해당 설정/접근 검사를 수행한 서버 시각이며 원본 갱신·동기화 시각이 아니다. 충분한 scope는 **이번 최소 읽기 권한**만 뜻하며 승인된 전체 자료·쓰기 권한이나 OAuth scope 목록을 인증하지 않는다. accountLabel은 항상 null이다.

Sheets 일부 파일 또는 Chat 한 공간만 성공하면 해당 서비스는 connected가 아니다. 서비스마다 성공한 전체 최소 검사만 verifiedAccess=true다. 다른 서비스의 확인된 결과는 보존한다. 모든 서비스가 not_configured/error/unavailable여도 분류 결과가 존재하면200 partial이며 UI는 각 state를 표시한다. timeout 시 진행 전송을 취소하고 끝나지 않은 서비스는 unavailable/TIMEOUT으로 남긴다. 부분 성공을 숨기거나 자동 재시도하지 않는다.

## 5. HTTP 오류·운영 보호

오류 봉투는 `{requestId,apiVersion:"v1",status:"error",error:{code},meta:{requestedAt,completedAt}}`다. 기존 세션 백엔드 자체 오류의 `{error:{code}}` 형식도 그대로 유지한다.

- 400 INVALID_REQUEST / INVALID_JSON: 미승인·잘못된 입력. 외부 호출0.
- 401 AUTH_REQUIRED: 로컬 사용자 세션/Bearer 없음. Google invalid_grant는 이 HTTP 오류로 보내지 않는다.
- 403 CSRF_BLOCKED / LOCAL_ONLY: Origin·Host·CSRF·접근 경계 위반.
- 405 METHOD_NOT_ALLOWED, 413 BODY_TOO_LARGE, 415 JSON_REQUIRED.
- 409 REPORT_PROTECTED: 기존 09:00~11:15 /15:30~17:45, generating/sending/unknown 원장, 공통 lease/guard/복구 또는 ledger 잠금. 기존 규칙을 확장 해제하지 않는다.
- 429 RATE_LIMITED: tasks 또는 다른 verify가 실행 중. 저장 없는 공통 메모리 gate를 공유한다.
- 503 VERIFICATION_DISABLED / CHECK_UNAVAILABLE: 미활성 또는 서버 검사 준비 불가. 재인증 필요로 표시하지 않는다.
- 세션 계층의 CONTROL_OFFLINE(503)/TIMEOUT(504)은 기존 계약 유지. 서버가 분류할 수 있는 Google 시간 초과는 HTTP200 partial의 item TIMEOUT이다.

요청 전체 예산15초(설계 제한, 운영 SLA 아님), 세션 백엔드17초. 자원·refresh 모두 남은 예산·동일 signal·retry=false 적용. 기존 SDK가 같은 자원/refresh를 재시도하려 해도 전송 전에 차단한다. 프로세스당 tasks/verify 합쳐1건. 각 외부 호출 직전·요청 중·완료 직전에 정기 보호를 재확인한다. 보호 상태로 바뀌면409로 중단하며 부분 결과로 우회하지 않는다.

## 6. 재인증·복구

이번 단계는 수동 안내뿐이다. 기존 메모리 access token 갱신과 새로운 사용자 OAuth 동의는 다르다. 만료 시각·refresh token 존재만으로 '재인증 필요'나 '정상 연결'을 만들지 않는다. 검사에서 얻은 새 access/refresh token은 파일에 저장하지 않으며 정기 보고 인증 인스턴스와 공유하지 않는다.

Chat의 현행 로컬 --auth-chat 절차는 지정 두 readonly scope를 검사하고 기존 토큰 backup 후 교체하는 별도 운영 명령이다. 실행·Google 동의·콜백·복구를 이번에 시험하거나 웹에서 호출하지 않는다. Sheets는 현재 배치된 외부 인증 도구의 실제 재승인·복구 절차가 미확정이므로 임의 명령/승인 URL을 만들지 않는다. UI에는 '기존 인증을 백업한 후 관리자에게 승인된 로컬 재인증을 요청하세요'만 안내한다. scope 부족도 새 권한을 요구하지 않고 관리자 확인으로 남긴다.

운영 auth 파일·키·원장·설정·커서·작업 XML은 전후 해시로 대조한다. 실제 변경이 필요하면 별도 사용자 승인·백업·복구 계획이 필요하다.

## 7. Claude Code 인계 및 독립 검증

PR #4의 createLiveConnection/session.login/check/logout, 메모리 CSRF·credentials:include·127.0.0.1 주소 검증을 재사용한다. 신규 계정 확인 어댑터만 위 POST를 명시적으로 호출해야 한다. 기존 GET adapter에 POST를 끼워 넣거나 별도 로그인/OAuth 플로우를 만들지 않는다. Google item AUTH_REQUIRED를 UI 세션 로그아웃으로 해석하지 않는다. Codex는 AIWorkspace 파일을 수정하지 않는다.

Mock 필수: 두 서비스 정상, 서비스별 단독, 미설정, 미조회, invalid_grant, 일반401, 명시403/scope부족, API비활성403, 429/5xx/offline, deadline·취소, 한 서비스 또는 같은 서비스의 일부 자원만 성공, malformed·중복 입력, disabled, 로컬401·CSRF/Origin/Host403, REPORT_PROTECTED409, tasks/verify 동시429. 기존 GET4종·예약 validate·로그인 회귀를 유지한다.

B(Codex)와 C(Claude Code)는 이 계약 버전을 기준으로 분리 PR을 제출한다. 경로·enum 변경은 계약을 먼저 수정한다. D는 C 완료 후 Codex 통합 시험 + Antigravity의 실제 코드·계약·보안 독립 검토이며 현재 완료로 표시하지 않는다. 사용자 승인 전 자동 병합·운영 배포·지속 실행·실제 재인증 금지.
