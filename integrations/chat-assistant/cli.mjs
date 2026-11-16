#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { collect, answerPending, deliverPreview, validateConfig, proposals } from './core.mjs';
import { openStore } from './store.mjs';
import { clients, readSources, fixedRules, recentReports } from './sources.mjs';

export function generateAntigravity(text, blocked, { executable = path.join(os.homedir(), 'AppData/Local/agy/bin/agy.exe'), launch = spawn } = {}) {
  if (text.length > 30000 || blocked()) return Promise.reject(new Error('프롬프트 한도 또는 정기 보고 보호'));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aiboot-dialog-'));
  return new Promise((resolve, reject) => {
    let child, output = '', error = '', settled = false, timer;
    const finish = (failure, result) => {
      if (settled) return; settled = true; clearInterval(timer);
      try { fs.rmSync(temporary, { recursive: true, force: true }); } catch {}
      failure ? reject(new Error('AI 실행/한도/보고 보호 중단')) : resolve(result);
    };
    try { child = launch(executable, ['-p', text, '--mode', 'plan', '--print-timeout', '540s'], { cwd: temporary, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { finish(true); return; }
    const deadline = Date.now() + 10 * 60000;
    timer = setInterval(() => {
      let stop = true;
      try { stop = blocked() || Date.now() >= deadline; } catch {}
      if (stop) { child.kill(); finish(true); }
    }, 1000);
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 64000) { child.kill(); finish(true); } });
    child.stderr.on('data', chunk => { error = (error + chunk).slice(-8000); });
    child.on('error', () => finish(true));
    child.on('close', code => finish(code !== 0 || /quota|rate.?limit|resource.?exhausted|429/i.test(error) || !output.trim(), output.trim()));
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
  const read = ids => readSources(ids, { report, chat: api.chat, sheets: api.sheets, rules, home });
  try {
    do {
      try {
        const collection = await collect(store.state, c, async args => (await api.chat.spaces.messages.list(args)).data, store.save, new Date());
        const io = { now: () => new Date(), reportLedger: ledger, readSources: read, save: store.save,
          policy: fs.readFileSync(path.join(repo, 'CURRENT.md'), 'utf8'), generate: generateAntigravity,
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
