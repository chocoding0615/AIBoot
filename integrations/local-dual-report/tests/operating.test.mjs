import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { retryNote, runPlan } from '../operating.mjs';

const known = ['codex', 'antigravity'];
const base = { trialStart: '2026-11-04', trialEnd: '2026-11-10' };
const both = ['codex', 'antigravity'];

test('11/10까지 비교 시험: 두 AI 모두', () => {
  assert.deepEqual(runPlan('2026-11-10', { ...base, afterTrialAgents: ['antigravity'] }, both, known), { agents: both, mode: '비교 시험' });
  assert.deepEqual(runPlan('2026-11-04', base, both, known).agents, both);
});

test('11/11부터 afterTrialAgents의 AI만, 시험 종료일 값은 그대로', () => {
  const c = { ...base, afterTrialAgents: ['antigravity'] };
  assert.deepEqual(runPlan('2026-11-11', c, both, known), { agents: ['antigravity'], mode: '시험 후 운영' });
  assert.deepEqual(runPlan('2027-03-02', c, both, known).agents, ['antigravity']);
  assert.match(runPlan('2026-11-11', c, ['codex'], known).skip, /antigravity만 보고/);
  assert.equal(c.trialEnd, '2026-11-10');
});

test('설정이 없으면 예전처럼 11/11부터 보고하지 않음, 잘못된 설정도 보고하지 않음', () => {
  assert.match(runPlan('2026-11-11', base, both, known).skip, /미설정/);
  for (const bad of [[], 'antigravity', ['gemini'], ['antigravity', 'x']]) assert.match(runPlan('2026-11-11', { ...base, afterTrialAgents: bad }, both, known).skip, /설정 오류/, JSON.stringify(bad));
  assert.match(runPlan('2026-11-03', base, both, known).skip, /전/);
  assert.match(runPlan('2026-11-05', {}, both, known).skip, /설정 없음/);
});

test('재시도에는 직전 검증 실패 사유만 넘김', () => {
  assert.match(retryNote({ status: 'failed', error: 'validation: 연노랑 없음을 미작성·미처리로 단정' }), /연노랑 없음을 미작성·미처리로 단정/);
  for (const e of [{ status: 'failed', error: 'antigravity exit 1' }, { status: 'sent', error: 'validation: x' }, { status: 'sending', error: 'validation: x' }, undefined, {}]) assert.equal(retryNote(e), '', JSON.stringify(e));
});

test('실행기: 운영 기간 판단은 runPlan 하나, 시간대·휴무 확인과 원장 중복 방지는 그대로', () => {
  const src = fs.readFileSync(new URL('../runner.mjs', import.meta.url), 'utf8');
  assert.equal(/date > c\.trialEnd/.test(src), false);
  const main = src.slice(src.indexOf('const plan = runPlan('));
  const order = ['if (plan.skip)', 'agents = plan.agents', 'SLOTS[slot].start', 'await workday(date, c)'].map(x => main.indexOf(x));
  assert.ok(order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1])), String(order));
  assert.ok(src.indexOf('retryNote(readLedger()[key])') < src.indexOf('dry ? true : claim(key)'));
  assert.match(src, /cur\.status === 'sent' \|\| cur\.status === 'sending'/);
  assert.match(src, /attempts \|\| 0\) >= 3\) return 'max-attempts'/);
});

test('검증기는 느슨해지지 않음: 연노랑 단정·알고퀵 날짜 규칙 유지', () => {
  const src = fs.readFileSync(new URL('../runner.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes("errs.push('연노랑 없음을 미작성·미처리로 단정')"));
  assert.ok(src.includes('날짜 오류: ${s.vendor} 규칙상 ${s.day}일'));
});
