import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HISTORY_HEADER, ID_KEY, OVERDUE_DAYS, WINDOW, makeCalendar, occurrences, parseHistory, parseLead, parseTasks, readRecurringSource, recurringLines, recurringOmissions, reportWindow } from '../recurring.mjs';
import { STATUS, REPORT } from '../../../tools/fixed-expense-flow/judge.mjs';
import { judgeRecurring } from '../../../tools/fixed-expense-flow/domains.mjs';

// 일일 보고 표시 범위(E열 알림 시작 ~ 기한 당일 ~ D+7)와 계산 범위(WINDOW)의 분리. 업무명은 가짜다.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const calendar = makeCalendar({ days: ['2026-12-25', '2027-01-01', '2026-01-01'], names: {} });
const lines = (tasks, today, history = new Map()) => recurringLines({ tasks, history }, calendar, today);
const has = (ls, s) => ls.some(l => l.includes(s));
// 같은 날짜 기한(12-15)에 알림 시작이 다른 두 업무.
const two = parseTasks([['가 업무', '매년', '12-15', '사용', 'D-3'], ['나 업무', '매년', '12-15', '사용', 'D-14']], ['A', 'B']);

test('E열 알림 시작: D-N만 받고 공란·오류·계산 범위 초과는 미설정으로 남김', () => {
  assert.deepEqual(parseLead('D-7'), { days: 7 });
  assert.deepEqual(parseLead(' d - 14 '), { days: 14 });
  assert.deepEqual(parseLead('D-0'), { days: 0 });
  assert.deepEqual(parseLead(`D-${WINDOW.after}`), { days: WINDOW.after });
  assert.equal(parseLead('').error, '미설정');
  for (const bad of ['7', '일주일', 'D+3', 'D-', `D-${WINDOW.after + 1}`]) assert.ok(parseLead(bad).error, bad);
  assert.equal(OVERDUE_DAYS, 7);
});

test('업무별 알림 시작이 다르면 각자 그 기간부터 기한 당일까지만 보고', () => {
  assert.deepEqual(lines(two, '2026-11-30'), []); // D-15: 둘 다 아직
  assert.deepEqual(lines(two, '2026-12-01'), ['나 업무: 2026-12-15 (D-14) — 완료 여부 확인 필요']);
  assert.deepEqual(lines(two, '2026-12-11'), ['나 업무: 2026-12-15 (D-4) — 완료 여부 확인 필요']);
  assert.deepEqual(lines(two, '2026-12-12'), ['가 업무: 2026-12-15 (D-3) — 완료 여부 확인 필요', '나 업무: 2026-12-15 (D-3) — 완료 여부 확인 필요']);
  assert.equal(lines(two, '2026-12-15').length, 2); // 기한 당일
});

test('기한 경과: D+1~D+7은 오전·오후 계속 보고, D+8부터 일일 보고에서 빠지지만 연결현황에는 미확인으로 남음', () => {
  assert.deepEqual(lines(two, '2026-12-16'), ['가 업무: 2026-12-15 (D+1) — 완료 여부 확인 필요', '나 업무: 2026-12-15 (D+1) — 완료 여부 확인 필요']);
  assert.equal(lines(two, '2026-12-22').length, 2); // D+7
  assert.deepEqual(lines(two, '2026-12-23'), []); // D+8
  const r = judgeRecurring({ tasks: two, history: new Map(), historyState: '연결', calendar }, [], { report: null, today: '2026-12-23' });
  const late = r.items.filter(i => i.target === '2026-12-15');
  assert.equal(late.length, 2);
  for (const i of late) {
    assert.equal(i.status, STATUS.check);
    assert.equal(i.report, REPORT.excluded);
    assert.match(i.reason, /D\+8 — 기한 D\+7 경과로 일일 보고 제외 — 처리 기록 없음/);
  }
  // 알림 시작 전 회차는 연결현황에서 정상 제외(아직 알릴 때가 아님).
  const early = judgeRecurring({ tasks: two, history: new Map(), historyState: '연결', calendar }, [], { report: null, today: '2026-12-05' });
  const ga = early.items.find(i => i.vendor === '가 업무 · 2026');
  assert.equal(ga.status, STATUS.ok);
  assert.match(ga.reason, /알림 시작 D-3 전/);
});

