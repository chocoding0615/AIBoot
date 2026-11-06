# AIBoot 연결현황 v1 (고정비 22개, 읽기 전용)

"코웨이가 왜 보고에 없지?"를 확인하는 화면이다. 트리 `AIBoot > 고정비 > 업체 22개`에서 업체마다 원본 연결, 점검 상태, 이번 보고 포함·제외와 이유를 보여 준다. 업체를 누르면 대상 회차·점검시각·판정 이유가 나온다.

## 여는 방법 (이 PC)

```powershell
cd tools\fixed-expense-flow
node build-evidence.mjs      # 이 폴더의 저장소 코드로 판정. 다른 폴더는 --repo <AIBoot 폴더>
start index.html             # 브라우저로 열기(서버 불필요)
```

결과는 실행한 시각 기준이다. 새로 보려면 다시 실행한다. 결과 파일이 없으면 화면은 전체 `미검증`으로 안내한다.

`--repo`로 고른 폴더의 `fixedSchedule()`로 판정하므로, 판정 기준 브랜치가 화면 상단에 표시된다.

## 상태

| 상태 | 뜻 |
|---|---|
| 정상 | 원본 시트 연결이 확인됐고, 최근 정기 보고에 포함됐거나 제외 사유가 입증됨 |
| 확인 필요 | 보고 대상인데 미포함, 납부 회차 미확정, 원본 접근 실패, 시트 행 이름 불일치, 최근 시트 읽기 실패 |
| 미검증 | 점검에 쓸 정기 보고 기록이 없거나 원본을 실제로 조회하지 않음 |

`정상 + 확인 필요 + 미검증 = 관리대상`은 매번 검사한다. 활성 업체가 22개가 아니면 화면 상단에 경고가 뜬다.

## 보고 포함·제외 판정

기준은 가장 최근에 발송된 정기 보고이며, 점검 창은 그 보고일부터 7일이다(실행기 `IMMINENT_DAYS`).

- **포함**: 보고의 `[고정비]` 블록에 업체명이 있음. 요약이나 다른 분야에만 나오면 포함으로 세지 않는다(예: `[정기 업무]`의 생각공장 주차권). 점검 창 안의 업체를 한쪽 AI 보고만 다뤘으면 `확인 필요`다.
- **정상 제외**: 다음 예정일이 점검 창 밖임.
- **누락 의심**: 점검 창 안인데 보고에 없음, 또는 납부 회차가 미확정이라 제외를 입증할 수 없음. AI 내부 근거에 언급만 된 경우도 정상으로 두지 않는다.

주말·공휴일 예정일은 이동 규칙이 미확정이라 날짜를 옮기지 않고 참고로만 표시한다. 지역 없이 `코웨이`라고만 쓴 보고는 어느 업체인지 알 수 없어 포함으로 세지 않는다. 직전 회차의 완료 여부는 판정하지 않는다.

## 읽는 것 (쓰기 없음)

- 저장소: `integrations/local-dual-report/runner.mjs`의 `fixedSchedule()`을 그대로 실행, `docs/FIXED-EXPENSES-V1.md`
- `%USERPROFILE%\.aiboot`: `logs`, `ledger.json`, `reports`, `holidays.json`, `config.json`(`spreadsheetId`·`googleAuthDir`만)
- 시트: `'JP매월 지출'!D14:D36` 업체명 열만 `values.get`으로 읽음. 금액·서식은 읽지 않음. `--no-sheet`면 원본은 미검증으로 표시

웹훅·Chat은 쓰지 않고, 시트·스케줄러·토큰을 바꾸지 않는다. 결과 파일 `evidence.local.js`는 Git에서 제외된다.

## 파일

- `judge.mjs`: 판정(순수 함수). 다른 분야는 같은 `{ id, name, summary, items, inactive }` 형식의 domain을 추가한다.
- `build-evidence.mjs`: 근거 수집 후 `judge.mjs` 호출
- `index.html`: 화면(외부 라이브러리 없음)
- `tests/judge.test.mjs`: `node --test tools/fixed-expense-flow/tests/judge.test.mjs`
