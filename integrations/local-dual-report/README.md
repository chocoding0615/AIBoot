# AIBoot 로컬 이중 보고 (Codex · Antigravity, 7일 시험 운영)

같은 회사 Google Chat 공간(기존 웹훅)으로 평일 **09:30 / 16:00 (KST)** 에 `[Codex]`, `[Antigravity]` 보고를 **각 1건씩** 보낸다.

## 동작
1. `JP매월 지출`(기준)과 `AIBoot_데일리마감`(변경 이력)을 **읽기 전용**(spreadsheets.get)으로 스냅샷. 연노랑(#fff2cc)은 `(연노랑)` 표시 = 지출결의 제출, 납부 완료 아님. `고정비 대시보드`(폐기 예정)와 `시트내용`(계정정보 포함)은 읽지 않는다.
   - 지정 Google Chat 스페이스 2개(`chatSpaces`)의 최근 7일 메시지를 **읽기 전용 별도 토큰**(`chat.messages.readonly`, `chat.spaces.readonly`)으로 함께 읽는다. 이 스페이스로는 아무것도 보내지 않는다. 읽기 실패 시 `조회 실패`로 표시하고 내용을 쓰지 않는다.
2. 근무일 정보(오늘·다음 근무일·35일 내 공휴일·휴가)와 같은 스냅샷으로 두 CLI를 **각자 빈 임시 폴더에서 별도 프로세스**로 실행. 서로의 출력은 프롬프트에 들어가지 않는다.
   - Codex: `codex exec --sandbox read-only --ephemeral` (ChatGPT 구독)
   - Antigravity: `agy -p … --mode plan` (Google 계정 한도, 한도 소진 시 재시도 안 함)
3. 각 AI는 `=== CHAT ===`(짧은 보고)과 `=== INTERNAL ===`(근거·예외)을 출력한다. 공통인 것은 구성뿐이고 표현·우선순위는 각 AI가 정한다.
   - 형식은 [CURRENT.md](../../CURRENT.md): `내용 요약 및 추천`(N. 제목 / ■ 내용 / □ 추천, 1~3건) → `오늘 완료` → `오늘 남은 일`(고정비·계약서·라이센스·복지 항상 표시, 고정비는 7일 이내 임박분만) → 다음 근무일 업무.
   - 코드 검증(대분류·실선·분야·날짜·D-구간·금지 표현) 실패나 2,000자 초과 시 **발송하지 않고 실패**로 기록한다(긴 분석 원문을 그대로 보내지 않음).
4. CHAT 부분을 **Cards V2 카드 3개**(내용 요약 및 추천 / 오늘 완료+오늘 남은 일 / 다음 업무)로 변환해 웹훅으로 발송하고 메시지 ID를 기록한다. 변환은 표시만 바꾼다: 카드에서 다시 뽑은 텍스트가 검증된 원문의 모든 줄을 같은 순서로 포함하지 않으면 발송하지 않는다. 웹훅이 카드를 거부(HTTP 400)하면 같은 내용을 텍스트로 보낸다. 전체 원문은 `%USERPROFILE%\.aiboot\reports\`(이 PC에만)에 저장한다.

## 중복 방지
`%USERPROFILE%\.aiboot\ledger.json` 키 `날짜|시간대|agent`. 파일 잠금으로 동시 실행을 막는다.
- `sent` → 다시 보내지 않음 · `sending`(발송 결과 불명) → 자동 재발송 안 함 · `generating` 15분 초과 → 재시도 · 3회 실패 → 중지
- 작업 스케줄러는 75분 동안 15분 간격으로 재확인한다. 이미 보낸 회차는 위 규칙 때문에 건너뛴다.

## 건너뛰는 날
주말 · 한국 공휴일(Google 공개 캘린더) · `config.json`의 `vacations`/`holidaysExtra` · 운영 기간(`trialStart`~`trialEnd`) 밖 · 보고 시간대 밖(오전 09:30–11:00, 오후 16:00–17:30).

## 제한 (중요)
- **PC가 꺼져 있거나 로그아웃 상태면 보고가 나가지 않는다.** 시간대가 지난 뒤 켜면 그 회차는 건너뛴다. Codex/Antigravity는 이 PC의 구독 로그인으로만 실행된다. 클라우드 대체 수단은 유료 API가 필요해 쓰지 않는다.
- AI가 받는 자료는 시트 스냅샷과 지정 스페이스 2개 메시지뿐이다(Gmail·은행·사이트 없음). 시트 토큰은 `spreadsheets`, Chat 토큰(`%USERPROFILE%.aibootchat-token.json`)은 읽기 전용 2개 권한만 가진다.
- Chat API는 OAuth 클라이언트의 GCP 프로젝트에서 **Google Chat API 사용 설정**이 되어 있어야 읽힌다.
- Apps Script 쪽 `installReportTrigger()`를 함께 켜면 같은 시각에 보고가 3건이 된다. 시험 기간에는 켜지 않는다.

## 설정·비밀값
`%USERPROFILE%\.aiboot\config.json` (사용자 전용 권한, 저장소 밖): `webhookUrl`, `spreadsheetId`, `googleAuthDir`, `trialStart`, `trialEnd`, `vacations`, `holidaysExtra`, `workdaysExtra`, `contractsSpreadsheetId`, `chatSpaces`(스페이스 ID 배열). **이 저장소에 값을 쓰지 않는다.**

## 명령
```
node runner.mjs --slot morning|afternoon [--agent codex|antigravity|both] [--test [--tag latest|space|cards] [--from-report <저장본 접미사>]] [--dry-run]
node runner.mjs --auth-chat --account <회사계정>   # Chat 읽기 전용 권한 1회 승인
node runner.mjs --check-chat                     # 지정 스페이스 읽기 확인(발송 없음)
powershell -File register-tasks.ps1          # 작업 스케줄러 등록 (AIBoot-DualReport-morning/afternoon)
Unregister-ScheduledTask -TaskName 'AIBoot-DualReport-*' -Confirm:$false   # 중지
```
로그: `%USERPROFILE%\.aiboot\logs\YYYY-MM-DD.log` (웹훅 주소는 기록하지 않음).


## 2026-11-05 보고 표시 및 업무 분류

- `[정기 업무]`: 법정의무교육, 보험 갱신, 정기 신고·점검 등 실제 출처가 있는 반복 업무.
- `[기타 업무]`: 지정 Chat 스페이스나 별도 요청에서 확인한 비정기 업무.
- 오늘 남은 일의 고정비·계약서·라이센스·복지 4분야 상시 표시 유지; 정기·기타는 확인된 경우 추가.
- Google Chat 카드 3개 구성 유지. 카드 내부 분야 사이 자동 실선을 제거하고 굵은 분야 제목과 충분한 간격만 사용.