test('완료·보류 기록이 있는 회차는 기간 안이라도 빠지고, 기록은 그대로 읽힘', () => {
  const hist = parseHistory([HISTORY_HEADER, ['A', '2026', '완료', 'x', '근거', '2026-12-15'], ['B', '2026', '보류', 'x', '사유', '2026-12-15']]);
  assert.deepEqual(lines(two, '2026-12-14', hist), []);
  assert.deepEqual(lines(two, '2026-12-18', hist), []);
  assert.equal(hist.size, 2);
});

test('월·연도 교차와 공휴일: 1월 첫 영업일(1/1 휴일 → 1/4)이 12월부터 알림 시작', () => {
  const t = parseTasks([['주차권', '매월', '첫 영업일', '', 'D-7']], ['P']);
  assert.ok(occurrences(t[0].rule, calendar, '2026-12-27').some(o => o.due === '2027-01-04')); // 계산 범위는 그대로
  assert.equal(has(lines(t, '2026-12-27'), '2027-01-04'), false); // D-8
  // 12/01 회차는 D+27이라 일일 보고에는 없고 1/4 회차만 D-7로 나옴
  assert.deepEqual(lines(t, '2026-12-28'), ['주차권: 2027-01-04 (D-7) — 완료 여부 확인 필요']);
  assert.ok(has(lines(t, '2026-12-08'), '2026-12-01 (D+7)'));
});

test('단발 1회 업무: 알림 시작부터 D+7까지, 완료·보류 후 빠지고 다음 해에 다시 생기지 않음', () => {
  const once = parseTasks([['공지 업무', '1회', '2026-11-16', '사용', 'D-5']], ['O']);
  assert.deepEqual(lines(once, '2026-11-10'), []);
  assert.deepEqual(lines(once, '2026-11-11'), ['공지 업무: 2026-11-16 (D-5) — 완료 여부 확인 필요']);
  assert.ok(has(lines(once, '2026-11-23'), 'D+7'));
  assert.deepEqual(lines(once, '2026-11-24'), []);
  const held = parseHistory([HISTORY_HEADER, ['O', '1회', '보류', 'x', '연기', '2026-11-16']]);
  assert.deepEqual(lines(once, '2026-11-16', held), []);
  assert.deepEqual(lines(once, '2027-11-11'), []);
});

test('E열 없는 옛 시트·공란·잘못된 값: 임의 기간 없이 업무별 입력 필요 한 줄, 기한 당일·경과 회차는 그대로 보고', () => {
  const old = parseTasks([['옛 업무', '매년', '12-15', '사용']], ['X']); // A:D만
  assert.equal(old[0].lead.error, '미설정');
  assert.deepEqual(lines(old, '2026-12-10'), ['옛 업무: 알림 시작(E열) 미설정 — 입력 필요, 다음 회차 2026-12-15 (D-5)']);
  assert.deepEqual(lines(old, '2026-10-01'), ['옛 업무: 알림 시작(E열) 미설정 — 입력 필요']); // 계산 범위 안 회차 없어도 사라지지 않음
  assert.deepEqual(lines(old, '2026-12-17'), ['옛 업무: 2026-12-15 (D+2) — 완료 여부 확인 필요', '옛 업무: 알림 시작(E열) 미설정 — 입력 필요']);
  const bad = parseTasks([['틀린 업무', '매년', '12-15', '사용', '일주일']], ['Y']);
  assert.deepEqual(lines(bad, '2026-12-10'), ['틀린 업무: 알림 시작(E열) 형식 오류 — 입력 필요, 다음 회차 2026-12-15 (D-5)']);
  assert.equal(parseTasks([['긴 업무', '매년', '12-15', '사용', 'D-90']], ['Z'])[0].lead.error, '계산 범위 D-60 초과');
  // 규칙 자체가 틀린 행은 규칙 확인 줄 하나에 E열 상태를 붙인다.
  const broken = parseTasks([['규칙 없는 업무', '', '2026-11-16', '사용']], [null]);
  assert.deepEqual(lines(broken, '2026-11-09'), ['규칙 없는 업무: 날짜 계산 불가(주기 미입력 — 한 번만 할 업무는 B열에 1회) — 규칙 확인 필요 / 알림 시작(E열) 미설정']);
  // 중지 행은 E열이 없어도 알리지 않음. A~D가 비고 E만 남은 행은 업무가 아님.
  assert.deepEqual(lines(parseTasks([['멈춘 업무', '매년', '12-15', '중지'], ['', '', '', '', 'D-7']]), '2026-12-10'), []);
});

