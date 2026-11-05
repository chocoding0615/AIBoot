/*
 * AIBoot 고정비 업무 흐름 — 구조 데이터 (읽기 전용 시각화용)
 *
 * - 이 파일에는 금액·토큰·웹훅·스페이스 ID·개인정보를 넣지 않는다. 업체명과 규칙은 docs/FIXED-EXPENSES-V1.md에 이미 있는 내용이다.
 * - 실행 근거(마지막 조회·발송 결과, 코드 점검 결과)는 build-evidence.mjs가 이 PC에서만 만드는 evidence.local.js에서 온다.
 * - 코드 참조는 integrations/local-dual-report/runner.mjs 의 함수 이름 기준이다(줄 번호는 바뀔 수 있음).
 * - 다른 분야(계약서·라이센스·복지·정기 업무)는 같은 형식의 domain 객체를 하나 더 추가하면 된다.
 */
window.AIBOOT_FLOW = {
  domain: '고정비',
  investigatedAt: '2026-11-05',
  sheetUrl: 'https://docs.google.com/spreadsheets/d/1za_CvtiImh51W9J_YzmY146rf7FaQ2oKz-3eHq8wiIo/edit#gid=695174831',

  statuses: {
    ok:         { label: '연결 확인', icon: '●', desc: '실제 데이터 조회·실행 성공 근거가 있음' },
    partial:    { label: '부분 연결', icon: '◐', desc: '일부 단계만 연결(예: 일정은 계산하지만 청구서는 미연결)' },
    none:       { label: '미연결',    icon: '○', desc: '해당 자료를 읽는 기능이 코드에 없음' },
    manual:     { label: '수동 처리', icon: '✋', desc: '담당자가 직접 확인해야 하는 단계' },
    fail:       { label: '조회 실패', icon: '✕', desc: '연결 기능은 있지만 최근 실제 조회가 실패함' },
    unverified: { label: '미검증',    icon: '?', desc: '코드·경로는 있으나 실제 동작 근거 없음' },
    inactive:   { label: '비활성',    icon: '–', desc: '더 이상 관리하지 않음(또는 규칙상 이 단계 제외)' }
  },

  // 업체별 4단계: 납부 일정 / 청구서 자동 확인 / 지출결의 표시(연노랑) / 실제 지급 확인
  stepNames: { schedule: '납부 일정', invoice: '청구서 자동 확인', approval: '지출결의 표시', payment: '실제 지급 확인' },

  // docs/FIXED-EXPENSES-V1.md 표(23행) 그대로. invoice: gmail = 회사 Gmail로 오는 청구서(코드상 Gmail 미연결), manual = Gmail 밖 경로, excluded = 규칙상 청구서 확인 제외
  vendors: [
    { row: 14, name: 'KT', kind: '통신비', period: '월 1일~말일', basis: '익월 25일', path: '회사 Gmail', invoice: 'gmail', note: '자동이체 — 실제 출금은 별도 확인' },
    { row: 15, name: '베네피아', kind: '서비스 이용료', period: '월 1일~말일', basis: '익월 15일', path: '별도 사이트(휴대전화 인증)', invoice: 'manual', note: '과거 익월 20일 기준은 폐기됨' },
    { row: 16, name: '알고퀵', kind: '운송비', period: '월 1일~말일', basis: '익월 10일', path: '회사 Gmail', invoice: 'gmail', note: '계좌이체' },
    { row: 17, name: 'Sendy', aliases: ['센디'], kind: '운송비', period: '월 1일~말일', basis: '익월 10일', path: '회사 Gmail', invoice: 'gmail', note: '계좌이체. 9월 PDF 비교 성공 사례는 사람이 수행한 1회성 대조이며 자동 기능 아님' },
    { row: 18, name: '이지화물', kind: '운송비', period: '월 1일~말일', basis: '당월 말일', path: '회사 Gmail', invoice: 'gmail', inactive: true, note: '2026-10 이용 종료·정리 완료, 11월 이후 비활성' },
    { row: 19, name: '커피마켓어스', kind: '서비스 이용료', period: '월 1일~말일', basis: '익월 1일', path: '카카오톡 → 사용자 파일 저장', invoice: 'manual', note: '사용자 확인: 해당 회차 전자결재 완료 — 같은 단계 재요청 금지', confirmed: '전자결재 완료(사용자 확인, 2026-11-04)' },
    { row: 20, name: '생각공장', kind: '서비스 이용료', period: '월 1일~말일', basis: '익월 말일', path: '회사 Gmail', invoice: 'gmail', note: '2026-09 사용분 납부 완료(사용자 확인) — 근거 없는 불일치·미납 보고 금지', confirmed: '2026-09 사용분 납부 완료(사용자 확인)' },
    { row: 21, name: '푸딩', kind: '서비스 이용료', period: '월 1일~말일', basis: '익월 10일', path: '푸딩 관리자페이지(사용자 로그인)', invoice: 'manual', note: '' },
    { row: 22, name: '런치랩', kind: '서비스 이용료', period: '월 1일~말일', basis: '익월 1일', path: 'Gmail 또는 런치랩 관리자페이지', invoice: 'gmail', note: '보안 HTML 실패 경험 — 사이트 대체 경로. 사용자 확인: 해당 회차 전자결재 완료', confirmed: '전자결재 완료(사용자 확인, 2026-11-04)' },
    { row: 23, name: '복합기(성수)', kind: '렌탈', period: '월 1일~말일', basis: '익월 25일', path: '세금계산서 사이트 PDF', invoice: 'manual', note: '자동이체' },
    { row: 24, name: '코웨이(본사)', kind: '렌탈', period: '월 1일~말일', basis: '익월 20일', path: '세금계산서 사이트 PDF', invoice: 'manual', note: '자동이체' },
    { row: 25, name: '수유 전기료', kind: '공과금', period: '11일~다음 달 10일', basis: '기간 종료 익월 말일', path: '회사 Gmail', invoice: 'gmail', note: '' },
    { row: 26, name: '수유 수도요금', kind: '공과금', period: '달력상 2개월(1~2월, 3~4월 …)', basis: '각 회차 종료 익월 말일', path: '회사 Gmail', invoice: 'gmail',
      note: '문서는 격월 회차이나 코드(fixedSchedule)는 매월 말일로 계산함 — 격월 여부는 사람이 판단', scheduleOverride: 'partial' },
    { row: 27, name: '매장 전기료', kind: '공과금', period: '5일~다음 달 4일', basis: '기간 종료 익월 10일', path: '카카오톡 → 사용자 파일 저장', invoice: 'manual', note: '사용기간 규칙일 뿐 “4일 검침 요청” 업무 아님(검증 단계에서 “검침” 표현 차단)' },
    { row: 28, name: '매장 안전관리자', kind: '시설 관리', period: '상세 사용기간 미기재', basis: '관리표 10일, 세부 회차 미확정', path: '청구서 확인 작업 제외', invoice: 'excluded',
      note: '문서상 세부 회차 미확정이지만 코드는 “10일”을 뽑아 매월 10일로 계산함. 청구서 확인만 제외, 다른 관리는 유지', scheduleOverride: 'partial' },
    { row: 29, name: '쿠쿠(매장)', kind: '렌탈', period: '월 1일~말일', basis: '익월 20일', path: '별도 사이트 이체내역서', invoice: 'manual', note: '자동이체' },
    { row: 30, name: 'Spotify', kind: '구독', period: '11일~다음 달 10일', basis: '기간 종료 익월 11일', path: '별도 사이트 결제내역', invoice: 'manual', note: '자동이체' },
    { row: 31, name: '양주 전기료', kind: '공과금', period: '23일~다음 달 22일', basis: '기간 종료 익월 15일', path: '회사 Gmail 이외 별도 이메일', invoice: 'manual', note: '별도 계정·접근 경로 미검증' },
    { row: 32, name: '서브(D)창고 전기료', kind: '공과금', period: '10일~다음 달 9일', basis: '기간 종료 익월 말일', path: '회사 Gmail', invoice: 'gmail', note: '자동이체' },
    { row: 33, name: '서브(E)창고 전기료', kind: '공과금', period: '10일~다음 달 9일', basis: '기간 종료 익월 말일', path: '회사 Gmail', invoice: 'gmail', note: '자동이체' },
    { row: 34, name: '양주 수도요금', kind: '공과금', period: '고지서별 변동', basis: '고지서 실제 인출예정일 우선', path: '회사 Gmail', invoice: 'gmail', note: '코드가 예정일을 계산하지 않음(날짜 미확정). 시트·스페이스에 구체 근거가 있을 때만 보고' },
    { row: 35, name: '복합기(양주)', kind: '렌탈', period: '월 1일~말일', basis: '익월 25일', path: '회사 Gmail', invoice: 'gmail', note: '자동이체' },
    { row: 36, name: '코웨이(양주)', kind: '렌탈', period: '월 1일~말일', basis: '익월 20일', path: '세금계산서 사이트 PDF', invoice: 'manual', note: '자동이체' }
  ],

  // 원본 데이터(①단계 하위 항목). status 'dyn:*'는 evidence.local.js 값으로 결정된다.
  sources: [
    { id: 'jp', title: 'JP매월 지출', sub: '고정비 원본 시트', status: 'dyn:sheets', items: [
      ['원본', '회사 고정비 Google Sheets › 탭 `JP매월 지출`'],
      ['실제 읽는 범위', 'dyn:rangeJP'],
      ['읽는 방법', 'spreadsheets.get(읽기 전용) — 셀 표시값과 배경색만. 시트에 쓰기 없음'],
      ['수집되는 정보', '범위 안 모든 셀의 표시값을 한 줄씩 텍스트로 이어붙임. 배경 연노랑(#fff2cc) 셀은 `(연노랑)` 표시 = 지출결의 작성·제출 표시(결재 승인·납부 아님)'],
      ['코드가 해석하는 것', '없음 — 업체·금액·날짜 열을 코드가 해석하지 않고 원문 그대로 AI 입력으로 넘긴다. 업체별 예정일은 이 시트가 아니라 docs/FIXED-EXPENSES-V1.md 표에서 계산한다'],
      ['읽지 않는 탭', '`고정비 대시보드`(폐기 예정), `시트내용`(계정정보 포함), 운송료DB 등 다른 탭은 코드에 범위가 없어 읽지 않음'],
      ['연결된 업체', 'dyn:vendorCount']
    ], link: true },
    { id: 'daily', title: 'AIBoot_데일리마감', sub: '완료·대기 기록(숨김 탭)', status: 'dyn:sheets', items: [
      ['실제 읽는 범위', 'dyn:rangeDaily'],
      ['열 구성', '기록시각 · 기록일 · 업체 · 사용회차 · 상태 · 다음확인일 · 메모 · 기록자 · 원문 (추가만, 같은 업체·사용회차의 마지막 행이 현재 상태)'],
      ['기록 주체', 'Google Chat 앱(Apps Script)의 `완료/대기/휴가` 회신 — 앱은 **미배포**(CURRENT.md). 2026-11-03 탭 생성 시 기록 0건. 현재 기록 건수는 이 화면에서 확인하지 않음(시트 직접 확인)'],
      ['원본 체크와 실제 납부 완료의 차이', 'JP매월 지출의 연노랑 = 지출결의 제출 표시, 전자결재 완료 = 결재 단계 완료. 둘 다 **실제 지급 완료가 아니다**. 지급 완료는 사용자가 명시적으로 확인한 경우(이 탭의 `완료` 기록 또는 CURRENT.md 사용자 확인 항목)만 인정'],
      ['보고 반영 규칙', '코드가 행을 해석하지 않고 원문을 AI에 넘긴다. AI는 “업체+사용회차+업무단계” 단위로 이미 처리된 단계는 오늘 남은 일에 재요청하지 않는다. 날짜가 지났다는 사실만으로 미납·미완료로 단정하지 않는다'],
      ['코드로 강제되는 부분', '검증 단계에서 커피마켓어스·런치랩 결재 재요청, 생각공장 불일치·미납, “미납” 단정 표현을 정규식으로 차단(그 외 판단은 AI 몫)']
    ], link: true },
    { id: 'doc', title: 'FIXED-EXPENSES-V1.md', sub: '업체별 납부 규칙 문서', status: 'dyn:schedule', items: [
      ['역할', '업체별 납부 예정일의 **실제 계산 원천**. fixedSchedule()이 이 문서 표의 “행·업체·납부 기준·운영 상태” 열을 파싱한다'],
      ['계산 방식', '“말일” → 그 달 마지막 날, “N일” → N, “고지서” → 날짜 없음. 사용기간 열은 계산에 쓰지 않음 → 같은 날짜가 매월 반복된다'],
      ['비활성 처리', '운영 상태에 “비활성/종료”가 있고 업체명이 이지화물이면 목록에서 제외'],
      ['계산 결과', 'dyn:scheduleSummary'],
      ['주의', '휴일 결제일 이동 규칙은 미확정 — 예정일을 옮기지 않는다']
    ] },
    { id: 'gmail', title: '회사 Gmail', sub: '청구서 수신', status: 'dyn:gmail', items: [
      ['코드 상태', 'dyn:gmailCode'],
      ['의미', '알고퀵·Sendy 등 Gmail로 오는 청구서의 수신 여부를 AIBoot가 **확인하지 않는다**. 사람이 메일함에서 확인한다'],
      ['보고 영향', '보고 하단에 “확인 불가(미연결): … 회사 Gmail …” 표시. 검증 단계는 “Gmail…확인됨/수신됨” 같은 표현을 차단']
    ] },
    { id: 'chat', title: '지정 Chat 스페이스 2개', sub: '업무 공지 참고(읽기 전용)', status: 'dyn:chat', items: [
      ['역할', '고정비 계산에는 쓰지 않음. 예정일 미확정 업체(양주 수도요금 등)를 언급할 근거, [기타 업무] 참고 자료'],
      ['최근 결과', 'dyn:chatDetail']
    ] }
  ],

  // 처리 단계(②~⑥)
  stages: [
    { id: 'collect', no: 2, title: 'AIBoot 데이터 수집', sub: 'runner.mjs › snapshot()', status: 'dyn:sheets', items: [
      ['실행', 'Windows 작업 스케줄러 `AIBoot-DualReport-morning/afternoon`이 평일 09:30·16:00에 실행, 15분 간격으로 75분 동안 재확인(이미 보낸 회차는 건너뜀)'],
      ['실행되는 코드', 'dyn:repoInfo'],
      ['건너뛰는 날', '주말 · 한국 공휴일(Google 공개 캘린더) · config의 휴가/지정 휴무 · 시험 운영 기간 밖 · 보고 시간대 밖(오전 09:30–11:00, 오후 16:00–17:30). PC가 꺼져 있으면 그 회차는 발송 안 됨'],
      ['읽는 자료', 'JP매월 지출 · AIBoot_데일리마감(읽기 전용) + 계약서·라이센스·복지·정기 업무 시트 + 지정 Chat 스페이스. 고정비 판단에 쓰이는 것은 앞의 두 탭과 FIXED-EXPENSES-V1.md'],
      ['마지막 수집', 'dyn:sheetsDetail']
    ] },
    { id: 'calc', no: 3, title: '납부 일정·업무 계산', sub: 'runner.mjs › facts()', status: 'dyn:schedule', items: [
      ['임박 업무 선택 규칙', '오늘 ~ 오늘+7일(8일 창)의 각 날짜에 fixedSchedule(날짜)를 적용해 “규칙상 예정일 = 그 날짜”인 업체만 `고정비 임박 예정` 목록에 넣는다'],
      ['이번 달 전체 예정', '참고용으로 AI에 함께 전달하되 “임박이 아니면 오늘 남은 일에 넣지 말 것”으로 지시'],
      ['처리 여부 판단', '**코드는 처리 여부를 판단하지 않는다.** 임박 목록 중 “실제 미처리 항목만” 넣으라고 AI에 지시하고, AI가 시트 스냅샷(연노랑·데일리마감)과 운영 기준을 읽어 판단한다'],
      ['날짜 미확정 업체', 'dyn:undated'],
      ['오늘 기준 임박 목록', 'dyn:imminent']
    ] },
    { id: 'ai', no: 4, title: 'Codex · Antigravity 분석', sub: 'runner.mjs › generate()', status: 'dyn:ai', items: [
      ['역할', '두 AI가 같은 입력으로 **각자 독립된 보고서**를 쓴다(서로의 출력은 보지 않음). 2026-11-04~11-10 비교 시험 운영 — 보고는 회차당 2건'],
      ['실제 실행 방식', 'Codex: `codex exec --sandbox read-only --ephemeral` (ChatGPT 구독) · Antigravity: `agy -p … --mode plan` (Google 계정 한도, 한도 소진 시 재시도 안 함). 각자 빈 임시 폴더에서 별도 프로세스, 제한 10분'],
      ['입력 자료', '운영 기준(CURRENT.md + FIXED-EXPENSES-V1.md 전문) · 계산된 사실(날짜·임박 목록·연결 상태) · 시트 스냅샷 원문 · Chat 메시지(연결 시)'],
      ['출력 결과', '`=== CHAT ===` 짧은 보고(발송 대상) + `=== INTERNAL ===` 판단 근거·제외 이유(이 PC의 %USERPROFILE%\\.aiboot\\reports\\에만 저장)'],
      ['AI가 결정하는 것', '어떤 임박 업체가 이미 처리됐는지, 요약 1~3건의 우선순위와 문구'],
      ['최근 실행', 'dyn:aiDetail']
    ] },
    { id: 'validate', no: 5, title: '보고 내용 검증', sub: 'runner.mjs › validate()', status: 'dyn:validate', items: [
      ['잘못된 납부 완료 판단 방지', '“미납” 단정, 연노랑 없음을 “미작성·미처리”로 단정, 생각공장 불일치·미납·재확인, 커피마켓어스·런치랩 결재 재요청 표현이 있으면 실패'],
      ['비활성 업체 제외', 'dyn:easyCheck'],
      ['날짜 검증', '업체명이 들어간 줄의 날짜가 규칙상 예정일과 다르면 실패. 오늘 남은 일 [고정비]에 7일 창 밖 날짜가 있거나 날짜 오름차순이 아니면 실패. 예정일 미확정 업체를 근거 없이 쓰면 실패'],
      ['형식 검증', '대분류 4개 순서·실선 3개 · 분야 순서 · 요약 1~3건 · 2,000자 이내 · 미연결 자료(Gmail·캘린더)를 본 것처럼 쓴 표현 금지 · 비밀값 형태 문자열 금지'],
      ['중복 발송 방지', '`ledger.json` 키 `날짜|시간대|agent`, 파일 잠금. sent → 재발송 안 함 · sending(결과 불명) → 자동 재발송 안 함 · generating 15분 초과 → 재시도 · 3회 실패 → 중지'],
      ['오류 시 처리', '검증 실패·AI 오류 → **발송하지 않고** ledger에 failed와 사유 기록. 카드 변환 후 원문 줄이 빠지거나 순서가 바뀌면 발송 안 함'],
      ['최근 실패', 'dyn:failures']
    ] },
    { id: 'chatout', no: 6, title: 'Google Chat 보고', sub: 'runner.mjs › toCards() · post()', status: 'dyn:send', items: [
      ['보고 구조', '오전: 당일 업무·중요 예정·주의 / 오후: 확인된 완료·잔여·다음 업무. 대분류는 `내용 요약 및 추천 → 오늘 완료 → 오늘 남은 일 → 내일(다음 근무일) 업무`'],
      ['카드 3개 구성', '① 내용 요약 및 추천 ② 오늘 완료 + 오늘 남은 일 ③ 다음 근무일 업무(하단에 미연결 자료 안내). 웹훅이 카드를 거부(HTTP 400)하면 같은 내용을 텍스트로 보냄'],
      ['고정비 표시 위치', '오늘 남은 일 [고정비]: 7일 이내 임박분 중 미처리만 · 오늘 완료 [고정비]: 오늘 새로 확인된 완료 · 다음 업무 [고정비]'],
      ['발송 경로', '기존 Google Chat 웹훅(주소는 이 PC의 config.json에만 있음, 로그에도 기록하지 않음). 메시지 ID = 웹훅 접수 근거, 화면 수신은 사용자 확인'],
      ['마지막 발송 결과', 'dyn:sends']
    ] }
  ],

  // 2026-11-05 조사에서 확인한 코드·운영 차이(근거 포함). 고친 뒤에는 이 목록에서 지운다.
  findings: [
    { level: 'warn', title: '마지막 정규 보고는 현재 검증 규칙 이전 코드로 발송됨',
      body: '11/05 09:30 Codex 정규 보고 본문에 이번 달 전체 고정비(25·30일 납부 등)가 “오늘 남은 일”로 나열되고 “사실:/권고:” 표현이 쓰였다. 7일 임박·표현 검증은 같은 날 10:57 커밋(04fb0d1)으로 추가됐다. 현재 코드의 첫 정규 실행은 11/05 16:00 회차.',
      ref: '%USERPROFILE%\\.aiboot\\reports\\2026-11-05-morning-codex.md · git 04fb0d1' },
    { level: 'warn', title: '수유 수도요금 격월 회차가 코드에 반영되지 않음',
      body: '문서는 “1~2월, 3~4월 등 달력상 2개월 회차, 종료 익월 말일”이지만 fixedSchedule()은 납부 기준의 “말일”만 보고 매월 말일로 계산한다. 해당 없는 달에도 임박 목록에 오를 수 있다.', ref: 'runner.mjs › fixedSchedule()' },
    { level: 'warn', title: '매장 안전관리자 “세부 회차 미확정”이 매월 10일로 계산됨',
      body: '납부 기준 “관리표 10일, 세부 회차 미확정”에서 정규식이 “10일”을 뽑는다. 11/05 오전 두 보고 모두 “10일 납부: 매장 안전관리자”로 표기했다.', ref: 'runner.mjs › fixedSchedule() · 11/05 오전 보고' },
    { level: 'info', title: '완료 기록 입력 경로가 아직 없음',
      body: 'AIBoot_데일리마감은 Chat 앱 회신으로 채워지는 구조인데 Chat 앱은 미배포다. 실행기는 탭을 읽지만, 현재 완료·지급 정보는 CURRENT.md에 적힌 사용자 확인 항목과 시트 연노랑 표시에 의존한다.', ref: 'integrations/google-chat/README.md · CURRENT.md' },
    { level: 'info', title: '운영 실행기는 main이 아니라 PR 브랜치 작업 폴더에서 실행됨',
      body: '작업 스케줄러는 AIBoot 작업 폴더의 runner.mjs를 직접 실행한다. main에는 local-dual-report가 아직 병합되지 않았다(PR #2~#6 미병합). 현재 체크아웃된 브랜치는 위 “실행되는 코드”에 표시.', ref: 'Get-ScheduledTask AIBoot-DualReport-*' },
    { level: 'info', title: '운송비 청구서 확인은 자동 기능이 아님',
      body: 'Sendy “9월 PDF 비교 성공 사례”는 사람이 한 1회성 대조다. 알고퀵·Sendy 청구서는 회사 Gmail로 오지만 실행기에 Gmail 읽기 코드가 없다.', ref: 'runner.mjs › snapshot() sources[\'회사 Gmail\']' }
  ],

  // 사람이 하는 일 vs AIBoot가 하는 일
  division: {
    auto: [
      '시트 2개 탭 읽기(JP매월 지출, AIBoot_데일리마감)',
      '문서 규칙으로 업체별 이번 달 예정일 계산, 7일 이내 임박 목록 생성',
      '이지화물 제외, 날짜·금지 표현·형식 검증',
      'AI 2종의 보고서 작성(처리 여부는 AI가 시트 원문으로 추정)',
      '중복 없이 Google Chat 카드 발송, 결과 기록'
    ],
    human: [
      '청구서 수신 확인(Gmail·카카오톡·관리자페이지·세금계산서 사이트) — 자동 확인 0건',
      '지출결의 작성·전자결재(연노랑 표시는 사람이 함)',
      '실제 지급·출금 확인(은행·이체내역 연결 없음)',
      '완료·대기 상태 기록(Chat 앱 미배포 → 현재는 사용자가 직접 알려야 함)',
      '양주 수도요금 등 고지서 기준 예정일, 수유 수도요금 격월 회차 판단',
      '금액 불일치 판단(동일 업체·회차의 두 금액·차액·출처가 모두 있어야 보고)'
    ]
  }
};
