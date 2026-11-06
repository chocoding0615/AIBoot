import test from 'node:test';
import assert from 'node:assert/strict';
import { HISTORY_HEADER, HISTORY_TAB, ID_KEY, loadHolidays, makeCalendar, occurrenceState, occurrences, parseHistory, parseHolidayFeed, parseRule, parseTasks, parseUse, readRecurringSource, recurringLines } from '../recurring.mjs';
import { planInit, planMark } from '../recurring-status.mjs';

const event = (date, summary) => `BEGIN:VEVENT\r\nDTSTART;VALUE=DATE:${date}\r\nDESCRIPTION:공휴일\r\nSUMMARY:${summary}\r\nEND:VEVENT\r\n`;
const FEED = [['20260216', '설날 연휴'], ['20260217', '설날'], ['20260218', '설날 연휴'], ['20260924', '추석 연휴'], ['20260925', '추석'], ['20260926', '추석 연휴'],
  ['20261003', '개천절'], ['20261009', '한글날'], ['20261225', '기독탄신일'], ['20270101', '새해'], ['20270207', '설날'], ['20270208', '설날 연휴'], ['20270209', '쉬는 날 설날'], ['20270915', '추석'], ['20260101', '새해']]
  .map(([d, s]) => event(d, s)).join('') + 'BEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20261105\r\nDESCRIPTION:기념일\r\nSUMMARY:설날\r\nEND:VEVENT\r\n';
const holidays = parseHolidayFeed(FEED);
const cal = makeCalendar(holidays);
const today = '2026-11-06';
const rows = [['생각공장 주차권 구매', '매월', '첫 영업일'], ['어버이날 복지 포인트', '매년', '05-08'], ['법정의무교육', '매년 2회', '05-01, 11-01'], ['명절 제품지원', '매년 2회', '설·추석 -10영업일'], ['SGI보증보험 ', '매년 1회', '12-15']];
const rule = (a, b) => parseRule(a, b);
const dues = (r, c = cal, t = today, o) => occurrences(r, c, t, o).map(x => x.due || x.unknown);
const source = (extra = {}) => ({ tasks: parseTasks(rows, ['T1', 'T2', 'T3', 'T4', 'T5']), history: new Map(), historyState: '연결', ...extra });

test('공휴일 피드: 설날·추석 당일만 이름으로 잡고 공휴일이 아닌 일정은 뺌', () => {
  assert.deepEqual(holidays.names.설날, ['2026-02-17', '2027-02-07']);
  assert.deepEqual(holidays.names.추석, ['2026-09-25', '2027-09-15']);
  assert.equal(holidays.days.includes('2026-11-05'), false);
});

test('공휴일 캐시: 오늘 캐시, 이름 없는 옛 캐시 갱신, 실패 시 이전 캐시, save=false는 파일을 쓰지 않음', async () => {
  const dir = await import('node:fs').then(fs => fs.mkdtempSync(process.env.TEMP ? process.env.TEMP + '/rec-' : '/tmp/rec-'));
  const fs = await import('node:fs'), file = dir + '/h.json';
  const ok = async () => ({ ok: true, text: async () => FEED });
  const bad = async () => { throw new Error('down'); };
  assert.equal(await loadHolidays({ file, today, fetcher: bad }), null);
  fs.writeFileSync(file, JSON.stringify({ fetched: today, days: ['2026-01-01'] }));
  const refreshed = await loadHolidays({ file, today, fetcher: ok, save: false });
  assert.deepEqual(refreshed.names.추석, ['2026-09-25', '2027-09-15']);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).names, undefined);
  assert.deepEqual((await loadHolidays({ file, today, fetcher: bad })).days, ['2026-01-01']);
  await loadHolidays({ file, today, fetcher: ok });
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).names);
  let called = 0;
  await loadHolidays({ file, today, fetcher: async () => { called++; return ok(); } });
  assert.equal(called, 0);
  fs.rmSync(dir, { recursive: true });
});

test('주차권: 첫 영업일은 주말·공휴일을 건너뛰고 임시 휴무·지정 근무일을 따름', () => {
  const first = rule('매월', '첫 영업일');
  assert.deepEqual(occurrences(first, cal, today).map(o => [o.key, o.due, o.d]), [['2026-11', '2026-11-02', -4], ['2026-12', '2026-12-01', 25], ['2027-01', '2027-01-04', 59]]);
  assert.equal(occurrences(first, makeCalendar(holidays, { holidaysExtra: ['2026-12-01'] }), today)[1].due, '2026-12-02');
  assert.equal(occurrences(first, makeCalendar(holidays, { workdaysExtra: ['2026-11-01'] }), today)[0].due, '2026-11-01');
  assert.equal(occurrences(first, cal, '2026-10-20')[0].due, '2026-10-01');
});

