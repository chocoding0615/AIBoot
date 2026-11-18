/**
 * 고정비 외 5개 분야 연결현황 판정 — 순수 함수(파일·네트워크 없음). 입력은 실행기가 읽는 범위와 같고, 결과는 judgeFixed와 같은
 * { id, name, summary, items, inactive, warnings } 형식이다.
 *
 * 원본 조회 성공 ≠ 보고 누락 검증 성공. 보고에 정확한 대상 키가 없으면 건수가 맞아도 정상이 아니라 미검증이다.
 * 금액·연락처·개인 이름·메시지 원문은 결과에 넣지 않는다.
 */
import { REPORT, STATUS, addDay } from './judge.mjs';
import { HISTORY_TAB, WINDOW, occurrenceState, occurrences, reportWindow } from '../../integrations/local-dual-report/recurring.mjs';

export const PARTIAL = '건수만 포함';
/** A real calendar date only: 2026-99-01 and 2026-02-31 are not dates. */
const isDate = s => { if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false; const t = Date.parse(s + 'T00:00:00Z'); return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s; };
const md = ymd => ymd.slice(5).replace('-', '/');
const days = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
const scrub = s => String(s ?? '').replace(/01[016789]-?\d{3,4}-?\d{4}/g, '<전화번호 생략>').replace(/\d{2,3}\s?[가-힣]\s?\d{4}/g, '<차량번호 생략>').replace(/\s+/g, ' ').trim();
const SPLIT_WORD = '[a-z0-9가-힣]';
// 차량번호·금액·호칭이 있는 계약 내용은 번호나 사람을 가리킬 수 있어 통째로 넘기지 않는다.
const PERSONAL = /생략>|\d{1,3}(?:,\d{3})+|\d+\s?만?\s?원|(?:대표|담당|과장|대리|부장|차장|팀장|사원|주임|이사|님)(?:$|[\s,)])/;
export const contractWhat = s => { const t = scrub(s); return PERSONAL.test(t) ? '내용 생략' : t; };

/** 보고 줄에서 대상 이름을 단어 경계로 찾는다. 조사는 허용하고, 이름 일부만 겹치는 경우(KT ↔ KT텔레캅)는 찾지 않는다. */
export function keyIn(line, name) {
  const core = String(name).replace(/\(주\)|㈜|주식회사/g, '').trim() || String(name).trim();
  if (!core) return false;
  const body = core.split(/\s+/).map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
  return new RegExp(`(?<!${SPLIT_WORD})${body}(?:은|는|이|가|을|를|의|와|과|도|로)?(?!${SPLIT_WORD})`, 'i').test(line);
}

const reportLines = (agent, tag) => String(agent.fields?.[tag] || '').split('\n').filter(l => l.trim());

/** 날짜는 한 줄에 MM/DD 또는 M월 D일로 정확히 있어야 한다. */
const dateIn = (line, ymd) => {
  const [m, day] = ymd.slice(5).split('-');
  return new RegExp(`(?<!\\d)${m}/${day}(?!\\d)|(?<!\\d)${Number(m)}월\\s*${Number(day)}일`).test(line);
};

/* ---------- 원본 행 → 필요한 열만 ---------- */

/** '계약서 검색'!A6:N200. C 업체, D 내용(없으면 B), H 종료일, M 자동연장, N 계약종료만 쓴다. 금액 열은 넘기지 않는다. */
export function parseContracts(values) {
  const rows = [];
  let ended = 0;
  (values || []).forEach((r, i) => {
    if (!r[2]) return;
    if (r[13] === 'TRUE') { ended++; return; }
    rows.push({ row: 6 + i, name: scrub(r[2]), what: contractWhat(r[3] || r[1] || ''), end: String(r[7] || '').trim(), autoRenew: r[12] === 'TRUE' });
  });
  return { rows, ended };
}

