import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATUS, REPORT, fieldPart } from '../judge.mjs';
import { PARTIAL, judgeChat, judgeContracts, judgeLicenses, judgeRecurring, judgeWelfare, keyIn, parseContracts, parseLicenses, parseTasks, parseVehicles, parseWelfare, unconnectedIn } from '../domains.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const buckets = [['D-7', 0, 7], ['D-30', 8, 30], ['D-60', 31, 60]];
const today = '2026-11-06';
const agent = (name, fields, extra = {}) => ({ name, fields, inChat: [], inInternal: [], ...extra });
const report = (...agents) => ({ date: today, slot: 'morning', agents });
const both = fields => report(agent('Codex', fields), agent('Antigravity', fields));
const item = (d, v) => d.items.find(i => i.vendor.startsWith(v));
const invariant = d => assert.equal(d.summary.ok + d.summary.check + d.summary.unverified, d.summary.total);
const contracts = (...rows) => ({ rows: rows.map((r, i) => ({ row: 6 + i, what: '', ...r })), ended: 0 });

test('계약서: 같은 구간 줄에 이름이 있으면 정상, 없으면 누락 의심', () => {
  const data = contracts({ name: '(주)페트라온', end: '2026-12-01' }, { name: '먼곳', end: '2027-06-01' });
  const ok = judgeContracts(data, { report: both({ '[계약서]': '- D-30 1건 ((주)페트라온)' }), buckets, today });
  assert.equal(item(ok, '(주)페트라온').status, STATUS.ok);
  assert.equal(item(ok, '먼곳').report, REPORT.excluded);
  assert.equal(item(ok, '먼곳').status, STATUS.ok);
  const gone = judgeContracts(data, { report: both({ '[계약서]': '- 해당 없음' }), buckets, today });
  assert.equal(item(gone, '(주)페트라온').status, STATUS.check);
  assert.equal(item(gone, '(주)페트라온').report, REPORT.missing);
  invariant(gone);
});

test('계약서: 이름 없이 건수만 맞으면 정상이 아니라 미검증', () => {
  const data = contracts({ name: '갑', end: '2026-12-25' }, { name: '을', end: '2026-12-26' }, { name: '병', end: '2026-12-27' });
  const r = judgeContracts(data, { report: both({ '[계약서]': '- D-60 3건 (갑 외 2건)' }), buckets, today });
  assert.equal(item(r, '갑').status, STATUS.ok);
  assert.equal(item(r, '을').status, STATUS.unverified);
  assert.equal(item(r, '을').report, PARTIAL);
  const wrongCount = judgeContracts(data, { report: both({ '[계약서]': '- D-60 2건 (갑 외 1건)' }), buckets, today });
  assert.equal(item(wrongCount, '을').status, STATUS.check);
});

test('계약서: 다른 구간에 표시된 이름, 같은 이름 여럿, 한쪽 보고만 포함은 정상이 아님', () => {
  const one = contracts({ name: '갑', end: '2026-12-01' });
  assert.equal(item(judgeContracts(one, { report: both({ '[계약서]': '- D-60 1건 (갑)' }), buckets, today }), '갑').status, STATUS.check);
  const twins = contracts({ name: '현대해상', what: '양주 화재', end: '2026-12-25' }, { name: '현대해상', what: '성수 화재', end: '2026-12-26' });
  const t = judgeContracts(twins, { report: both({ '[계약서]': '- D-60 2건 (현대해상 2건)' }), buckets, today });
  assert.equal(t.items[0].status, STATUS.unverified);
  const side = report(agent('Codex', { '[계약서]': '- D-30 1건 (갑)' }), agent('Antigravity', { '[계약서]': '- 해당 없음' }));
  const s = item(judgeContracts(one, { report: side, buckets, today }), '갑');
  assert.equal(s.status, STATUS.check);
  assert.match(s.reason, /Codex 보고에만 있고 Antigravity 보고에 없음/);
});

test('계약서·라이센스: 종료일 경과·날짜 아님은 정상 제외로 두지 않음', () => {
  const d = contracts({ name: '지난곳', end: '2026-10-01' }, { name: '기한없음', end: '해지 시까지' });
  const r = judgeContracts(d, { report: both({ '[계약서]': '' }), buckets, today });
  assert.equal(item(r, '지난곳').status, STATUS.check);
  assert.equal(item(r, '기한없음').status, STATUS.unverified);
  assert.equal(item(judgeLicenses({ rows: [{ row: 5, name: 'GPT', what: '', end: '' }], ended: 0 }, { report: both({}), buckets, today }), 'GPT').status, STATUS.unverified);
});