test('개인 종일휴가는 회사 영업일 계산에 영향이 없음', () => {
  const withVacation = makeCalendar(holidays, { vacations: ['2026-12-01'] });
  assert.equal(occurrences(rule('매월', '첫 영업일'), withVacation, today)[1].due, '2026-12-01');
});

test('고정 날짜: 5/8, 5/1·11/1, 12/15는 그날 그대로이고 주말이어도 옮기지 않음', () => {
  assert.deepEqual(occurrences(rule('매년', '05-08'), cal, '2027-04-20').map(o => [o.key, o.due]), [['2027', '2027-05-08']]);
  assert.deepEqual(occurrences(rule('매년 2회', '05-01, 11-01'), cal, today).map(o => [o.key, o.due, o.d]), [['2026-2', '2026-11-01', -5]]);
  assert.deepEqual(occurrences(rule('매년 2회', '11-01,05-01'), cal, '2026-04-10').map(o => [o.key, o.due]), [['2026-1', '2026-05-01']]);
  assert.deepEqual(occurrences(rule('매년 1회', '12-15'), cal, today).map(o => [o.key, o.due, o.d]), [['2026', '2026-12-15', 39]]);
});

test('설·추석 -10영업일: 연휴와 주말을 빼고 세며 연도별로 계산', () => {
  const r = rule('매년 2회', '설·추석 -10영업일');
  assert.deepEqual(r, { kind: 'lunar', names: ['설날', '추석'], offset: 10 });
  assert.deepEqual(occurrences(r, cal, '2026-01-25').map(o => [o.key, o.due]), [['2026-설날', '2026-02-02']]);
  assert.deepEqual(occurrences(r, cal, '2026-08-20').map(o => [o.key, o.due]), [['2026-추석', '2026-09-10']]);
  assert.equal(occurrences(r, makeCalendar(holidays, { holidaysExtra: ['2026-09-15'] }), '2026-08-20')[0].due, '2026-09-09');
});

test('1년 경계: 12월에 다음 해 회차가 해당 연도 키로 계산됨', () => {
  assert.deepEqual(occurrences(rule('매년', '01-05'), cal, '2026-12-20').map(o => [o.key, o.due]), [['2027', '2027-01-05']]);
  assert.deepEqual(occurrences(rule('매년', '12-20'), cal, '2027-01-05').map(o => [o.key, o.due]), [['2026', '2026-12-20']]);
  assert.deepEqual(occurrences(rule('매월', '첫 영업일'), cal, '2026-12-28').map(o => o.key), ['2026-12', '2027-01', '2027-02']);
});

test('날짜 불명: 공휴일 목록이 없으면 첫 영업일·명절을 만들지 않고 확인으로 돌림', () => {
  const none = makeCalendar(null);
  assert.ok(occurrences(rule('매월', '첫 영업일'), none, today).every(o => o.unknown));
  assert.ok(occurrences(rule('매년 2회', '설·추석 -10영업일'), none, today).every(o => o.unknown && !o.due));
  assert.deepEqual(dues(rule('매년 1회', '12-15'), none), ['2026-12-15']);
  assert.match(occurrences(rule('매년', '02-29'), cal, '2026-02-10')[0].unknown, /없는 날짜/);
  const feedNoYear = makeCalendar(parseHolidayFeed(event('20261225', '기독탄신일')));
  assert.match(occurrences(rule('매년 2회', '설·추석 -10영업일'), feedNoYear, '2026-08-20')[0].unknown, /추석|설날/);
});

test('미설정·해석 불가 규칙은 임의 날짜 없이 오류로 남음', () => {
  for (const [a, b] of [['', ''], ['매월', ''], ['매월', '15일'], ['분기', '첫 영업일'], ['매년 2회', '05-01'], ['매년', '05-01, 11-01'], ['매년', '13-01'], ['매년', '02-30'], ['매년 2회', '05-01, 05-01'], ['매년 1회', '설·추석 -10영업일']]) assert.ok(parseRule(a, b).error, `${a}/${b}`);
  assert.deepEqual(occurrences(parseRule('분기', '말일'), cal, today).length, 1);
});

