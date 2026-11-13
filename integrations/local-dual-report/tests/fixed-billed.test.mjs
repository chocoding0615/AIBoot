import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// 실제 runner.mjs 소스와 실제 FIXED-EXPENSES-V1 표로 고정비 사실 줄을 만든다(발송·시트 조회 없음).
const src = fs.readFileSync(new URL('../runner.mjs', import.meta.url), 'utf8');
const pick = re => { const m = src.match(re); assert.ok(m, String(re)); return m[0]; };
const code = [
  pick(/const IMMINENT_DAYS = 7;/), pick(/const VENDOR_BILLED = [^\n]+/), pick(/const billedNote = [^\n]+/),
  pick(/const addDay = [^\n]+/), pick(/function fixedSchedule\(date\) \{[\s\S]*?\n\}/),
  pick(/function fixedMark\(jp, s, due\) \{[\s\S]*?\n\}/), pick(/function fixedFacts\(date, jp\) \{[\s\S]*?\n\}/), 'fixedFacts'
].join('\n');
const REPO = new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const fixedFacts = vm.runInNewContext(code, { fs, path, REPO });
const lineOf = (date, vendor, part) => {
  const { lines } = fixedFacts(date, []);
  const ref = lines.indexOf(lines.find(l => l.startsWith('[고정비 이번 달')));
  return (part === 'imminent' ? lines.slice(0, ref) : lines.slice(ref)).find(l => l.startsWith(`- ${vendor}:`)) || null;
};

test('양주 전기료 D-1·D-0: 임박 예정에 청구서 수신·지출결의 확인으로 표시', () => {
  for (const d of ['2026-11-14', '2026-11-15']) {
    const l = lineOf(d, '양주 전기료', 'imminent');
    assert.ok(l, d);
    assert.match(l, /11\/15 .*업체 선납 후 청구 — 청구서 수신·지출결의 작성 여부 확인 필요\(청구서가 아직 없다는 이유로 작성 누락·납부 지연으로 쓰지 말 것\)$/);
    assert.doesNotMatch(lineOf(d, '양주 전기료', 'ref'), /예정일 경과/);
  }
});

test('양주 전기료 D+1: 임박 예정에서 빠지고 참고 목록에 일일 보고 제외 표시', () => {
  assert.equal(lineOf('2026-11-16', '양주 전기료', 'imminent'), null);
  assert.match(lineOf('2026-11-16', '양주 전기료', 'ref'), /11\/15 .*예정일 경과: 일일 보고 제외/);
});

test('베네피아 등 다른 고정비에는 적용하지 않음 — 같은 날 같은 예정일이어도 기존 문구 유지', () => {
  for (const d of ['2026-11-14', '2026-11-15', '2026-11-16']) {
    for (const part of ['imminent', 'ref']) {
      const l = lineOf(d, '베네피아', part);
      if (l) assert.doesNotMatch(l, /선납|예정일 경과/, `${d} ${part}`);
    }
  }
  const all = fixedFacts('2026-11-16', []).lines.filter(l => /선납|예정일 경과/.test(l));
  assert.equal(all.map(l => l.split(':')[0]).join(','), '- 양주 전기료');
});
