import test from 'node:test';
import assert from 'node:assert/strict';
import { cellText, makeCalendar, occurrenceState, occurrences, parseHistory, parseRule, parseTasks, recurringLines, recurringOmissions, HISTORY_HEADER } from '../recurring.mjs';

const cal = makeCalendar({ days: ['2026-01-01', '2027-01-01'], names: {} });

test('1회 / 2026-11-16: 그날 한 번만, 다음 해에 다시 생기지 않음', () => {
  const r = parseRule('1회', '2026-11-16');
  assert.deepEqual(r, { kind: 'once', date: '2026-11-16' });
  assert.deepEqual(occurrences(r, cal, '2026-11-09').map(o => [o.key, o.due, o.d]), [['1회', '2026-11-16', 7]]);
  assert.deepEqual(occurrences(r, cal, '2027-11-09'), []);
  assert.deepEqual(occurrences(r, cal, '2026-12-20'), []);
  assert.equal(occurrences(r, cal, '2026-12-10')[0].d, -24);
  assert.deepEqual(parseRule('단발', '2026-11-16'), r);
});

test('1회는 연도 없는 날짜·잘못된 날짜를 받지 않고, 주기 없이 날짜만 있으면 1회 입력을 안내', () => {
  for (const b of ['11-16', '2026-02-30', '다음주']) assert.match(parseRule('1회', b).error, /연도까지/);
  assert.match(parseRule('', '2026-11-16').error, /B열에 1회/);
});

test('날짜 셀: 표시값 11-16 대신 실제 날짜로 읽음, 문자열 셀은 그대로', () => {
  assert.equal(cellText({ formattedValue: '11-16', effectiveValue: { numberValue: 46342 }, effectiveFormat: { numberFormat: { type: 'DATE' } } }), '2026-11-16');
  assert.equal(cellText({ formattedValue: '05-01, 11-01', effectiveValue: { stringValue: '05-01, 11-01' } }), '05-01, 11-01');
  assert.equal(cellText({ formattedValue: '3', effectiveValue: { numberValue: 3 }, effectiveFormat: { numberFormat: { type: 'NUMBER' } } }), '3');
  assert.equal(cellText(undefined), '');
});

test('매년 규칙에 연도 붙은 날짜 셀이 와도 월·일만 씀', () => {
  assert.deepEqual(parseRule('매년', '2025-05-08'), { kind: 'dates', dates: ['05-08'] });
});

test('실제 7행: 공지 1회 업무는 그 해에만 보고, 완료 기록 후 빠짐, 날짜를 고치면 확인 필요', () => {
  const tasks = parseTasks([['법정의무교육(공지)', '1회', '2026-11-16', '사용']], ['T7']);
  assert.deepEqual(recurringLines({ tasks, history: new Map() }, cal, '2026-11-09'), ['법정의무교육(공지): 2026-11-16 (D-7) — 완료 여부 확인 필요']);
  const done = parseHistory([HISTORY_HEADER, ['T7', '1회', '완료', 'x', '공지 발송', '2026-11-16']]);
  assert.deepEqual(recurringLines({ tasks, history: done }, cal, '2026-11-09'), []);
  const moved = parseTasks([['법정의무교육(공지)', '1회', '2026-11-18', '사용']], ['T7']);
  assert.equal(occurrenceState(moved[0], { key: '1회', due: '2026-11-18' }, done).state, '확인 필요');
  assert.deepEqual(recurringLines({ tasks, history: new Map() }, cal, '2027-11-09'), []);
});

test('보고 누락 검사: 회차마다 업무명과 날짜가 있어야 함 (날짜 표기 여러 꼴)', () => {
  const rec = ['생각공장 주차권 구매: 2026-11-02 (D+7) — 완료 여부 확인 필요', '생각공장 주차권 구매: 2026-12-01 (D-22) — 완료 여부 확인 필요',
    '법정의무교육: 2026-11-01 (D+8) — 완료 여부 확인 필요', 'SGI보증보험: 2026-12-15 (D-36) — 완료 여부 확인 필요',
    '분기 점검: 날짜 계산 불가(주기 해석 불가: 분기) — 규칙 확인 필요', '차량 보험 BMW: 계약서(DB) 종료 2026-10-02 — Q열(비고) 재가입 완료 표시 없음, 확인 필요(실제 미갱신 단정 금지)'];
  const full = ['- 11/02 생각공장 주차권 구매 — 완료 여부 확인 필요', '- 2026-12-01 생각공장 주차권 구매 — 확인 필요', '- 1일: 법정의무교육 — 완료 여부 확인 필요 (11/01 기준, D+8)', '- 12월 15일 SGI보증보험 — 확인 필요', '- 분기 점검 — 규칙 확인 필요'];
  assert.deepEqual(recurringOmissions(rec, full), []);
  // 11/09 Antigravity: 지난 2건만 쓰고 미래 회차를 뺀 경우
  assert.deepEqual(recurringOmissions(rec, full.slice(0, 1).concat(full[2])), ['생각공장 주차권 구매 12/01', 'SGI보증보험 12/15', '분기 점검']);
  // 이름만 있고 날짜가 다르면 누락
  assert.deepEqual(recurringOmissions(rec.slice(3, 4), ['- 12/16 SGI보증보험']), ['SGI보증보험 12/15']);
  // 11/2를 12/1로 오인하지 않음
  assert.deepEqual(recurringOmissions(rec.slice(0, 1), ['- 11/20 생각공장 주차권 구매']), ['생각공장 주차권 구매 11/02']);
  assert.deepEqual(recurringOmissions([], ['- 해당 없음']), []);
});