/** DB columns D/E/I/N/O only, starting at row 5. B exposure is deliberately not requested or filtered. */
export function parseContractDb(columns) {
  if (!Array.isArray(columns) || columns.length !== 5 || columns.some(c => !Array.isArray(c))) throw new Error('계약서 DB 응답 확인 필요');
  const count = Math.max(0, ...columns.map(c => c.length));
  const projection = Array.from({length: count}, (_, i) => {
    const r = [];
    r[2] = columns[0][i]?.[0] || '';
    r[3] = columns[1][i]?.[0] || '';
    r[7] = columns[2][i]?.[0] || '';
    r[12] = String(columns[3][i]?.[0] ?? '').toUpperCase();
    r[13] = String(columns[4][i]?.[0] ?? '').toUpperCase();
    return r;
  });
  const parsed = parseContracts(projection);
  parsed.rows.forEach(row => { row.row -= 1; });
  return parsed;
}

/** '프로그램(2026)'!A5:D60. A 이름, C 종료일만 쓴다. `사용 만료` 머리글 아래는 이미 만료된 행이다. */
export function parseLicenses(values) {
  const rows = [];
  let ended = 0, below = false;
  (values || []).forEach((r, i) => {
    if (/사용 만료/.test(r[0] || '')) { below = true; return; }
    if (!r[0]) return;
    if (below) { ended++; return; }
    rows.push({ row: 5 + i, name: scrub(r[0]), what: '', end: String(r[2] || '').trim() });
  });
  return { rows, ended };
}

/** 복지 A8:A·E8:E. 번호가 있는 행의 적용일을 날짜별 인원수로만 집계한다. 어떤 행인지는 남기지 않는다. */
export function parseWelfare(no, applied) {
  const counts = {};
  let undated = 0;
  (no || []).forEach((r, i) => {
    if (!/^\d+$/.test(String(r[0] || '').trim())) return;
    const e = String((applied?.[i] || [])[0] || '').trim();
    if (isDate(e)) counts[e] = (counts[e] || 0) + 1; else undated++;
  });
  return { counts, undated };
}

/** '계약서(DB)' C·E·I·Q. 차량보험 행만, 차종·종료일·재가입 완료 여부만 쓴다. 번호판·이름이 있는 E 원문과 Q 원문은 넘기지 않는다. */
export function parseVehicles(cc, ee, ii, qq) {
  const first = v => String((v || [])[0] || '').trim();
  const rows = [];
  (ee || []).forEach((e, i) => {
    const text = first(e);
    if (first(cc?.[i]) !== '보험료' || !/차량보험/.test(text)) return;
    rows.push({ row: 5 + i, car: (/BMW|벤츠|카니발|모닝/.exec(text) || ['차량'])[0], end: first(ii?.[i]), renewed: /재가입\s*완료/.test(first(qq?.[i])) });
  });
  return rows;
}

/* ---------- 공통 ---------- */

/** 대상별 보고 비교 결과 { 에이전트: named|partial|wrong|missing } → 상태. 정상은 읽은 보고 전부가 정확한 키로 다뤘을 때만이다. */
function verdict(results, due, partialWhy) {
  const names = st => Object.keys(results).filter(a => results[a] === st);
  const named = names('named'), partial = names('partial'), wrong = names('wrong'), missing = names('missing');
  if (wrong.length) return { report: REPORT.missing, status: STATUS.check, reason: `${due} — ${wrong.join('·')} 보고에 다른 구간·값으로 표시됨` };
  if (missing.length) {
    const others = [...named, ...partial];
    return { report: others.length ? REPORT.included : REPORT.missing, status: STATUS.check, reason: others.length ? `${due} — ${others.join('·')} 보고에만 있고 ${missing.join('·')} 보고에 없음` : `${due}인데 보고에 없음 — 제외 근거 없음` };
  }
  if (partial.length) return { report: PARTIAL, status: STATUS.unverified, reason: `${due} — ${partialWhy}${named.length ? ` (${named.join('·')} 보고는 이름 포함)` : ''}` };
  return { report: REPORT.included, status: STATUS.ok, reason: `${due} — ${named.join('·')} 보고에 포함` };
}

