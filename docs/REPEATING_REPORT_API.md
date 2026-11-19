# 반복 추가 예약 보고 API v1 — 검토용 구현 계약

2026-11-19. 대상: AIBoot의 기존 실행기 + 로컬 예약 관리 어댑터. 기존 09:30/16:00 KST 정기 보고는 변경하지 않는다. 이 문서는 운영 설치·예약 등록·발송 승인이 아니다.

## 상태·경계

- 신규 구현이며 기본 쓰기 비활성·실제 추가 발송 비활성의 이중 차단이다. 실제 Windows 작업 등록·예약 발송·절전/로그아웃/재부팅 통합 검증 전 운영 적용 금지.
- 기존 AIWorkspace GET health/reports/tasks/connections와 향후 actions/prepare/confirm 계약을 변경하거나 재사용하지 않는다.
- 추가 예약은 매주 지정 요일 반복, 최대 16개(삭제되지 않은 예약 기준). 예약당 별도 작업을 생성하지 않고 관리되는 Windows 작업 AIBoot-ExtraReports 하나에 최대 16개 주간 트리거를 등록한다.
- Antigravity 단독, 기존 Google Chat 웹훅·기존 승인 Sheets/Chat 범위·공식 계약 DB와 분류·gid 검증을 재사용한다. 브라우저나 API 응답에 비밀·회사 원문·파일/시트 ID·원문 메시지 ID·임의 실행 명령을 반환하지 않는다.
- 실행 시작 예정 시각이다. 완료/웹훅 접수/사용자 수신 시각을 보장하지 않는다.

## 접근·인증

127.0.0.1:17841에만 수신한다. 다른 포트는 명시 로컬 CLI 설정만 허용한다. LAN/0.0.0.0·모바일 원격 공개·CORS·쿠키 기반 자동 인증은 지원하지 않는다.

신뢰된 동일 PC 백엔드가 Authorization: Bearer <로컬 32바이트 무작위 제어 토큰>으로 호출한다. 브라우저는 자체 UI 백엔드를 통해 연결해야 한다. Google 토큰이나 웹훅을 이 인증에 사용하지 않는다.

토큰은 init-access로 사용자 전용 ACL 폴더의 access.json에 생성하며 출력/URL에 넣지 않는다. 현 사용자와 SYSTEM 외 Allow ACE가 있으면 시작을 거절한다. Origin 또는 Sec-Fetch-Site 헤더가 있는 요청, Host 불일치, 비루프백 연결은 차단한다. CSRF를 피하려고 인증을 생략하는 폴백은 없다.

serve는 기본 writeEnabled=false다. 별도 설치 승인 후 인증·ACL·호출 주체·Windows 권한을 검증하고 --enable-writes로 명시 시작해야 변경할 수 있다. 인증 검사 실패 시 서버는 시작하지 않는다. 운영 인증/실제 변경 권한은 배포 전에 재검증한다.

예약 관리 쓰기 허용과 실제 추가 발송 활성화는 별개다. init-access는 allowDispatch=false로 생성한다. 추가 작업이 등록되어 있어도 이 값이 false면 해당 회차는 held/DISPATCH_DISABLED로 표시하고 모델·웹훅을 호출하지 않는다. 실제 runner 진입도 이 값을 재확인한다. 별도 발송 승인·비발송 QA 후 로컬 activate-dispatch --confirm-dispatch로만 활성화한다. 비활성화는 deactivate-dispatch --confirm-dispatch이며 이미 실행 중인 회차를 취소하지 않는다. 원격 활성화 API는 없다.

## 공통 자료형

Rule:
- weekdays: 중복 없는 정수 배열 1~7(월=1, 일=7), 1개 이상.
- time: HH:mm, 00:00~23:59.
- effectiveFrom?: YYYY-MM-DD KST. 미래 적용 날짜를 명시할 때 사용한다.
- 시간대는 Asia/Seoul 고정이며 클라이언트가 변경하지 못한다. 알 수 없는 필드는 거절한다.

Schedule:
- id: 서버 생성 UUID v4. 수정·일시정지·재개·삭제에도 같은 ID 유지, 삭제는 tombstone.
- version: 예약별 버전. configVersion은 전체 예약 설정의 낙관적 동시성 버전.
- enabled, deleted, timezone, rule.
- firstRunAt: 최근 생성/활성화/수정에서 확정된 최초 예정 회차.
- nextRunAt: 다음 주간 트리거 시각 또는 정지/삭제이면 null.
- 다음 예정 시각은 근무일 정책에 따라 건너뛸 수 있는 트리거 예정 시각이다. 서버는 결과 도착 시각으로 표현하지 않는다.

Run:
- key: extra|예약ID|예정시각(RFC3339 UTC)|antigravity.
- scheduleId, scheduledAt, scheduledDate(KST), startedAt, completedAt, webhookAcceptedAt.
- status: reserved | generating | sending | sent | failed_not_sent | unknown | held | missed | skipped_nonworkday.
- reason: 안전한 오류 코드 또는 null.
- receiptEvidencePresent: 웹훅 접수 증거 존재 여부. userReceiptVerified는 현재 null.
- scheduledDate는 실행/완료가 자정을 넘어도 바꾸지 않는다. startedAt/완료 시각으로 실제 날짜를 따로 알 수 있다.
- sent와 unknown은 다시 실행하지 않는다. failed_not_sent라도 v1은 자동 재시도하지 않는다. 다음 주간 회차는 별개다.

