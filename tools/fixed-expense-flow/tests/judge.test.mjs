import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIVE_EXPECTED, STATUS, REPORT, dueDate, fixedPart, judgeFixed, parseDocRows, vendorsIn } from '../judge.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const runner = fs.readFileSync(path.join(REPO, 'integrations/local-dual-report/runner.mjs'), 'utf8');
// The real runner function against the real operating doc: no second copy of the rules.
const fixedSchedule = new Function('fs', 'path', 'REPO', runner.match(/function fixedSchedule\(date\) \{[\s\S]*?\n\}/)[0] + '\nreturn fixedSchedule;')(fs, path, REPO);
const docRows = parseDocRows(fs.readFileSync(path.join(REPO, 'docs/FIXED-EXPENSES-V1.md'), 'utf8'));
const sheetOk = { rows: Object.fromEntries(docRows.map(d => [d.row, d.vendor])) };
const agent = (inChat = [], inInternal = []) => ({ name: 'Codex', inChat, inInternal });
const report = (date, inChat, inInternal) => ({ date, slot: 'morning', agents: [agent(inChat, inInternal)] });
const run = o => judgeFixed({ fixedSchedule, docRows, windowDays: 7, sheet: sheetOk, today: '2026-11-06', ...o });
const item = (r, v) => r.items.find(i => i.vendor === v);
const nov6 = ['알고퀵', 'Sendy', '푸딩', '매장 전기료', 'Spotify']; // 11/06~11/13 예정 업체

test('1. 원본 23행 → 활성 22개 전수 대조, 이지화물은 비활성 이력', () => {
  assert.equal(docRows.length, 23);
  const r = run({ report: report('2026-11-06', nov6) });
  assert.equal(r.items.length, ACTIVE_EXPECTED);
  assert.deepEqual(r.inactive, ['이지화물']);
  assert.equal(new Set(r.items.map(i => i.vendor)).size, 22);
  assert.deepEqual(r.warnings, []);
});

test('2. 베네피아·코웨이: 보고에 없어도 예정일 전이면 정상 제외와 이유', () => {
  const r = run({ report: report('2026-11-06', nov6) });
  for (const v of ['베네피아', '코웨이(본사)', '코웨이(양주)']) {
    assert.equal(item(r, v).status, STATUS.ok);
    assert.equal(item(r, v).report, REPORT.excluded);
  }
  assert.match(item(r, '베네피아').reason, /다음 예정일 11\/15/);
  assert.match(item(r, '코웨이(본사)').reason, /다음 예정일 11\/20/);
});

test('3. 보고 대상인데 보고에 없으면 확인 필요·누락 의심 (내부 근거 언급만으로 정상 처리 안 함)', () => {
  const r = run({ report: report('2026-11-06', nov6.slice(1), ['알고퀵']) });
  assert.equal(item(r, '알고퀵').status, STATUS.check);
  assert.equal(item(r, '알고퀵').report, REPORT.missing);
  assert.match(item(r, '알고퀵').reason, /내부 근거에만 언급/);
  const none = run({ report: report('2026-11-06', nov6.slice(1)) });
  assert.match(item(none, '알고퀵').reason, /제외 근거 없음/);
});

test('4. 원본 접근 실패·이름 불일치는 확인 필요 (보고가 깨끗해도)', () => {
  const r = run({ report: report('2026-11-06', nov6), sheet: { error: 'PERMISSION_DENIED' } });
  assert.equal(r.summary.check, 22);
  assert.match(item(r, '베네피아').reason, /PERMISSION_DENIED/);
  const moved = run({ report: report('2026-11-06', nov6), sheet: { rows: { ...sheetOk.rows, 15: '다른 업체' } } });
  assert.equal(item(moved, '베네피아').status, STATUS.check);
  const failed = run({ report: report('2026-11-06', nov6), sourceOk: false });
  assert.match(item(failed, 'KT').reason, /시트 읽기 실패/);
});

