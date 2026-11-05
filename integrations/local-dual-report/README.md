# AIBoot 로컬 이중 보고 (Codex · Antigravity, 7일 시험 운영)

같은 회사 Google Chat 공간(기존 웹훅)으로 평일 **09:30 / 16:00 (KST)** 에 `[Codex]`, `[Antigravity]` 보고를 **각 1건씩** 보낸다.

## 동작
1. `JP매월 지출`(기준)과 `AIBoot_데일리마감`(변경 이력)을 **읽기 전용**(spreadsheets.get)으로 스냅샷. 연노랑(#fff2cc)은 `(연노랑)` 표시 = 지출결의 제출, 납부 완료 아님. `고정비 대시보드`(폐기 예정)와 `시트내용`(계정정보 포함)은 읽지 않는다.
2. 근무일 정보(오늘·다음 근무일·35일 내 공휴일·휴가)와 같은 스냅샷으로 두 CLI를 **각자 빈 임시 폴더에서 별도 프로세스**로 실행. 서로의 출력은 프롬프트에 들어가지 않는다.
   - Codex: `codex exec --sandbox read-only --ephemeral` (ChatGPT 구독)
   - Antigravity: `agy -p … --mode plan` (Google 계정 한도, 한도 소진 시 재시도 안 함)
3. 각 AI는 `=== CHAT ===`(짧은 보고)과 `=== INTERNAL ===`(근거·예외)을 출력한다. 공통인 것은 구성뿐이고 표현·우선순위는 각 AI가 정한다.
   - 오전: 오늘 처리할 일 / 가까운 일정 확인 / 대표 판단 필요
   - 오후: 오늘 완료 / 오늘 남은 일 / 다음 근무일
   - 한 줄 항목, 합계 3~5건(긴급 누락 위험 우선). 새 완료 근거가 없으면 "오늘 새로 확인된 완료 없음".
   - 머리말 누락이나 1,200자 초과 시 **발송하지 않고 실패**로 기록한다(긴 분석 원문을 그대로 보내지 않음).
4. CHAT 부분만 웹훅으로 발송하고 메시지 ID를 기록한다. 전체 원문은 `%USERPROFILE%\.aiboot\reports\`(이 PC에만)에 저장한다.

## 중복 방지
`%USERPROFILE%\.aiboot\ledger.json` 키 `날짜|시간대|agent`. 파일 잠금으로 동시 실행을 막는다.
- `sent` → 다시 보내지 않음 · `sending`(발송 결과 불명) → 자동 재발송 안 함 · `generating` 15분 초과 → 재시도 · 3회 실패 → 중지
- 작업 스케줄러는 75분 동안 15분 간격으로 재확인한다. 이미 보낸 회차는 위 규칙 때문에 건너뛴다.

## 건너뛰는 날
주말 · 한국 공휴일(Google 공개 캘린더) · `config.json`의 `vacations`/`holidaysExtra` · 운영 기간(`trialStart`~`trialEnd`) 밖 · 보고 시간대 밖(오전 09:30–11:00, 오후 16:00–17:30).

## 제한 (중요)
- **PC가 꺼져 있거나 로그아웃 상태면 보고가 나가지 않는다.** 시간대가 지난 뒤 켜면 그 회차는 건너뛴다. Codex/Antigravity는 이 PC의 구독 로그인으로만 실행된다. 클라우드 대체 수단은 유료 API가 필요해 쓰지 않는다.
- AI가 받는 자료는 시트 스냅샷뿐이다(Gmail·은행·사이트 없음). 로컬 Google 토큰 권한이 `spreadsheets` 하나다.
- Apps Script 쪽 `installReportTrigger()`를 함께 켜면 같은 시각에 보고가 3건이 된다. 시험 기간에는 켜지 않는다.

## 설정·비밀값
`%USERPROFILE%\.aiboot\config.json` (사용자 전용 권한, 저장소 밖): `webhookUrl`, `spreadsheetId`, `googleAuthDir`, `trialStart`, `trialEnd`, `vacations`, `holidaysExtra`, `workdaysExtra`. **이 저장소에 값을 쓰지 않는다.**

## 명령
```
node runner.mjs --slot morning|afternoon [--agent codex|antigravity|both] [--test] [--dry-run]
powershell -File register-tasks.ps1          # 작업 스케줄러 등록 (AIBoot-DualReport-morning/afternoon)
Unregister-ScheduledTask -TaskName 'AIBoot-DualReport-*' -Confirm:$false   # 중지
```
로그: `%USERPROFILE%\.aiboot\logs\YYYY-MM-DD.log` (웹훅 주소는 기록하지 않음).
