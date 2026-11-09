# 정기 업무 시트 메뉴 (Apps Script, 미배포)

`[MS] 김현호` 시트 안에서 신규 업무의 업무ID 지정과 회차 완료·보류·다시 열기를 하는 컨테이너 바인딩 Apps Script다. `recurring-status.mjs`를 콘솔에서 실행하던 일을 대신한다. 정기 보고 실행기·스케줄러·웹훅은 바뀌지 않는다. 운영 기준은 [CURRENT.md](../../CURRENT.md).

**상태: 구현·가짜 시트 테스트만 완료. 실제 시트 설치·실제 운영 검증 전.** 설치는 사용자 승인 후 사용자가 한다.

## 사용자가 하는 일

| 하고 싶은 것 | 시트에서 |
|---|---|
| 새 업무 등록 | `업무` 탭 빈 행에 A~D를 쓴다. A~D 편집 직후(또는 파일을 열 때) ID가 자동으로 붙는다. 셀은 바뀌지 않는다 |
| 회차 완료·보류 | 업무 행의 아무 칸을 선택 → 메뉴 **AIBoot 정기 업무 › 선택한 업무 회차 처리…** → 회차 선택, 근거 입력, `완료`/`보류` |
| 실수 되돌리기 | 같은 대화상자에서 `다시 열기(미처리)` |
| ID가 안 붙었을 때 | 메뉴 **새 업무에 ID 지정** (결과를 알림으로 보여 준다) |

숨김 탭 `반복업무_처리이력`을 직접 고치지 않아도 된다.

## 무엇을 쓰고 무엇을 안 쓰나

- 쓰는 곳: `업무` 탭 행의 개발자 메타데이터 `aiboot.recurring.taskId`, 숨김 탭 `반복업무_처리이력` A:F. 처음 설정 메뉴는 이 탭이 없을 때만 만든다.
- 안 쓰는 곳: `업무` 탭 셀 값, 다른 탭, 다른 파일. 파일 이름이 `[MS] 김현호`가 아니면 아무것도 하지 않는다.
- 트리거 설치·시간 기반 실행·웹훅·외부 발송 코드는 없다. `onOpen`·`onEdit`는 단순 트리거라 따로 설치하지 않으며, `업무` 탭 A~D 편집에만 반응한다.

## 계산이 정기 보고와 같은 이유

`dist/Recurring.gs`는 `local-dual-report/recurring.mjs`와 `recurring-status.mjs` 원문을 감싼 자동 생성 파일이다. 회차키·기준일 계산과 기록 규칙(`planInit`, `planMark`: 근거 없는 완료 거부, 같은 회차는 한 행 갱신, 미래 회차는 D-60 이내만)이 콘솔 도구와 같다. 원본을 고치면 `node integrations/recurring-sheet/build.mjs`로 다시 만든다. 테스트가 dist와 원본이 다르면 실패한다.

`Sheet.gs`가 하는 일은 시트 읽기·쓰기뿐이다.
- 날짜 셀은 표시값(`11-16`)이 아니라 실제 날짜로 읽는다.
- 문서 잠금 안에서 다시 읽고 쓴다. 동시 편집·onEdit 중복으로 같은 ID·같은 회차 행이 두 번 생기지 않는다.
- 대화상자를 연 뒤 행이 이동·삭제되었거나 ID가 바뀌었으면 쓰지 않는다.
- 회차키를 글자 형식으로 쓴다. `2026-11`이 날짜로 바뀌지 않게 하기 위해서다.

## 권한 (appsscript.json)

| 범위 | 이유 |
|---|---|
| `spreadsheets.currentonly` | 이 스크립트가 붙은 파일 하나만 |
| `script.container.ui` | 메뉴·대화상자 |
| `script.external_request` | 공휴일 피드(정기 보고와 같은 공개 ICS). 첫 영업일·설·추석 회차 계산용. 실패하면 날짜를 추측하지 않고 기록을 거부한다 |

선택 Script Properties: `HOLIDAYS_EXTRA`·`WORKDAYS_EXTRA`(쉼표로 구분한 `YYYY-MM-DD`). 운영 PC `config.json`의 같은 값과 맞춰야 첫 영업일 기준일이 정기 보고와 같다.

## 설치 (사용자 승인 후)

1. `[MS] 김현호` 시트 › 확장 프로그램 › Apps Script (새 프로젝트, 기존 `integrations/google-chat` 프로젝트와 별개).
2. 파일 세 개를 만든다: `Recurring.gs`(=`dist/Recurring.gs`), `Sheet.gs`, `Dialog.html`(HTML 파일 이름 `Dialog`). 프로젝트 설정에서 매니페스트 표시 후 `appsscript.json` 내용을 붙인다.
3. 시트를 새로 고치면 메뉴가 생긴다. 메뉴를 처음 누를 때 권한 승인 창이 뜬다(위 3개 범위).
4. 확인: 메뉴 › 새 업무에 ID 지정 → 7행 ID가 붙는지 본다. 숨김 이력 탭과 기존 5개 ID는 그대로여야 한다. 운영 PC에서 `node recurring-status.mjs`(읽기만)로 같은 ID가 보이는지 확인한다.

## 삭제·롤백

- Apps Script 프로젝트를 지우면 메뉴와 자동 ID 지정이 멈춘다. 이미 붙은 ID와 처리이력은 그대로 남고, 정기 보고와 콘솔 도구는 계속 읽는다.
- 잘못 기록한 회차는 대화상자의 `다시 열기`로 되돌린다.
- 기존 `recurring-status.mjs`는 그대로 남아 있어 필요하면 콘솔로도 처리할 수 있다.

## 테스트

```text
node integrations/recurring-sheet/build.mjs --check
node --test integrations/recurring-sheet/tests/sheet.test.mjs
```

실제 시트에는 개발 테스트를 쓰지 않는다. `tests/fake-gas.mjs`가 행 메타데이터 이동·삭제, 날짜 셀 표시값, 글자 형식이 아닌 셀의 날짜 자동 변환을 재현한다. 테스트 업무명은 가짜다.