test('사용 여부: 실제 값 완료·진행중과 빈칸, 중지', () => {
  assert.deepEqual(parseUse(''), { active: true, label: '미설정' });
  assert.deepEqual(parseUse('진행중'), { active: true, label: '진행중' });
  assert.equal(parseUse('사용').active, true);
  assert.equal(parseUse('중지').active, false);
  const done = parseUse('완료');
  assert.equal(done.active, true);
  assert.match(done.warn, /회차 완료로 보지 않음/);
  const t = parseTasks([['주차권', '매월', '첫 영업일', '완료'], ['SGI', '매년', '12-15', '중지']], ['A', 'B']);
  const lines = recurringLines({ tasks: t, history: new Map() }, cal, today);
  assert.ok(lines.some(l => /주차권: 2026-11-02 .*회차 완료로 보지 않음/.test(l)));
  assert.equal(lines.some(l => l.includes('SGI')), false);
});

test('실제 규칙표 다섯 행의 2026-11-06 회차', () => {
  const lines = recurringLines(source(), cal, today);
  assert.deepEqual(lines, ['생각공장 주차권 구매: 2026-11-02 (D+4) — 완료 여부 확인 필요', '생각공장 주차권 구매: 2026-12-01 (D-25) — 완료 여부 확인 필요', '생각공장 주차권 구매: 2027-01-04 (D-59) — 완료 여부 확인 필요',
    '법정의무교육: 2026-11-01 (D+5) — 완료 여부 확인 필요', 'SGI보증보험: 2026-12-15 (D-39) — 완료 여부 확인 필요']);
});

test('완료·보류 회차는 분리되고 다음 회차는 남음', () => {
  const hist = parseHistory([HISTORY_HEADER, ['T1', '2026-11', '완료', '2026-11-02 10:00:00', '구매 영수증', '2026-11-02'], ['T3', '2026-2', '보류', '2026-11-06 10:00:00', '일정 조정', '2026-11-01']]);
  const lines = recurringLines(source({ history: hist }), cal, today);
  assert.equal(lines.some(l => l.includes('2026-11-02')), false);
  assert.ok(lines.some(l => l.includes('주차권 구매: 2026-12-01')));
  assert.equal(lines.some(l => l.includes('법정의무교육')), false);
});

test('증빙 없는 완료·중복 행·기준일 변경은 완료로 인정하지 않음', () => {
  const t = source().tasks[2], occ = { key: '2026-2', due: '2026-11-01' };
  const state = rows2 => occurrenceState(t, occ, parseHistory([HISTORY_HEADER, ...rows2])).state;
  assert.equal(state([['T3', '2026-2', '완료', 'x', '', '2026-11-01']]), '확인 필요');
  assert.equal(state([['T3', '2026-2', '완료', 'x', '근거', '2026-11-01'], ['T3', '2026-2', '완료', 'x', '근거', '2026-11-01']]), '확인 필요');
  assert.equal(state([['T3', '2026-2', '완료', 'x', '근거', '2026-11-02']]), '확인 필요');
  assert.equal(state([['T3', '2026-2', '끝남', 'x', '근거', '2026-11-01']]), '확인 필요');
  assert.equal(state([['T3', '2026-2', '미처리', 'x', '', '2026-11-01']]), '미처리');
  assert.equal(state([['T3', '2026-2', '완료', 'x', '근거', '2026-11-01']]), '완료');
  const monthly = source().tasks[0];
  assert.equal(occurrenceState(monthly, { key: '2026-11', due: '2026-11-03' }, parseHistory([HISTORY_HEADER, ['T1', '2026-11', '완료', 'x', '근거', '2026-11-02']])).state, '완료');
});

test('비고 원문은 파싱 결과에 남지 않음', () => {
  assert.equal(JSON.stringify([...parseHistory([HISTORY_HEADER, ['T1', '2026-11', '완료', 'x', '김철수 010-1234-5678', '2026-11-02']])]).includes('김철수'), false);
});