test('5. 미점검은 미검증 — 원본 연결만으로 정상이 되지 않음', () => {
  const r = run({ report: null });
  assert.equal(r.summary.unverified, 22);
  assert.equal(item(r, 'KT').report, REPORT.unknown);
  assert.equal(item(r, 'KT').source.state, STATUS.ok);
  const noSheet = run({ report: report('2026-11-06', nov6), sheet: null });
  assert.equal(item(noSheet, 'KT').status, STATUS.unverified);
  assert.equal(run({ fixedSchedule: null, report: null }).summary.unverified, 23); // 일정 계산 불가면 비활성도 구분 못 함
});

test('6. 월 경계·격월·회차 미확정·주말: #9의 fixedSchedule 기준', () => {
  // 수유 수도요금: 11/30 다음은 12월을 건너뛰고 1/31
  assert.equal(dueDate(fixedSchedule, '수유 수도요금', '2026-11-06'), '2026-11-30');
  assert.equal(dueDate(fixedSchedule, '수유 수도요금', '2026-12-01'), '2027-01-31');
  const r = run({ report: report('2026-11-06', nov6) });
  assert.equal(item(r, '수유 수도요금').report, REPORT.excluded);
  // 매장 안전관리자·양주 수도요금: 회차 미확정은 정상 제외로 두지 않음
  for (const v of ['매장 안전관리자', '양주 수도요금']) {
    assert.equal(item(r, v).status, STATUS.check);
    assert.match(item(r, v).reason, /회차 미확정/);
  }
  // 월말 창이 다음 달로 넘어가면 다음 달 1일 예정 업체가 대상
  const eom = run({ report: report('2026-11-27', []) });
  assert.equal(item(eom, '커피마켓어스').report, REPORT.missing);
  assert.match(item(eom, '커피마켓어스').reason, /12\/01/);
  // 11/15은 일요일: 날짜를 옮기지 않고 표시만
  assert.match(item(r, '베네피아').notes.join(), /주말·공휴일/);
  assert.equal(item(r, '베네피아').target, '11/15');
});

test('7. 정상+확인 필요+미검증 = 관리대상 22 불변식', () => {
  const cases = [
    { report: report('2026-11-06', nov6) }, { report: null }, { report: report('2026-11-27', []) },
    { report: report('2026-11-06', nov6), sheet: null }, { report: report('2026-11-06', []), sheet: { error: 'x' } }
  ];
  for (const c of cases) {
    const { summary: s } = run(c);
    assert.equal(s.ok + s.check + s.unverified, s.total);
    assert.equal(s.total, 22);
  }
});

test('8. 원본 변경 0: 도구는 시트 쓰기 호출·발송 코드가 없고 이름 열만 읽는다', () => {
  for (const f of ['build-evidence.mjs', 'judge.mjs', 'index.html']) {
    const src = fs.readFileSync(path.join(HERE, '..', f), 'utf8');
    assert.doesNotMatch(src, /values\.(update|append|clear|batchUpdate)|spreadsheets\.batchUpdate|method:\s*'POST'|webhookUrl|fetch\(/, f);
  }
  const build = fs.readFileSync(path.join(HERE, '..', 'build-evidence.mjs'), 'utf8');
  assert.deepEqual([...new Set(build.match(/range: "[^"]+"/g))], [`range: "'JP매월 지출'!D14:D36"`]);
});

test('9. 다른 분야에 이름만 나온 업체는 포함이 아님 (생각공장 주차권)', () => {
  const chat = ['내용 요약 및 추천', '1. 고정비', '■ 내용: 생각공장 주차권 D+5', '--------------------', '오늘 완료', '- 없음', '--------------------', '오늘 남은 일', '[고정비]', '- 10일 납부: 알고퀵', '[정기 업무]', '- 생각공장 주차권 구매 (D+5)'].join('\n');
  assert.deepEqual(vendorsIn(fixedPart(chat), ['알고퀵', '생각공장']), ['알고퀵']);
});

test('10. 지역 없는 코웨이는 어느 쪽 포함으로도 판정하지 않음', () => {
  assert.deepEqual(vendorsIn('코웨이 렌탈료', ['코웨이(본사)', '코웨이(양주)']), []);
  assert.deepEqual(vendorsIn('코웨이(본사) 렌탈료', ['코웨이(본사)', '코웨이(양주)']), ['코웨이(본사)']);
  assert.deepEqual(vendorsIn('센디 운임', ['Sendy']), ['Sendy']);
});
