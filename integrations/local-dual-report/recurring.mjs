/**
 * 정기 업무 — `[MS] 김현호` › `업무` 규칙표(A 업무명, B 주기, C 기준, D 사용 여부)와 숨김 탭 `반복업무_처리이력`.
 *
 * 실행기·연결현황·처리 도구가 이 파일 하나의 계산을 함께 쓴다. 쓰기는 없다(쓰기는 recurring-status.mjs만).
 * 날짜를 확정할 수 없으면 추측하지 않고 unknown으로 돌려준다. 양력 설·추석 날짜를 코드에 넣지 않는다.
 *
 * 회차키는 날짜가 아니라 기간으로 만든다: 매월 `2026-11`, 연 1회 `2026`, 연 N회 `2026-2`, 명절 `2026-추석`.
 * 임시 휴무로 날짜가 밀려도 같은 회차로 남는다. 연 단위 회차는 기록 당시 기준일과 달라지면 확인 필요로 돌린다.
 */
import fs from 'node:fs';

export const FILE_TITLE = '[MS] 김현호';
export const TASK_TAB = '업무';
export const HISTORY_TAB = '반복업무_처리이력';
export const HISTORY_HEADER = ['업무ID', '회차키', '상태', '처리시각', '비고', '회차기준일'];
export const ID_KEY = 'aiboot.recurring.taskId';
export const WINDOW = { before: 30, after: 60 };
export const STATES = ['완료', '보류', '미처리'];
export const HOLIDAY_ICS = 'https://calendar.google.com/calendar/ical/ko.south_korea.official%23holiday%40group.v.calendar.google.com/public/basic.ics';
const TASK_RANGE = `'${TASK_TAB}'!A2:D200`;
const HISTORY_RANGE = `'${HISTORY_TAB}'!A:F`; // 행 제한 없음: 범위를 넘긴 기록이 미처리로 되돌아가면 안 된다