test('계약서: 한 줄에 구간이 섞이면 정상이 아니고, D-구간 밖 행은 내용을 내보내지 않음', () => {
  const data = contracts({ name: '을', what: '비공개 내용', end: '2026-11-10' }, { name: '먼곳', what: '비공개 내용', end: '2027-06-01' });
  const r = judgeContracts(data, { report: both({ '[계약서]': '- D-30 1건(갑), D-7 1건(을)' }), buckets, today });
  assert.equal(item(r, '을').status, STATUS.unverified);
  assert.equal(item(r, '먼곳').vendor, '먼곳');
  assert.equal(JSON.stringify(item(r, '먼곳')).includes('비공개'), false);
  const raw = contracts({ name: '원문', end: '김철수와 협의' });
  assert.equal(JSON.stringify(judgeContracts(raw, { report: both({}), buckets, today })).includes('김철수'), false);
});

test('달력에 없는 날짜는 정상이 되지 않음', () => {
  assert.equal(item(judgeContracts(contracts({ name: '갑', end: '2026-99-01' }), { report: both({ '[계약서]': '- D-30 1건 (갑)' }), buckets, today }), '갑').status, STATUS.unverified);
  assert.equal(judgeRecurring(parseTasks([['h'], ['2026-02-31', '교육', '', '']]), [], { report: both({ '[정기 업무]': '- 교육' }), today }).items[0].status, STATUS.check);
  assert.deepEqual(parseWelfare([['1']], [['2026-99-01']]), { counts: {}, undated: 1 });
});

test('부분 문자열·다른 분야 언급은 포함 근거가 아님', () => {
  assert.equal(keyIn('- D-30 1건 (KT텔레캅)', 'KT'), false);
  assert.equal(keyIn('- D-30 1건 (SKT)', 'KT'), false);
  assert.equal(keyIn('- D-30 1건 (KT·콜마)', 'KT'), true);
  assert.equal(keyIn('- D-30 1건 (한국콜마)', '콜마'), false);
  assert.equal(keyIn('- D-30 1건 (페트라온의 계약)', '(주)페트라온'), true);
  const chat = ['오늘 남은 일', '[라이센스]', '- D-30 1건 (채널톡)', '[계약서]', '- 해당 없음'].join('\n');
  assert.equal(fieldPart(chat, '[계약서]'), '- 해당 없음');
  const r = judgeContracts(contracts({ name: '채널톡', end: '2026-12-01' }), { report: both({ '[계약서]': fieldPart(chat, '[계약서]') }), buckets, today });
  assert.equal(r.items[0].status, STATUS.check);
});

test('읽지 못한 보고·보고 없음은 미검증, 시트 읽기 실패는 확인 필요', () => {
  const data = contracts({ name: '갑', end: '2026-12-01' }, { name: '먼곳', end: '2027-06-01' });
  const none = judgeContracts(data, { report: null, buckets, today });
  assert.equal(item(none, '갑').status, STATUS.unverified);
  const half = report(agent('Codex', { '[계약서]': '- D-30 1건 (갑)' }), agent('Antigravity', {}, { unread: true }));
  const u = judgeContracts(data, { report: half, buckets, today });
  assert.equal(item(u, '갑').status, STATUS.unverified);
  assert.match(item(u, '먼곳').reason, /Antigravity 보고 파일을 읽지 못함/);
  assert.equal(item(judgeContracts(data, { report: both({}), sourceOk: false, buckets, today }), '먼곳').status, STATUS.check);
});

test('원본을 못 읽으면 대상 수를 만들지 않음', () => {
  const failed = judgeContracts({ error: 'PERMISSION_DENIED' }, { report: both({}), buckets, today });
  assert.equal(failed.summary.total, 1);
  assert.equal(failed.items[0].status, STATUS.check);
  assert.match(failed.items[0].reason, /PERMISSION_DENIED/);
  assert.equal(judgeWelfare(undefined, { report: both({}), imminentDays: 7, today }).items[0].status, STATUS.unverified);
  const task = judgeRecurring({ error: 'x' }, [], { report: both({}), today });
  assert.equal(task.summary.check, 1);
  const noCar = judgeRecurring([], { error: 'x' }, { report: both({}), today });
  assert.equal(noCar.items[0].status, STATUS.check);
});