/** 근거 공통 규칙: 보고가 없으면 미검증, 최근 읽기 실패나 읽지 못한 보고가 있으면 정상으로 두지 않는다. */
function finish(meta, items, { report, sourceOk, warnings = [], inactive = [], inactiveNote = '' }) {
  const unread = (report?.agents || []).filter(a => a.unread).map(a => a.name);
  for (const i of items) {
    if (i.status !== STATUS.ok) continue;
    if (sourceOk === false) { i.status = STATUS.check; i.reason = `최근 시트 읽기 실패 — ${i.reason}`; }
    else if (unread.length) { i.status = STATUS.unverified; i.reason = `${unread.join('·')} 보고 파일을 읽지 못함 — ${i.reason}`; }
  }
  const count = st => items.filter(i => i.status === st).length;
  const summary = { total: items.length, ok: count(STATUS.ok), check: count(STATUS.check), unverified: count(STATUS.unverified) };
  if (summary.ok + summary.check + summary.unverified !== summary.total) warnings.push(`${meta.name}: 상태 합계가 대상 수와 다름`);
  return { ...meta, summary, items, inactive, inactiveNote, warnings };
}

/** 원본을 못 읽으면 대상 수를 알 수 없으므로 수치를 만들지 않고 한 줄로만 표시한다. */
function unreadable(meta, data, checkedAt) {
  const failed = !!data?.error;
  const text = failed ? `원본 조회 실패: ${data.error}` : '원본을 조회하지 않음';
  return finish(meta, [{ row: 0, vendor: '원본 조회', source: { state: failed ? STATUS.check : STATUS.unverified, text }, status: failed ? STATUS.check : STATUS.unverified,
    report: REPORT.unknown, reason: `${text} — 대상 수를 산출할 수 없음`, target: '-', details: [], checkedAt }], {});
}

const base = (row, vendor, sourceText, target, details, checkedAt) => ({ row, vendor, source: { state: STATUS.ok, text: sourceText }, target, details, checkedAt });
const noReport = item => ({ ...item, status: STATUS.unverified, report: REPORT.unknown, reason: '점검에 쓸 정기 보고 기록이 없음' });

/* ---------- 계약서·라이센스: 종료일 기준 D-구간 ---------- */

function bucketLine(line) {
  const m = /D-(\d+)\s*(\d+)\s*건/.exec(line);
  return m ? { bucket: `D-${m[1]}`, count: Number(m[2]) } : /D-(\d+)/.test(line) ? { bucket: `D-${/D-(\d+)/.exec(line)[1]}`, count: null } : null;
}

function compareExpiry(row, tag, report, siblings, bucketTotal) {
  const results = {};
  for (const a of report.agents.filter(x => !x.unread)) {
    const lines = reportLines(a, tag);
    const hits = lines.filter(l => keyIn(l, row.name));
    // 한 줄에 구간이 여럿이면 이름이 어느 구간인지 알 수 없다.
    const mixed = hits.some(l => (l.match(/D-\d+/g) || []).length > 1);
    const rightBucket = hits.filter(l => bucketLine(l)?.bucket === row.bucket);
    const stated = lines.map(bucketLine).find(b => b?.bucket === row.bucket && b.count !== null);
    if (mixed) results[a.name] = 'partial';
    else if (rightBucket.length) {
      // 같은 이름이 같은 구간에 여럿이면 내용까지 있어야 어느 행인지 안다.
      results[a.name] = siblings > 1 && !(row.what && rightBucket.some(l => keyIn(l, row.what))) ? 'partial' : 'named';
    } else if (hits.length) results[a.name] = 'wrong';
    else results[a.name] = stated?.count === bucketTotal ? 'partial' : 'missing';
  }
  return results;
}

