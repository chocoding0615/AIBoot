# 반복 추가 예약 보고 API v1 — 검토용 구현 계약

2026-11-19 최종 계약. 대상: AIBoot의 기존 실행기 + 로컬 예약 관리 어댑터. 기존 09:30/16:00 KST 정기 보고는 변경하지 않는다. 이 문서는 운영 설치·예약 등록·발송 승인이 아니다.

## 상태·경계

- 신규 구현이며 기본 쓰기 비활성·실제 추가 발송 비활성의 이중 차단이다. 실제 Windows 작업 등록·예약 발송·절전/로그아웃/재부팅 통합 검증 전 운영 적용 금지.
- 기존 AIWorkspace GET health/reports/tasks/connections와 향후 actions/prepare/confirm 계약을 변경하거나 재사용하지 않는다.
- 추가 예약은 매주 지정 요일 반복, 최대 16개(삭제되지 않은 예약 기준). 예약당 별도 작업을 생성하지 않고 관리되는 Windows 작업 AIBoot-ExtraReports 하나에 최대 16개 주간 트리거를 등록한다.
- Antigravity 단독, 기존 Google Chat 웹훅·기존 승인 Sheets/Chat 범위·공식 계약 DB와 분류·gid 검증을 재사용한다. 브라우저나 API 응답에 비밀·회사 원문·파일/시트 ID·원문 메시지 ID·임의 실행 명령을 반환하지 않는다.
- 실행 시작 예정 시각이다. 완료/웹훅 접수/사용자 수신 시각을 보장하지 않는다.

## 접근·인증

127.0.0.1:17841에만 수신한다. 다른 포트는 명시 로컬 CLI 설정만 허용한다. LAN/0.0.0.0·모바일 원격 공개·CORS·쿠키 기반 자동 인증은 지원하지 않는다.

신뢰된 동일 PC 백엔드가 Authorization: Bearer <로컬 32바이트 무작위 제어 토큰>으로 호출한다. 브라우저는 자체 UI 백엔드를 통해 연결해야 한다. Google 토큰이나 웹훅을 이 인증에 사용하지 않는다. **제어 토큰을 브라우저에 전달하지 않는다.** UI 백엔드는 자체 사용자 세션·CSRF·Origin 검증을 먼저 완료해야 하며, 무인증 프록시가 토큰을 주입하거나 브라우저 헤더를 무조건 제거해 권한을 대신해서는 안 된다.

토큰은 init-access로 사용자 전용 ACL 폴더의 access.json에 생성하며 출력/URL에 넣지 않는다. 현 사용자와 SYSTEM 외 Allow ACE가 있으면 시작을 거절한다. Origin 또는 Sec-Fetch-Site 헤더가 있는 요청, Host 불일치, 비루프백 연결은 차단한다. CSRF를 피하려고 인증을 생략하는 폴백은 없다.

serve는 기본 writeEnabled=false다. 별도 설치 승인 후 인증·ACL·호출 주체·Windows 권한을 검증하고 --enable-writes로 명시 시작해야 변경할 수 있다. 인증 검사 실패 시 서버는 시작하지 않는다. 운영 인증/실제 변경 권한은 배포 전에 재검증한다.

예약 관리 쓰기 허용과 실제 추가 발송 활성화는 별개다. init-access는 allowDispatch=false로 생성한다. 추가 작업이 등록되어 있어도 이 값이 false면 해당 회차는 held/DISPATCH_DISABLED로 표시하고 모델·웹훅을 호출하지 않는다. 실제 runner 진입도 이 값을 재확인한다. 별도 발송 승인·비발송 QA 후 로컬 activate-dispatch --confirm-dispatch로만 활성화한다. 비활성화는 deactivate-dispatch --confirm-dispatch이며 이미 실행 중인 회차를 취소하지 않는다. 이 비활성화는 예약 상태 손상/pending/트리거 불일치 중에도 가능하고, 반대로 활성화는 이 상태에서 거절한다. 원격 활성화 API는 없다.

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
- workdayPolicy: existing_workday, workdayEvaluation: at_execution.
- nextRunMeaning: trigger_attempt, maySkipNonWorkday: true. 주말·공휴일·휴가 예약도 저장할 수 있으나 실행 시 기존 workday 정책으로 건너뛸 수 있음을 UI에 표시한다.
- 다음 예정 시각은 근무일 정책에 따라 건너뛸 수 있는 트리거 예정 시각이다. 서버는 결과 도착 시각으로 표현하지 않는다.