test('복지: D-7 이내만 대상, 날짜와 인원수가 맞아야 정상, 7일 임박과 다른 구간을 섞지 않음', () => {
  const data = { counts: { '2026-11-11': 1, '2026-12-01': 3, '2026-10-01': 5 }, undated: 0 };
  const r = judgeWelfare(data, { report: both({ '[복지]': '- 11/11 복지포인트 적용: 1명 (D-5)' }), imminentDays: 7, today });
  assert.equal(r.summary.total, 2);
  assert.equal(item(r, '11/11').status, STATUS.ok);
  assert.equal(item(r, '12/01').report, REPORT.excluded);
  assert.match(r.inactiveNote, /5명/);
  assert.equal(judgeWelfare({ counts: { '2027-01-04': 1 }, undated: 0 }, { report: both({}), imminentDays: 7, today }).items[0].vendor, '2027-01-04 적용 1명');
  assert.equal(item(judgeWelfare(data, { report: both({ '[복지]': '- 11/11 적용: 2명' }), imminentDays: 7, today }), '11/11').status, STATUS.check);
  assert.equal(item(judgeWelfare(data, { report: both({ '[복지]': '- 해당 없음' }), imminentDays: 7, today }), '11/11').report, REPORT.missing);
  assert.equal(item(judgeWelfare(data, { report: both({ '[복지]': '- 12/11 적용: 1명' }), imminentDays: 7, today }), '11/11').status, STATUS.check);
  const mixed = judgeWelfare(data, { report: both({ '[복지]': '- 11/11 적용 2명, 11/12 적용 1명' }), imminentDays: 7, today });
  assert.equal(item(mixed, '11/11').status, STATUS.check);
  assert.equal(item(judgeWelfare({ counts: {}, undated: 2 }, { report: both({}), imminentDays: 7, today }), '적용일 없는').status, STATUS.check);
});

test('정기 업무: 날짜·완료 구분, 같은 이름은 날짜로 특정', () => {
  const tasks = parseTasks([['날짜', '업무', '내용', '완료'],
    ['2026-11-01', '법정의무교육', '비밀 내용', ''], ['2026-12-01', 'SGI보증보험 가입', '', 'FALSE'], ['2027-03-01', '먼 업무', '', ''],
    ['2026-09-01', '오래된 업무', '', ''], ['2026-11-02', '끝난 업무', '', 'TRUE'], ['', '날짜없는 업무', '', '']]);
  const r = judgeRecurring(tasks, [], { report: both({ '[정기 업무]': '- 11/01 법정의무교육 (D+5)' }), today });
  assert.equal(item(r, '법정의무교육').status, STATUS.ok);
  assert.equal(item(r, 'SGI').status, STATUS.check);
  assert.equal(item(r, '먼 업무').report, REPORT.excluded);
  assert.equal(item(r, '오래된 업무').status, STATUS.check);
  assert.equal(item(r, '날짜없는').status, STATUS.check);
  assert.equal(item(r, '끝난 업무'), undefined);
  assert.match(r.inactiveNote, /완료 표시 1건/);
  assert.equal(JSON.stringify(r).includes('비밀 내용'), false);
  const elsewhere = judgeRecurring(tasks, [], { report: both({ '[정기 업무]': '- 12/25 법정의무교육' }), today });
  assert.equal(item(elsewhere, '법정의무교육').status, STATUS.unverified);
  const dup = parseTasks([['h'], ['2026-11-01', '주차권', '', ''], ['2026-12-01', '주차권', '', '']]);
  assert.equal(judgeRecurring(dup, [], { report: both({ '[정기 업무]': '- 주차권 확인' }), today }).items[0].status, STATUS.unverified);
});

test('차량 보험: Q열 재가입 완료만 정상 제외, 번호판·Q열 원문은 결과에 없음', () => {
  const v = parseVehicles([['보험료'], ['보험료'], ['기타']], [['차량보험 12가3456 벤츠 홍길동'], ['차량보험 BMW 99나9999'], ['차량보험']], [['2026-10-01'], ['2026-10-02'], ['2026-10-03']], [['재가입 완료 메모'], ['']]);
  assert.equal(v.length, 2);
  const r = judgeRecurring([], v, { report: both({ '[정기 업무]': '- 해당 없음' }), today });
  assert.equal(item(r, '차량 보험 벤츠').report, REPORT.excluded);
  assert.equal(item(r, '차량 보험 BMW').status, STATUS.check);
  const text = JSON.stringify(r);
  for (const leak of ['12가3456', '홍길동', '99나9999', '메모']) assert.equal(text.includes(leak), false, leak);
  assert.equal(item(judgeRecurring([], v, { report: both({ '[정기 업무]': '- 차량 보험 BMW: 확인 필요' }), today }), '차량 보험 BMW').status, STATUS.ok);
  assert.equal(item(judgeRecurring([], v, { report: both({ '[정기 업무]': '- BMW 화재 보험 확인' }), today }), '차량 보험 BMW').status, STATUS.check);
  const unknownCar = parseVehicles([['보험료']], [['차량보험 트럭']], [['2026-10-01']], [['']]);
  assert.equal(judgeRecurring([], unknownCar, { report: both({ '[정기 업무]': '- 차량 보험 확인' }), today }).items[0].status, STATUS.unverified);
});

