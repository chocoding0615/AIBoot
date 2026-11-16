import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { openStore } from '../store.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { generateAntigravity } from '../cli.mjs';
import { ADVICE, validateAnswer, renderAnswer, answerPending, initialState, fact, aiFailure } from '../core.mjs';

const good = { factIds: [], advice: '' };
const envelope = (value = good, extra = {}) => JSON.stringify({ status: 'SUCCESS', structured_output: value, ...extra });
const launchFixture = ({ output = envelope(), stderr = '', exitCode = 0, signal = null, chunks, inspect, neverClose = false, killThrows = false } = {}) => {
  const state = { calls: 0, killed: 0 };
  state.launch = (file, args, options) => {
    state.calls++; state.cwd = options.cwd; state.args = args;
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    state.child = child;
    child.kill = () => { state.killed++; if (killThrows) throw Error('private secret'); };
    inspect?.(file, args, options);
    queueMicrotask(() => {
      if (neverClose) return;
      if (stderr) child.stderr.write(stderr);
      for (const chunk of chunks || [output]) child.stdout.write(chunk);
      child.emit('close', exitCode, signal);
    });
    return child;
  };
  return state;
};
const run = (fixture, blocked = () => false, text = 'offline synthetic prompt') => generateAntigravity(text, blocked, { launch: fixture.launch, executable: 'fake.exe' });
const rejects = async (promise, code, exitCode) => assert.rejects(promise, error => {
  assert.equal(error.code, code); if (exitCode !== undefined) assert.equal(error.exitCode, exitCode);
  assert.ok(!JSON.stringify(error).includes('private secret')); return true;
});

test('wire schema uses supported object/array/string/required subset; empty advice remains valid locally', async () => {
  const f = launchFixture({ inspect: (file, args, options) => {
    assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
    assert.deepEqual(JSON.parse(args[args.indexOf('--settings') + 1]), { useG1Credits: false });
    assert.equal(args[args.indexOf('--output-format') + 1], 'json');
    assert.equal(args[args.indexOf('--mode') + 1], 'plan');
    assert.equal(args[args.indexOf('--print-timeout') + 1], '540s');
    const schema = JSON.parse(args[args.indexOf('--json-schema') + 1]);
    assert.deepEqual(schema, { type: 'object', properties: { factIds: { type: 'array', maxItems: 12, items: { type: 'string' } }, advice: { type: 'string' } }, required: ['factIds', 'advice'] });
    // In particular no enum:[''], nullable union, nested objects or backend-only bounds.
    assert.ok(!JSON.stringify(schema).includes('enum'));
  } });
  assert.deepEqual(JSON.parse(await run(f)), good); assert.equal(f.calls, 1);
  assert.equal(fs.existsSync(f.cwd), false);
  for (const advice of ADVICE) assert.deepEqual(validateAnswer({ factIds: ['known'], advice }), { factIds: ['known'], advice });
});

test('strict response fields reject null/missing/extra/nested values and array boundaries', () => {
  const invalid = [null, [], '', 0, false, {}, { factIds: [] }, { advice: '' },
    { ...good, extra: {} }, { ...good, factIds: null }, { ...good, factIds: {} },
    { ...good, factIds: [null] }, { ...good, factIds: [false] }, { ...good, factIds: [{}] },
    { ...good, factIds: [[]] }, { ...good, advice: null }, { ...good, advice: false },
    { ...good, advice: 0 }, { ...good, advice: [] }, { ...good, advice: {} },
    { ...good, advice: 'unapproved prose' }, { ...good, factIds: Array(13).fill('known') }];
  for (const value of invalid) assert.throws(() => validateAnswer(value), { code: 'AI_OUTPUT_SCHEMA' });
  assert.equal(validateAnswer({ ...good, factIds: Array(12).fill('known') }).factIds.length, 12);
});

test('split UTF-8 Korean bytes roundtrip without replacement characters', async () => {
  const value = { factIds: ['contracts:known'], advice: ADVICE[1] };
  const bytes = Buffer.from(envelope(value), 'utf8');
  const f = launchFixture({ chunks: [...bytes].map(byte => Buffer.from([byte])) });
  assert.deepEqual(JSON.parse(await run(f)), value);
});

