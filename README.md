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
| [integrations/local-dual-report](integrations/local-dual-report/README.md) | **운영 중** (Windows 작업 스케줄러) | 평일 09:30/16:00 정기 보고. Codex·Antigravity가 기존 웹훅으로 카드 3장씩 발송 |
| [tools/fixed-expense-flow](tools/fixed-expense-flow/README.md) | **완료, v1 동결** | 고정비 22개 연결현황을 읽기 전용으로 점검 |
| [integrations/google-chat](integrations/google-chat/README.md) | **시제품, 미배포** | 양방향 회신 기록용. 향후 연결을 위해 보존하며 정기 보고에 쓰지 않음 |

## 운영 PC 현황 (2026-11-06 확인)

GitHub main 병합은 운영 PC 전환이 아니다. 작업 스케줄러는 `C:\Users\admin\Desktop\github\AIBoot` 체크아웃을 그대로 실행한다.

- **실행 중인 코드:** 브랜치 `claude/chat-oauth-client`, 커밋 `32577bb` (main의 조상)
- **아직 운영에 없는 것:** 고정비 회차 수정(#9), 이후 문서 변경. 운영 보고에는 이전 회차 규칙과 이전 `CURRENT.md`가 쓰인다
- **시험 운영 종료일:** `config.json`의 `trialEnd`가 2026-11-10이다. 이후 정기 보고는 실행기가 건너뛴다