function judgeExpiry(meta, tag, data, { report, sourceOk, buckets, checkedAt, today }) {
  if (!data || data.error) return unreadable(meta, data, checkedAt);
  const date = report?.date || today, within = buckets.at(-1)[2];
  const dated = data.rows.map(r => {
    if (!isDate(r.end)) return { ...r, d: null };
    const d = days(date, r.end);
    return { ...r, d, bucket: (buckets.find(([, lo, hi]) => d >= lo && d <= hi) || [null])[0] };
  });
  const items = dated.map(r => {
    // 내용은 실행기가 보고에 넘기는 D-구간 행에서만 보여 준다. 나머지는 이름과 행 번호로 충분하다.
    const label = r.bucket && r.what ? `${r.name} · ${r.what}` : r.name;
    const item = base(r.row, label, `원본 ${r.row}행`, r.d === null ? '종료일 미상' : `${md(r.end)} (${r.d < 0 ? 'D+' + -r.d : 'D-' + r.d})`,
      [['대상', label], ['종료일', r.d === null ? (r.end ? '날짜 아님' : '없음') : r.end], ...(r.autoRenew ? [['자동연장', '표시됨']] : [])], checkedAt);
    if (r.d === null) return { ...item, status: STATUS.unverified, report: REPORT.unknown, reason: '종료일이 날짜 형식이 아니라 기한을 판정할 수 없음' };
    if (r.d < 0) return { ...item, status: STATUS.check, report: REPORT.missing, reason: `종료일 ${r.d * -1}일 경과, 계약종료 미표시 — 실행기 D-구간 밖이라 보고되지 않음` };
    if (r.d > within) return { ...item, status: STATUS.ok, report: REPORT.excluded, reason: `D-${r.d} — 보고 구간(D-${within}) 밖` };
    if (!report) return noReport(item);
    const siblings = dated.filter(x => x.name === r.name && x.bucket === r.bucket).length;
    const total = dated.filter(x => x.bucket === r.bucket).length;
    return { ...item, ...verdict(compareExpiry(r, tag, report, siblings, total), `${r.bucket} 보고 대상`, `보고에 ${r.bucket} ${total}건으로 건수가 맞지만 이 대상을 특정하지 못함`) };
  });
  return finish(meta, items, { report, sourceOk, inactiveNote: data.ended ? `${meta.endedLabel} ${data.ended}건은 대상에서 제외` : '' });
}

export const judgeContracts = (data, o) => judgeExpiry({ id: 'contract', name: '계약서', endedLabel: '계약종료 처리' }, '[계약서]', data, o);
export const judgeLicenses = (data, o) => judgeExpiry({ id: 'license', name: '라이센스', endedLabel: '사용 만료 구역' }, '[라이센스]', data, o);

/* ---------- 복지: 적용일별 인원수, D-7 이내만 보고 대상 ---------- */