test('기타 업무: 조회가 성공해도 메시지별 정상을 만들지 않음', () => {
  const r = judgeChat({ spaces: 2, cursor: '11. 06. 09:30', failed: [] }, { report: both({ '[기타 업무]': '- 사내 원문이 들어간 줄' }) });
  assert.equal(r.summary.total, 2);
  assert.equal(r.summary.ok, 0);
  assert.equal(r.summary.unverified, 2);
  assert.equal(JSON.stringify(r).includes('사내 원문'), false);
  assert.match(r.items[0].details[1][1], /Codex 1줄/);
  assert.equal(judgeChat({ spaces: 2, cursor: 'x', failed: [1] }, { report: both({}) }).items[1].status, STATUS.check);
  assert.equal(judgeChat({ spaces: 1, cursor: null, failed: [] }, { report: both({}) }).items[0].status, STATUS.check);
  assert.equal(judgeChat({ spaces: 1, cursor: 'x', failed: [] }, { report: null }).items[0].status, STATUS.unverified);
  assert.equal(judgeChat({ spaces: 0, cursor: null, failed: [] }, { report: null }).summary.ok, 0);
});

test('파서는 필요한 열만 남긴다: 금액·연락처·이름 없음', () => {
  const row = ['1', '분류', '업체', '내용 010-1234-5678', '담당자이름', '12,345,000', 'x', '2026-12-01', '25', 'a', 'b', 'c', 'TRUE', 'FALSE'];
  const c = JSON.stringify(parseContracts([row]));
  for (const leak of ['담당자이름', '12,345,000', '010-1234-5678']) assert.equal(c.includes(leak), false, leak);
  assert.equal(parseContracts([{ ...row, 13: 'TRUE' }]).ended, 1);
  for (const what of ['차량보험 12가3456', '청소 용역 김철수 대리', '월 300만원']) assert.equal(parseContracts([['', '', '업체', what]]).rows[0].what, '내용 생략');
  assert.equal(parseContracts([['', '', '업체', '양주 D창고 화재보험']]).rows[0].what, '양주 D창고 화재보험');
  const l = parseLicenses([['다우오피스', '990,000', '2026-12-25', '49'], ['사용 만료'], ['옛것', '', '2026-01-01', '']]);
  assert.equal(l.rows.length, 1);
  assert.equal(l.ended, 1);
  assert.equal(JSON.stringify(l).includes('990,000'), false);
  const w = parseWelfare([['1'], ['2'], ['메모'], ['3']], [['2026-11-11'], ['2026-11-11'], ['2026-11-11'], ['']]);
  assert.deepEqual(w, { counts: { '2026-11-11': 2 }, undated: 1 });
});

test('미연결 소스는 실행기 표시에서 가져오고, 도구는 쓰기 호출이 없음', () => {
  const runner = fs.readFileSync(path.join(HERE, '../../../integrations/local-dual-report/runner.mjs'), 'utf8');
  assert.deepEqual(unconnectedIn(runner), ['정기 신고·점검', '회사 Gmail', '회사 자체 캘린더']);
  for (const f of ['domains.mjs', 'build-evidence.mjs']) {
    const src = fs.readFileSync(path.join(HERE, '..', f), 'utf8');
    assert.doesNotMatch(src, /values\.(update|append|clear|batchUpdate)|spreadsheets\.batchUpdate|webhookUrl|fetch\(|chat\.spaces/, f);
  }
  // 대상 수는 코드에 박지 않는다: 고정비 기대값 22 외 분야 상수 없음
  assert.doesNotMatch(fs.readFileSync(path.join(HERE, '../domains.mjs'), 'utf8'), /EXPECTED/);
});