Run:
- key: extra|예약ID|예정시각(RFC3339 UTC)|antigravity.
- scheduleId, scheduledAt, scheduledDate(KST), actualDate(실제 시작 KST 날짜 또는 null), startedAt, completedAt, webhookAcceptedAt.
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

- Windows PC 서버 KST 기준 현재 분을 포함한 가장 가까운 요청 회차가 현재+20분 이상이어야 한다. 더 임박하면 LEAD_TIME으로 거절하며 자동으로 다른 시각/다음 주로 바꾸지 않는다. 미래 날짜는 effectiveFrom으로 명시한다.
- 저장 직전 Windows 반영 후와 최종 저장 직후 모두 서버 시각으로 +20분을 재확인한다. 클라이언트의 임시 30분 규칙은 사용하지 않는다. 늦어졌으면 작업·설정을 복구한다.
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

공통 report-execution.json lease는 정기/추가 보고의 조회·생성·발송을 보호한다. PID와 모든 생성 자식 PID/birth를 추적하며, 자식 등록 전 생성 단계도 별도 표시한다. 부모가 이 구간에서 죽었거나 자식 종료를 증명할 수 없으면 발송/lease 해제를 차단한다. OS가 PID 없이 spawn 실패를 확정한 경우에만 해당 미등록 슬롯을 해제한다. PID와 생성 자식 PID가 살아 있거나 생존 확인이 불명확하면 TTL만으로 회수하지 않는다. 죽은 소유자만 짧은 mutex 안에서 회수하고 복구 메타데이터를 남긴다. 기존 원장 키·시도 횟수·Chat 커서는 건드리지 않는다. sending 이후 죽은 추가 회차는 unknown으로 남긴다.

짧은 mutex 자체를 보유한 채 강제 종료되면 guard가 남을 수 있다. 아래 명시적 오프라인 복구 절차를 사용하며 시간만 보고 자동 삭제하지 않는다. 소유 PID 생성 시각을 기록하고, 전체 lease의 자동 회수도 현재 프로세스 트리 증명을 재확인한다. PID 재사용·생존 불명·자식 생존은 계속 차단한다. 추가 상태/추가 mutation.guard는 정기 보고가 읽지 않으므로 별도 장애 범위다. 공통 guard 잔류만 정기 보고를 안전 차단할 수 있으며, 증명 불가 상태에서는 운영 활성화를 허용하지 않는다.

## Windows·부재·용량

- 기존 정기 작업 두 개는 유지한다. 추가 작업은 Interactive/Limited, IgnoreNew, 최대 20분, WakeToRun=false, StartWhenAvailable=false다.
- Windows 시간대가 Korea Standard Time이 아니면 작업 반영을 거절한다. 앱 계산은 KST 고정이다.
- PC 종료/절전/로그아웃 중 실행을 보장하지 않는다. 늦은 회차를 소급 발송하지 않는다. 같은 예정 분 이내 진입만 허용하고 다음 분부터는 실행하지 않는다.
- 다음 dispatcher에서는 최대 최근 1주의 놓친 회차를 missed로 표시만 한다. 그보다 오래된 부재 기간은 완전한 회차 감사 범위가 아니며 자동 복구/발송하지 않는다.
- 재시작 후 같은 key는 다시 예약하지 않는다. dead sending은 unknown, dead 발송 전 상태는 failed_not_sent로 정리하며 자동 재실행하지 않는다.
- 멱등 요청 4096개, 실행 이력 10000개 상한에 도달하면 추가 기능을 차단하고 수동 보관 정책 결정을 요구한다. 성공/불명 키를 자동 삭제해 중복을 허용하지 않는다. 기존 정기 보고에는 이 상한을 적용하지 않는다.

## 오류

