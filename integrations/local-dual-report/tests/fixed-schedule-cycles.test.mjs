import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const runner = fs.readFileSync(new URL('../runner.mjs', import.meta.url), 'utf8');
const match = runner.match(/function fixedSchedule\(date\) \{[\s\S]*?\n\}/);
assert.ok(match, 'fixedSchedule source must exist');
const text = [
  '| 행 | 업체 | 사용기간 | 납부 기준 | 청구 경로 | 운영 상태 |',
  '| 26 | 수유 수도요금 | 2개월 | 각 회차 종료 익월 말일 | Gmail | 활성 |',
  '| 28 | 매장 안전관리자 | 미확정 | 관리표 10일, 세부 회차 미확정 | 제외 | 활성 |',
  '| 16 | 알고퀵 | 월 1일~말일 | 익월 10일 | Gmail | 활성 |',
  '| 18 | 이지화물 | 월 1일~말일 | 당월 말일 | Gmail | 종료 |'
].join('\n');
const fakeFs = {readFileSync(){return text;}};
const context={fs:fakeFs,path,REPO:'/test'};
const fn=vm.runInNewContext('('+match[0]+')',context);
function due(date, vendor){const row=fn(date).find(x=>x.vendor===vendor);return row?.day??null;}
test('수유 수도요금 격월 납부 회차',()=>{
  assert.equal(due('2026-10-01','수유 수도요금'),null);
  assert.equal(due('2026-11-01','수유 수도요금'),30);
  assert.equal(due('2027-01-01','수유 수도요금'),31);
  assert.equal(due('2027-02-01','수유 수도요금'),null);
  assert.equal(due('2027-03-01','수유 수도요금'),31);
});
test('매장 안전관리자 미확정 회차는 매월 자동 납부로 취급하지 않음',()=>{
  assert.equal(due('2026-11-01','매장 안전관리자'),null);
  assert.equal(due('2026-12-01','매장 안전관리자'),null);
});
test('다른 업체 및 종료 업체는 기존 로직 유지',()=>{
  assert.equal(due('2026-11-01','알고퀵'),10);
  assert.equal(fn('2026-11-01').find(x=>x.vendor==='이지화물'),undefined);
});
test('실제 운영 기준 문서(FIXED-EXPENSES-V1)로도 같은 결과',()=>{
  const real=vm.runInNewContext('('+match[0]+')',{fs,path,REPO:new URL('../../..',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1')});
  const day=(d,v)=>real(d).find(x=>x.vendor===v)?.day??null;
  assert.equal(real('2026-11-01').length,22); // 이지화물 종료 → 활성 22항목
  assert.equal(day('2026-11-01','수유 수도요금'),30);
  assert.equal(day('2026-12-01','수유 수도요금'),null);
  assert.equal(day('2026-11-01','매장 안전관리자'),null);
  assert.ok(real('2026-11-01').some(x=>x.vendor==='매장 안전관리자')); // 항목은 유지(납부일만 미확정)
});