test('업무ID: 이름 변경·규칙 변경·행 이동에도 같은 회차 상태, 동명 업무는 분리, 같은 ID는 차단', () => {
  const hist = parseHistory([HISTORY_HEADER, ['T9', '2026', '완료', 'x', '근거', '2026-12-15']]);
  const renamed = parseTasks([['다른 줄', '매년', '01-01'], ['SGI 보증보험 갱신', '매년 1회', '12-15']], ['T8', 'T9']);
  assert.equal(recurringLines({ tasks: renamed, history: hist }, cal, today).some(l => l.includes('SGI')), false);
  const same = parseTasks([['주차권', '매월', '첫 영업일'], ['주차권', '매월', '첫 영업일']], ['A', 'B']);
  assert.ok(same.every(t => t.sameTitle && !t.idConflict));
  const h2 = parseHistory([HISTORY_HEADER, ['A', '2026-11', '완료', 'x', '근거', '2026-11-02']]);
  const lines = recurringLines({ tasks: same, history: h2 }, cal, today).filter(l => l.includes('2026-11-02'));
  assert.equal(lines.length, 1);
  const clash = parseTasks([['가', '매월', '첫 영업일'], ['나', '매월', '첫 영업일']], ['X', 'X']);
  assert.equal(occurrenceState(clash[0], { key: '2026-11', due: '2026-11-02' }, new Map()).state, '확인 필요');
  assert.equal(occurrenceState(parseTasks([['가', '매월', '첫 영업일']])[0], { key: '2026-11', due: '2026-11-02' }, new Map()).why, '업무ID 미지정');
});

test('빈 행은 건너뛰고 업무명 없는 행은 확인으로 남김', () => {
  const t = parseTasks([['', '', '', ''], ['', '매월', '첫 영업일', '']]);
  assert.equal(t.length, 1);
  assert.equal(t[0].row, 3);
  assert.ok(t[0].rule.error);
});

const fakeApi = ({ title = '[MS] 김현호', tabs = ['업무', 'Master_Sheet'], historyFail = false, values = [], ids = [], history = [HISTORY_HEADER] } = {}) => {
  const ranges = [];
  return { ranges, get: async p => p.ranges
    ? { data: { sheets: [{ data: [{ rowData: values.map(r => ({ values: r.map(formattedValue => ({ formattedValue })) })), rowMetadata: ids.map(v => v ? { developerMetadata: [{ metadataKey: 'other', metadataValue: 'z' }, { metadataKey: ID_KEY, metadataValue: v }] } : {}) }] }] } }
    : { data: { properties: { title }, sheets: tabs.map((t, i) => ({ properties: { title: t, sheetId: i + 7 } })) } },
    values: { get: async ({ range }) => { ranges.push(range);
      if (range.includes('Master_Sheet')) return { data: { values: [['[MS] 김현호', '', '업무']] } };
      if (historyFail) throw new Error('boom');
      return { data: { values: history } }; } } };
};

test('원본 읽기: 다른 파일 차단, 탭 없음 실패, 이력 미생성·조회 실패 구분', async () => {
  await assert.rejects(readRecurringSource(fakeApi({ title: '[MS] AD_관리비 내역' }), 'id'), /정기 업무 원본이 아님/);
  await assert.rejects(readRecurringSource(fakeApi({ tabs: ['Master_Sheet'] }), 'id'), /업무 탭 없음/);
  const a = fakeApi({ values: [['주차권', '매월', '첫 영업일', '진행중']], ids: ['T1'] });
  const s = await readRecurringSource(a, 'id');
  assert.equal(s.historyState, '미생성');
  assert.equal(s.registered, true);
  assert.equal(s.taskSheetId, 7);
  assert.equal(s.tasks[0].id, 'T1');
  assert.equal(a.ranges.some(r => r.includes(HISTORY_TAB)), false);
  assert.equal((await readRecurringSource(fakeApi({ tabs: ['업무', 'Master_Sheet', HISTORY_TAB], historyFail: true }), 'id')).historyState, '조회 실패');
  assert.equal((await readRecurringSource(fakeApi({ tabs: ['업무', 'Master_Sheet', HISTORY_TAB] }), 'id')).historyState, '연결');
});