test('업무ID 미지정 행도 표시 범위 안에서는 보고되고 연결현황은 확인 필요', () => {
  const t = parseTasks([['새 업무', '매년', '12-15', '사용', 'D-7']], [null]);
  assert.deepEqual(lines(t, '2026-12-08'), ['새 업무: 2026-12-15 (D-7) — 완료 여부 확인 필요']);
  const r = judgeRecurring({ tasks: t, history: new Map(), historyState: '연결', calendar }, [], { report: null, today: '2026-12-08' });
  assert.equal(r.items[0].status, STATUS.check);
  assert.match(r.items[0].reason, /업무ID 미지정/);
});

test('누락 검사는 표시 범위의 줄만 요구: D-60 미래 회차·D+8 회차를 요구하지 않고, 미설정 줄은 안내 뜻까지 있어야 함', () => {
  const t = parseTasks([['주차권', '매월', '첫 영업일', '', 'D-3'], ['옛 업무', '매년', '12-15']], ['P', 'X']);
  const rec = lines(t, '2026-11-09'); // 11/02는 D+7, 12/01·01/04는 표시 범위 밖
  assert.deepEqual(rec, ['주차권: 2026-11-02 (D+7) — 완료 여부 확인 필요', '옛 업무: 알림 시작(E열) 미설정 — 입력 필요, 다음 회차 2026-12-15 (D-36)']);
  assert.deepEqual(recurringOmissions(rec, ['- 11/02 주차권 — 완료 여부 확인 필요', '- 옛 업무: 알림 시작 미설정, 입력 필요']), []);
  assert.deepEqual(recurringOmissions(rec, ['- 11/02 주차권']), ['옛 업무 알림 시작(E열) 안내']);
  assert.deepEqual(recurringOmissions(lines(t, '2026-11-10'), ['- 옛 업무 알림 시작 입력 필요']), []); // 11/02는 D+8이라 요구하지 않음
});

test('E열 안내는 같은 업무의 회차 줄로 대신할 수 없음 (Codex F2)', () => {
  const old = parseTasks([['옛 업무', '매년', '12-15', '사용']], ['X']);
  const rec = lines(old, '2026-12-17'); // D+2 회차 줄 + E열 안내 줄
  assert.equal(rec.length, 2);
  assert.deepEqual(recurringOmissions(rec, ['- 12/15 옛 업무 — 완료 여부 확인 필요']), ['옛 업무 알림 시작(E열) 안내']);
  assert.deepEqual(recurringOmissions(rec, ['- 12/15 옛 업무 — 완료 여부 확인 필요', '- 옛 업무 — 알림 시작(E열) 미설정, 입력 필요']), []);
  assert.deepEqual(recurringOmissions(rec, ['- 12/15 옛 업무 — 완료 여부 확인 필요, 알림 시작(E열) 미설정·입력 필요']), []); // 한 줄에 둘 다 있으면 충분
});

test('E열 입력 원문은 보고에 싣지 않고, 안내 줄은 실행기의 본문 금지어 검사에 걸리지 않음 (Codex F3)', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'runner.mjs'), 'utf8');
  // validate()의 본문 전체 검사(`if (/…/.test(chat))`)를 실행기 원문에서 그대로 가져온다.
  const bans = [...src.matchAll(/if \(\/(.+?)\/\.test\(chat\)\)/g)].map(m => new RegExp(m[1]));
  assert.ok(bans.length >= 4);
  for (const raw of ['검침', '미납', '이지화물', '생각공장 재확인', 'D+3', '']) {
    const t = parseTasks([['가 업무', '매년', '12-15', '사용', raw]], ['A']);
    for (const l of lines(t, '2026-12-10')) {
      assert.equal(!!raw && l.includes(raw), false, l);
      for (const b of bans) assert.equal(b.test(l), false, `${b} ${l}`);
    }
  }
});

