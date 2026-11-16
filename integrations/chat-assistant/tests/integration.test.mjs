import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { openStore } from '../store.mjs';
import { fixedRules, readSources, recentReports } from '../sources.mjs';
import { collect, answerPending, deliverPreview, prompt, initialState, proposals } from '../core.mjs';
import { generateAntigravity } from '../cli.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const rules = fixedRules(repo), now = new Date('2026-11-16T03:00:00Z');
const temporary = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiboot-fixture-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const report = { spreadsheetId: 'fixed', contractsSpreadsheetId: 'contracts', opsSpreadsheetId: 'welfare', recurringSpreadsheetId: 'recurring', chatSpaces: ['reference1', 'reference2'] };
function fakeSheets(calls) {
  return () => ({
    get: async args => {
      calls.push(args);
      if (args.spreadsheetId === 'fixed') return { data: { sheets: [{ data: [{ rowData: [] }] }] } };
      if (!args.ranges) return { data: { properties: { title: '[MS] 김현호' }, sheets: [{ properties: { title: '업무', sheetId: 1 } }] } };
      return { data: { sheets: [{ data: [{ rowData: [{ values: ['준비 업무', '1회', '2026-11-20', '사용', 'D-7'].map(formattedValue => ({formattedValue})) }] }] }] } };
    },
    values: {
      get: async args => { calls.push(args); return { data: { values: [['[MS] 김현호', '', '업무']] } }; },
      batchGet: async args => {
        calls.push(args);
        const ranges = args.ranges;
        let data;
        if (ranges[0].includes('계약서 검색')) data = [[['', '', '업체A', '서비스', '', '', '', '2026-11-20', '4']]];
        else if (ranges[0].includes('프로그램')) data = [[['프로그램A', '', '2026-11-20', '4']]];
        else if (ranges[0].includes('복지')) data = [[['1'], ['2']], [['2026-11-20'], ['2026-11-20']]];
        else data = [[], [], [], []];
        return { data: { valueRanges: data.map(values => ({ values })) } };
      }
    }
  });
}
const fakeChat = calls => ({ spaces: { messages: { list: async args => { calls.push(args); return { data: { messages: [{ name: `${args.parent}/messages/ref`, text: '업무 공지', sender: {type: 'HUMAN'} }] } }; } } } });
const fixtureRead = (ids, calls = []) => readSources(ids, { report, chat: fakeChat(calls), sheets: fakeSheets(calls), rules, home: '/nonexistent-aiboot-fixture', now, fetcher: async () => { throw new Error('offline'); } });

