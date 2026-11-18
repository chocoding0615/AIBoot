# AIBoot — 경영지원 업무 누락 방지 AI 비서

회사 경영지원 담당자 1명에게 근무일 09:30/16:00 Google Chat으로 업무 보고를 보낸다. 이 파일은 진입점과 현재 상태만 담는다.

## 어디를 읽나

| 알고 싶은 것 | 문서 |
|---|---|
| 운영 정책, 보고 형식, 소스별 연결 상태 | [CURRENT.md](CURRENT.md) |
| 업체별 회차·예외 | [docs/FIXED-EXPENSES-V1.md](docs/FIXED-EXPENSES-V1.md) |
| 설치·실행·테스트 | 아래 각 구현의 README |

## 구현 상태

| 구현 | 상태 | 역할 |
|---|---|---|
| [integrations/local-dual-report](integrations/local-dual-report/README.md) | **운영 중** (Windows 작업 스케줄러) | 평일 09:30/16:00 정기 보고. 설정으로 선택된 AI가 기존 웹훅으로 카드 3장 발송 |
| [tools/fixed-expense-flow](tools/fixed-expense-flow/README.md) | **완료, v1 동결** | 고정비 22개 연결현황을 읽기 전용으로 점검 |
| [integrations/google-chat](integrations/google-chat/README.md) | **시제품, 미배포** | 양방향 회신 기록용. 향후 연결을 위해 보존하며 정기 보고에 쓰지 않음 |

## 과거 확인 기록 — 2026-11-06

아래는 당시 운영 PC 전환 여부를 설명한 기록이다. 현재 실행 상태가 아니며, 이후 검증과 비교할 수 있도록 보존한다.

GitHub main 병합은 운영 PC 전환이 아니다. 작업 스케줄러는 `C:\Users\admin\Desktop\github\AIBoot` 체크아웃을 그대로 실행한다.

- **실행 중인 코드:** 브랜치 `claude/chat-oauth-client`, 커밋 `32577bb` (main의 조상)
- **아직 운영에 없는 것:** 고정비 회차 수정(#9), 이후 문서 변경. 운영 보고에는 이전 회차 규칙과 이전 `CURRENT.md`가 쓰인다
- **비교 시험 종료일:** `config.json`의 `trialEnd`가 2026-11-10이다. 그 뒤에는 `afterTrialAgents`에 적힌 AI만 같은 09:30·16:00 슬롯으로 보고한다. 이 값이 없으면 실행기가 보고를 건너뛴다

## 최신 확인 기록 — 2026-11-18 v0 감사

이 절은 아래 시점의 확인 사실만 기록하며 운영 정책을 바꾸지 않는다. 정책·소스별 판정은 [CURRENT.md](CURRENT.md), 업체별 회차는 [고정비 규칙](docs/FIXED-EXPENSES-V1.md)을 따른다. 이후 상태가 달라지면 기존 기록을 지우지 않고 새 날짜의 확인 결과를 추가한다.

| 확인 항목 | 확인 결과 |
|---|---|
| 실제 실행 경로 | Windows 작업 `AIBoot-DualReport-morning/afternoon` → `C:\Users\admin\Desktop\github\AIBoot\integrations\local-dual-report\runner.mjs` |
| 브랜치·코드 기준 | 로컬 `main`, `73afa6043f05601156ce7315f449dce169cd2755`. 감사 당시 GitHub main과 일치 |
| 작업 트리·파일 대조 | 미커밋·미추적 파일 없음. 추적 46개 파일은 CRLF/LF 정규화 후 GitHub blob과 모두 일치. Git 제외 로컬 생성물은 별도 |
| 정기 작업 상태 | 두 작업 모두 Ready, 최근 종료 코드 0. 마지막 실행은 오전 11/18 10:46:16, 오후 11/17 17:15:01 KST. 재시도·건너뛰기 실행도 있으므로 종료 코드만으로 발송을 확정하지 않음 |
| 발송 원장 근거 | Antigravity의 11/18 오전 09:49:32, 11/17 오후 16:04:40 KST 항목은 `sent`, 카드 3장·메시지 ID 존재. 메시지 ID는 웹훅 접수 근거 |
| 실제 사용자 화면 수신 | 미확인. 원장과 작업 종료 코드로 수신 성공을 대신하지 않음 |
| 오프라인 검증 | 기존 테스트 190개 통과. 외부 OAuth·실제 Sheets 쓰기·Apps Script 설치·iPhone 동작 성공을 뜻하지 않음 |

**구현 ≠ 테스트 통과 ≠ Windows 반영 ≠ 실제 운영·사용자 수신 검증.** 위 경로와 SHA는 당시 PC 반영 근거이고, 개별 기능의 실제 운영 검증은 별개다. 대화 완료 이력의 정기 보고 읽기 경로는 구현되어 있으나 감사 당시 로컬 완료 기록은 0건이어서 실자료 효과는 미검증이다.

정기 보고 실행기는 이 README가 아니라 `CURRENT.md`와 `docs/FIXED-EXPENSES-V1.md`를 정책 입력으로 읽는다. 이번 문서 정합성 PR은 두 정책 파일·운영 코드·설정·스케줄러·웹훅·원장을 변경하거나 배포하지 않는다. 다른 구현 README는 이 절을 참조하고 최신 Windows 상태를 중복 관리하지 않는다.