test('완료·보류된 단발 업무는 E열이 없어도 더 안내하지 않음, 반복 업무는 계속 안내', () => {
  const once = parseTasks([['공지 업무', '1회', '2026-11-16', '사용']], ['O']);
  assert.deepEqual(lines(once, '2026-11-10'), ['공지 업무: 알림 시작(E열) 미설정 — 입력 필요, 다음 회차 2026-11-16 (D-6)']);
  const done = parseHistory([HISTORY_HEADER, ['O', '1회', '완료', 'x', '근거', '2026-11-16']]);
  assert.deepEqual(lines(once, '2026-11-10', done), []);
  assert.deepEqual(lines(once, '2027-03-01'), []); // 계산 범위 밖으로 지난 단발 업무
  const yearly = parseTasks([['연 업무', '매년', '12-15', '사용']], ['Y']);
  const doneYear = parseHistory([HISTORY_HEADER, ['Y', '2026', '완료', 'x', '근거', '2026-12-15']]);
  assert.deepEqual(lines(yearly, '2026-12-10', doneYear), ['연 업무: 알림 시작(E열) 미설정 — 입력 필요']);
});

test('원본 조회 실패: 실행기는 "해당 없음" 대신 확인 불가 줄을 넘기고 누락 검사가 그 줄을 요구', () => {
  const runner = fs.readFileSync(path.join(HERE, '..', 'runner.mjs'), 'utf8');
  const line = /recurring\.push\('(정기 업무 원본: 확인 불가[^']*)'\)/.exec(runner)?.[1];
  assert.ok(line, 'runner pushes a 확인 불가 line on read failure');
  assert.deepEqual(recurringOmissions([line], ['- 해당 없음']), ['정기 업무 원본']);
  assert.deepEqual(recurringOmissions([line], ['- 정기 업무 원본: 확인 불가(조회 실패)']), []);
  // Codex F1: 업무명만 맞추고 해당 없음으로 쓰면 통과하지 않는다.
  assert.deepEqual(recurringOmissions([line], ['- 정기 업무 원본: 해당 없음']), ['정기 업무 원본']);
  assert.deepEqual(recurringOmissions([line], ['- 정기 업무 원본: 확인 불가, 해당 없음']), ['정기 업무 원본']);
  assert.ok(runner.includes('"확인 불가" 줄은 "해당 없음"으로 바꾸지 않는다'));
});

test('원본 읽기: 업무 탭 A:E를 읽고, E열 없는 행은 미설정', async () => {
  const requested = [];
  const api = {
    get: async p => {
      if (!p.ranges) return { data: { properties: { title: '[MS] 김현호' }, sheets: [{ properties: { title: '업무', sheetId: 7 } }, { properties: { title: 'Master_Sheet', sheetId: 8 } }] } };
      requested.push(...p.ranges);
      const v = s => ({ formattedValue: s });
      return { data: { sheets: [{ data: [{ rowData: [{ values: ['가', '매년', '12-15', '사용', 'D-3'].map(v) }, { values: ['나', '매년', '12-15', '사용'].map(v) }],
        rowMetadata: [{ developerMetadata: [{ metadataKey: ID_KEY, metadataValue: 'A' }] }, { developerMetadata: [{ metadataKey: ID_KEY, metadataValue: 'B' }] }] }] }] } };
    },
    values: { get: async () => ({ data: { values: [['[MS] 김현호', '', '업무']] } }) }
  };
  const s = await readRecurringSource(api, 'id');
  assert.deepEqual(requested, ["'업무'!A2:E200"]);
  assert.deepEqual(s.tasks.map(t => [t.id, t.lead]), [['A', { days: 3 }], ['B', { error: '미설정' }]]);
});

test('reportWindow는 계산 결과를 바꾸지 않는 판정만 함', () => {
  const t = two[0];
  assert.deepEqual(reportWindow(t, { d: 0 }), { show: true });
  assert.deepEqual(reportWindow(t, { d: -7 }), { show: true });
  assert.equal(reportWindow(t, { d: -8 }).show, false);
  assert.deepEqual(reportWindow(t, { d: 3 }), { show: true });
  assert.equal(reportWindow(t, { d: 4 }).show, false);
  assert.equal(reportWindow({}, { d: 1 }).noLead, true); // lead 없는 업무 객체(옛 호출자)도 미설정으로
});
