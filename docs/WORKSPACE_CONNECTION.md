# AIWorkspace 로컬 연결 계약 — 2·3단계

2026-11-19. 기준 main: `ce25f542fe709c3c8018acbff23058ce0198fc8f`. **이 PR의 개발 구현이며 운영 설치·UI 활성화·실발송 승인이 아니다.** 운영 정책은 [CURRENT](../CURRENT.md)를 그대로 따른다.

## 경계와 상태

```text
동일 PC의 UI (http://127.0.0.1:5173)
  → 사용자 세션·CSRF 검증 백엔드 (127.0.0.1:17842)
  → 서버 내부 Bearer → AIBoot 제어 API (127.0.0.1:17841)
      ├ GET 4종: 저장본 또는 승인 소스 읽기
      └ 반복 예약 API: 기존 구현, 관리 쓰기 기본 차단
기존 Windows 정기 작업 2개 → 기존 runner·Antigravity·웹훅 (변경 없음)
```

별도 UI/레이아웃을 만들거나 AIWorkspace 파일을 수정하지 않는다. 새 상시 서비스나 시작 프로그램은 설치하지 않는다. 포트는 예시 기본값이며 사용 중이면 시작 실패한다. LAN/외부 바인딩, 프록시 자동 인증, iPhone 연결은 지원하지 않는다.

