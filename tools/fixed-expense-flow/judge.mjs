/**
 * 고정비 연결현황 판정 — 순수 함수(파일·네트워크 없음). 일정은 실행기의 fixedSchedule()을 그대로 받아 쓴다.
 * 두 번째 판정 엔진을 만들지 않기 위해 예정일·7일 창 계산은 실행기 facts()의 임박 계산과 같은 방식이다.
 *
 * 상태 3개: 정상 / 확인 필요 / 미검증. 원본 연결 성공 ≠ 정상. 제외 사유가 입증되지 않으면 정상으로 두지 않는다.
 * 다른 분야를 붙일 때도 { id, name, summary, items, inactive } 형식의 domain을 하나 더 만들면 된다.
 */
export const ACTIVE_EXPECTED = 22;
export const STATUS = { ok: '정상', check: '확인 필요', unverified: '미검증' };
export const REPORT = { included: '포함', excluded: '정상 제외', missing: '누락 의심', unknown: '미판정' };
const SCAN_DAYS = 92;

// 보고 문구의 다른 표기. 지역 없는 '코웨이'·'복합기'는 어느 업체인지 알 수 없어 일부러 넣지 않는다(포함으로 잘못 판정하지 않기 위해).
export const ALIASES = {
  Sendy: ['센디'],
  '복합기(성수)': ['성수 복합기'],
  '복합기(양주)': ['양주 복합기'],
  '코웨이(본사)': ['본사 코웨이'],
  '코웨이(양주)': ['양주 코웨이'],
  '쿠쿠(매장)': ['매장 쿠쿠', '쿠쿠']
};