test('regression: truncated non-JSON prose and a final JSON cannot be salvaged as a raw answer', async () => {
  const f = launchFixture({ output: 'Non-JSON partial response cut off by output token limit\n' + JSON.stringify(good) });
  await rejects(run(f), 'AI_OUTPUT_JSON', 0); assert.equal(f.calls, 1);
});

test('regression: final structured result is independent of prior token-truncated prose', async () => {
  const f = launchFixture({ output: envelope(good, { response: 'Non-JSON partial response, then internal continuation' }) });
  assert.deepEqual(JSON.parse(await run(f)), good);
});

test('regression: advice.enum[0] HTTP 400 exit 3 is schema error, never quota or evidence error', async () => {
  const f = launchFixture({ exitCode: 3, output: JSON.stringify({ status: 'ERROR', error: 'INVALID_ARGUMENT (code 400): parameters.properties[advice].enum[0]: cannot be empty; private secret' }) });
  await rejects(run(f), 'AI_REQUEST_SCHEMA', 3); assert.equal(f.calls, 1);
});

for (const [name, text, code] of [
  ['subscription', 'RESOURCE_EXHAUSTED: quota exhausted', 'AI_SUBSCRIPTION_LIMIT'],
  ['rate', '429 rate limit exceeded', 'AI_SUBSCRIPTION_LIMIT'],
  ['output-token', 'Your previous response was cut off because it exceeded the output token limit', 'AI_OUTPUT_TOKEN_LIMIT'],
  ['timeout', 'DEADLINE_EXCEEDED', 'AI_EXECUTION_TIMEOUT'],
  ['auth', 'UNAUTHENTICATED authentication required', 'AI_AUTH_ERROR'],
  ['generic', 'internal execution failure', 'AI_EXIT_ERROR']
]) test(`terminal ${name} failure has safe distinct code and no retry`, async () => {
  const f = launchFixture({ exitCode: 3, output: JSON.stringify({ status: 'ERROR', error: text + ' private secret' }) });
  await rejects(run(f), code, 3); assert.equal(f.calls, 1); assert.equal(fs.existsSync(f.cwd), false);
});

test('successful structured output ignores ordinary stderr quota refresh messages', async () => {
  assert.deepEqual(JSON.parse(await run(launchFixture({ stderr: 'quota refreshed: 98% remaining; no rate limit exceeded' }))), good);
});

test('malformed or incomplete JSON envelopes never fall back to response text', async () => {
  for (const output of ['', '{', '```json\n{}\n```', JSON.stringify(good), 'null', '[]', '1',
    JSON.stringify({ status: 'SUCCESS', response: JSON.stringify(good) }),
    JSON.stringify({ status: 'SUCCESS', structured_output: null }),
    JSON.stringify({ status: 'SUCCESS', structured_output: { factIds: [], advice: false } })]) {
    const f = launchFixture({ output }); await assert.rejects(run(f)); assert.equal(f.calls, 1);
  }
  for (const status of ['ERROR', 'CANCELED', 'INTERRUPTED', 'INVALID', 'WAITING', 'RUNNING']) {
    await rejects(run(launchFixture({ output: envelope(good, { status }) })), 'AI_EXIT_ERROR', 0);
  }
  assert.deepEqual(JSON.parse(await run(launchFixture({ output: '\uFEFF' + envelope() }))), good);
});

test('stdout byte limit accepts exact bound and kills oversized output once', async () => {
  const payload = envelope(), padding = ' '.repeat(64000 - Buffer.byteLength(payload));
  assert.deepEqual(JSON.parse(await run(launchFixture({ output: payload + padding }))), good);
  const f = launchFixture({ output: '가'.repeat(22000), killThrows: true });
  await rejects(run(f), 'AI_OUTPUT_LIMIT'); assert.equal(f.killed, 1); assert.equal(fs.existsSync(f.cwd), false);
});