test('--init 계획: 숨김 탭 1개, 머리글, 업무 셀은 쓰지 않고 ID 없는 행만 지정, 두 번째는 할 일 없음', () => {
  const s = { ...source(), tasks: parseTasks(rows, ['T1']), historyState: '미생성', taskSheetId: 7 };
  const p = planInit(s, (() => { let n = 1; return () => 'T' + n++; })(), 55);
  assert.equal(p.createTab, true);
  assert.deepEqual(p.assign.map(a => a.row), [3, 4, 5, 6]);
  assert.equal(new Set(p.assign.map(a => a.id)).size, 4);
  assert.equal(p.assign.some(a => a.id === 'T1'), false);
  assert.equal(p.requests[0].addSheet.properties.hidden, true);
  assert.equal(p.requests[0].addSheet.properties.title, HISTORY_TAB);
  assert.equal(p.requests.filter(r => r.addSheet).length, 1);
  assert.ok(p.requests.slice(2).every(r => r.createDeveloperMetadata.developerMetadata.location.dimensionRange.sheetId === 7));
  assert.equal(p.requests.filter(r => r.updateCells).every(r => r.updateCells.start.sheetId === 55), true);
  assert.equal(JSON.stringify(p.requests).match(/"(deleteSheet|deleteDimension|updateSheetProperties|repeatCell)"/), null);
  const again = planInit({ ...source(), historyState: '연결', historyHeader: HISTORY_HEADER });
  assert.deepEqual(again.requests, []);
  assert.throws(() => planInit({ ...source(), historyState: '연결', historyHeader: ['다른 열'] }), /머리글/);
  assert.throws(() => planInit({ ...source(), historyState: '조회 실패' }), /판단할 수 없음/);
  const named = planInit({ ...source(), tasks: parseTasks([['(주)거래처 점검', '매년', '12-01'], ['', '매년', '12-01']]), historyState: '미생성', taskSheetId: 7 });
  assert.deepEqual(named.assign.map(a => a.row), [2]);
});

test('--mark 계획: 증빙 필수, 같은 회차는 새 행 없이 갱신, 중복 기록·미래 회차 차단', () => {
  const s = source();
  const mark = (src, o) => planMark(src, o, cal, today, '2026-11-06 17:00:00');
  assert.deepEqual(mark(s, { id: 'T1', key: '2026-11', status: '완료', note: '구매 완료 메일' }), { op: 'append', row: undefined, values: ['T1', '2026-11', '완료', '2026-11-06 17:00:00', '구매 완료 메일', '2026-11-02'] });
  assert.throws(() => mark(s, { id: 'T1', key: '2026-11', status: '완료', note: ' ' }), /근거/);
  assert.throws(() => mark(s, { id: 'T1', key: '2026-11', status: '보류' }), /근거/);
  assert.throws(() => mark(s, { id: 'T1', key: '2026-11', status: '끝남', note: 'x' }), /상태는/);
  assert.throws(() => mark(s, { id: 'NOPE', key: '2026-11', status: '완료', note: 'x' }), /업무ID 없음/);
  assert.throws(() => mark(s, { id: 'T1', key: '2030-01', status: '완료', note: 'x' }), /계산 가능한 회차/);
  assert.throws(() => mark({ ...s, historyState: '미생성' }, { id: 'T1', key: '2026-11', status: '완료', note: 'x' }), /--init/);
  const done = { ...s, history: parseHistory([HISTORY_HEADER, ['T1', '2026-11', '보류', 'x', '사유', '2026-11-02']]) };
  const up = mark(done, { id: 'T1', key: '2026-11', status: '완료', note: '근거' });
  assert.equal(up.op, 'update');
  assert.equal(up.row, 2);
  assert.equal(mark(done, { id: 'T1', key: '2026-11', status: '보류', note: '근거' }).op, 'none');
  assert.equal(mark(s, { id: 'T1', key: '2026-11', status: '미처리' }).op, 'none');
  const dup = { ...s, history: parseHistory([HISTORY_HEADER, ['T1', '2026-11', '완료', 'x', 'a', '2026-11-02'], ['T1', '2026-11', '완료', 'x', 'a', '2026-11-02']]) };
  assert.throws(() => mark(dup, { id: 'T1', key: '2026-11', status: '보류', note: 'x' }), /여럿/);
});

test('실행기는 시트에 쓰지 않고 옛 날짜형 탭을 읽지 않음', async () => {
  const fs = await import('node:fs');
  const src = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
  for (const name of ['runner.mjs', 'recurring.mjs']) assert.equal(/\.(batchUpdate|update|append|clear)\(/.test(src(name).replace(/createHash\([^)]*\)\.update\(/g, '').replace(/\.update\(raw\)|\.update\(snap/g, '')), false, name);
  assert.equal(src('runner.mjs').includes("'업무'!A1:D150"), false);
});