400 NO_OCCURRENCE/INVALID_RULE/INVALID_WEEKDAYS/INVALID_TIME/INVALID_DATE/INVALID_REQUEST/INVALID_JSON/INVALID_OPERATION/INVALID_IDEMPOTENCY_KEY/CONFIRMATION_REQUIRED.
401 AUTH_REQUIRED.
403 DISPATCH_DISABLED/ACTIVATION_CONFIRMATION_REQUIRED/WRITES_DISABLED/LOCAL_ONLY/CSRF_BLOCKED/ACCESS_ACL_UNVERIFIED.
404 NOT_FOUND/RUN_NOT_FOUND.
405 METHOD_NOT_ALLOWED, 413 BODY_TOO_LARGE, 415 JSON_REQUIRED.
409 RECOVERY_IN_PROGRESS/LEAD_TIME/SCHEDULE_CONFLICT/VERSION_CONFLICT/IDEMPOTENCY_CONFLICT/RUN_ACTIVE/STORE_BUSY/SCHEDULE_LIMIT/RUN_NOT_RESERVED/OCCURRENCE_EXPIRED/LEASE_LOST/DELIVERY_UNCERTAIN.
503 EXECUTION_CHILD_UNVERIFIED/LEASE_STATE_INVALID/EXECUTION_PROTECTION_BLOCKED/STORE_CORRUPT/EXECUTION_STATE_CORRUPT/TRIGGER_MISMATCH/WINDOWS_TASK_FAILED/RECONCILIATION_REQUIRED/WINDOWS_REQUIRED/REQUEST_HISTORY_FULL/RUN_HISTORY_FULL/INTERNAL_ERROR.

미확인·조회 실패를 자료 없음/완료/발송 실패 확정으로 바꾸지 않는다. HTTP 오류 응답 외 네트워크 단절·메시지 ID 부재는 발송 결과 불명이며 재발송하지 않는다.

## 검증·미검증

합성 데이터로 CRUD/주간 충돌/자정/+20분/동시 요청/저장 실패/트리거 불일치/강제 종료/재시작/결과 불명/정기 원장 불변/loopback 인증·CSRF를 검증한다. 설치 SDK는 실제 클래스와 합성 transport로 main→snapshot을 확인한다.

실제 회사 보고 발송, Windows 추가 작업 등록·트리거 정시 실행, 실전 전원 종료·절전·로그아웃 복귀, 운영 인증·권한·최종 UI 연결은 미검증이다. 개발 완료를 운영 검증 완료로 표현하지 않는다.

## P1 guard 복구 — 운영자 전용, HTTP 경로 없음

역할을 구분한다. extra-reports/mutation.guard는 예약 저장/이력의 짧은 커밋 보호이며 정기 보고와 분리된다. report-execution.guard는 전체 lease 파일 갱신의 짧은 보호다. report-execution.json은 조회·생성·발송 전체의 소유권이다. 기존 ledger.lock/ledger.json은 기존 원장 보호이며 이 복구 명령이 변경하지 않는다.

1. 읽기 전용 cli.mjs inspect-locks --home <운영 홈>으로 scope, fingerprint, 소유 PID/birth, 자식/생존 증명, phase를 확인한다. 브라우저에 이 진단을 전달하지 않는다.
2. 별도 유지보수 승인을 받고 먼저 deactivate-dispatch --confirm-dispatch로 미래 추가 발송을 비활성화한 뒤 API 서버를 중지한다. 기존 정기 작업 2개 및 추가 작업이 있으면 비활성화하고 실행 중이 아님을 확인한다. 이번 개발 작업에서는 이 조치를 실행하지 않는다.
3. 검증한 코드에서 cli.mjs recover-guard --scope execution|schedule --fingerprint <검사한 SHA256> --confirm-recovery --home <운영 홈>을 실행한다. 명령이 실제 작업 비활성 상태를 다시 확인한다.
4. 복구 마커를 먼저 획득한다. 일반 writer는 마커를 guard 생성 전·후 검사하므로 교체 guard를 잘못 회수하는 경합을 막는다.
5. 소유 PID와 생성 시각·전체 lease 소유자 및 기록된 자식·현재 자식 트리를 두 번 검사한다. 죽음이 증명되고 살아 있는 자식이 없을 때만 guard를 recovered-UUID 디렉터리로 이동해 증거를 보존한다. 무조건 삭제하거나 TTL로 판단하지 않는다.
6. sending lease와 기존 정기/추가 원장·시도 횟수·Chat 커서는 그대로 둔다. sending의 복구 결과는 unknown_preserved다. 같은 회차 재시도 허가는 아니다.
7. pending이 남았으면 실제 추가 발송 비활성화를 확인한 뒤 별도의 recover --enable-writes로 이전 Windows/예약 계획 복구를 확인한다. inspect-locks, status와 기존 정기 보고 비발송 검증을 마친 뒤 승인된 순서로 기존 작업을 복원한다. 추가 실발송은 별도 활성화다.