test('spawn throw and spawn error event are classified without leaking messages', async () => {
  await rejects(generateAntigravity('fixture', () => false, { launch: () => { throw Error('private secret'); } }), 'AI_SPAWN_ERROR');
  const f = launchFixture({ neverClose: true }); const p = run(f);
  f.child.emit('error', Error('private secret')); await rejects(p, 'AI_SPAWN_ERROR');
  assert.equal(fs.existsSync(f.cwd), false);
});

test('signal termination preserves only safe signal and no synthetic success', async () => {
  const f = launchFixture({ output: envelope(), exitCode: null, signal: 'SIGTERM' });
  await assert.rejects(run(f), e => { assert.equal(e.code, 'AI_EXIT_ERROR'); assert.equal(e.signal, 'SIGTERM'); return true; });
});

test('input/protection failure never launches and Windows quoted argument overflow is rejected', async () => {
  const f = launchFixture(); await rejects(run(f, () => true), 'AI_REPORT_PROTECTION');
  await rejects(run(f, () => false, 'x'.repeat(30001)), 'AI_INPUT_LIMIT');
  await rejects(run(f, () => { throw Error('private secret'); }), 'AI_REPORT_PROTECTION');
  if (process.platform === 'win32') await rejects(run(f, () => false, '"'.repeat(20000)), 'AI_INPUT_LIMIT');
  assert.equal(f.calls, 0);
});

test('local wall timeout kills worker and ignores late success', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 0 });
  const f = launchFixture({ neverClose: true }); const p = run(f);
  t.mock.timers.tick(600001); await rejects(p, 'AI_EXECUTION_TIMEOUT');
  f.child.stdout.write(envelope()); f.child.emit('close', 0);
  assert.equal(f.killed, 1); assert.equal(fs.existsSync(f.cwd), false);
});

test('in-flight report protection remains fail-closed when guard throws', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 0 });
  let checks = 0; const f = launchFixture({ neverClose: true });
  const p = run(f, () => { if (++checks > 1) throw Error('private secret'); return false; });
  t.mock.timers.tick(1000); await rejects(p, 'AI_REPORT_PROTECTION'); assert.equal(f.killed, 1);
});

test('fresh evidence rules remain strict after structural validation', () => {
  const evidence = fact('contracts', 'known', 'Fixture', 'Fixture contract date');
  const snapshot = { sources: { contracts: '연결' }, facts: [evidence] };
  assert.match(renderAnswer(JSON.stringify({ factIds: [evidence.id], advice: '' }), snapshot), /출처/);
  assert.throws(() => renderAnswer(JSON.stringify({ factIds: ['stale'], advice: '' }), snapshot), { code: 'AI_EVIDENCE' });
  assert.throws(() => renderAnswer(JSON.stringify({ factIds: [], advice: ADVICE[1] }), snapshot), { code: 'AI_EVIDENCE' });
  assert.throws(() => renderAnswer('{', snapshot), { code: 'AI_OUTPUT_JSON' });
});

test('failure pipeline persists safe exit/type, pauses retries and never posts', async () => {
  const now = new Date('2026-11-16T03:00:00Z'), state = initialState();
  state.questions.q = { id: 'q', text: '계약서 확인', at: now.toISOString(), status: 'pending' };
  let calls = 0, posts = 0;
  const io = { now: () => now, reportLedger: () => ({}), save: () => {}, policy: '', readSources: async () => ({ sources: {contracts: '연결'}, facts: [] }),
    generate: async () => { calls++; throw aiFailure('AI_REQUEST_SCHEMA', { exitCode: 3, signal: 'invalid private secret' }); }, post: async () => { posts++; } };
  await answerPending(state, { maxDailyCalls: null }, io);
  assert.deepEqual(state.questions.q.failure, { type: 'AI_REQUEST_SCHEMA', exitCode: 3 });
  state.questions.next = { id: 'next', text: '계약 확인', status: 'pending' };
  await answerPending(state, { maxDailyCalls: null }, io);
  assert.equal(calls, 1); assert.equal(posts, 0); assert.equal(state.aiPausedDay, '2026-11-16');
  assert.ok(!JSON.stringify(state).includes('private secret'));
});