제어 API와 예약 관리 계약의 기준은 [REPEATING_REPORT_API](REPEATING_REPORT_API.md)다. GET 4종의 의미·입력·필드·업무 상태는 [AIWorkspace API_CONTRACT](https://github.com/chocoding0615/AIWorkspace/blob/main/docs/API_CONTRACT.md)를 따른다. 이 문서는 새 사용자 세션 경계와 현재 어댑터의 제한을 정의한다. AIWorkspace 문서의 과거 '미구현' 표시는 해당 문서 시점이며 UI는 여전히 Mock이다.

## 사용자 세션 계약 (Claude Code 인계)

브라우저는 17842만 호출한다. 17841의 Bearer 제어 토큰은 서버 파일·메모리 밖으로 전달하지 않는다. 브라우저에 OAuth, 웹훅, Google 원본 ID, 로컬 경로, 관리자 권한 또는 실행 명령을 주지 않는다. 새 토큰 디렉터리는 현재 Windows 사용자와 SYSTEM만 허용하고 파일 및 부모의 소유권·DACL을 검증한다. 링크·하드링크 및 검증 불가 ACL은 시작을 차단한다. 동일 Windows 계정의 악성 프로세스를 격리하는 보안 경계는 아니다.

운영 설치 승인 후 관리자가 다음 명령을 직접 실행하는 방식이다. **이 작업에서 운영 홈에 실행하지 않았다.**

```powershell
node integrations/workspace-api/cli.mjs init-access
node integrations/workspace-api/cli.mjs serve --ui-origin http://127.0.0.1:5173
```

- 서버는 사용자 전용 `workspace-api/access.json`에 독립 제어 토큰을 둔다. 기존 예약 access.json·OAuth·웹훅은 수정하지 않는다.
- 시작할 때 사용자 전용 `workspace-api/pairing.json`에 별도의 1회 인증 코드를 만든다. 운영자가 자기 PC에서 확인해 UI 로그인에 입력한다. URL·로그·GitHub에 넣지 않는다. Bearer 토큰과 다른 값이다.
- 인증 코드는 10분 유효, 최대 5회 시도, 성공 후 재사용 불가다. 재시작 시 코드가 바뀌고 기존 메모리 세션은 폐기된다.
- `POST /api/session`: JSON `{code}`, 정확한 승인 Origin 필수. 성공 200: `{data:{authenticated:true,csrfToken,expiresAt}}`. `HttpOnly; SameSite=Strict; Path=/api` 쿠키 발급.
- `GET /api/session`: 유효한 쿠키로 CSRF 토큰·만료 시각을 확인한다.
- `DELETE /api/session`: 쿠키 + `X-CSRF-Token` + 승인 Origin. 세션과 쿠키를 폐기한다.
- 세션은 최대 8시간, 비활동 30분이다. 쿠키와 CSRF는 재시작 후 복구하지 않는다. HTTP loopback 전용이며 외부 HTTPS 인증 설계로 확대 해석하지 않는다.
- 모든 데이터 요청은 `credentials: "include"`, `X-CSRF-Token`을 사용한다. UI Origin은 지정한 `http://127.0.0.1:포트` 하나만 허용한다. `localhost`와 섞지 않는다.
- Host가 실제 127.0.0.1 바인딩 포트와 다르거나 다른 Origin, cross-site 접근이면 403이다. CORS preflight도 메서드·헤더 허용목록을 검사한다.
- 프록시는 GET 4종과 기존 예약 경로만 허용한다. 임의 URL·명령·파일·업무 쓰기 경로는 없다. 브라우저 Authorization 헤더를 받지 않는다.
- 401 AUTH_REQUIRED: 로그인 필요. 403 CSRF_BLOCKED/PAIRING_EXPIRED: 재인증 또는 올바른 Origin/CSRF 필요. 503 CONTROL_OFFLINE: 백엔드 복구 필요. 504 TIMEOUT: 완료를 추정하지 않는다. 오류 원문·로컬 경로는 반환하지 않는다.

```javascript
// code는 운영자가 입력한 1회 코드. 제어 토큰을 UI 환경변수에 넣지 않는다.
const login = await fetch("http://127.0.0.1:17842/api/session", {
  method: "POST", credentials: "include",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ code })
});
const { data } = await login.json();
const response = await fetch("http://127.0.0.1:17842/api/tasks?sources=fixed,welfare", {
  credentials: "include", headers: { "X-CSRF-Token": data.csrfToken }
});
```

## GET 구현 매핑과 실패 처리

| 경로 | 구현·출처 | 현재 제한 |
|---|---|---|
| GET /api/health | 프로세스·빌드 버전·구현 capability | Google 연결·발송 성공 의미 아님. write/ai=false |
| GET /api/reports | sent 정규 원장과 대응 파일 CHAT 구간만 | INTERNAL/프롬프트 제외. 사용자 수신 null. 파손·파일 누락은 502 |
| GET /api/tasks | 지정된 6종 허용목록 중 요청한 소스만 | 모델 호출·원본/이력/캐시 쓰기 없음. 기본 limit=50, 최대100 |
| GET /api/connections | 설정 존재 여부만 읽기 | configured≠연결 성공. 현재 readStatus=not_checked, freshness=unknown |

날짜·slot·agent·limit·sources 및 응답 필드는 기존 API_CONTRACT를 유지한다. 알 수 없는 필드·중복 단일값·허용 외 소스는 외부 호출 전에 거절한다. 요청에 Google ID·경로·프롬프트는 받지 않는다.

- tasks는 기존 공식 원본 검증 어댑터를 재사용한다. 파일명·탭명·승인 gid가 일치한 숨김 탭도 허용하며 원본을 자동 대체하지 않는다. 복지 A/E, 지정 Chat 두 공간의 최근 7일, 기존 계약·차량보험 범위를 유지한다.
- 한 요청 안에서 파일 메타데이터를 공유한다. 영속 캐시와 '마지막 동기화 시각'은 만들지 않는다. connections는 자동 Google probe를 하지 않는다.
- tasks 전체 15초, 개별 SDK 호출 최대10초·retry=false·AbortSignal을 전달한다. 기한·클라이언트 취소 시 진행 중 전송을 취소한다. OAuth 갱신 자체의 SDK 내부 취소 보장은 별도 운영 시험이 필요하다. 강제 프로세스 종료를 도입하거나 기존 운영 SDK를 변경하지 않는다.
- 기한 내 끝난 소스는 보존하고 나머지는 TIMEOUT으로 표시한다. 일부 성공은 200 partial, 전부 기한 초과면 504다. 일부 조회 실패는 200 partial, 전부 실패는 502다. 실패를 빈 정상 결과로 바꾸지 않는다.
- 개수 제한으로 잘리면 partial + truncated/hasMore=true다. 현재 후속 페이징 계약이 없으므로 전체 목록이라고 표시하지 않는다. 더 좁은 sources 또는 최대100으로 조회할 수 있지만 완전 수집을 보장하지 않는다.
- live tasks는 프로세스당 한 건만 허용한다(동시 요청429). 기존 보고 보호 구간, generating/sending/unknown 원장, 공통 lease/guard 및 복구 마커가 있으면409 REPORT_PROTECTED다. 각 외부 호출 직전과 요청 중 재확인하며 보호 상태가 되면 취소한다. 저장 reports/health/connections는 외부 조회를 하지 않는다.
- 운영 보호 파일·원장·Chat 커서·완료 이력에 쓰지 않는다. 이 API의 동시 읽기 보호를 기존 생성·발송 공통 lease의 대체물로 사용하지 않는다.

## 완료 근거와 UI 인수 조건

상세 상태의 유일한 정의는 AIWorkspace API_CONTRACT §3.2.1이다. 구현은 `evidence.mjs`에서 시트/로컬을 별도 투영한다.

- 정기 업무는 보고용 '완료 항목 제거' 함수를 거치지 않고 회차·행위별 근거를 별도로 보여 준다.
- 원본 업무ID·동일 회차·기준일·행위·규칙을 검증한다. 로컬 근거는 기존 `readReportCompletions`의 사용자·확인 메시지 검증을 통과한 기록만 사용한다.
- 자료가 없는 로컬 상태 파일이나 검증되지 않은 빈 상태는 not_checked/unavailable로 두며 '미완료'를 만들지 않는다. 조회 성공·식별 완료일 때만 no_record/absent다.
- 출처별 sourceBusinessStatus는 계약 enum을 사용한다. 금액·원문 비고·확인자·메시지 ID를 내보내지 않고 불투명 evidenceRef를 사용한다.
- 시트 처리일이 정해진 날짜 형식으로 확인되지 않으면 양쪽 완료 일치로 격상하지 않는다. 과거 다른 기준일·회차·행위는 합치지 않는다.
- UI는 전체 '확인 필요', 출처별 '완료 근거 확인/기록 없음/조회 실패/미조회'를 나누어 표시한다. 확인 필요를 미완료로 치환하지 않는다.
- reports는 과거 저장 보고, tasks는 이번 조회다. 예약 시각·실제 시작·완료·웹훅 접수·사용자 수신은 분리한다.
- 401/403/409/429/502/503/504, partial, truncated, not_checked를 실제 화면에서 검증한 뒤 Mock을 교체한다. UI 연결은 별도 Claude Code 단계이며 이번 PR은 UI를 켜지 않는다.

## 예약 API 연결 및 Windows 시험

예약 Rule/Schedule/Run, 버전·멱등 키·confirmed·충돌·오류는 [공식 예약 계약](REPEATING_REPORT_API.md)만 따른다. 이 백엔드의 운영 진입점은 예약 목록·상세·validate를 연결하되 관리 쓰기를 차단한다. 관리 쓰기와 실발송을 각각 별도 승인해야 한다. CLI는 allowWrites 또는 allowDispatch를 true로 바꾼 접근 파일을 거절하며 우회 활성화 옵션이 없다.

WindowsBackend는 Windows가 반환하는 트리거 순서를 정규화한다. 같은 시각의 다른 요일도 결정적으로 정렬하며 요일·시각·시작일·설정의 실제 차이는 계속 TRIGGER_MISMATCH다. 기존 두 정기 작업은 변경하지 않는다.

명시적 사용자 승인 후에만 다음 통합 시험을 실행한다. 운영 계정의 작업 권한을 쓰므로 일반 회귀 테스트에 자동 포함하지 않는다.

```powershell
node integrations/workspace-api/verify-windows.mjs --confirm-synthetic-task --exercise-disabled-dispatch --operating-repo <운영저장소>
```

비공개 백업 → 기존 작업/원장/설정 해시 → 임시 인증·GET → 미래 토요일 합성 예약 최대16개 → 수정/정지/재개/삭제 → 불일치 차단 → 추가 작업 제거 → 원본 비교 순서다. 기존 추가 작업이 있으면 중단한다. 합성 홈에는 allowDispatch=false, 실제 업무 설정·실행 원장이 없고 실제 보고 실행기를 호출하지 않는다. 실패 시에도 생성한 추가 작업만 정리한다. 운영 코드 적용·작업 상시 등록·실발송 활성화는 하지 않는다.

실제 재부팅·절전·로그아웃·예약 시각 자동 기동·보고 수신은 이 시험으로 검증하지 않는다. 강제 종료·잔류 guard/PID 재사용·unknown 보존·롤백·중복 방지·공휴일 정책은 기존 회귀 시험을 재사용하고 실제 전원 시험과 구분한다.


## 2026-11-19 확인 결과

- 전체 오프라인 회귀 366개 통과(기존323+신규43). 실제 시각에 따라 실패하던 기존 runner 시험은 합성 now를 공통 lease에 전달하도록 시험 한 줄만 보완했다. 운영 보호 구간은 바꾸지 않았다.
- 실제 세션→백엔드→제어 API: health 200/6ms, reports 200/16ms, connections 200/4ms. 무인증·CSRF 누락 차단, 비공개 ACL 허용 및 광범위 상속 ACL 거절 확인.
- 전체 소스 tasks: 최종 200 partial/9177ms, 6종 모두 읽기 성공. 기본50개 제한에 따른 truncated이며 실패를 숨긴 partial이 아니다. SDK 읽기14회(HTTP 패킷·OAuth 내부 요청 수와 다름), 공휴일은 당일 기존 캐시 사용.
- 최초 전체 조회는15029ms에504 취소됐다. 재검증에서9.18초가 나왔다고15초 보장을 주장하지 않는다. 완료된 소스 보존 및 진행 전송 취소를 회귀 시험으로 보완했고 예산15초는 유지했다.
- 실제 Windows 등록에서 두 트리거 반환 순서가 달라 TRIGGER_MISMATCH를 발견했다. 정규화 후 최대16개, 상한 거절, 수정·일시정지·재개·삭제 및 실제 불일치 차단을 통과했다. 임시 추가 작업은 모두 제거했다.
- 별도 동일 안전 조건의 Limited 계정 dispatcher 수동 기동: LastTaskResult=0, 합성 상태 lastScanAt만 갱신, 실행 회차0개, allowDispatch=false. 정확한 예약 시각 자동 기동 시험은 아니다. --exercise-disabled-dispatch는 이 시험을 재현하는 명시적 선택이다.
- 기존 운영 SHA·설정·원장·완료 이력·인증·Chat 커서와 두 정기 작업 XML은 불변. 모델·웹훅 호출0건. 실제 전원/로그아웃·실발송·UI 연결·사용자 수신은 미검증이며 다음 승인을 기다린다. 비공개 검증 원문은 로컬 백업에만 보존했다.