export function judgeWelfare(data, { report, sourceOk, imminentDays, checkedAt, today }) {
  const meta = { id: 'welfare', name: '복지' };
  if (!data || data.error) return unreadable(meta, data, checkedAt);
  const date = report?.date || today;
  const upcoming = Object.keys(data.counts).filter(d => d >= date).sort();
  const past = Object.keys(data.counts).filter(d => d < date).reduce((n, d) => n + data.counts[d], 0);
  const items = upcoming.map((d, i) => {
    const left = days(date, d), n = data.counts[d];
    const shown = d.slice(0, 4) === date.slice(0, 4) ? md(d) : d;
    const item = base(i + 1, `${shown} 적용 ${n}명`, '복지 적용일 열', `D-${left}`, [['적용일', d], ['인원', `${n}명`]], checkedAt);
    if (left > imminentDays) return { ...item, status: STATUS.ok, report: REPORT.excluded, reason: `D-${left} — 임박 기준(D-${imminentDays}) 전` };
    if (!report) return noReport(item);
    const results = {};
    for (const a of report.agents.filter(x => !x.unread)) {
      const hits = reportLines(a, '[복지]').filter(l => dateIn(l, d));
      // 인원수는 그 날짜 바로 뒤, 다음 항목 구분자 전까지만 본다(11/11 2명, 11/12 1명을 섞지 않는다).
      const paired = new RegExp(`${md(d)}[^,;·]*?(?<!\\d)${n}\\s*명|${Number(d.slice(5, 7))}월\\s*${Number(d.slice(8))}일[^,;·]*?(?<!\\d)${n}\\s*명`);
      results[a.name] = !hits.length ? 'missing' : hits.some(l => paired.test(l)) ? 'named' : 'wrong';
    }
    return { ...item, ...verdict(results, `D-${left} 임박 적용일`, '') };
  });
  if (data.undated) items.push({ ...base(items.length + 1, `적용일 없는 행 ${data.undated}명`, '복지 적용일 열', '적용일 없음', [['인원', `${data.undated}명`]], checkedAt),
    status: STATUS.check, report: REPORT.missing, reason: '번호는 있는데 적용일이 날짜가 아니라 실행기가 보고하지 못함' });
  return finish(meta, items, { report, sourceOk, inactiveNote: past ? `지난 적용일 ${past}명은 대상에서 제외` : '' });
}

/* ---------- 정기 업무: [MS] 김현호 규칙표 + 회차별 처리이력, 차량보험 Q열 ---------- */

// 원본을 옮긴 날. 이전 회차는 처리이력이 있을 수 없어 D+30을 넘어도 미처리로 세지 않는다.
export const RECURRING_SINCE = '2026-11-06';

function judgeOccurrence(t, o, source, ctx) {
  const { report, checkedAt, date } = ctx;
  const shownUse = t.use.label;
  const item = base(t.row * 1000 + ctx.index, `${t.title} · ${o.key}`, `업무 ${t.row}행`, o.due, [['규칙', `${t.cycle} ${t.basis}`], ['회차', o.key], ['기준일', o.due], ['사용 여부', shownUse]], checkedAt);
  const d = o.d;
  if (source.historyState === '조회 실패') return { ...item, status: STATUS.unverified, report: REPORT.unknown, reason: `${HISTORY_TAB}을 읽지 못해 회차 상태를 판정할 수 없음` };
  const state = occurrenceState(t, o, source.history);
  item.details.push(['처리이력', state.why]);
  if (state.state === '완료' || state.state === '보류') return { ...item, status: STATUS.ok, report: REPORT.excluded, reason: state.why };
  if (state.state === '확인 필요') return { ...item, status: STATUS.check, report: REPORT.unknown, reason: state.why };
  if (t.use.warn) return { ...item, status: STATUS.check, report: REPORT.unknown, reason: t.use.warn };
  if (!t.id) return { ...item, status: STATUS.check, report: REPORT.unknown, reason: '업무ID 미지정 — 처리이력과 연결할 수 없음(--init 필요)' };
  if (d > WINDOW.after) return { ...item, status: STATUS.ok, report: REPORT.excluded, reason: `D-${d} — 계산 범위(D-${WINDOW.after}) 전` };
  // 일일 보고 표시 범위는 실행기와 같은 reportWindow. 보고에서 빠져도 기한 지난 회차는 미확인으로 남긴다.
  const w = reportWindow(t, o);
  if (!w.show && d < 0) return { ...item, status: STATUS.check, report: REPORT.excluded, reason: `${w.why} — 처리 기록 없음, 완료·보류 기록 필요` };
  if (!w.show && w.noLead) return { ...item, status: STATUS.check, report: REPORT.unknown, reason: `${w.why} — 일일 보고에는 입력 필요 한 줄만 실림` };
  if (!w.show) return { ...item, status: STATUS.ok, report: REPORT.excluded, reason: w.why };
  if (!report) return noReport(item);
  const results = {};
  for (const a of report.agents.filter(x => !x.unread)) {
    const hits = reportLines(a, '[정기 업무]').filter(l => keyIn(l, t.title));
    results[a.name] = !hits.length ? 'missing' : hits.some(l => dateIn(l, o.due)) ? (t.sameTitle ? 'partial' : 'named') : 'partial';
  }
  return { ...item, ...verdict(results, `${d < 0 ? 'D+' + -d : 'D-' + d} 보고 대상`, t.sameTitle ? '같은 이름 업무가 있어 행을 특정하지 못함' : `보고에 이름은 있지만 날짜 ${md(o.due)}로 특정되지 않음`) };
}