## HTTP 엔드포인트

모든 응답은 {data:...} 또는 {error:{code,details?}} JSON이다. 공통 요청 예산은 본문/헤더 수신 5초, JSON 최대 32 KiB, 변경 시 Windows 명령당 15초 제한이다. Windows 명령 timeout은 성공으로 간주하지 않는다. 변경 전체는 정합성 확인 또는 복구가 끝나야 확정한다.

| 메서드·경로 | 요청 | 응답 |
|---|---|---|
| GET /api/report-schedules | 파라미터 없음 | configVersion, timezone, serverNow, writeEnabled, reconciliationRequired, dispatchEnabled, triggerStatus(matched/mismatch/unavailable), triggerError, items[Schedule + lastRun] |
| GET /api/report-schedules/:id | UUID v4 | Schedule + 최근 100개 runs. 삭제된 예약의 이력도 조회 가능 |
| POST /api/report-schedules/validate | {operation, id?, rule?, expectedVersion} | configVersion, before, after, requiresConfirmation:true. 변경·작업 등록 없음 |
| POST /api/report-schedules | {rule, expectedVersion, confirmed:true} | 201, configVersion와 Schedule |
| PATCH /api/report-schedules/:id | {rule, expectedVersion, confirmed:true} | 갱신된 configVersion와 Schedule |
| POST /api/report-schedules/:id/pause | {expectedVersion, confirmed:true} | 정지 결과 |
| POST /api/report-schedules/:id/resume | 같은 형식 | 재개 결과. +20분 및 전체 주간 충돌 재검사 |
| DELETE /api/report-schedules/:id | 같은 형식 | deleted=true. 기존 실행 이력은 보존 |

validate의 operation은 create/update/pause/resume/delete다. 생성 preview의 ID는 미예약 임시값이며 저장 시 확정된 ID를 사용한다.

변경 요청은 Content-Type: application/json, Idempotency-Key(영숫자/_/- 16~100자)가 필요하다. 동일 키/동일 요청은 이전 확정 결과를 반환하며 다른 내용은 409다. client clock/클라이언트 계산 충돌 여부는 신뢰하지 않는다. 요청 query와 알 수 없는 최상위 필드, 임의 파일/명령/웹훅 지정은 금지한다.

## 유효성·충돌·우선순위

- Windows PC 서버 KST 기준 가장 가까운 요청 회차가 현재+20분 이상이어야 한다. 더 임박하면 LEAD_TIME으로 거절하며 자동으로 다른 시각/다음 주로 바꾸지 않는다. 미래 날짜는 effectiveFrom으로 명시한다.
- 저장 직전 Windows 반영 후에도 서버 시각으로 +20분을 재확인한다. 늦어졌으면 작업·설정을 복구한다.
- 요일 주기 전체를 주간 원형 구간으로 비교한다. 최초 회차 날짜가 달라도 미래 같은 요일의 겹침과 일요일→월요일 자정 경계를 검사한다.
- 정기 보고 보호 구간은 월~금 09:00~11:15, 15:30~17:45. 기존 15분 재시도·75분 재확인·생성 timeout·지연 여유를 보존한 보수적 차단이다. 추가 보고 20분 실행 예산이 조금이라도 겹치면 등록을 거절한다.
- 추가 예약끼리도 20분 실행 구간의 겹침을 거절한다. 15분 이하 간격은 지원하지 않는다.
- 실행 직전 실제 Windows 계획·설정 버전·회차 상태·공통 실행 lease·정기 보호 구간을 재검사한다. 충돌 시 held로 남기고 임의 시각 변경/우회 발송하지 않는다.
- 현재 예약 실행이 reserved/generating/sending이거나 공통 lease의 소유자/자식이 살아 있으면 예약 변경·삭제를 RUN_ACTIVE로 거절한다. 실행 중 snapshot을 수정하거나 강제 취소하지 않는다.
- 휴일·휴가·주말 판정은 기존 workday 정책을 실행 시 그대로 적용한다. 추가 예약 요일을 주말로 선택해도 기존 정책상 비근무일이면 skipped_nonworkday다. 숨김 탭·계약 분류·원본 범위 정책은 바꾸지 않는다.

## 저장·Windows 반영·복구

예약과 이력은 운영 config/기존 ledger와 분리한 ~/.aiboot/extra-reports/state.json에 저장한다. 임시 파일 fsync 후 원자 rename, 짧은 mutation.guard로 동시 쓰기를 직렬화한다.

변경 전 native 상태와 로컬 계획을 비교한다. pending 복구 기록을 먼저 영속화 → 고정된 추가 작업만 갱신 → 실제 작업 재조회 → 서버 시각 재검사 → 최종 저장 순서다. 실패 시 이전 작업과 설정으로 복원한다. 복구도 실패하면 pending을 남기고 추가 예약 변경·실행을 RECONCILIATION_REQUIRED로 차단한다.

