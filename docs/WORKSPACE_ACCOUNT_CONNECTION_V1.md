# AIWorkspace 계정 연결 계약 v1 — 개발 기준 (제안)

작성: 2026-11-20. 1단계: 계정 연결. 기존 AIBoot `CURRENT.md`, `docs/WORKSPACE_CONNECTION.md`, AIWorkspace `docs/API_CONTRACT.md`보다 운영 권한을 확대하지 않는다. **이 문서는 구현·운영 반영 증빙이 아니다.**

## 1. 목적과 기존 기능 재사용

- AIBoot 서버는 기존 Google Sheets·Google Chat 승인 인증을 재사용하고, AIWorkspace는 같은 PC 사용자 세션(127.0.0.1:17842)을 통한다. 17841의 Bearer 및 Google OAuth 토큰을 브라우저에 전달하지 않는다.
- 기존 `GET /api/connections`의 `configured`는 설정 여부뿐이며 로그인 성공·접근 권한·마지막 성공 시각이 아니다. 기존 필드를 변경하지 않는다.
- 09:30/16:00 정기 보고, 기존 Windows 작업·원장·Chat 커서, 예약 쓰기·발송, AI 호출, 기존 인증 파일을 변경하지 않는다.
- 신규 연결 상태 검증은 사용자가 버튼으로 요청하는 읽기 전용 검사이며, 임의 정기 폴링이나 자동 토큰 재발급/교체를 하지 않는다.

## 2. 1단계 경계

범위: 기존 연결 상태 표시, Sheets·Chat 승인 범위 내 접근 검사, 계정 재인증 필요 여부 안내, 읽기 전용 API와 기존 화면 연결. Antigravity는 Google 계정 연결과 구분하며 이번 단계에서 실행·로그인하지 않는다. 신규 Google 계정 추가·계정 전환, OAuth scope 확대, 사용자별 멀티테넌트, 외부 LAN·iPhone 원격 로그인, Sheets 변경·Chat 발송, 스케줄러 변경은 제외한다.

## 3. API 계약 (확정 제안 — 구현 전 양쪽 일치 필요)

요청: `POST /api/connections/verify` JSON `{ "sources": ["sheets","chat"] }`; 둘 중 하나만 가능. 기존 세션 쿠키 + CSRF 헤더 + 정확한 Origin/Host 필요. 승인된 로컬 사용자만. 요청당 동시 검사는 1건으로 제한하며 429 반환. 무인증 401, CSRF/Origin 거절 403, 보고 실행·잠금 또는 기타 보호 상태 409, 승인 외 목록/중복/잘못된 형식 400, 연결 불가 503, 시간 초과 504. 재시도는 자동 수행하지 않는다.

정상 HTTP 200 응답:
```json
{
  "requestId": "opaque",
  "apiVersion": "v1",
  "status": "ok",
  "data": {
    "items": [
      {
        "provider": "google",
        "service": "sheets",
        "configured": true,
        "state": "connected",
        "checkedAt": "2026-11-20T00:00:00Z",
        "verifiedAccess": true,
        "scopeStatus": "sufficient",
        "accountLabel": null,
        "action": "none",
        "errorCode": null
      }
    ]
  },
  "meta": { "requestedAt": "2026-11-20T00:00:00Z", "completedAt": "2026-11-20T00:00:00Z" }
}
```

