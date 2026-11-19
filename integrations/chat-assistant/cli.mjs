#!/usr/bin/env node
import fs from 'node:fs';
import { executionBusy } from '../report-scheduler/execution.mjs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { collect, answerPending, deliverPreview, validateConfig, proposals, aiFailure, PROMPT_MAX } from './core.mjs';
import { readCompletionSource } from './sources.mjs';
import { openStore } from './store.mjs';
import { clients, readSources, fixedRules, recentReports } from './sources.mjs';

export function generateAntigravity(text, blocked, { executable = path.join(os.homedir(), 'AppData/Local/agy/bin/agy.exe'), launch = spawn } = {}) {
  try {
    if (typeof text !== 'string' || text.length > PROMPT_MAX) return Promise.reject(aiFailure('AI_INPUT_LIMIT'));
    if (blocked()) return Promise.reject(aiFailure('AI_REPORT_PROTECTION'));
  } catch { return Promise.reject(aiFailure('AI_REPORT_PROTECTION')); }
  // Conservative OpenAPI-compatible wire types. Empty advice is valid STRING;
  // the existing ADVICE allowlist, array cap and closed object are enforced locally.
  const schema = { type: 'object', properties: { factIds: { type: 'array', maxItems: 12, items: { type: 'string' } }, advice: { type: 'string' } }, required: ['factIds', 'advice'] };
  let temporary;
  try { temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aiboot-dialog-')); }
  catch { return Promise.reject(aiFailure('AI_SPAWN_ERROR')); }
  return new Promise((resolve, reject) => {
    let child, pending = '', envelope, hasResult = false, invalid = false, stderr = '', settled = false, timer;
    const details = {};
    const finish = (code, value) => {
      if (settled) return;
      settled = true; clearInterval(timer);
      try { fs.rmSync(temporary, { recursive: true, force: true }); } catch {}
      code ? reject(aiFailure(code, details)) : resolve(JSON.stringify(value));
    };
    const stop = code => {
      try { child?.kill(); } catch {}
      finish(code);
    };
    // Classify only terminal errors, never benign stderr notices such as quota refresh.
    const classify = text => {
      if (/INVALID_ARGUMENT|json.?schema|schema.{0,40}(invalid|unsupported)|enum.{0,80}(empty|invalid)|parameters\.properties/i.test(text)) return 'AI_REQUEST_SCHEMA';
      if (/RESOURCE_EXHAUSTED|\b429\b|quota.{0,40}(exceeded|exhausted)|rate.?limit.{0,40}(exceeded|exhausted)|out of (quota|credits)/i.test(text)) return 'AI_SUBSCRIPTION_LIMIT';
      if (/output token limit|maximum output|response.{0,30}cut off/i.test(text)) return 'AI_OUTPUT_TOKEN_LIMIT';
      if (/UNAUTHENTICATED|PERMISSION_DENIED|authentication required|unauthorized|\b(401|403)\b/i.test(text)) return 'AI_AUTH_ERROR';
      if (/timed? ?out|deadline exceeded|DEADLINE_EXCEEDED/i.test(text)) return 'AI_EXECUTION_TIMEOUT';
      return 'AI_EXIT_ERROR';
    };
    const args = ['--settings', JSON.stringify({ useG1Credits: false, agentMode: '', toolPermission: 'strict' }), '--disable-slash-commands', '--input-format', 'stream-json', '--output-format', 'stream-json', '--json-schema', JSON.stringify(schema), '--print-timeout', '540s'];
    // Count UTF-16 command-line units after Windows quoting, including JSON quotes.
    const quotedLength = value => {
      let length = 2, slashes = 0;
      for (let i = 0; i < value.length; i++) {
        if (value[i] === '\\') { slashes++; continue; }
        length += value[i] === '"' ? slashes * 2 + 2 : slashes + 1; slashes = 0;
      }
      return length + slashes * 2;
    };
    if (process.platform === 'win32' && [executable, ...args].reduce((n, value) => n + quotedLength(value) + 1, 0) >= 32767) { finish('AI_INPUT_LIMIT'); return; }
    try {
      child = launch(executable, args, { cwd: temporary, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    } catch { stop('AI_SPAWN_ERROR'); return; }
    const deadline = Date.now() + 10 * 60000;
    timer = setInterval(() => {
      if (settled) return;
      try { if (blocked()) { stop('AI_REPORT_PROTECTION'); return; } }
      catch { stop('AI_REPORT_PROTECTION'); return; }
      if (Date.now() >= deadline) stop('AI_EXECUTION_TIMEOUT');
    }, 1000);
    const readLine = line => {
      if (!line.trim()) return;
      if (Buffer.byteLength(line, 'utf8') > 64000) { stop('AI_OUTPUT_LIMIT'); return; }
      let event;
      try { event = JSON.parse(line.replace(/^\uFEFF/, '')); }
      catch { invalid = true; return; }
      if (!event || !['init', 'step_update', 'result'].includes(event.event) || hasResult) { invalid = true; return; }
      if (event.event === 'result') { hasResult = true; envelope = event.result; }
    };
    child.stdout.on('data', chunk => {
      if (settled) return;
      pending += chunk;
      let newline;
      while (!settled && (newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        readLine(line);
      }
      if (!settled && Buffer.byteLength(pending, 'utf8') > 64000) stop('AI_OUTPUT_LIMIT');
    });
    child.stderr.on('data', chunk => { if (!settled) stderr = (stderr + chunk).slice(-8000); });
    child.stdout.on('error', () => stop('AI_EXIT_ERROR'));
    child.stderr.on('error', () => stop('AI_EXIT_ERROR'));
    child.on('error', () => stop('AI_SPAWN_ERROR'));
    child.on('close', (exitCode, signal) => {
      if (settled) return;
      if (Number.isInteger(exitCode)) details.exitCode = exitCode;
      if (typeof signal === 'string' && /^SIG[A-Z0-9]+$/.test(signal)) details.signal = signal;
      if (pending) readLine(pending);
      if (settled) return;
      if (invalid || !envelope) { finish(exitCode === 0 ? 'AI_OUTPUT_JSON' : classify(stderr)); return; }
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || typeof envelope.status !== 'string') { finish('AI_OUTPUT_SCHEMA'); return; }
      if (exitCode !== 0 || envelope.status !== 'SUCCESS') {
        finish(classify(typeof envelope.error === 'string' && envelope.error ? envelope.error : stderr)); return;
      }
      if (!Object.hasOwn(envelope, 'structured_output')) { finish('AI_OUTPUT_SCHEMA'); return; }
      finish(null, envelope.structured_output);
    });
    child.stdin.on('error', () => stop('AI_EXIT_ERROR'));
    try { child.stdin.end(JSON.stringify({ event: 'user', message: { content: text } }) + '\n', 'utf8'); }
    catch { stop('AI_EXIT_ERROR'); }
  });
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.some(x => !['--once', '--loop', '--propose', '--send'].includes(x)) || argv.includes('--once') && argv.includes('--loop')) throw new Error('허용 옵션: --once, --loop, --propose, --send');
  const home = path.join(os.homedir(), '.aiboot');
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const report = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  const c = JSON.parse(fs.readFileSync(path.join(home, 'assistant.json'), 'utf8'));
  validateConfig(c, report);
  if (argv.includes('--send') && c.deliveryApproved !== true) throw new Error('실제 발송 미승인');
  const rules = fixedRules(repo), api = clients(report, home);
  const store = openStore(path.join(home, 'assistant'));
  // Changing the owner or space never silently reuses an old collection cursor or pending answers.
  const identity = `${c.space}|${c.owner}|${c.startAt}`;
  if (store.state.identity && store.state.identity !== identity) { store.close(); throw new Error('대화 공간/사용자/시작시각 변경 — 상태 이관 확인 필요'); }
  store.state.identity = identity; store.save();
  const ledger = () => JSON.parse(fs.readFileSync(path.join(home, 'ledger.json'), 'utf8'));
  const read = ids => readSources(ids, { report, chat: api.chat, sheets: api.sheets, rules, home, completionHistory: store.state.completionHistory });
  try {
    do {
      try {
        const collection = await collect(store.state, c, async args => (await api.chat.spaces.messages.list(args)).data, store.save, new Date());
        const io = { now: () => new Date(), reportLedger: ledger, executionBusy: () => executionBusy(home), readSources: read, save: store.save,
          policy: ['CURRENT.md', 'docs/FIXED-EXPENSES-V1.md'].map(file => `### ${file}\n` + fs.readFileSync(path.join(repo, file), 'utf8')).join('\n\n'), generate: generateAntigravity,
          readCompletionSource: () => readCompletionSource({ report, sheets: api.sheets, home }),
          post: async text => {
            // Existing URL is read, never modified. One-way webhook sending is opt-in only after approval.
            const response = await fetch(report.webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ text: `[AIBoot 대화]\n${text}` }), signal: AbortSignal.timeout(20000) });
            if (!response.ok) throw new Error('웹훅 실패');
            const value = await response.json();
            if (!value.name?.startsWith(`${c.space}/messages/`)) throw new Error('발송 접수 확인 불가');
            return value;
          } };
        const reports = recentReports(home);
        store.state.context = store.state.context.filter(x => !x.reportId).concat(reports.items);
        const result = await answerPending(store.state, c, io);
        store.save();
        if (argv.includes('--propose')) {
          const snapshot = await read(['fixed', 'contracts', 'licenses', 'welfare', 'recurring', 'chat']);
          const result = proposals(snapshot, recentReports(home), store.state, new Date());
          store.state.lastProposalCheck = { at: new Date().toISOString(), status: result.status }; store.save();
          console.log(result.status); // No business data or candidates in console/Git.
        }
        if (argv.includes('--send')) console.log((await deliverPreview(store.state, c, io)).status);
        console.log(JSON.stringify({ collection: collection.complete ? '완전 조회' : collection.reason, answer: result.status }));
      } catch {
        console.error('조회/처리 확인 불가 — 상태 보존, 자동 발송/AI 재시도 없음');
        if (!argv.includes('--loop')) { process.exitCode = 1; break; }
      }
      if (!argv.includes('--loop')) break;
      await delay(60000); // One poll per minute; no new Windows scheduled task is registered.
    } while (true);
  } finally { store.close(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error('설정/권한/상태 확인 불가 — 실행 중단'); process.exitCode = 1; });