소유권 불명·PID 재사용·자식 생존/종료 불명·미등록 생성 자식·JSON 손상·구형 guard의 phase 부재·복구 마커 자체 잔류는 자동 복구하지 않는다. 운영 활성화를 차단하고 스냅샷/작업 XML/원장 백업을 보존한다. 모든 진입점 중지 및 프로세스/자식/발송 상태를 운영자가 증명한 별도 오프라인 검토 전 파일을 지우지 않는다. 재부팅은 프로세스를 종료할 뿐 발송 결과 불명 기록을 해소하지 않는다.

복구 CLI 오류: DISPATCH_MUST_BE_DISABLED(409), RECOVERY_CONFIRMATION_REQUIRED(403), MAINTENANCE_REQUIRED(409), INVALID_RECOVERY_SCOPE/RECOVERY_FINGERPRINT_REQUIRED(400), RECOVERY_IN_PROGRESS/RECOVERY_SNAPSHOT_CHANGED/OWNER_OR_CHILD_UNVERIFIED(409), RECOVERY_LAYOUT_INVALID/GUARD_REVIEW_REQUIRED/LEASE_REVIEW_REQUIRED(503). 활성화 명령은 잔류 guard·복구 마커·증명 불가 lease·자기 프로세스 신원 불명이 있으면 EXECUTION_PROTECTION_BLOCKED로 거절한다.

## Claude Code 연결 기준

브라우저는 UI 백엔드만 호출한다. 아래는 인증된 UI 백엔드가 같은 PC의 AIBoot에 보내는 예이며 토큰은 서버 메모리/사용자 전용 로컬 파일에만 둔다.

- 목록: GET /api/report-schedules → data.configVersion/serverNow/writeEnabled/dispatchEnabled/triggerStatus 및 items. writeEnabled는 설정 변경 권한이며 현재 실행 가능 보장이 아니다.
- 사전 검사: POST /api/report-schedules/validate. 다음 예시는 configVersion=0인 합성 예이며 저장·활성화하지 않는다.

```json
{
  "operation": "create",
  "rule": {
    "weekdays": [
      1,
      4
    ],
    "time": "13:00"
  },
  "expectedVersion": 0
}
```

- 생성: POST /api/report-schedules, 새 Idempotency-Key 헤더와 아래 JSON을 사용한다. 201의 data.schedule.id가 확정 ID다. preview의 임시 ID를 저장 ID로 사용하지 않는다.

```json
{
  "rule": {
    "weekdays": [
      1,
      4
    ],
    "time": "13:00"
  },
  "expectedVersion": 0,
  "confirmed": true
}
```

- 수정·정지·재개·삭제는 같은 expectedVersion/confirmed/멱등 키 규칙을 따른다. 성공의 새 configVersion을 반영한다. 결과를 잃으면 동일 키와 동일 요청으로 재확인하며 다른 내용에 키를 재사용하지 않는다.
- LEAD_TIME: error.details.earliestAllowedAt 표시. 자동으로 다음 주로 이동하거나 서버 대신 30분 규칙을 적용하지 않는다.
- SCHEDULE_CONFLICT: error.details.reasons[].kind가 regular_protected 또는 extra_overlap. 원인의 weekday/scheduleId를 표시한다.
- VERSION_CONFLICT: 목록 재조회 후 사용자가 diff를 다시 확인한다. RUN_ACTIVE는 실행 중 변경/삭제 불가다.
- TRIGGER_MISMATCH/RECONCILIATION_REQUIRED/RECOVERY_IN_PROGRESS/EXECUTION_PROTECTION_BLOCKED: 오류로 표시하고 저장/실행 성공으로 꾸미지 않는다. 복구 API를 만들거나 실제 발송 활성화를 UI에서 우회하지 않는다.
- 예약 시각, 실제 시작/완료, webhookAcceptedAt을 분리한다. sent는 웹훅 접수이며 사용자 수신 확인이 아니다. unknown은 실패 확정이나 미발송이 아니다.
- 주말/휴일 예약의 nextRunAt은 다음 트리거 시각이다. workdayPolicy/nextRunMeaning/maySkipNonWorkday 필드를 근거로 실행 시 건너뛸 수 있음을 표시한다.

구현에서 JSON Content-Type은 application/json 및 UTF-8 charset 표기를 허용한다. expectedVersion은 0 이상의 정수이며 누락/문자열은 INVALID_REQUEST(400), confirmed가 true가 아니면 CONFIRMATION_REQUIRED(400)다. 필요 없는 operation/id/rule 입력도 거절한다.
