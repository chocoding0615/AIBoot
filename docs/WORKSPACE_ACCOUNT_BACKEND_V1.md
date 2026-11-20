# 계정 연결 v1 백엔드 — 구현·검증·인계

2026-11-20. 기준 main: `26b3663e9338b7b83f51e505a74a43830274c450`.

**준비 A 계약과 B 구현은 별도 PR이다. 운영 배포·실제 재인증·Claude Code UI 개발·Antigravity 독립 합격을 뜻하지 않는다.**

## 계약의 유일한 기준

[docs/WORKSPACE_ACCOUNT_CONNECTION_V1.md @ c6af46503369fa432c65ec9477e5c13aab0a9298](https://github.com/chocoding0615/AIBoot/blob/c6af46503369fa432c65ec9477e5c13aab0a9298/docs/WORKSPACE_ACCOUNT_CONNECTION_V1.md) — Draft PR #35의 Codex 기술 검증본. 경로·필드·enum·오류·최소 소스·권한 정의는 이 문서만 따른다. 이 구현 브랜치는 main 기반이며 PR #35 문서를 복사하거나 그 브랜치 위에 기능을 쌓지 않았다.

기존 GET4종과 세션은 [WORKSPACE_CONNECTION](WORKSPACE_CONNECTION.md), 반복 예약은 [REPEATING_REPORT_API](REPEATING_REPORT_API.md) 그대로다. UI 검토 기준은 AIWorkspace PR #4 `c9509bb36be9e7c8423e954b527e04df402936ca`다.

## 변경 파일·재사용

| 파일 | 변경·재사용 |
|---|---|
| integrations/chat-assistant/sources.mjs | 기존 clients 로더·OAuth2·setCredentials 재사용. 서비스 선택과 인스턴스별 onAuth 옵션만 추가, 기본 호출 동작 유지 |
| integrations/shared/official-sources.mjs | 기존 파일명/탭명/gid 검사와 요청별 캐시를 재사용하는 메타데이터 검증 메서드 |
| integrations/workspace-api/accounts.mjs | 최소 검사·상태 분류·공통 busy·SDK refresh 포함 전송 예산/취소·재시도/쓰기 차단 |
| integrations/report-scheduler/api.mjs | 기존 Bearer/loopback 검사 뒤 새 POST와 v1 오류 봉투 연결 |
| integrations/workspace-api/session.mjs | 기존 세션/CSRF/Origin/Host 프록시에 정확한 새 POST 한 경로만 추가 |
| integrations/workspace-api/cli.mjs | 기존 서버에 명시적 opt-in 플래그 연결. 기본 비활성 |
| integrations/workspace-api/tests/accounts.test.mjs | 기존 시험을 복제하지 않은 계정 검사 회귀·설치 SDK 합성 통합 시험 |
| integrations/workspace-api/verify-accounts.mjs | 승인 후 쓰는 실계정 최소 읽기 검증 도구. 보호 상태는 우회하지 않음 |
| 이 문서 | 구현·실측·미검증·Claude Code/Antigravity 인계 |

CURRENT, 정기 보고 runner, 고정비 규칙·업무 판정, 운영 config/OAuth/원장/커서/스케줄러/예약 dispatch 설정은 변경하지 않는다. 표준 Node 모듈과 기존 Google SDK만 사용하며 새 의존성·인증 시스템·AI 모델·유료 서비스를 넣지 않았다.

## 기존 인증 처리 근거

- Sheets는 기존 SDK 디렉터리의 credentials 및 OAuth keys, Chat은 기존 chat-token과 선택 chatOAuthKeys(없으면 기존 keys)를 읽는다. 경로·ID 원문은 응답에 주지 않는다.
- 인증 파일의 저장 경로·권한은 변경하지 않았다. 실제 제어 access 파일의 기존 사용자/SYSTEM ACL 검사는 통과했다. 기존 OAuth 파일의 사용자 소유·도구 읽기 권한은 별도 읽기 점검으로 확인했다.
- SDK144.0.0/auth9.15.1의 기존 refresh는 메모리 갱신이다. 검사 전용 새 인스턴스에만 transporter wrapper를 달며 원래 SDK 객체·전역 prototype·운영 runner 인스턴스를 바꾸지 않는다.
- wrapper는 승인 Google 호스트의 Sheets 메타데이터/Chat 목록 GET과 기존 refresh_token grant만 전송한다. 새로운 grant·scope 인자·타 호스트·다른 POST 및 같은 자원/refresh 재시도는 전송 전에 거절한다.
- refresh와 자원 모두 동일 AbortSignal, 남은15초 예산, retry=false다. tokens 저장 listener가 있으면 검사 준비를 거절한다. 새 토큰을 파일·다른 프로세스·브라우저에 저장/전달하지 않는다.
- Sheets의 기존 OAuth scope가 쓰기도 허용할 수 있다는 사실과 검사 코드가 읽기만 한다는 사실을 구분한다. Chat은 기존 readonly 승인을 그대로 사용한다.
- 수동 재인증 안내만 제공한다. 기존 Chat CLI의 백업 경로를 코드에서 확인했으나 실제 Google 동의/콜백/복구를 실행하지 않았다. Sheets 외부 인증 도구의 재승인 명령은 확인되지 않아 임의 안내하지 않는다.

## Claude Code 인계

브라우저 호출은 **17842의 POST /api/connections/verify**다. 요청:
```json
{"sources":["sheets","chat"]}
```

1. PR #4의 createLiveConnection/session.login/check/logout과 raw/observe, 메모리 CSRF·HttpOnly 쿠키를 재사용한다.
2. 기존 GET 어댑터는 변경하지 않고 createLiveConnection 내부에 전용 verify 어댑터를 추가한다. 이 API는 apiVersion=v1이고 기존 GET은 v0다.
3. 기존 raw 호출 예: `raw('POST','/api/connections/verify',{body:{sources},signal,withCsrf:true})`. 브라우저에 Bearer/OAuth·인증 경로를 추가하지 않는다.
4. 로그인 전 local login_required, 로컬 HTTP401 AUTH_REQUIRED만 세션 만료 처리한다. HTTP200 item의 AUTH_REQUIRED는 Google 재인증 안내이며 UI 세션을 로그아웃시키지 않는다.
5. 전부 connected일 때만 status=ok다.200 partial도 서비스별 실패이며 초록색 전체 성공으로 표시하지 않는다. configured·미조회·connected를 구분한다.
6. checkedAt=null은 미시도다. 현재 시각을 대신 넣지 않는다. 정상 연결은 검사한 최소 범위만 보장한다.
7. 로그인용5초 timed wrapper를 Google 검사에 그대로 쓰지 않는다. 서버15초/프록시17초와 사용자 취소 signal을 고려한다. UI 예산20초는 제안이며 운영 실측값이 아니다.
8. 명시적 버튼만 호출하고 자동 polling·페이지 진입 probe·토큰 교체·새 OAuth·계정 라벨 추정·실제 예약 쓰기는 하지 않는다.
9. 정상2종, 단독 서비스, 미설정/미조회, invalid_grant, 일반401/403, 명시 scope 부족, API 비활성, 네트워크/timeout, 서비스 내 부분 접근, mixed partial, null시각, disabled503, 로컬401/403, 보호409, 동시429를 Mock으로 검증한다.

예를 들어 Sheets connected + Chat reauth_required는200 partial이며, Chat에만 수동 재인증 안내를 보여 준다. 기존 연결 서랍·로그인 구성·모바일 상태 메뉴를 재사용하는 화면 작업은 Claude Code 담당이다. 이 PR은 UI를 수정하지 않는다.

## 개발 검증 명령·결과

```powershell
node --test integrations/workspace-api/tests/accounts.test.mjs
node integrations/recurring-sheet/build.mjs --check
```

설치 SDK 증명 시험은 AIBOOT_GOOGLE_SDK_DIR에 기존 SDK 디렉터리를 지정한다. 이는 라이브 인증 파일을 읽거나 Google에 접근하지 않고 합성 홈·가짜 전송과 localhost만 사용한다. 변수가 없으면 SDK 의존 시험4개는 skipped이며, 이번 Windows 검증에서는 모두 실행했다.

- 기존 회귀366개 + 신규44개 = 최종 전체410개 통과, 실패/건너뜀0을 확인했다.
- 실제 Windows CLI를 합성 홈에서 실행해 기존 로그인과 기본 VERIFICATION_DISABLED503, 쓰기/발송 false를 확인했다.
- 실제 SDK 경로에서 Sheets 메타데이터·Chat 목록, 메모리 refresh, invalid_grant 전파, 파일 바이트 불변을 합성 검증했다.
- 실제 SDK HTTP 요청의 AbortSignal 취소는 localhost 서버로 검증했다. 실제 Google 장애·실제 grant 폐기·계정 재승인 시험과 구분한다.
- AIWorkspace PR #4의 기존 클라이언트93개 시험도 임시 읽기 사본에서 통과했다. 신규 화면 준비 C 또는 실제 브라우저 인수 완료를 뜻하지 않는다.

## 실환경 읽기 검증·운영 영향

사용자 승인 범위에서만 다음 도구를 수동 실행한다. 자동 회귀에는 포함하지 않는다.
```powershell
node integrations/workspace-api/verify-accounts.mjs --confirm-existing-auth-read-only
```

기존 파일 해시와 정기 작업 XML을 사용자 전용 비공개 감사 폴더에 보존 → 임시 localhost 세션/제어 서버 → 새 POST 최소 검사 → 기존 GET connections 전후 비교 → 서버 종료 → 파일·작업 불변 확인 순서다. OAuth/업무 원문은 로그·Git에 저장하지 않으며 실제 토큰 복사본을 새로 만들지 않는다.

2026-11-20 10:51 KST:409 REPORT_PROTECTED, 외부 읽기/refresh/모델/웹훅0. 기존 GET 호환 및 운영 설정·원장·인증 파일·커서 해시·작업 XML 불변, 임시 서버 종료를 확인했다. 보호 시간 외 실접근 결과는 추가 확인 전 성공으로 표시하지 않는다.

기능은 기본 비활성이다. 운영 설치·검토 승인 후 기존 serve의 --enable-account-verification opt-in이 필요하다. 이번 개발에서 운영 코드 덮어쓰기·지속 실행·자동 시작·Windows 작업 변경·실제 재인증·토큰 파일 교체·병합은 하지 않는다.

## Antigravity 독립 검증·인수 대기

C 완료 뒤 D에서 실제 구현 커밋과 위 계약 커밋을 함께 검토한다. Codex 설명만으로 PASS하지 않는다. 우선 검토 대상은 onAuth 기본 동작 불변, 인스턴스별 전송 wrapper/refresh 안전성, 최소 원본 범위, 상태 분류, 권한 경계, busy/취소, 파일·원장·커서 불변이다.

Codex는 기능·통합·회귀 결과를 제공한다. Antigravity의 독립 코드·보안 검토와 Claude Code C/D 화면 통합, 실제 Google 오류·재인증·사용자 인수는 별도 완료 증거가 필요하다. 계약 PR #35 → 구현 PR 순으로 검토·병합하되 양쪽 모두 사용자 승인 전 병합·운영 반영하지 않는다.
