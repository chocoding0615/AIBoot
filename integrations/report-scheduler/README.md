# 반복 추가 보고 — 운영 미설치

기존 정기 보고와 별도 회차인 주간 반복 예약 엔진·로컬 관리 API다. 기존 09:30/16:00 작업, Antigravity, 웹훅과 승인 원본을 유지한다. P0 SDK 복구 PR을 먼저 적용해야 한다.

상세 계약·오류·권한은 [반복 예약 API](../../docs/REPEATING_REPORT_API.md), 운영 정책은 [CURRENT](../../CURRENT.md)를 참조한다.

## 이번 제출 상태

- 운영 코드/설정/원장/스케줄러 변경 없음. 실제 예약과 추가 Windows 작업을 등록하지 않음.
- API는 기본 쓰기 차단이고 실제 추가 발송도 별도 기본 차단이며, 인증·ACL 없으면 시작 거절. 공개·모바일 원격 접근 없음.
- 스케줄러 작업 등록/발송과 전원 복구 통합 시험은 미실행. 합성 테스트 통과만으로 운영 활성화하지 않는다.

## 별도 승인 후 설치 순서

1. 운영 실행/발송 상태 확인, 코드·config·원장·작업 XML 백업. P0 PR 우선 검증.
2. Windows KST 및 기존 작업 2개·Antigravity 설정·8개 gid 유지 확인.
3. cli.mjs init-access로 사용자 전용 ACL과 토큰 생성. 토큰은 콘솔/URL/브라우저에 복사하지 않고 신뢰된 로컬 백엔드만 읽는다.
4. cli.mjs serve로 쓰기 차단 상태의 인증/Host/CSRF 거절을 확인한다.
5. 운영 권한/복구를 검증한 별도 승인 하에 serve --enable-writes. 이때까지 실제 예약 등록 금지.
6. validate→사용자 diff 확인→변경 요청, Windows 계획 재조회 확인. 기존 작업은 변경하지 않고 AIBoot-ExtraReports 한 개만 관리한다.
7. 이 단계까지 dispatch는 비활성으로 held 기록만 남기고 모델/웹훅을 호출하지 않는다. 합성/비발송 통합 검증과 별도 발송 승인 후 activate-dispatch --confirm-dispatch로만 실행을 활성화한다.

CLI는 앱 실행 중 요청 처리용이며 타이머/상시 보고 서비스가 아니다. 보고 실행은 Windows 주간 트리거가 cli.mjs dispatch --plan-version N을 호출하고 기존 runner를 시작한다. API 서버가 꺼져 있어도 이미 등록된 Windows 예약은 남는다.

현재 추가 작업 설치 코드는 실제로 실행하지 않았다. --enable-writes는 사용자 승인과 운영 검증을 대체하지 않는다.

## 복구

pending이 남으면 추가 기능은 안전 차단한다. 저장된 before 계획을 읽고 프로세스·발송 상태를 확인한 뒤 승인된 cli.mjs recover --enable-writes로 복원한다. 기존 ledger/완료 이력을 복사해 덮어쓰거나 sending을 failed로 바꾸지 않는다.

공통 짧은 mutation guard 잔류·손상 lease는 자동 TTL 삭제하지 않는다. 소유자/자식 종료와 발송 상태를 증명한 후 별도 복구가 필요하다. 추가 예약 상태만 손상된 경우 정기 보고는 해당 파일을 읽지 않는다.

중지/삭제는 실행 중이면 409로 거절한다. 이미 시작한 실행을 종료하거나 snapshot을 바꾸지 않는다. 성공·불명 회차는 재실행하지 않고 이력도 보존한다.

## 테스트

node --test integrations/report-scheduler/tests/*.test.mjs

전체 기존 회귀 테스트도 함께 실행한다. 테스트의 임시 홈·가짜 Windows backend·가짜 모델/발송기를 사용하며 실제 업무 자료/원장/스케줄러를 변경하지 않는다.
