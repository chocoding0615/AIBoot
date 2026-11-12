import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../runner.mjs', import.meta.url), 'utf8').match(/function fixedMark\(jp, s, due\) \{[\s\S]*?\n\}/);
assert.ok(src, 'fixedMark source must exist');
const fixedMark = vm.runInNewContext(`(${src[0]})`);
const months = Array.from({ length: 12 }, (_, i) => `${String(i + 1).padStart(2, '0')}월`);
const cell = (t, yellow = false) => ({ t, yellow });
// JP매월 지출 B열부터: 연도 → 머리글 → 업체 행. yellowMonths = 연노랑 칠한 월 번호.
const block = (year, rows) => [[cell(`${year}년`)], ['NO', '구분', '항목', '수신메일', '결제 방식', '지출결의', '결제일', ...months].map(t => cell(t)),
  ...rows.map(([vendor, yellowMonths]) => ['2', '', vendor, '', '계좌이체', '계좌이체', '15일', ...months.map((_, i) => '')].map((t, i) => cell(t, i >= 7 && yellowMonths.includes(i - 6))))];
const beneVia = { vendor: '베네피아', period: '월 1일~말일', basis: '익월 15일' };

test('11/15 납부(익월 15일)는 10월분 열의 연노랑으로 판정 — 11/12 오후 재요청 재현', () => {
  const jp = block(2026, [['베네피아', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]]]);
  assert.match(fixedMark(jp, beneVia, '2026-11-15'), /^10월분 열 연노랑 — 지출결의 작성·제출 표시 확인\(결재 승인·납부 완료 아님\)$/);
});

test('대상 월 열에 연노랑이 없으면 작성 여부 확인 필요 — 다른 월 열 색으로 추정하지 않음', () => {
  const jp = block(2026, [['베네피아', [9, 11]]]);
  assert.equal(fixedMark(jp, beneVia, '2026-11-15'), '10월분 열 연노랑 없음 — 지출결의 작성 여부 확인 필요');
});

test('달을 걸치는 사용기간·업체 행 없음·연도 블록 없음은 작성 완료로 추정하지 않음', () => {
  const jp = block(2026, [['양주 전기료', [9, 10, 11]], ['베네피아', [12]]]);
  assert.equal(fixedMark(jp, { vendor: '양주 전기료', period: '23일~다음 달 22일', basis: '기간 종료 익월 15일' }, '2026-11-15'), '대상 월 열 미확정 — 지출결의 작성 여부 확인 필요');
  assert.equal(fixedMark(jp, { ...beneVia, vendor: 'KT' }, '2026-11-25'), '10월분 열 확인 불가 — 지출결의 작성 여부 확인 필요');
  assert.equal(fixedMark(jp, beneVia, '2027-01-15'), '12월분 열 연노랑 — 지출결의 작성·제출 표시 확인(결재 승인·납부 완료 아님)');
  assert.equal(fixedMark(block(2027, [['베네피아', [12]]]), beneVia, '2027-01-15'), '12월분 열 확인 불가 — 지출결의 작성 여부 확인 필요');
  assert.equal(fixedMark(null, beneVia, '2026-11-15'), '10월분 열 확인 불가 — 지출결의 작성 여부 확인 필요');
});

test('업체명은 항목 열에서만, 대상 월 머리글은 하나일 때만 판정 — 다른 행·중복 열로 작성 완료 추정 금지', () => {
  const jp = block(2026, [['KT', [10]]]);
  jp[2][3] = cell('베네피아'); // KT 행의 수신메일 열에 업체명이 있어도 베네피아 행이 아님
  assert.equal(fixedMark(jp, beneVia, '2026-11-15'), '10월분 열 확인 불가 — 지출결의 작성 여부 확인 필요');
  const dup = block(2026, [['베네피아', [10]]]);
  dup[1].push(cell('10월')); dup[2].push(cell(''));
  assert.equal(fixedMark(dup, beneVia, '2026-11-15'), '10월분 열 확인 불가 — 지출결의 작성 여부 확인 필요');
});
