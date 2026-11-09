import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FakeSheet, FakeSpreadsheet, ICS, kstDate, loadGas, sheetsApi } from './fake-gas.mjs';
import { build, OUT } from '../build.mjs';
import { HISTORY_HEADER, ID_KEY, makeCalendar, occurrences, parseHistory, parseHolidayFeed, parseTasks, readRecurringSource, recurringLines } from '../../local-dual-report/recurring.mjs';

const TITLE = '[MS] 김현호';
const IDS = ['Te0265aed', 'T3e06e25e', 'T0a4e1f1d', 'Tf32918f7', 'T66645e27'];
/** 실제 시트와 같은 꼴의 견본(업무명은 가짜). 2~6행은 ID 5개, 7행은 날짜 셀 단발 업무, ID 없음. */
function sample({ history = true, row7Cycle = '1회' } = {}) {
  const tasks = new FakeSheet('업무', [
    ['업무명', '주기', '기준', '사용 여부'],
    ['주차권 구매', '매월', '첫 영업일', '사용'],
    ['교육 이수', '매년 2회', '05-01, 11-01', '사용'],
    ['보증보험', '매년', '12-15', '사용'],
    ['명절 선물', '매년 2회', '설·추석 -10영업일', '사용'],
    ['분기 점검', '분기', '첫 영업일', '사용'],
    ['공지 업무', row7Cycle, kstDate('2026-11-16'), '사용']
  ], 1763835306);
  IDS.forEach((id, i) => tasks.meta[i + 1].push({ key: ID_KEY, value: id }));
  const other = new FakeSheet('기타', [['건드리면 안 되는 값', 'x'], ['2026-11', 'y']]);
  const sheets = [tasks, other];
  if (history) { const h = new FakeSheet('반복업무_처리이력', [HISTORY_HEADER]); h.cells[0].forEach(c => { c.text = true; }); h.hidden = true; sheets.push(h); }
  return { ss: new FakeSpreadsheet(TITLE, sheets), tasks, other, hist: sheets[2] };
}
const ids = sheet => sheet.meta.map(list => list.filter(m => m.key === ID_KEY).map(m => m.value));
const snapshot = sheet => JSON.stringify(sheet.values());
const editA = (gas, sheet, row) => gas.onEdit({ range: sheet.getRange(row, 1) });
/** 정기 보고(Node)가 같은 시트 상태를 읽었을 때의 [정기 업무] 줄. */
function reportLines({ tasks, hist }, today = '2026-11-09') {
  const rows = tasks.values().slice(1).map(r => r.slice(0, 4).map(v => Object.prototype.toString.call(v) === '[object Date]' ? new Date(v.getTime() + 9 * 3600000).toISOString().slice(0, 10) : String(v ?? '')));
  const rowIds = ids(tasks).slice(1).map(l => l[0] || null);
  const history = parseHistory(hist.values().map(r => r.map(v => String(v ?? ''))));
  return recurringLines({ tasks: parseTasks(rows, rowIds), history }, makeCalendar(parseHolidayFeed(ICS)), today);
}