export const addDay = (ymd, n) => new Date(Date.parse(ymd + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const md = ymd => ymd.slice(5).replace('-', '/');
const norm = s => String(s).replace(/[\s()·]/g, '').toLowerCase();

/** The vendors named in a report text. */
export const vendorsIn = (text, vendors) => {
  const t = norm(text);
  return vendors.filter(v => [v, ...(ALIASES[v] || [])].some(n => t.includes(norm(n))));
};

/** Only the report lines that count as the fixed-cost check: 오늘 완료 and [고정비] blocks. A vendor named in the
 *  summary or another field (e.g. 생각공장 주차권 under [정기 업무]) is not proof that its payment was reported. */
export function fixedPart(chat) {
  const keep = [];
  let field = null, done = false;
  for (const l of String(chat).split('\n')) {
    const t = l.trim();
    if (/^-{5,}$/.test(t)) { field = null; done = false; continue; }
    if (t === '오늘 완료') { done = true; continue; }
    if (/^\[[^\]]+\]$/.test(t)) { field = t; continue; }
    if (done || field === '[고정비]') keep.push(l);
  }
  return keep.join('\n');
}

/** Parses the operating doc's vendor table; the row number is the source sheet row. */
export function parseDocRows(doc) {
  return String(doc).split('\n').map(l => l.split('|').map(x => x.replace(/\*\*/g, '').trim()))
    .filter(c => c.length >= 7 && /^\d+$/.test(c[1]))
    .map(c => ({ row: Number(c[1]), vendor: c[2], period: c[3], basis: c[4], path: c[5], note: c[6] }));
}

/** Nearest due date on or after `from` (step = 1) or before it (step = -1), by the runner's own schedule. */
export function dueDate(fixedSchedule, vendor, from, step = 1) {
  for (let i = 0; i < SCAN_DAYS; i++) {
    const d = addDay(from, step * (step > 0 ? i : i + 1));
    if (fixedSchedule(d).find(s => s.vendor === vendor)?.day === Number(d.slice(8))) return d;
  }
  return null;
}

function sourceState(doc, sheet) {
  if (!sheet) return { state: STATUS.unverified, text: `규칙 문서 ${doc.row}행 확인 · 시트 실제 조회 안 함` };
  if (sheet.error) return { state: STATUS.check, text: `원본 시트 접근 실패: ${sheet.error}` };
  const name = sheet.rows[doc.row];
  if (name === undefined) return { state: STATUS.check, text: `시트 ${doc.row}행이 비어 있음` };
  if (name !== doc.vendor) return { state: STATUS.check, text: `시트 ${doc.row}행 이름 불일치(시트: ${name})` };
  return { state: STATUS.ok, text: `시트 ${doc.row}행 이름 일치 · 규칙 문서 ${doc.row}행` };
}

/** Whether the vendor's absence from the report is proven; the only place that decides 정상 제외 / 누락 의심. */
function reportState(v, { report, imminent, next }) {
  const agents = report.agents.filter(a => a.inChat.includes(v)).map(a => a.name);
  if (agents.length) return { report: REPORT.included, status: STATUS.ok, reason: `${agents.join('·')} 보고에 포함` };
  if (imminent) {
    const noted = report.agents.some(a => a.inInternal.includes(v));
    return { report: REPORT.missing, status: STATUS.check, reason: `예정일 ${md(imminent)}로 보고 대상인데 보고에 없음 — ` +
      (noted ? 'AI 내부 근거에만 언급, 제외 사유 입증 안 됨' : '제외 근거 없음') };
  }
  if (next) return { report: REPORT.excluded, status: STATUS.ok, reason: `다음 예정일 ${md(next)} — 아직 보고 시점 아님` };
  return { report: REPORT.missing, status: STATUS.check, reason: `납부 회차 미확정 — 근거가 있을 때만 보고되는 업체라 제외가 맞는지 입증되지 않음` };
}

/**
 * @param fixedSchedule 실행기 함수 (없으면 전 업체 미검증)
 * @param docRows parseDocRows() 결과(원본 23행)
 * @param report 점검에 쓴 최근 정기 보고 { date, slot, agents: [{ name, inChat, inInternal }] } | null
 * @param sheet { rows: { 행: 이름 } } | { error } | null
 * @param sourceOk 최근 실행기의 시트 읽기가 성공했으면 true, 실패로 끝났으면 false
 */
export function judgeFixed({ fixedSchedule, docRows, windowDays, report, sheet, sourceOk = true, holidays = [], checkedAt = null, today }) {
  const basis = report?.date || today;
  const active = fixedSchedule ? fixedSchedule(basis) : [];
  const windowEnd = addDay(basis, windowDays);
  const items = [], warnings = [];
  const inactive = fixedSchedule ? docRows.filter(d => !active.some(s => s.row === d.row)).map(d => d.vendor) : [];

  for (const doc of docRows) {
    if (inactive.includes(doc.vendor)) continue;
    const v = doc.vendor;
    const source = sourceState(doc, sheet);
    const base = { row: doc.row, vendor: v, source, period: doc.period, basisRule: doc.basis, path: doc.path, checkedAt };
    if (!fixedSchedule || !report) {
      items.push({ ...base, status: STATUS.unverified, report: REPORT.unknown,
        reason: !fixedSchedule ? '실행기 일정 계산을 불러오지 못해 점검하지 않음' : '점검에 쓸 정기 보고 기록이 없음' });
      continue;
    }
    const next = dueDate(fixedSchedule, v, basis);
    const previous = dueDate(fixedSchedule, v, basis, -1);
    const imminent = next && next <= windowEnd ? next : null;
    const r = reportState(v, { report, imminent, next });
    const notes = [];
    if (next && (holidays.includes(next) || [0, 6].includes(new Date(next + 'T00:00:00Z').getUTCDay()))) notes.push(`예정일 ${md(next)}은 주말·공휴일 — 이동 규칙 미확정이라 날짜를 옮기지 않음`);
    if (previous) notes.push(`직전 예정일 ${md(previous)} — 그 회차의 완료 여부는 이 화면이 판정하지 않음`);
    const item = { ...base, ...r, target: next ? md(next) : '회차 미확정', notes };
    // Connection problems outrank a clean report: 원본 연결 성공 없이는 정상이 아니다.
    if (sourceOk === false) { item.status = STATUS.check; item.reason = `최근 시트 읽기 실패 — ${r.reason}`; }
    else if (source.state === STATUS.check) { item.status = STATUS.check; item.reason = `${source.text} — ${r.reason}`; }
    else if (source.state === STATUS.unverified && item.status === STATUS.ok) { item.status = STATUS.unverified; item.reason = `원본 시트 미조회 — ${r.reason}`; }
    items.push(item);
  }

  if (fixedSchedule) {
    for (const s of active) if (!docRows.some(d => d.row === s.row)) warnings.push(`실행기 관리 대상 ${s.vendor}가 규칙 문서 표에 없음`);
    if (items.length !== ACTIVE_EXPECTED) warnings.push(`활성 업체 ${items.length}개 — 기준 ${ACTIVE_EXPECTED}개와 다름`);
  }
  const count = st => items.filter(i => i.status === st).length;
  const summary = { total: items.length, ok: count(STATUS.ok), check: count(STATUS.check), unverified: count(STATUS.unverified) };
  if (summary.ok + summary.check + summary.unverified !== summary.total) warnings.push('상태 합계가 관리대상 수와 다름');
  return { id: 'fixed', name: '고정비', summary, items, inactive, warnings, basis, windowEnd };
}