test('evidence failure is distinguished from execution and still pauses further generation', async () => {
  const now = new Date('2026-11-16T03:00:00Z'), state = initialState();
  state.questions.q = { id: 'q', text: '계약서 확인', status: 'pending' };
  await answerPending(state, { maxDailyCalls: null }, { now: () => now, reportLedger: () => ({}), save: () => {}, policy: '', readSources: async () => ({ sources: {contracts: '연결'}, facts: [] }), generate: async () => JSON.stringify({ factIds: ['invented'], advice: '' }) });
  assert.equal(state.questions.q.failure.type, 'AI_EVIDENCE'); assert.equal(state.questions.q.status, 'blocked');
});


test('regression: already-corrupted question-mark advice is rejected instead of accepted as Korean', async () => {
  await rejects(run(launchFixture({ output: envelope({factIds: [], advice: '?? ??'}) })), 'AI_OUTPUT_SCHEMA', 0);
});

test('stdout/stderr read errors settle once without exposing raw exceptions', async () => {
  for (const stream of ['stdout', 'stderr']) {
    const f = launchFixture({neverClose: true}), p = run(f);
    f.child[stream].emit('error', Error('private secret'));
    await rejects(p, 'AI_EXIT_ERROR'); assert.equal(f.killed, 1);
  }
});

test('real offline child process confirms UTF-8 pipes and JSON envelope ingestion', async () => {
  const value = { factIds: ['fixture'], advice: ADVICE[1] };
  let calls = 0;
  const launch = (file, args, options) => {
    calls++;
    return spawn(process.execPath, ['-e', 'process.stdout.write(' + JSON.stringify(envelope(value)) + ')'], options);
  };
  assert.deepEqual(JSON.parse(await generateAntigravity('synthetic offline process', () => false, {launch})), value);
  assert.equal(calls, 1);
});

test('real offline exit-3 schema error survives store restart and pauses further calls', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiboot-boundary-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  let store = openStore(dir), calls = 0;
  const now = new Date('2026-11-16T03:00:00Z');
  store.state.questions.q = {id:'q',text:'계약서 확인',status:'pending'};store.save();
  const output = JSON.stringify({status:'ERROR',error:'INVALID_ARGUMENT (400): advice.enum[0]: cannot be empty; private secret'});
  const launch = (file, args, options) => { calls++; return spawn(process.execPath, ['-e', 'process.stdout.write(' + JSON.stringify(output) + '); process.exitCode=3;'], options); };
  try {
    await answerPending(store.state, {maxDailyCalls:null}, {now:()=>now,reportLedger:()=>({}),save:store.save,policy:'',readSources:async()=>({sources:{contracts:'연결'},facts:[]}),generate:(p,b)=>generateAntigravity(p,b,{launch})});
  } finally {store.close();}
  store=openStore(dir);
  try {
    assert.deepEqual(store.state.questions.q.failure,{type:'AI_REQUEST_SCHEMA',exitCode:3});
    assert.equal(store.state.questions.q.status,'blocked');
    assert.equal(store.state.aiPausedDay,'2026-11-16');
    assert.ok(!fs.readFileSync(path.join(dir,'state.json'),'utf8').includes('private secret'));
  } finally {store.close();}
  assert.equal(calls,1);
});

test('successful explicitly retried preview clears obsolete failure diagnostics', async () => {
  const state=initialState(),now=new Date('2026-11-16T03:00:00Z');
  state.questions.q={id:'q',text:'계약 확인',status:'pending',error:'old',failure:{type:'AI_EXIT_ERROR'}};
  await answerPending(state,{maxDailyCalls:null},{now:()=>now,reportLedger:()=>({}),save:()=>{},policy:'',readSources:async()=>({sources:{contracts:'연결'},facts:[]}),generate:async()=>JSON.stringify(good)});
  assert.equal(state.questions.q.status,'preview');assert.equal(state.questions.q.error,undefined);assert.equal(state.questions.q.failure,undefined);
});