test('pure fixed calculations reuse original rules, not runner main', () => {
  assert.ok(rules.fixedFacts('2026-11-09', []).imminent.length > 0);
  assert.ok(!rules.fixedFacts('2026-11-09', []).sched.some(x => x.vendor === '이지화물'));
  assert.equal(rules.bucketOf(7), 'D-7'); assert.equal(rules.bucketOf(8), 'D-30');
});
test('fresh selective read includes only requested source API calls, strict welfare columns and aggregate', async () => {
  const calls = []; const data = await fixtureRead(['welfare'], calls);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].ranges, ["'복지포인트 관리(2026)'!A8:A", "'복지포인트 관리(2026)'!E8:E"]);
  assert.equal(data.facts.length, 1); assert.match(data.facts[0].text, /2명/);
});
test('all supported sources use existing parsers, no write methods; reference chat separate from question cursor', async () => {
  const calls = []; const data = await fixtureRead(['fixed', 'contracts', 'licenses', 'welfare', 'recurring', 'chat'], calls);
  assert.ok(Object.values(data.sources).every(s => s === '연결'));
  assert.ok(data.facts.some(f => f.source === 'recurring'));
  assert.ok(data.facts.some(f => f.source === 'chat'));
  const vehicle = calls.find(c => c.ranges?.[0].includes('계약서(DB)'));
  assert.deepEqual(vehicle.ranges, ["'계약서(DB)'!C5:C300", "'계약서(DB)'!E5:E300", "'계약서(DB)'!I5:I300", "'계약서(DB)'!Q5:Q300"]);
  assert.equal(calls.filter(c => c.parent).length, 2);
  assert.ok(!JSON.stringify(calls).includes('건강검진')); assert.ok(!JSON.stringify(calls).includes('훈련생'));
});
test('read failure removes partially collected evidence and marks unavailable', async () => {
  let calls = 0;
  const snapshot = await readSources(['chat'], { report, chat: {spaces: { messages: { list: async () => { if (++calls === 2) throw new Error('unavailable'); return { data: { messages: [{name: 'x', text: '공지', sender: {type: 'HUMAN'}}] } }; } } } }, now });
  assert.equal(snapshot.facts.length, 0); assert.match(snapshot.sources.chat, /조회 실패/);
});
test('recent report comparison only reads sent regular CHAT sections, missing evidence fails closed', t => {
  const home = temporary(t); fs.mkdirSync(path.join(home, 'reports'));
  fs.writeFileSync(path.join(home, 'ledger.json'), JSON.stringify({ '2026-11-16|morning|antigravity': {status: 'sent'}, '2026-11-16|morning|codex|test': {status: 'sent'} }));
  assert.equal(recentReports(home, now).verified, false);
  fs.writeFileSync(path.join(home, 'reports/2026-11-16-morning-antigravity.md'), 'snapshot fixture\n=== CHAT ===\n보고 내용\n=== INTERNAL ===\n내부 근거');
  const reports = recentReports(home, now);
  assert.equal(reports.verified, true); assert.deepEqual(reports.texts, ['보고 내용']);
});
test('real atomic persistence: question → fresh source → model fixture → preview → restart → dedup → approved mock receipt', async t => {
  const dir = temporary(t), config = { space: 'spaces/dialog', owner: 'users/123', startAt: '2026-11-16T00:00:00Z', maxDailyCalls: 2 };
  let store = openStore(dir);
  const question = { name: 'spaces/dialog/messages/q1', createTime: '2026-11-16T02:00:00Z', text: '계약 만료 알려줘', sender: {name: 'users/123', type: 'HUMAN'} };
  await collect(store.state, config, async () => ({messages: [question]}), store.save, now);
  let calls = 0;
  const tools = () => ({ now: () => now, save: store.save, reportLedger: () => ({}), readSources: fixtureRead, policy: '읽기 전용',
    generate: async text => { calls++; const data = JSON.parse(text.slice(text.indexOf('{"question"'))); return JSON.stringify({ factIds: [data.fresh.facts[0].id], advice: '' }); },
    post: async () => ({ name: 'spaces/dialog/messages/mock-reply' }) });
  await answerPending(store.state, config, tools());
  assert.equal(store.state.questions[question.name].status, 'preview'); store.close();
  store = openStore(dir);
  try {
    await collect(store.state, config, async () => ({messages: [question]}), store.save, now);
    await answerPending(store.state, config, tools()); assert.equal(calls, 1);
    await deliverPreview(store.state, {...config, deliveryApproved: true}, tools());
    assert.equal(store.state.questions[question.name].status, 'sent');
    assert.equal(Object.keys(store.state.questions).length, 1);
  } finally { store.close(); }
});
test('changed source before send returns preview to pending without sending stale answer', async t => {
  const state = initialState(); state.questions.q = {id: 'q', text: '복지 알려줘', at: now.toISOString(), status: 'pending'};
  const config = { maxDailyCalls: 1 }; let posted = false;
  const tools = { now: () => now, save: () => {}, reportLedger: () => ({}), readSources: fixtureRead, policy: '', generate: async () => JSON.stringify({factIds: [], advice: ''}) };
  await answerPending(state, config, tools);
  await deliverPreview(state, {deliveryApproved: true}, {...tools, readSources: async () => ({ sources: {welfare: '조회 실패'}, facts: [] }), post: async () => {posted = true;} });
  assert.equal(posted, false); assert.equal(state.questions.q.status, 'pending');
});
test('store refuses concurrent worker and corrupted state; restores interrupted phases', t => {
  const dir = temporary(t), first = openStore(dir);
  assert.throws(() => openStore(dir), /이미 실행/);
  first.state.questions.a = { status: 'sending' }; first.state.questions.b = {status: 'generating'}; first.save(); first.close();
  const recovered = openStore(dir); assert.equal(recovered.state.questions.a.status, 'unknown'); assert.equal(recovered.state.questions.b.status, 'pending'); recovered.close();
  fs.writeFileSync(path.join(dir, 'state.json'), '{broken');
  assert.throws(() => openStore(dir), /손상/); assert.equal(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'), '{broken');
});
test('bounded prompt labels old context and incomplete fresh evidence, keeps current policy', () => {
  const state = initialState(); state.context = Array.from({ length: 10 }, () => ({at: now.toISOString(), facts: 'old'.repeat(2000)}));
  const data = { sources: {chat: '연결'}, facts: Array.from({length: 50}, (_, i) => ({id: String(i), source: 'chat', text: '현재 자료'.repeat(300)})) };
  const text = prompt('공지 알려줘', data, state, 'CURRENT POLICY');
  assert.ok(text.length <= 28000); assert.match(text, /CURRENT POLICY/); assert.match(text, /일부 근거 제외/);
});
test('Antigravity adapter uses isolated cwd, no shell, plan flags and no repeated calls', async () => {
  let calls = 0, cwd;
  const launch = (file, args, options) => {
    calls++; cwd = options.cwd; assert.equal(options.shell, false); assert.ok(args.includes('plan')); assert.deepEqual(JSON.parse(args[args.indexOf('--settings') + 1]), { useG1Credits: false }); assert.equal(args[args.indexOf('--output-format') + 1], 'json'); assert.deepEqual(JSON.parse(args[args.indexOf('--json-schema') + 1]).required, ['factIds', 'advice']);
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    queueMicrotask(() => { child.stdout.write(JSON.stringify({ status: 'SUCCESS', structured_output: { factIds: [], advice: '' } })); child.emit('close', 0); });
    return child;
  };
  assert.match(await generateAntigravity('fixture', () => false, {launch, executable: 'fake'}), /factIds/);
  assert.equal(calls, 1); assert.equal(fs.existsSync(cwd), false);
  await assert.rejects(generateAntigravity('fixture', () => true, {launch})); assert.equal(calls, 1);
});


test('dead worker lock recovers persisted questions after an actual process exit', t => {
  const dir = temporary(t);
  const module = new URL('../store.mjs', import.meta.url).href;
  const code = `import {openStore} from ${JSON.stringify(module)}; const store = openStore(${JSON.stringify(dir)}); store.state.questions.q = {status: 'generating'}; store.save(); process.exit(0);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code]);
  assert.equal(child.status, 0);
  const store = openStore(dir);
  try { assert.equal(store.state.questions.q.status, 'pending'); } finally { store.close(); }
});
test('cross-source candidate flow uses fresh parsed dates and never invokes AI or webhook', async t => {
  const snapshot = await fixtureRead(['contracts', 'welfare']);
  const dir = temporary(t), store = openStore(dir);
  try {
    const result = proposals(snapshot, {verified: true, texts: ['다른 정기 보고 추천']}, store.state, now);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].evidence[0].date, '2026-11-20');
    store.save();
  } finally {store.close();}
  const restored = openStore(dir);
  try { assert.equal(Object.keys(restored.state.proposals).length, 1); } finally {restored.close();}
});
test('active generation is interrupted when the report guard becomes active', async () => {
  let checks = 0, killed = false;
  const launch = () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {killed = true;}; return child;
  };
  await assert.rejects(generateAntigravity('fixture', () => ++checks > 1, {launch, executable: 'fake'}));
  assert.equal(killed, true);
});


test('Antigravity adapter ignores token-truncated prose and accepts only structured terminal result', async () => {
  const value = { factIds: ['contracts:verified'], advice: '' };
  let calls = 0;
  const launch = () => {
    calls++;
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    queueMicrotask(() => {
      const output = JSON.stringify({ status: 'SUCCESS', response: 'Non-JSON partial output before internal continuation', structured_output: value });
      child.stdout.write(output.slice(0, 25)); child.stdout.write(output.slice(25)); child.emit('close', 0);
    });
    return child;
  };
  assert.deepEqual(JSON.parse(await generateAntigravity('fixture', () => false, { launch })), value);
  assert.equal(calls, 1);
});

test('Antigravity adapter rejects missing schema output, non-success status and malformed schema without fallback', async () => {
  const good = { factIds: [], advice: '' };
  const cases = [
    JSON.stringify({ status: 'SUCCESS', response: JSON.stringify(good) }),
    JSON.stringify({ status: 'ERROR', structured_output: good }),
    JSON.stringify({ status: 'SUCCESS', structured_output: { factIds: [3], advice: '' } }),
    JSON.stringify({ status: 'SUCCESS', structured_output: { factIds: [], advice: 'unsupported advice' } }),
    JSON.stringify({ status: 'SUCCESS', structured_output: { ...good, extra: true } }),
    JSON.stringify(good), 'partial prose' + JSON.stringify(good)
  ];
  for (const output of cases) {
    const launch = () => {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
      queueMicrotask(() => { child.stdout.write(output); child.emit('close', 0); });
      return child;
    };
    await assert.rejects(generateAntigravity('fixture', () => false, { launch }));
  }
});
