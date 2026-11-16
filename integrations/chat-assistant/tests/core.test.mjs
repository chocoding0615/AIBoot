import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, collect, validateConfig, reportBlocked, recover, remember, pruneContext, selectSources, fact, renderAnswer, proposals, answerPending, deliverPreview } from '../core.mjs';

const now = new Date('2026-11-16T03:00:00Z'); // Noon KST
const config = { space: 'spaces/dialog', owner: 'users/123', startAt: '2026-11-16T00:00:00Z', maxDailyCalls: 2 };
const msg = (id, text = '왜?', extra = {}) => ({ name: `spaces/dialog/messages/${id}`, text, createTime: '2026-11-16T01:00:00.123456Z', sender: { name: 'users/123', type: 'HUMAN' }, ...extra });
const snap = () => ({ sources: { contracts: '연결', recurring: '연결' }, facts: [fact('contracts', 'a', '업체A', '업체A 계약 종료 2026-11-20', { date: '2026-11-20' }), fact('recurring', 'b', '준비 업무', '준비 업무 2026-11-20', { date: '2026-11-20' })] });
const queue = () => { const s = initialState(); s.questions.q = { id: 'q', text: '계약 만료 알려줘', at: now.toISOString(), status: 'pending' }; return s; };
const io = (s, extra = {}) => ({ now: () => now, save: () => {}, reportLedger: () => ({}), readSources: async () => snap(), policy: '원본만 사용', generate: async () => JSON.stringify({ factIds: [snap().facts[0].id], advice: '사전 준비를 검토하세요.' }), ...extra });