전원 종료/요청 취소 후에는 성공 여부를 임의 판단하지 않는다. 동일 멱등성 키로 결과를 재조회하거나 재호출한다. 이미 확정된 변경은 HTTP 연결 취소로 취소되지 않는다. pending은 승인된 로컬 recover --enable-writes 절차로 이전 계획을 재적용한 후 해제한다.

공통 report-execution.json lease는 정기/추가 보고의 조회·생성·발송을 보호한다. PID와 생성 자식 PID가 살아 있거나 생존 확인이 불명확하면 TTL만으로 회수하지 않는다. 죽은 소유자만 짧은 mutex 안에서 회수하고 복구 메타데이터를 남긴다. 기존 원장 키·시도 횟수·Chat 커서는 건드리지 않는다. sending 이후 죽은 추가 회차는 unknown으로 남긴다.

짧은 mutex 자체를 보유한 채 강제 종료되면 guard가 남을 수 있다. 이를 시간만 보고 자동 삭제하지 않는다. 프로세스/자식/발송 상태 확인 후 별도 수동 복구가 필요하다. 이 경우 공통 실행 안전 차단으로 정기 보고도 지연될 수 있는 잔여 위험이다. 추가 상태 파일 손상만으로 정기 보고를 막지는 않는다.

## Windows·부재·용량

- 기존 정기 작업 두 개는 유지한다. 추가 작업은 Interactive/Limited, IgnoreNew, 최대 20분, WakeToRun=false, StartWhenAvailable=false다.
- Windows 시간대가 Korea Standard Time이 아니면 작업 반영을 거절한다. 앱 계산은 KST 고정이다.
- PC 종료/절전/로그아웃 중 실행을 보장하지 않는다. 늦은 회차를 소급 발송하지 않는다. 같은 예정 분 이내 진입만 허용하고 다음 분부터는 실행하지 않는다.
- 다음 dispatcher에서는 최대 최근 1주의 놓친 회차를 missed로 표시만 한다. 그보다 오래된 부재 기간은 완전한 회차 감사 범위가 아니며 자동 복구/발송하지 않는다.
- 재시작 후 같은 key는 다시 예약하지 않는다. dead sending은 unknown, dead 발송 전 상태는 failed_not_sent로 정리하며 자동 재실행하지 않는다.
- 멱등 요청 4096개, 실행 이력 10000개 상한에 도달하면 추가 기능을 차단하고 수동 보관 정책 결정을 요구한다. 성공/불명 키를 자동 삭제해 중복을 허용하지 않는다. 기존 정기 보고에는 이 상한을 적용하지 않는다.

## 오류

400 INVALID_RULE/INVALID_WEEKDAYS/INVALID_TIME/INVALID_DATE/INVALID_REQUEST/INVALID_JSON/INVALID_OPERATION/INVALID_IDEMPOTENCY_KEY/CONFIRMATION_REQUIRED.
401 AUTH_REQUIRED.
403 DISPATCH_DISABLED/ACTIVATION_CONFIRMATION_REQUIRED/WRITES_DISABLED/LOCAL_ONLY/CSRF_BLOCKED/ACCESS_ACL_UNVERIFIED.
404 NOT_FOUND/RUN_NOT_FOUND.
405 METHOD_NOT_ALLOWED, 413 BODY_TOO_LARGE, 415 JSON_REQUIRED.
409 LEAD_TIME/SCHEDULE_CONFLICT/VERSION_CONFLICT/IDEMPOTENCY_CONFLICT/RUN_ACTIVE/STORE_BUSY/SCHEDULE_LIMIT/RUN_NOT_RESERVED/OCCURRENCE_EXPIRED/LEASE_LOST/DELIVERY_UNCERTAIN.
503 STORE_CORRUPT/EXECUTION_STATE_CORRUPT/TRIGGER_MISMATCH/WINDOWS_TASK_FAILED/RECONCILIATION_REQUIRED/WINDOWS_REQUIRED/REQUEST_HISTORY_FULL/RUN_HISTORY_FULL/INTERNAL_ERROR.

미확인·조회 실패를 자료 없음/완료/발송 실패 확정으로 바꾸지 않는다. HTTP 오류 응답 외 네트워크 단절·메시지 ID 부재는 발송 결과 불명이며 재발송하지 않는다.

## 검증·미검증

합성 데이터로 CRUD/주간 충돌/자정/+20분/동시 요청/저장 실패/트리거 불일치/강제 종료/재시작/결과 불명/정기 원장 불변/loopback 인증·CSRF를 검증한다. 설치 SDK는 실제 클래스와 합성 transport로 main→snapshot을 확인한다.

실제 회사 보고 발송, Windows 추가 작업 등록·트리거 정시 실행, 실전 전원 종료·절전·로그아웃 복귀, 운영 인증·권한·최종 UI 연결은 미검증이다. 개발 완료를 운영 검증 완료로 표현하지 않는다.