export function judgeRecurring(source, vehicles, { report, sourceOk, checkedAt, today }) {
  const meta = { id: 'recurring', name: '정기 업무' };
  if (!source || source.error) return unreadable(meta, source, checkedAt);
  const date = report?.date || today, items = [];
  // 보고 범위 밖도 원본을 옮긴 뒤의 회차와 다음 1회차까지 보여 준다. 그 이상은 미리 만들지 않는다.
  const before = Math.max(WINDOW.before, days(RECURRING_SINCE, date));
  const stopped = source.tasks.filter(t => !t.use.active).length;
  for (const t of source.tasks.filter(x => x.use.active)) {
    const ownBase = (reason, target = '-') => ({ ...base(t.row * 1000, t.title, `업무 ${t.row}행`, target, [['규칙', `${t.cycle} ${t.basis}`.trim() || '없음'], ['사용 여부', t.use.label]], checkedAt), status: STATUS.check, report: REPORT.missing, reason });
    if (t.rule.error) { items.push(ownBase(`규칙 확인 필요: ${t.rule.error}`)); continue; }
    const list = occurrences(t.rule, source.calendar, date, { before, after: 400 });
    const near = list.filter(o => o.unknown || o.d <= WINDOW.after);
    const shown = near.some(o => o.due && o.d >= 0) ? near : [...near, ...list.filter(o => o.due && o.d > WINDOW.after).slice(0, 1)];
    shown.forEach((o, index) => {
      if (o.unknown) items.push({ ...ownBase(`날짜 계산 불가: ${o.unknown}`, '날짜 불명'), row: t.row * 1000 + index });
      else items.push(judgeOccurrence(t, o, source, { report, checkedAt, date, index }));
    });
  }
  const notes = [stopped ? `사용 여부 중지 ${stopped}건은 대상에서 제외` : '', source.historyState === '미생성' ? `${HISTORY_TAB} 탭 미생성 — 모든 회차가 미처리` : '', source.registered === false ? 'Master_Sheet에서 이 원본을 찾지 못함' : source.registered === null ? 'Master_Sheet 등록 확인 필요 — 점검 불가' : ''];
  if (!vehicles || vehicles.error) items.push({ ...base(100000, '차량 보험', vehicles?.error ? `원본 조회 실패: ${vehicles.error}` : '원본을 조회하지 않음', '-', [], checkedAt),
    status: vehicles?.error ? STATUS.check : STATUS.unverified, report: REPORT.unknown, reason: '계약서(DB)를 읽지 못해 차량 보험을 판정할 수 없음' });
  else for (const v of vehicles) {
    const shownEnd = isDate(v.end) ? v.end : v.end ? '날짜 아님' : '없음';
    const item = base(100000 + v.row, `차량 보험 ${v.car} (${v.row}행)`, `계약서(DB) ${v.row}행`, shownEnd, [['종료일', shownEnd], ['Q열 재가입 완료', v.renewed ? '있음' : '없음']], checkedAt);
    if (v.renewed) { items.push({ ...item, status: STATUS.ok, report: REPORT.excluded, reason: 'Q열 재가입 완료 표시' }); continue; }
    if (!isDate(v.end)) { items.push({ ...item, status: STATUS.check, report: REPORT.missing, reason: '종료일이 날짜가 아니라 판정할 수 없음' }); continue; }
    const d = days(date, v.end);
    if (d >= 0) { items.push({ ...item, status: STATUS.ok, report: REPORT.excluded, reason: `종료 전(D-${d}) — 재가입 확인 시점 아님` }); continue; }
    if (d < -365) { items.push({ ...item, status: STATUS.check, report: REPORT.missing, reason: '종료 후 1년 초과, Q열 표시 없음 — 실행기 보고 범위 밖' }); continue; }
    if (!report) { items.push(noReport(item)); continue; }
    const results = {};
    for (const a of report.agents.filter(x => !x.unread)) {
      const hits = reportLines(a, '[정기 업무]').filter(l => /차량\s*보험/.test(l) && (v.car === '차량' || keyIn(l, v.car)));
      const sameCar = vehicles.filter(x => x.car === v.car && !x.renewed).length > 1;
      results[a.name] = !hits.length ? 'missing' : v.car === '차량' || sameCar ? 'partial' : 'named';
    }
    items.push({ ...item, ...verdict(results, 'Q열 표시 없이 종료', '차종으로 행을 특정하지 못함') });
  }
  return finish(meta, items, { report, sourceOk, inactiveNote: notes.filter(Boolean).join(' · ') });
}