test('dist/Recurring.gs가 recurring.mjs·recurring-status.mjs 원문과 같음', () => {
  assert.equal(fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n'), build());
});

test('v0: 새 행 등록 → ID 자동 지정 → 회차 완료 → 정기 보고가 완료를 인식', () => {
  const s = sample();
  const { gas } = loadGas({ ss: s.ss, ics: ICS });
  const before = snapshot(s.tasks);
  editA(gas, s.tasks, 7);
  const after = ids(s.tasks);
  assert.deepEqual(after.slice(1, 6), IDS.map(x => [x]), '기존 5개 ID 보존');
  assert.match(after[6][0], /^T[0-9a-f]{8}$/);
  assert.equal(snapshot(s.tasks), before, 'A:D 셀 값은 쓰지 않음');
  assert.ok(reportLines(s).some(l => l.startsWith('공지 업무: 2026-11-16')));

  const list = gas.listOccurrences(7);
  assert.equal(JSON.stringify(list.occurrences.map(o => [o.key, o.due, o.state])), JSON.stringify([['1회', '2026-11-16', '미처리']]));
  const r = gas.markOccurrence({ row: 7, id: after[6][0], key: '1회', due: '2026-11-16', status: '완료', note: '공지 발송함' });
  assert.equal(r.op, 'append');
  assert.deepEqual(s.hist.values()[1].filter((_, i) => i !== 3), [after[6][0], '1회', '완료', '공지 발송함', '2026-11-16']);
  assert.ok(!reportLines(s).some(l => l.startsWith('공지 업무')), '완료 회차는 보고에서 빠짐');
});

test('ID 지정은 몇 번 반복해도 같은 결과, 같은 이름 두 행은 다른 ID, 업무명 없는 행은 ID 없음', () => {
  const s = sample();
  s.tasks.cells.push([{ v: '주차권 구매' }, { v: '매월' }, { v: '첫 영업일' }, { v: '사용' }], [{ v: '' }, { v: '매월' }, { v: '첫 영업일' }, { v: '' }]);
  s.tasks.meta.push([], []);
  const { gas } = loadGas({ ss: s.ss });
  gas.assignNewIds_(); const once = JSON.stringify(ids(s.tasks));
  gas.assignNewIds_(); editA(gas, s.tasks, 8); gas.onOpen();
  assert.equal(JSON.stringify(ids(s.tasks)), once);
  const all = ids(s.tasks).flat();
  assert.equal(new Set(all).size, all.length);
  assert.equal(ids(s.tasks)[7].length, 1);
  assert.equal(ids(s.tasks)[8].length, 0, '업무명 없는 행');
});

test('행 이동·삭제: ID가 행을 따라가고, 대화상자를 연 뒤 행이 바뀌면 쓰지 않음', () => {
  const s = sample();
  const { gas } = loadGas({ ss: s.ss, ics: ICS });
  const list = gas.listOccurrences(2);
  assert.equal(list.id, IDS[0]);
  s.tasks.insertRowBefore(2);
  assert.throws(() => gas.markOccurrence({ row: 2, id: IDS[0], key: '2026-11', due: '2026-11-02', status: '완료', note: 'x' }), /업무가 바뀌었음/);
  assert.equal(gas.listOccurrences(3).id, IDS[0], '이동한 행의 ID 유지');
  s.tasks.deleteRow(3);
  assert.ok(!ids(s.tasks).flat().includes(IDS[0]), '지운 행의 ID는 사라짐');
  assert.equal(s.hist.writes, 0);
});

test('완료 → 보류 → 다시 열기: 같은 회차 행 하나만 갱신, 보고 포함 여부가 따라감', () => {
  const s = sample();
  const { gas } = loadGas({ ss: s.ss, ics: ICS });
  const line = () => reportLines(s).filter(l => l.startsWith('주차권 구매')).map(l => l.slice(0, 18));
  const ALL = ['주차권 구매: 2026-11-02', '주차권 구매: 2026-12-01', '주차권 구매: 2027-01-04'];
  assert.deepEqual(line(), ALL);
  gas.markOccurrence({ row: 2, id: IDS[0], key: '2026-11', due: '2026-11-02', status: '완료', note: '구매함' });
  assert.deepEqual(line(), ALL.slice(1));
  assert.equal(gas.markOccurrence({ row: 2, id: IDS[0], key: '2026-11', due: '2026-11-02', status: '완료', note: '구매함' }).op, 'none');
  assert.equal(gas.markOccurrence({ row: 2, id: IDS[0], key: '2026-11', due: '2026-11-02', status: '보류', note: '다음 달로' }).op, 'update');
  assert.deepEqual(line(), ALL.slice(1));
  gas.markOccurrence({ row: 2, id: IDS[0], key: '2026-11', due: '2026-11-02', status: '미처리', note: '' });
  assert.deepEqual(line(), ALL);
  assert.equal(s.hist.getLastRow(), 2, '회차당 한 행');
  assert.equal(s.hist.values()[1][1], '2026-11', '회차키가 날짜로 바뀌지 않음(글자 형식)');
});

test('기준일 변경: 단발 업무 날짜를 고치면 완료 기록이 확인 필요로 돌아감', () => {
  const s = sample();
  const { gas } = loadGas({ ss: s.ss, ics: ICS });
  gas.assignNewIds_();
  const id = ids(s.tasks)[6][0];
  gas.markOccurrence({ row: 7, id, key: '1회', due: '2026-11-16', status: '완료', note: '공지 발송함' });
  s.tasks.cells[6][2].v = kstDate('2026-11-18');
  assert.equal(gas.listOccurrences(7).occurrences[0].state, '확인 필요');
  assert.ok(reportLines(s).some(l => l.startsWith('공지 업무: 2026-11-18') && l.includes('기록 당시 기준일과 달라짐')));
});

test('거부: 근거 없는 완료, 60일 넘은 미래 회차, 규칙 오류 행, ID 충돌, 머리글 변경, 다른 파일', () => {
  const s = sample();
  const { gas } = loadGas({ ss: s.ss, ics: ICS });
  assert.throws(() => gas.markOccurrence({ row: 2, id: IDS[0], key: '2026-11', due: '2026-11-02', status: '완료', note: ' ' }), /근거가 필요/);
  assert.throws(() => gas.markOccurrence({ row: 2, id: IDS[0], key: '2027-03', due: '2027-03-02', status: '완료', note: 'x' }), /계산 가능한 회차가 아님/);
  assert.match(gas.listOccurrences(6).error, /규칙 확인 필요/);
  s.tasks.meta[6].push({ key: ID_KEY, value: IDS[0] });
  assert.throws(() => gas.markOccurrence({ row: 2, id: IDS[0], key: '2026-11', due: '2026-11-02', status: '완료', note: 'x' }), /두 행/);
  s.tasks.meta[6].pop();
  s.hist.cells[0][2].v = '상태값';
  assert.throws(() => gas.assignNewIds_(), /머리글/);
  assert.match(gas.listOccurrences(2).error, /조회 실패/);
  assert.equal(s.hist.writes, 0);
  const wrong = loadGas({ ss: new FakeSpreadsheet('[MS] AD_관리비 내역', s.ss.sheets) }).gas;
  assert.throws(() => wrong.assignNewIds_(), /원본 파일이 아님/);
});

test('잠금 실패·쓰기 권한 거부·공휴일 피드 실패는 쓰지 않고 실패를 알림', () => {
  const s = sample();
  assert.throws(() => loadGas({ ss: s.ss, ics: ICS, lockFails: true }).gas.markOccurrence({ row: 2, id: IDS[0], key: '2026-11', due: '2026-11-02', status: '완료', note: 'x' }), /다른 처리가 진행 중/);
  s.hist.failWrites = 'You do not have permission to edit';
  assert.throws(() => loadGas({ ss: s.ss, ics: ICS }).gas.markOccurrence({ row: 2, id: IDS[0], key: '2026-11', due: '2026-11-02', status: '완료', note: 'x' }), /permission/);
  delete s.hist.failWrites;
  assert.equal(s.hist.getLastRow(), 1);
  // 공휴일을 못 받으면 첫 영업일 회차를 계산하지 못해 기록을 거부한다(날짜를 추측하지 않음).
  const nofeed = loadGas({ ss: s.ss, fetchFails: true }).gas;
  assert.throws(() => nofeed.markOccurrence({ row: 2, id: IDS[0], key: '2026-11', due: '2026-11-02', status: '완료', note: 'x' }), /계산 가능한 회차가 아님/);
  // 단순 트리거의 ID 지정이 권한 거부로 실패해도 편집 자체를 막지 않는다.
  s.tasks.failWrites = 'denied';
  assert.doesNotThrow(() => editA(loadGas({ ss: s.ss }).gas, s.tasks, 7));
});

test('다른 탭 편집은 무시하고, 어떤 동작도 다른 탭·업무 탭 셀을 바꾸지 않음', () => {
  const s = sample({ history: false });
  const { gas } = loadGas({ ss: s.ss, ics: ICS });
  const other = snapshot(s.other), task = snapshot(s.tasks);
  gas.onEdit({ range: s.other.getRange(1, 1) });
  assert.equal(ids(s.tasks)[6].length, 0, '다른 탭 편집으로는 ID 지정 안 함');
  gas.onEdit({ range: s.tasks.getRange(7, 5) });
  assert.equal(ids(s.tasks)[6].length, 0, 'E열 편집은 무시');
  assert.match(gas.listOccurrences(2).error, /미생성/);
  assert.equal(gas.setupHistoryTab_().created, true);
  assert.equal(gas.setupHistoryTab_().created, false, '두 번 만들지 않음');
  gas.assignNewIds_();
  gas.markOccurrence({ row: 2, id: IDS[0], key: '2026-11', due: '2026-11-02', status: '완료', note: 'x' });
  assert.equal(snapshot(s.other), other);
  assert.equal(snapshot(s.tasks), task);
  assert.equal(s.other.writes, 0);
  const h = s.ss.getSheetByName('반복업무_처리이력');
  assert.equal(h.hidden, true);
  assert.deepEqual(h.values()[0], HISTORY_HEADER);
});

test('시트 메뉴가 계산한 회차는 정기 보고 계산과 같음(같은 원문)', () => {
  const s = sample();
  const { gas } = loadGas({ ss: s.ss, ics: ICS });
  const cal = makeCalendar(parseHolidayFeed(ICS));
  for (const [row, cycle, basis] of [[2, '매월', '첫 영업일'], [3, '매년 2회', '05-01, 11-01'], [5, '매년 2회', '설·추석 -10영업일']]) {
    const want = occurrences(parseTasks([['x', cycle, basis, '사용']])[0].rule, cal, '2026-11-09', { before: 400 }).filter(o => o.due).map(o => o.key + ' ' + o.due);
    assert.deepEqual([...gas.listOccurrences(row).occurrences.map(o => o.key + ' ' + o.due)], want);
  }
});

test('정기 보고의 실제 읽기 경로(readRecurringSource)가 시트 메뉴 기록을 같은 상태로 읽음', async () => {
  const s = sample();
  const { gas } = loadGas({ ss: s.ss, ics: ICS });
  gas.assignNewIds_();
  const id7 = ids(s.tasks)[6][0];
  gas.markOccurrence({ row: 2, id: IDS[0], key: '2026-11', due: '2026-11-02', status: '완료', note: '구매함' });
  gas.markOccurrence({ row: 7, id: id7, key: '1회', due: '2026-11-16', status: '보류', note: '=1+1 수식처럼 보이는 근거' });
  const src = await readRecurringSource(sheetsApi(s.ss), 'fake');
  assert.equal(src.historyState, '연결');
  assert.deepEqual(src.tasks.map(t => t.id), [...IDS, id7]);
  assert.equal(src.tasks[5].basis, '2026-11-16', '날짜 셀을 실제 날짜로 읽음');
  const lines = recurringLines(src, makeCalendar(parseHolidayFeed(ICS)), '2026-11-09');
  assert.ok(!lines.some(l => l.startsWith('주차권 구매: 2026-11-02')));
  assert.ok(!lines.some(l => l.startsWith('공지 업무')));
  assert.equal(s.hist.values()[2][4], '=1+1 수식처럼 보이는 근거', '근거가 수식으로 바뀌지 않음');
  assert.equal(s.hist.values()[1][1], '2026-11');
});

test('대화상자 이후 기준일 변경·이력 행 삭제·행 삽입이 생기면 쓰지 않음', () => {
  const s = sample();
  const { gas } = loadGas({ ss: s.ss, ics: ICS });
  gas.assignNewIds_();
  const id7 = ids(s.tasks)[6][0];
  const seen = gas.listOccurrences(7).occurrences[0];
  s.tasks.cells[6][2].v = kstDate('2026-11-18');
  assert.throws(() => gas.markOccurrence({ row: 7, id: id7, key: '1회', due: seen.due, status: '완료', note: 'x' }), /기준일이 2026-11-16에서 2026-11-18/);
  assert.throws(() => gas.markOccurrence({ row: 7, id: id7, key: '1회', status: '완료', note: 'x' }), /기준일 없는 요청/);
  // 갱신하려던 이력 행이 읽은 뒤 지워져 다른 회차 행이 그 자리에 온 경우
  gas.markOccurrence({ row: 2, id: IDS[0], key: '2026-11', due: '2026-11-02', status: '완료', note: 'a' });
  gas.markOccurrence({ row: 2, id: IDS[0], key: '2026-12', due: '2026-12-01', status: '완료', note: 'b' });
  const before = JSON.stringify(s.hist.values());
  assert.throws(() => gas.writeHistoryRow_(s.hist, 2, ['x', '2026-12', '보류', 't', 'n', '2026-12-01'], [IDS[0], '2026-12']), /그 사이 바뀌었음/);
  assert.throws(() => gas.writeHistoryRow_(s.hist, 3, ['x', 'k', '보류', 't', 'n', 'd'], null), /그 사이 바뀌었음/, '추가할 자리가 비어 있지 않음');
  assert.equal(JSON.stringify(s.hist.values()), before);
  // ID 지정 계획을 세운 뒤 사용자가 위에 행을 넣은 경우: 빈 행이 된 자리에 ID를 붙이지 않음
  s.tasks.cells.push([{ v: '새 업무' }, { v: '1회' }, { v: '2026-12-10' }, { v: '사용' }]); s.tasks.meta.push([]);
  const row = s.tasks.cells.length, orig = gas.readSource_;
  gas.readSource_ = ss => { const r = orig(ss); s.tasks.insertRowBefore(row); return r; };
  assert.equal(gas.assignNewIds_().assigned.length, 0);
  gas.readSource_ = orig;
  assert.equal(ids(s.tasks)[row - 1].length, 0, '삽입된 빈 행에 ID 없음');
  assert.equal(gas.assignNewIds_().assigned[0].row, row + 1, '다음 실행에서 옮겨진 행에 붙음');
});

test('A~D를 모두 비운 행은 ID를 떼고, 그 자리에 새 업무를 쓰면 새 ID — 예전 완료 기록을 물려받지 않음', () => {
  const s = sample();
  const { gas } = loadGas({ ss: s.ss, ics: ICS });
  gas.assignNewIds_();
  const old = ids(s.tasks)[6][0];
  gas.markOccurrence({ row: 7, id: old, key: '1회', due: '2026-11-16', status: '완료', note: '발송' });
  s.tasks.cells[6].forEach(c => { c.v = ''; });
  editA(gas, s.tasks, 7);
  assert.equal(ids(s.tasks)[6].length, 0, '비운 행의 ID 제거');
  s.tasks.cells[6] = [{ v: '다른 공지' }, { v: '1회' }, { v: kstDate('2026-11-16') }, { v: '사용' }];
  editA(gas, s.tasks, 7);
  assert.notEqual(ids(s.tasks)[6][0], old);
  assert.ok(reportLines(s).some(l => l.startsWith('다른 공지: 2026-11-16')), '새 업무는 보고에 나옴');
  // 이름만 고친 행은 같은 업무로 보고 ID 유지
  s.tasks.cells[1][0].v = '주차권 구매(본사)';
  editA(gas, s.tasks, 2);
  assert.equal(ids(s.tasks)[1][0], IDS[0]);
});
