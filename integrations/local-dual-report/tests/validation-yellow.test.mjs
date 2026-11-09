import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../runner.mjs', import.meta.url), 'utf8');
// The runner's own rule, taken from its source so this test follows any change to it.
const line = src.split('\n').find(l => l.includes("errs.push('연노랑 없음을 미작성·미처리로 단정')"));
const yellow = new RegExp(/if \(\/(.*)\/\.test\(chat\)\)/.exec(line)[1]);

test('11/09 Antigravity 실패 문장은 계속 막힘', () => {
  assert.ok(yellow.test('■ 내용: 4건의 납부 예정일이 도래하며, 현재 원본 시트상 11월 지출결의(연노랑)가 미작성 상태입니다.'));
  assert.ok(yellow.test('- 10일 납부: 알고퀵 — 결재 미처리'));
});

test('프롬프트가 권하는 표현은 같은 검증을 통과함', () => {
  for (const ok of ['- 10일 납부: 알고퀵·Sendy·푸딩·매장 전기료 — 지출결의 작성 여부 확인 필요', '■ 내용: 시트상 연노랑 표시가 없어 지출결의 작성 여부 확인이 필요합니다.']) assert.equal(yellow.test(ok), false, ok);
  assert.ok(src.includes('"지출결의 작성 여부 확인 필요"로 쓴다'));
});

test('검증 실패 사유는 다음 생성 프롬프트에 붙음', () => {
  assert.ok(src.includes("await generate(agent, note ? text + '\\n\\n' + note : text)"));
});