const addDays = (ymd, n) => new Date(Date.parse(ymd + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const dayDiff = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
const realDate = s => { const t = Date.parse(s + 'T00:00:00Z'); return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s; };
const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();

/* ---------- 공휴일: 평일 판단과 설·추석 당일 ---------- */

/** 공휴일 피드 → 날짜 목록과 설날·추석 당일. '설날 연휴'·'쉬는 날 설날'은 당일이 아니다. */
export function parseHolidayFeed(text) {
  const names = { 설날: [], 추석: [] }, days = [];
  for (const ev of String(text).split('BEGIN:VEVENT').slice(1)) {
    if (!/DESCRIPTION:공휴일/.test(ev)) continue;
    const d = /DTSTART;VALUE=DATE:(\d{4})(\d{2})(\d{2})/.exec(ev);
    if (!d) continue;
    const ymd = `${d[1]}-${d[2]}-${d[3]}`, summary = (/SUMMARY:(.*)/.exec(ev) || [])[1]?.trim();
    days.push(ymd);
    if (summary in names && !names[summary].includes(ymd)) names[summary].push(ymd);
  }
  return { days, names };
}

/**
 * 오늘 받은 캐시가 없으면 피드를 받는다. 실패하면 이전 캐시를 쓰고, 그것도 없으면 null.
 * save=false면 파일을 쓰지 않는다(연결현황은 읽기만 한다).
 */
export async function loadHolidays({ file, today, save = true, log = () => {}, fetcher = fetch }) {
  let cached = null;
  try { cached = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (cached?.fetched === today && cached.names) return cached;
  try {
    const res = await fetcher(HOLIDAY_ICS);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const { days, names } = parseHolidayFeed(await res.text());
    if (!days.length) throw new Error('0 holidays');
    const fresh = { fetched: today, days, names };
    if (save) fs.writeFileSync(file, JSON.stringify(fresh));
    return fresh;
  } catch (e) {
    log('holiday feed refresh failed: ' + e.message + (cached ? ' (using cache)' : ' (no cache)'));
    return cached;
  }
}

/**
 * 회사 영업일 달력. 개인 종일휴가(vacations)는 회사 휴무가 아니므로 넣지 않는다.
 * 피드에 없는 해는 판단할 수 없어 isBusiness가 null을 돌려준다.
 */
export function makeCalendar(holidays, { holidaysExtra = [], workdaysExtra = [] } = {}) {
  const days = new Set(holidays?.days || []);
  const years = new Set([...days].map(d => d.slice(0, 4)));
  return {
    isBusiness(ymd) {
      if (workdaysExtra.includes(ymd)) return true;
      const dow = new Date(ymd + 'T00:00:00Z').getUTCDay();
      if (dow === 0 || dow === 6 || holidaysExtra.includes(ymd)) return false;
      if (!years.has(ymd.slice(0, 4))) return null;
      return !days.has(ymd);
    },
    /** 한 해에 당일이 정확히 하나일 때만 날짜를 돌려준다. */
    lunar(year, name) {
      const hit = (holidays?.names?.[name] || []).filter(d => d.startsWith(String(year)));
      return hit.length === 1 ? hit[0] : null;
    }
  };
}

function firstBusinessDay(year, month, cal) {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  for (let i = 0; i < 31; i++) {
    const d = addDays(start, i);
    if (d.slice(5, 7) !== start.slice(5, 7)) return null;
    const b = cal.isBusiness(d);
    if (b === null) return null;
    if (b) return d;
  }
  return null;
}

/** ymd 이전으로 n번째 영업일. ymd 자신은 세지 않는다. */
function businessDaysBefore(ymd, n, cal) {
  let d = ymd, left = n;
  for (let guard = 0; left > 0 && guard < 120; guard++) {
    d = addDays(d, -1);
    const b = cal.isBusiness(d);
    if (b === null) return null;
    if (b) left--;
  }
  return left ? null : d;
}

/* ---------- 규칙표 ---------- */

/** B 주기 + C 기준 → 규칙. 정해진 표현이 아니면 해석하지 않고 error를 돌려준다. */
export function parseRule(cycle, basis) {
  const c = String(cycle ?? '').replace(/\s/g, ''), b = String(basis ?? '').replace(/\s/g, '');
  if (!c && /^\d{4}-\d{2}-\d{2}$/.test(b)) return { error: '주기 미입력 — 한 번만 할 업무는 B열에 1회' };
  if (!c || !b) return { error: '주기 또는 기준 미설정' };
  if (c === '1회' || c === '단발') {
    // 한 번만: 연도까지 있는 날짜만 받는다. 연도 없는 날짜는 해마다 반복으로 오해할 수 있어 받지 않는다.
    if (/^\d{4}-\d{2}-\d{2}$/.test(b) && realDate(b)) return { kind: 'once', date: b };
    return { error: `1회 업무는 연도까지 있는 날짜(YYYY-MM-DD)가 필요: ${clean(basis)}` };
  }
  if (c === '매월') return b === '첫영업일' ? { kind: 'first-business' } : { error: `매월 기준 해석 불가: ${clean(basis)}` };
  const year = /^매년(?:(\d+)회)?$/.exec(c);
  if (!year) return { error: `주기 해석 불가: ${clean(cycle)}` };
  const count = Number(year[1] || 1);
  const lunar = /^(설날?)?[·・,/]?(추석)?-(\d+)영업일$/.exec(b);
  if (lunar && (lunar[1] || lunar[2])) {
    const names = [lunar[1] && '설날', lunar[2] && '추석'].filter(Boolean);
    return names.length === count ? { kind: 'lunar', names, offset: Number(lunar[3]) } : { error: `주기 ${count}회와 기준 ${names.length}개가 다름` };
  }
  // 날짜 셀은 연도가 붙어 올 수 있다(2025-05-08). 매년 규칙은 월·일만 쓴다.
  const dates = b.split(/[,，]/).map(d => /^\d{4}-\d{2}-\d{2}$/.test(d) ? d.slice(5) : d);
  if (!dates.every(d => /^\d{2}-\d{2}$/.test(d) && realDate('2024-' + d))) return { error: `기준 해석 불가: ${clean(basis)}` };
  if (dates.length !== count) return { error: `주기 ${count}회와 기준 ${dates.length}개가 다름` };
  if (new Set(dates).size !== count) return { error: `같은 날짜가 반복됨: ${clean(basis)}` };
  return { kind: 'dates', dates: [...dates].sort() };
}

/**
 * D열 드롭다운의 실제 값은 `완료`·`진행중`이고 공란인 행도 있다.
 * 행 전체에 대한 값이라 `완료`를 회차 완료로 읽으면 다음 회차까지 사라지므로, 숨기지 않고 확인 필요로 둔다.
 * 빈칸은 사용으로 단정하지 않되 보고에서 빠지지 않게 포함한다. `중지`만 대상에서 뺀다.
 */
export function parseUse(value) {
  const v = clean(value);
  if (v === '중지') return { active: false, label: '중지' };
  if (v === '사용' || v === '진행중') return { active: true, label: v };
  if (!v) return { active: true, label: '미설정' };
  return { active: true, label: v, warn: `사용 여부가 '${v}' — 행 전체 값이라 회차 완료로 보지 않음` };
}

/** A:D 행과 행별 개발자 메타데이터(업무ID) → 업무 목록. 같은 ID·같은 이름은 표시해서 넘긴다. */
export function parseTasks(rows, rowIds = []) {
  const tasks = [];
  rows.forEach((r, i) => {
    const [a, b, c, d] = r.map(clean);
    if (!a && !b && !c && !d) return;
    const rule = a ? parseRule(b, c) : { error: '업무명 없음' };
    tasks.push({ row: 2 + i, title: a || `(${2 + i}행 업무명 없음)`, cycle: b || '', basis: c || '', use: parseUse(d), rule, id: rowIds[i] || null });
  });
  const seen = (list, value) => list.filter(x => x === value).length > 1;
  const ids = tasks.map(t => t.id).filter(Boolean), titles = tasks.map(t => t.title);
  for (const t of tasks) {
    t.idConflict = !!t.id && seen(ids, t.id);
    t.sameTitle = seen(titles, t.title);
  }
  return tasks;
}

/**
 * today 기준 앞뒤 창 안의 회차. 미래 회차를 저장하지 않고 필요할 때 계산만 한다.
 * @return {{key?:string,due?:string,d?:number,unknown?:string}[]}
 */
export function occurrences(rule, cal, today, { before = WINDOW.before, after = WINDOW.after } = {}) {
  if (rule.error) return [{ unknown: rule.error }];
  const from = addDays(today, -before), to = addDays(today, after);
  const y0 = Number(from.slice(0, 4)), y1 = Number(to.slice(0, 4));
  const out = [];
  const push = (key, due) => { if (due >= from && due <= to) out.push({ key, due, d: dayDiff(today, due) }); };
  if (rule.kind === 'first-business') {
    for (let m = y0 * 12 + Number(from.slice(5, 7)) - 1; m <= y1 * 12 + Number(to.slice(5, 7)) - 1; m++) {
      const year = Math.floor(m / 12), month = m % 12 + 1, key = `${year}-${String(month).padStart(2, '0')}`;
      const due = firstBusinessDay(year, month, cal);
      if (due) push(key, due); else out.push({ key, unknown: `${key} 첫 영업일 계산 불가(공휴일 목록 없음)` });
    }
  } else if (rule.kind === 'once') {
    // 회차키가 날짜가 아니라 '1회'라서 날짜를 고치면 기록 당시 기준일과 달라져 확인 필요로 돌아간다.
    push('1회', rule.date);
  } else if (rule.kind === 'dates') {
    for (let y = y0; y <= y1; y++) rule.dates.forEach((md, i) => {
      const key = rule.dates.length === 1 ? String(y) : `${y}-${i + 1}`, due = `${y}-${md}`;
      if (realDate(due)) push(key, due); else if (y === Number(today.slice(0, 4))) out.push({ key, unknown: `${y}년에 없는 날짜 ${md}` });
    });
  } else {
    // 1월 설의 N영업일 전은 전년 12월일 수 있어 다음 해까지 본다. 지난해와 창 밖 해의 공휴일 없음은 알릴 필요가 없다.
    for (let y = y0; y <= y1 + 1; y++) for (const name of rule.names) {
      const key = `${y}-${name}`, day = cal.lunar(y, name);
      const due = day && businessDaysBefore(day, rule.offset, cal);
      if (due) push(key, due); else if (y >= Number(today.slice(0, 4)) && y <= y1) out.push({ key, unknown: `${y}년 ${name} 날짜 확인 불가(공휴일 목록 없음)` });
    }
  }
  return out.sort((a, b) => (a.due || '9').localeCompare(b.due || '9'));
}

/* ---------- 처리이력 ---------- */

/** 비고 원문은 메모리에도 남기지 않고 있음·없음만 둔다. 보고와 연결현황에 들어갈 일이 없게 하기 위해서다. */
export function parseHistory(values) {
  const rows = new Map();
  (values || []).slice(1).forEach((r, i) => {
    const id = clean(r[0]), key = clean(r[1]);
    if (!id && !key) return;
    const k = `${id}|${key}`;
    const entry = { row: 2 + i, status: clean(r[2]), hasNote: !!clean(r[4]), basis: clean(r[5]), duplicate: rows.has(k) };
    if (entry.duplicate) entry.row = rows.get(k).row;
    rows.set(k, entry);
  });
  return rows;
}

/** 회차 상태. 증빙(비고) 없는 완료, 중복 행, 기준일이 달라진 연 단위 회차는 완료로 인정하지 않는다. */
export function occurrenceState(task, occ, history) {
  if (task.idConflict) return { state: '확인 필요', why: '같은 업무ID가 두 행에 있음' };
  if (!task.id) return { state: '미처리', why: '업무ID 미지정' };
  const h = history?.get(`${task.id}|${occ.key}`);
  if (!h) return { state: '미처리', why: '처리이력 없음' };
  if (h.duplicate) return { state: '확인 필요', why: '같은 회차 행이 여럿' };
  if (!STATES.includes(h.status)) return { state: '확인 필요', why: '상태 값 해석 불가' };
  if (h.status === '미처리') return { state: '미처리', why: '처리이력 미처리' };
  if (!h.hasNote) return { state: '확인 필요', why: `${h.status} 표시에 근거(비고) 없음` };
  if (task.rule.kind !== 'first-business' && h.basis !== occ.due) return { state: '확인 필요', why: h.basis ? '기록 당시 기준일과 달라짐' : '회차기준일 없음' };
  return { state: h.status, why: `처리이력 ${h.status}` };
}

/** 보고에 넘길 정기 업무 줄. 완료·보류·중지만 빠진다. */
export function recurringLines(source, cal, today) {
  const lines = [];
  for (const t of source.tasks) {
    if (!t.use.active) continue;
    const warn = t.use.warn ? ` / ${t.use.warn}` : '';
    for (const o of occurrences(t.rule, cal, today)) {
      if (o.unknown) { lines.push(`${t.title}: 날짜 계산 불가(${o.unknown}) — 규칙 확인 필요${warn}`); continue; }
      const s = occurrenceState(t, o, source.history);
      if (s.state === '완료' || s.state === '보류') continue;
      const tail = s.state === '확인 필요' ? `처리이력 확인 필요(${s.why})` : '완료 여부 확인 필요';
      lines.push(`${t.title}: ${o.due} (${o.d < 0 ? 'D+' + -o.d : 'D-' + o.d}) — ${tail}${warn}`);
    }
  }
  return lines;
}

const norm = s => String(s).replace(/[s()·]/g, '').toLowerCase(); // runner.mjs norm과 같다
/**
 * 계산된 정기 업무 회차가 보고 줄에 업무명과 날짜로 모두 있는지. 날짜는 11/02·11-02·11월 2일·2026-11-02 어느 꼴이든 된다.
 * 날짜를 계산하지 못한 업무는 업무명만 있으면 된다. 차량 보험 줄은 형식이 달라 여기서 보지 않는다.
 */
export function recurringOmissions(recurring = [], lines = []) {
  const out = [];
  for (const r of recurring) {
    const dated = /^(.+?): (\d{4})-(\d{2})-(\d{2}) \(D[+-]\d+\)/.exec(r), unknown = /^(.+?): 날짜 계산 불가/.exec(r);
    if (!dated && !unknown) continue;
    const title = norm((dated || unknown)[1]);
    const day = dated && new RegExp(`(?<!\\d)0?${Number(dated[3])}[/.-]0?${Number(dated[4])}(?!\\d)|(?<!\\d)${Number(dated[3])}월\\s*${Number(dated[4])}일`);
    if (!lines.some(l => norm(l).includes(title) && (!day || day.test(l)))) out.push(dated ? `${dated[1]} ${dated[3]}/${dated[4]}` : unknown[1]);
  }
  return out;
}

/* ---------- 원본 읽기 (spreadsheets API는 호출하는 쪽이 넘긴다) ---------- */

/** 날짜 형식 셀은 표시값(11-16)이 연도를 숨기므로 실제 값(일련번호)에서 YYYY-MM-DD로 바꾼다. 나머지는 표시값 그대로. */
export function cellText(v) {
  const n = v?.effectiveValue?.numberValue, type = v?.effectiveFormat?.numberFormat?.type;
  if (typeof n === 'number' && (type === 'DATE' || type === 'DATE_TIME')) return new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000).toISOString().slice(0, 10);
  return v?.formattedValue ?? '';
}

/**
 * 파일 제목과 `Master_Sheet` 등록을 확인하고 규칙표·처리이력을 읽는다. 다른 탭은 읽지 않는다.
 * 처리이력을 못 읽어도 규칙표는 돌려준다. 회차 상태를 아는 체하지 않도록 historyState로 구분한다.
 */
export async function readRecurringSource(api, spreadsheetId, log = () => {}) {
  const meta = await api.get({ spreadsheetId, fields: 'properties(title),sheets(properties(sheetId,title))' });
  if (meta.data.properties.title !== FILE_TITLE) throw new Error('설정된 파일이 정기 업무 원본이 아님');
  const tabs = meta.data.sheets.map(s => s.properties);
  const taskTab = tabs.find(t => t.title === TASK_TAB);
  if (!taskTab) throw new Error('업무 탭 없음');
  const grid = await api.get({ spreadsheetId, ranges: [TASK_RANGE],
    fields: 'sheets(data(rowMetadata(developerMetadata(metadataKey,metadataValue)),rowData(values(formattedValue,effectiveValue,effectiveFormat(numberFormat(type))))))' });
  const data = grid.data.sheets[0].data[0];
  const rows = (data.rowData || []).map(r => [0, 1, 2, 3].map(i => cellText(r.values?.[i])));
  const rowIds = (data.rowMetadata || []).map(m => (m.developerMetadata || []).find(x => x.metadataKey === ID_KEY)?.metadataValue || null);
  let registered = null;
  try {
    const m = await api.values.get({ spreadsheetId, range: "'Master_Sheet'!B1:D60" });
    registered = (m.data.values || []).some(r => clean(r[0]) === FILE_TITLE && clean(r[2]) === TASK_TAB);
  } catch (e) { log('Master_Sheet read failed: ' + e.message); }
  let history = new Map(), historyState = '미생성', historyHeader = null;
  if (tabs.some(t => t.title === HISTORY_TAB)) {
    try {
      const v = await api.values.get({ spreadsheetId, range: HISTORY_RANGE });
      historyHeader = (v.data.values || [])[0] || [];
      // 열이 바뀐 표를 읽으면 상태를 잘못 해석하고 쓰기 도구가 다른 열을 덮어쓴다.
      if (HISTORY_HEADER.some((h, i) => clean(historyHeader[i]) !== h)) throw new Error('머리글이 고정 열과 다름');
      history = parseHistory(v.data.values);
      historyState = '연결';
    } catch (e) { log('recurring history read failed: ' + e.message); historyState = '조회 실패'; }
  }
  return { tasks: parseTasks(rows, rowIds), history, historyState, historyHeader, registered, taskSheetId: taskTab.sheetId };
}