- `state`: `not_configured | not_checked | connected | reauth_required | access_denied | unavailable | error`. `connected`는 해당 서비스의 승인된 최소 실접근 성공만을 뜻하며 모든 시트·공간 권한을 보증하지 않는다.
- `verifiedAccess`: `true | false | null`; 미검증·일시 장애 시 `null`. `scopeStatus`: `sufficient | insufficient | unknown`. 실제 확인 근거 없는 `sufficient` 금지.
- `accountLabel`: 별도 명시적 허용 없이 항상 `null`; 개인 주소, Google resource ID, OAuth 토큰, 로컬 경로, 서버 오류 원문 노출 금지.
- `action`: `none | retry_verify | local_reauth_required | contact_admin`. UI가 임의 OAuth URL을 만들거나 인증 파일을 교체하지 않는다.
- `errorCode`: `null | NOT_CONFIGURED | AUTH_REQUIRED | PERMISSION_DENIED | NETWORK_ERROR | TIMEOUT | CHECK_FAILED`.
- 소스 일부 실패: HTTP 200, `status=partial`, 소스별 실패 분리. 모든 소스 장애를 '정상/미연결'로 일괄 판정하지 않음.
- Google API 401/403의 원인이 권한 누락인지, 인증 만료인지 확정할 수 없는 경우 `error`와 `CHECK_FAILED` 또는 `access_denied`를 근거에 맞춰 사용하고 임의로 '토큰 만료'로 단정하지 않는다.
- `GET /api/connections` 기존 응답은 현행 호환 유지. `verify`가 호출되지 않았으면 `not_checked` 유지.
- 조회 결과에 Google API 호출·OAuth 갱신의 부작용이 없는지 검증하고, 자동 토큰 갱신 가능성이 있다면 읽기 전용 보장을 증명하기 전까지 검증 기능을 비활성화한다.

## 4. 재인증 절차

이번 단계의 재인증은 **안전한 수동 안내**까지다. 기존 AIBoot 운영 인증 파일을 웹 버튼에서 자동 교체하지 않는다. 계정 소유자가 사용자 세션으로 명시 확인하고 기존 운영 인증을 백업한 다음, 현행 승인된 로컬 재인증 절차를 따르도록 안내한다. 해당 절차의 실제 CLI·콜백·권한 범위·롤백 방식이 검증되지 않으면 '재인증 필요 — 관리자 수동 조치'로 표시하고 클릭 가능한 재인증 실행 버튼은 내지 않는다. 회사 내부 자원 ID와 인증 상세값을 로그/PR에 포함하지 않는다.

## 5. 병렬 작업의 소유권과 품질 게이트

A 계약 확정 뒤 B/C를 병렬 진행:
- B(Codex, AIBoot): 위 계약대로 17841/17842 경계의 검증 API, 허용목록·잠금·타임아웃·오류 매핑, 합성 테스트. `CURRENT.md`/runner/운영 토큰 불변.
- C(Claude Code, AIWorkspace): 이미 검증한 PR #4 기준 화면의 기존 연결 서랍·모바일 상태 메뉴에 명시적 '연결 확인'과 확인 결과·안내 표시. 새로운 OAuth 플로우 또는 별도 로그인 개발 금지. `previews/` 원본 불변. 변경을 별도 PR로 제출.
- D(Codex + Antigravity): Codex 기능·계약 회귀 테스트, Antigravity 독립 읽기 전용 코드·권한·정기 보고 영향 검토. 리뷰 실패 시 원 담당자가 수정. 모델/웹훅/실시트 쓰기 호출 0건.
- 모든 PR·보고·UI 문구는 한국어. 영문 기술 식별자는 유지.
- 실제 Windows 인증이나 Google 계정 재승인은 사용자 검토 이후. PR 자동 병합, 운영 설치, 지속 실행은 별도 승인.

## 6. 인수 판정

인증된 사용자가 승인된 Sheets·Chat에 한해 실접근 결과를 확인할 수 있다. 미설정/미검증/재인증 필요/권한 거부/일시 장애가 명확히 구분된다. 기존 GET 4종과 PR #4 인증·UI 회귀 통과. 주어진 권한 밖의 자원을 읽지 않으며 보고 실행·원장·커서·인증 파일·예약 상태가 보존된다. 실제 계정 교체·외부 공개·발송은 0건.

**미해결 설계 게이트:** 실접근 확인 시 Google SDK가 OAuth 토큰을 자동 갱신하는지, 기존 승인 소스에서 무부작용 최소 검사가 가능한지 실코드 근거로 확인. 통과 전 `verify`를 운영 활성화하지 않는다.
