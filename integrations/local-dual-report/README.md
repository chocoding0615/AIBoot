# AIBoot 로컬 이중 보고 (Codex · Antigravity)

평일 **09:30 / 16:00 (KST)** 에 같은 회사 Google Chat 공간(기존 웹훅)으로 `[Codex]`, `[Antigravity]` 보고를 **각 1건씩** 보낸다. 보고 형식과 판정 기준은 [CURRENT.md](../../CURRENT.md)가 정하고, 이 문서는 구현과 실행 방법만 다룬다.

## 동작

1. 원본을 **읽기 전용**(`spreadsheets.get`, `values.get`, `values.batchGet`)으로 스냅샷한다.
   - `JP매월 지출`, `AIBoot_데일리마감`. 연노랑(#fff2cc)은 `(연노랑)`으로 표시한다. `고정비 대시보드`(폐기 예정)와 `시트내용`(계정정보 포함)은 읽지 않는다.
   - `계약서 검색`, `프로그램(2026)`, 복지 탭 A·E열, `계약서(DB)` C·E·I·Q열.
   - 정기 업무: `recurringSpreadsheetId`의 `[MS] 김현호` → `업무!A2:D200`과 행 메타데이터(업무ID), `Master_Sheet!B1:D60`, `반복업무_처리이력!A1:F2000`. 설정이 없으면 `미설정`으로 표시하고 옛 `업무` 탭으로 돌아가지 않는다.
   - 지정 Chat 스페이스 2개(`chatSpaces`)를 **읽기 전용 별도 토큰**으로 읽는다. 이 스페이스로는 아무것도 보내지 않고, 읽기 실패 시 `조회 실패`로 표시하고 내용을 쓰지 않는다.
2. Chat 조회 구간을 계산한다. 앞선 회차의 `chatUntil` 이후 메시지만 읽고, 기록이 없으면 직전 근무일 00:00(KST) 또는 마지막 정기 보고 발송일 중 더 이른 날부터 읽는다(최대 45일). 두 스페이스를 오래된 순으로 합쳐 8,000자까지 넣고, 넘치면 마지막으로 넣은 메시지까지만 다루고 나머지는 다음 보고로 넘긴다. 같은 회차 재시도는 같은 구간을 다시 읽는다. 이는 사용자 읽음 상태 추적이 아니라 보고 누락 방지용 누적 수집이다.
3. 근무일 정보와 같은 스냅샷으로 두 CLI를 **각자 빈 임시 폴더에서 별도 프로세스**로 실행한다. 서로의 출력은 프롬프트에 들어가지 않는다. `CURRENT.md`와 `docs/FIXED-EXPENSES-V1.md`는 실행 시점 파일 그대로 프롬프트에 들어간다.
   - Codex: `codex exec --sandbox read-only --ephemeral` (ChatGPT 구독)
   - Antigravity: `agy -p … --mode plan` (Google 계정 한도, 한도 소진 시 재시도 안 함). 프롬프트가 명령행 인자이므로 32,000자 안에서만 실행한다.
4. 각 AI는 `=== CHAT ===`(보고)과 `=== INTERNAL ===`(근거·예외)을 출력한다. 코드 검증(대분류·실선·분야·날짜·D-구간·금지 표현) 실패나 2,000자 초과 시 **발송하지 않고 실패**로 기록한다.
5. CHAT 부분을 **Cards V2 카드 3개**로 변환해 웹훅으로 발송하고 메시지 ID를 기록한다. 변환은 표시만 바꾼다: 카드에서 다시 뽑은 텍스트가 검증된 원문의 모든 줄을 같은 순서로 포함하지 않으면 발송하지 않는다. 웹훅이 카드를 거부(HTTP 400)하면 같은 내용을 텍스트로 보낸다. 전체 원문은 `%USERPROFILE%\.aiboot\reports\`(이 PC에만)에 저장한다.

## 중복 방지

`%USERPROFILE%\.aiboot\ledger.json` 키 `날짜|시간대|agent`. 파일 잠금으로 동시 실행을 막는다.

- `sent` → 다시 보내지 않음
- `sending`(발송 결과 불명) → 자동 재발송 안 함
- `generating` 15분 초과 → 재시도
- 3회 실패 → 중지

작업 스케줄러는 75분 동안 15분 간격으로 재확인한다. 이미 보낸 회차는 위 규칙 때문에 건너뛴다.

## 건너뛰는 날

주말 · 한국 공휴일(Google 공개 캘린더) · `config.json`의 `vacations`/`holidaysExtra` · 운영 기간(`trialStart`~`trialEnd`) 밖 · 보고 시간대 밖(오전 09:30–11:00, 오후 16:00–17:30).

## 제한

- **PC가 꺼져 있거나 로그아웃 상태면 보고가 나가지 않는다.** 시간대가 지난 뒤 켜면 그 회차는 건너뛴다. Codex/Antigravity는 이 PC의 구독 로그인으로만 실행된다. 클라우드 대체 수단은 유료 API가 필요해 쓰지 않는다.
- AI가 받는 자료는 시트 스냅샷과 지정 스페이스 2개 메시지뿐이다(Gmail·은행·사이트 없음). 시트 토큰은 `spreadsheets`, Chat 토큰(`%USERPROFILE%\.aiboot\chat-token.json`)은 읽기 전용 2개 권한(`chat.messages.readonly`, `chat.spaces.readonly`)만 가진다.
- Chat API는 OAuth 클라이언트의 GCP 프로젝트에서 **Google Chat API 사용 설정**이 되어 있어야 읽힌다. Chat만 다른 프로젝트의 클라이언트를 쓰려면 `config.json`의 `chatOAuthKeys`에 그 클라이언트 JSON 경로(상대 경로는 `%USERPROFILE%\.aiboot` 기준)를 넣고 `--auth-chat`을 다시 실행한다. Sheets 인증은 바뀌지 않는다. 재승인 시 기존 Chat 토큰은 `chat-token.backup-*.json`으로 남는다.
- Apps Script 쪽 `installReportTrigger()`를 함께 켜면 같은 시각에 보고가 3건이 된다. 켜지 않는다.

## 설정·비밀값

`%USERPROFILE%\.aiboot\config.json` (사용자 전용 권한, 저장소 밖): `webhookUrl`, `spreadsheetId`, `googleAuthDir`, `trialStart`, `trialEnd`, `vacations`, `holidaysExtra`, `workdaysExtra`, `contractsSpreadsheetId`, `opsSpreadsheetId`(AD_운영 관리: 복지 적용일), `trainingSpreadsheetId`(HR_법정의무교육 일정표), `chatSpaces`(스페이스 ID 배열), `chatOAuthKeys`(선택: Chat 전용 OAuth 클라이언트 JSON 경로). **이 저장소에 값을 쓰지 않는다.**

## 명령

```
node runner.mjs --slot morning|afternoon [--agent codex|antigravity|both] [--test [--tag latest|space|cards|layout] [--from-report <저장본 접미사>]] [--dry-run] [--show-cards] [--facts-only]
node runner.mjs --auth-chat --account <회사계정>   # Chat 읽기 전용 권한 1회 승인
node runner.mjs --check-chat [--as-of YYYY-MM-DD] [--vacation 날짜,날짜] [--no-ledger]   # 지정 스페이스 읽기 확인(발송 없음, 건수만 출력)
powershell -File register-tasks.ps1          # 작업 스케줄러 등록 (AIBoot-DualReport-morning/afternoon)
Unregister-ScheduledTask -TaskName 'AIBoot-DualReport-*' -Confirm:$false   # 중지
```

- `--dry-run`: AI를 호출하고 검증·카드 변환까지 하되 발송과 원장 기록은 하지 않는다. 시간대·근무일 검사까지 건너뛰려면 `--test --dry-run`.
- `--facts-only`: AI 호출·발송 없이 계산된 사실만 출력한다. 시간대 밖이면 `--test`를 함께 쓴다.

로그: `%USERPROFILE%\.aiboot\logs\YYYY-MM-DD.log` (웹훅 주소는 기록하지 않음).

## 테스트

`node --test`에는 폴더가 아니라 파일 경로를 준다.

```
node --check integrations/local-dual-report/runner.mjs
node --test integrations/local-dual-report/tests/fixed-schedule-cycles.test.mjs
```

## 정기 업무 회차와 처리이력

`recurring.mjs`가 회차를 계산하고, 실행기·연결현황이 같은 코드를 쓴다. 실행기는 시트에 쓰지 않는다.

| 규칙 (B 주기 / C 기준) | 날짜 | 회차키 |
|---|---|---|
| 매월 / 첫 영업일 | 주말·공휴일·`holidaysExtra`를 건너뛰고 `workdaysExtra`는 영업일. 개인 `vacations`는 회사 휴무가 아니다 | `2026-11` |
| 매년 또는 매년 1회 / `12-15` | 해당 날짜 그대로. 주말이어도 옮기지 않는다 | `2026` |
| 매년 2회 / `05-01, 11-01` | 해당 날짜 그대로 | `2026-1`, `2026-2` |
| 매년 2회 / `설·추석 -10영업일` | 공휴일 피드의 설날·추석 당일에서 영업일을 거꾸로 센다 | `2026-설날`, `2026-추석` |

- 다른 표현, 횟수와 기준 개수가 다른 규칙, 피드에 없는 해는 날짜를 만들지 않고 `규칙 확인 필요`로 보고한다.
- D열의 실제 드롭다운 값은 `완료`·`진행중`이다. 공란과 `진행중`은 대상에 포함하고, `완료`는 회차 완료로 보지 않고 확인 필요로 표시한다. `중지`로 입력된 행만 제외한다.
- **업무ID**는 행 개발자 메타데이터 `aiboot.recurring.taskId`에 둔다. 셀이 아니라서 A:D 표가 그대로이고, 이름·규칙을 바꾸거나 행을 옮겨도 유지된다. 같은 이름의 두 행은 ID가 다르다.
- **처리이력** 열은 `업무ID / 회차키 / 상태 / 처리시각 / 비고 / 회차기준일`, 상태는 `완료·보류·미처리`. 회차당 한 행이고 미래 회차를 미리 만들지 않는다. 근거(비고) 없는 완료·보류, 중복 행, 기록 당시와 기준일이 달라진 연 단위 회차는 완료로 인정하지 않는다.
- `비고`는 쓰는 칸일 뿐이며 코드는 내용을 읽어 넘기지 않는다.

시트에 쓰는 코드는 `recurring-status.mjs`뿐이고 사람이 실행할 때만 동작한다. `--apply`가 없으면 계획만 출력한다.

```text
node recurring-status.mjs                                  규칙·회차 상태 보기
node recurring-status.mjs --init --apply                   숨김 탭 1개 생성, 업무ID 지정 (한 번)
node recurring-status.mjs --mark --id <ID> --key 2026-11 --status 완료 --note "근거" --apply
```

배포 순서: `config.json`에 `recurringSpreadsheetId` 추가 → `--init --apply` → `--test --facts-only`로 확인.