test('config rejects reference spaces, noncanonical owner and mismatched webhook', () => {
  assert.doesNotThrow(() => validateConfig(config, { chatSpaces: ['reference1', 'reference2'] }));
  assert.throws(() => validateConfig(config, { chatSpaces: ['dialog'] }));
  assert.throws(() => validateConfig({ ...config, owner: 'name@example.com' }, {}));
  assert.throws(() => validateConfig({ ...config, deliveryApproved: true }, { webhookUrl: 'https://chat.googleapis.com/v1/spaces/other/messages' }));
  assert.throws(() => validateConfig({ ...config, maxDailyCalls: 0 }, {}));
});
test('all pages include short questions and equal timestamps, exclude bots/other users; no duplicate on replay', async () => {
  const state = initialState(); let calls = 0;
  const list = async args => { calls++; return args.pageToken ? { messages: [msg('two')] } : { messages: [msg('one'), msg('bot', '답변', { sender: { type: 'BOT', name: 'users/123' } }), msg('other', '질문', { sender: { type: 'HUMAN', name: 'users/999' } })], nextPageToken: 'next' }; };
  await collect(state, config, list, () => {}, now);
  assert.equal(calls, 2); assert.equal(Object.keys(state.questions).length, 2);
  assert.equal(state.questions['spaces/dialog/messages/one'].text, '왜?');
  await collect(state, config, list, () => {}, now);
  assert.equal(Object.keys(state.questions).length, 2);
});
test('cursor unchanged on partial page failure, fetched questions durable; replay completes without loss', async () => {
  const state = initialState(), saves = [];
  await assert.rejects(collect(state, config, async args => { if (args.pageToken) throw new Error('API'); return { messages: [msg('one')], nextPageToken: 'next' }; }, () => saves.push(structuredClone(state)), now));
  assert.equal(state.cursor, null); assert.equal(Object.keys(saves[0].questions).length, 1);
  await collect(state, config, async () => ({ messages: [msg('one'), msg('two')] }), () => {}, now);
  assert.equal(Object.keys(state.questions).length, 2); assert.equal(state.cursor, now.toISOString());
});
test('cursor overlaps previous completed window and page queries remain identical', async () => {
  const state = initialState(); state.cursor = '2026-11-16T02:00:00Z'; const calls = [];
  await collect(state, config, async args => { calls.push(args); return args.pageToken ? {} : { nextPageToken: '2' }; }, () => {}, now);
  assert.match(calls[0].filter, /01:58:00.000Z/); assert.equal(calls[0].filter, calls[1].filter);
});
test('invalid message metadata never advances cursor', async () => {
  const state = initialState();
  await assert.rejects(collect(state, config, async () => ({ messages: [msg('x', '업무', { name: undefined })] }), () => {}, now));
  assert.equal(state.cursor, null);
});
test('repeated page token and collection page cap retain cursor', async () => {
  for (const repeat of [true, false]) {
    const state = initialState(); let i = 0;
    const run = () => collect(state, config, async () => ({ nextPageToken: repeat ? 'same' : String(++i) }), () => {}, now);
    if (repeat) await assert.rejects(run()); else assert.equal((await run()).complete, false);
    assert.equal(state.cursor, null);
  }
});
test('restart returns generation to pending but ambiguous sends stay unknown', () => {
  const state = initialState(); state.questions.a = { status: 'generating' }; state.questions.b = { status: 'sending' }; state.questions.c = { status: 'sent' };
  recover(state); assert.equal(state.questions.a.status, 'pending'); assert.equal(state.questions.b.status, 'unknown'); assert.equal(state.questions.c.status, 'sent');
});
test('10 recent messages and 7 day business context boundary', () => {
  const state = initialState(); for (let i = 0; i < 15; i++) remember(state, 'user', String(i), now.toISOString());
  assert.equal(state.messages.length, 10); assert.equal(state.messages[0].text, '5');
  state.context = [{ at: '2026-11-09T03:00:00Z' }, { at: '2026-11-09T02:59:59Z' }]; pruneContext(state, now);
  assert.equal(state.context.length, 1);
});
test('narrow source routing and follow-up reuse prior question only as context', () => {
  assert.deepEqual(selectSources('계약 만료 언제야?'), ['contracts']);
  assert.deepEqual(selectSources('라이센스 만료 언제야?'), ['licenses']);
  assert.deepEqual(selectSources('그건 언제야?', [{ role: 'user', text: '라이센스 현황' }]), ['licenses']);
  assert.equal(selectSources('오늘 해야 할 업무').length, 6); assert.deepEqual(selectSources('안녕'), []);
});
test('report reservation windows, retry tail and active/ambiguous ledger block', () => {
  for (const clock of ['00:00', '02:14', '06:30', '08:44']) assert.equal(reportBlocked(new Date(`2026-11-16T${clock}:00Z`), {}), true);
  assert.equal(reportBlocked(now, {}), false);
  assert.equal(reportBlocked(now, { x: { status: 'generating' } }), true);
  assert.equal(reportBlocked(now, { x: { status: 'sending' } }), true);
  assert.equal(reportBlocked(now, { x: { status: 'sent' } }), false);
});
test('output facts must be fresh IDs; source failures explicit, unsupported status/date blocked', () => {
  const fresh = snap(); fresh.sources.welfare = '조회 실패';
  const text = renderAnswer(JSON.stringify({ factIds: [fresh.facts[0].id], advice: '준비를 검토하세요.' }), fresh);
  assert.match(text, /출처: contracts:/); assert.match(text, /welfare: 확인 불가/);
  assert.throws(() => renderAnswer(JSON.stringify({ factIds: ['old-memory'], advice: '' }), fresh));
  for (const advice of ['미납 상태입니다', '2030-01-01까지 준비', '이미 수정했어요', 'https://example.com']) assert.throws(() => renderAnswer(JSON.stringify({ factIds: [], advice }), fresh));
});
test('question invokes AI once, refreshes selected sources, persists preview and memory; no sends', async () => {
  const state = queue(); let calls = 0, sources;
  const result = await answerPending(state, config, io(state, { readSources: async ids => { sources = ids; return snap(); }, generate: async () => { calls++; return JSON.stringify({ factIds: [snap().facts[0].id], advice: '' }); } }));
  assert.deepEqual(sources, ['contracts']); assert.equal(calls, 1); assert.match(result.status, /미발송/);
  assert.equal(state.questions.q.status, 'preview'); assert.equal(state.messages.length, 2);
  await answerPending(state, config, io(state, { generate: async () => { throw new Error('must not run'); } }));
  assert.equal(calls, 1);
});
test('no question and ambiguous question do not call Antigravity', async () => {
  const tools = io({}, { generate: async () => { throw new Error('must not run'); }, readSources: async () => { throw new Error('must not read'); } });
  await answerPending(initialState(), config, tools);
  const state = queue(); state.questions.q.text = '안녕'; await answerPending(state, config, tools);
  assert.equal(state.questions.q.status, 'preview');
});
test('daily cap preserves pending question; quota failure consumes one attempt without automatic retry', async () => {
  const state = queue(); state.usage['2026-11-16'] = 2;
  assert.match((await answerPending(state, config, io(state))).status, /상한/); assert.equal(state.questions.q.status, 'pending');
  state.usage = {}; let count = 0;
  const tools = io(state, { generate: async () => { count++; throw new Error('QUOTA'); } });
  await answerPending(state, config, tools); await answerPending(state, config, tools);
  assert.equal(count, 1); assert.equal(state.usage['2026-11-16'], 1); assert.equal(state.questions.q.status, 'blocked');
});
test('report begins after source read: AI and delivery remain deferred', async () => {
  const state = queue(); let started = false;
  const result = await answerPending(state, config, io(state, { readSources: async () => { started = true; return snap(); }, reportLedger: () => started ? { x: { status: 'generating' } } : {} }));
  assert.match(result.status, /대기/); assert.equal(state.questions.q.status, 'pending');
});
test('preview send requires approval; only preview can send; ambiguous error never resends', async () => {
  const state = queue(); state.questions.q.status = 'preview'; state.questions.q.answer = '원본 근거'; let count = 0;
  const tools = io(state, { post: async () => { count++; throw new Error('ambiguous'); } });
  await assert.rejects(deliverPreview(state, config, tools));
  await deliverPreview(state, { ...config, deliveryApproved: true }, tools);
  await deliverPreview(state, { ...config, deliveryApproved: true }, tools);
  assert.equal(count, 1); assert.equal(state.questions.q.status, 'unknown');
});
test('verified webhook receipt persists sent ID without touching report records', async () => {
  const state = queue(); state.questions.q.status = 'preview'; state.questions.q.answer = '확인';
  await deliverPreview(state, { ...config, deliveryApproved: true }, io(state, { post: async () => ({ name: 'spaces/dialog/messages/reply' }) }));
  assert.equal(state.questions.q.status, 'sent'); assert.equal(state.questions.q.replyId, 'spaces/dialog/messages/reply');
});
test('proposals cross two fresh connected sources only, remain local and deduplicate across restart', () => {
  const state = initialState(), fresh = snap();
  const result = proposals(fresh, { verified: true, texts: ['다른 업무 보고'] }, state, now);
  assert.equal(result.candidates.length, 1); assert.match(result.candidates[0].status, /미발송/);
  assert.equal(proposals(fresh, { verified: true, texts: [] }, structuredClone(state), now).candidates.length, 0);
  assert.equal(proposals(fresh, { verified: false, texts: [] }, initialState(), now).candidates.length, 0);
  assert.equal(proposals(fresh, { verified: true, texts: ['업체A 계약 검토'] }, initialState(), now).candidates.length, 0);
  fresh.sources.recurring = '조회 실패'; assert.equal(proposals(fresh, { verified: true, texts: [] }, initialState(), now).candidates.length, 0);
});

test('unsupported factual advice cannot introduce an approval absence or a new task', () => {
  const fresh = snap();
  for (const advice of ['대표가 휴가이므로 결재를 앞당기세요.', '새로운 세무 신고가 필요합니다.']) assert.throws(() => renderAnswer(JSON.stringify({factIds: [fresh.facts[0].id], advice}), fresh));
});
test('a quota/validation failure pauses other pending questions for the same KST day', async () => {
  const state = queue(); const tools = io(state, {generate: async () => {throw new Error('quota');}});
  await answerPending(state, config, tools);
  state.questions.next = {id: 'next', text: '계약 확인', at: now.toISOString(), status: 'pending'};
  assert.match((await answerPending(state, config, tools)).status, /오류일 보호/);
  assert.equal(state.questions.next.status, 'pending');
});


test('proposal dedup ignores daily D-day wording changes for the same source subjects and occurrence', () => {
  const state = initialState(), fresh = snap(), reports = {verified: true, texts: []};
  assert.equal(proposals(fresh, reports, state, now).candidates.length, 1);
  fresh.facts[0].text += ' (D-3)'; fresh.facts[1].id += '-new-display';
  assert.equal(proposals(fresh, reports, state, now).candidates.length, 0);
});