/* ---------- 기타 업무: 저장된 실행 기록뿐이라 메시지 단위 정상은 만들지 않는다 ---------- */

/**
 * @param chat { spaces: 지정 스페이스 수, cursor: 기준 보고의 chatUntil 표시 문자열|null, failed: 실패한 스페이스 번호[] }
 */
export function judgeChat(chat, { report, checkedAt }) {
  const meta = { id: 'chat', name: '기타 업무' };
  const lines = (report?.agents || []).filter(a => !a.unread).map(a => `${a.name} ${reportLines(a, '[기타 업무]').length}줄`).join(' · ') || '없음';
  const items = Array.from({ length: chat?.spaces || 0 }, (_, i) => {
    const failed = chat.failed.includes(i);
    const source = { state: failed ? STATUS.check : STATUS.ok, text: failed ? '기준 보고일 로그에 조회 실패 기록' : '기준 보고일 로그에 조회 실패 기록 없음' };
    const item = { row: i + 1, vendor: `지정 스페이스 ${i + 1}`, source, target: chat.cursor || '커서 없음', details: [['읽기 커서', chat.cursor || '없음'], ['보고의 [기타 업무]', lines]], checkedAt };
    if (!report) return noReport(item);
    if (failed) return { ...item, status: STATUS.check, report: REPORT.unknown, reason: '조회 실패 기록이 있어 일부 메시지가 빠졌을 수 있음' };
    if (!chat.cursor) return { ...item, status: STATUS.check, report: REPORT.unknown, reason: '기준 보고에 읽기 커서가 없어 조회 구간을 확인할 수 없음' };
    return { ...item, status: STATUS.unverified, report: REPORT.unknown, reason: '메시지 ID·원문이 저장되지 않아 메시지별 보고 누락은 비교할 수 없음' };
  });
  if (!items.length) items.push({ row: 1, vendor: '지정 스페이스', source: { state: STATUS.unverified, text: '설정에서 스페이스를 찾지 못함' }, target: '-', details: [], checkedAt, status: STATUS.unverified, report: REPORT.unknown, reason: '지정 스페이스 설정을 읽지 못함' });
  return finish(meta, items, { report });
}

/** 실행기가 미연결로 표시하는 소스. 점검 대상이 아니므로 숫자에 넣지 않는다. */
export const unconnectedIn = runnerSrc => [...new Set([...String(runnerSrc).matchAll(/sources\['([^']+)'\] = '미연결'/g)].map(m => m[1]))];
export { addDay };
