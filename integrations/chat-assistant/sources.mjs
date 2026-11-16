import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fact, kst } from './core.mjs';
import { readRecurringSource, recurringLines, loadHolidays, makeCalendar } from '../local-dual-report/recurring.mjs';
import { parseContracts, parseLicenses, parseVehicles, parseWelfare } from '../../tools/fixed-expense-flow/domains.mjs';

/** Same approach as build-evidence.mjs: reuse pure runner calculations without importing/running its main(). */
export function fixedRules(repo) {
  const src = fs.readFileSync(path.join(repo, 'integrations/local-dual-report/runner.mjs'), 'utf8');
  const start = src.indexOf('const IMMINENT_DAYS = '), end = src.indexOf('/* ---------- read-only snapshot ---------- */');
  if (start < 0 || end <= start || !src.slice(start, end).includes('function fixedFacts(')) throw new Error('고정비 계산 경계 변경 — 재검증 필요');
  const rules = fs.readFileSync(path.join(repo, 'docs/FIXED-EXPENSES-V1.md'), 'utf8');
  const context = vm.createContext({ REPO: repo, path, fs: { readFileSync: file => {
    if (file !== path.join(repo, 'docs/FIXED-EXPENSES-V1.md')) throw new Error('계산 함수의 허용되지 않은 파일 접근');
    return rules;
  } } });
  return vm.runInContext(src.slice(start, end) + '\n({fixedFacts, bucketOf, welfareTab, daysBetween})', context, { timeout: 1000 });
}
export function clients(report, home) {
  const require = createRequire(path.join(report.googleAuthDir, 'package.json'));
  const { google } = require('googleapis');
  function auth(tokenFile, keyFile) {
    const keys = JSON.parse(fs.readFileSync(keyFile, 'utf8')), k = keys.installed || keys.web;
    const client = new google.auth.OAuth2(k.client_id, k.client_secret, (k.redirect_uris || [])[0]);
    client.setCredentials(JSON.parse(fs.readFileSync(tokenFile, 'utf8')));
    return client;
  }
  const defaultKeys = path.join(report.googleAuthDir, 'dist/gcp-oauth.keys.json');
  return {
    chat: google.chat({ version: 'v1', auth: auth(path.join(home, 'chat-token.json'), report.chatOAuthKeys ? path.resolve(home, report.chatOAuthKeys) : defaultKeys) }),
    sheets: () => google.sheets({ version: 'v4', auth: auth(path.join(report.googleAuthDir, 'dist/.gsheets-server-credentials.json'), defaultKeys) }).spreadsheets
  };
}

/** Strictly reads only existing connected resources. Each failed category remains explicitly unavailable. */
export async function readSources(ids, { report, chat, sheets, rules, home, now = new Date(), fetcher = fetch }) {
  const date = kst(now).slice(0, 10), facts = [], sources = {};
  const add = (source, key, subject, text, extra) => facts.push(fact(source, key, subject, text, extra));
  const batch = async (spreadsheetId, ranges) => {
    if (!spreadsheetId) throw new Error('미설정');
    const result = await sheets().values.batchGet({ spreadsheetId, ranges });
    return result.data.valueRanges.map(r => r.values || []);
  };
  for (const source of [...new Set(ids)]) {
    const start = facts.length;
    try {
      if (source === 'fixed') {
        if (!report.spreadsheetId) throw new Error('미설정');
        const r = await sheets().get({ spreadsheetId: report.spreadsheetId, ranges: ["'JP매월 지출'!B1:V37"], includeGridData: true,
          fields: 'sheets(data(rowData(values(formattedValue,effectiveFormat(backgroundColor)))))' });
        const jp = (r.data.sheets[0].data[0].rowData || []).map(row => (row.values || []).map(v => {
          const bg = v.effectiveFormat?.backgroundColor;
          return { t: v.formattedValue || '', yellow: !!bg && Math.round((bg.red || 0) * 255) === 255 && Math.round((bg.green || 0) * 255) === 242 && Math.round((bg.blue || 0) * 255) === 204 };
        }));
        const calculated = rules.fixedFacts(date, jp);
        for (const item of calculated.imminent) {
          const line = calculated.lines.find(l => l.startsWith(`- ${item.vendor}:`));
          add(source, `${item.vendor}|${item.date}`, item.vendor, line, { date: item.date });
        }
        for (const item of calculated.sched.filter(s => !s.day)) add(source, `${item.vendor}|unknown`, item.vendor, `${item.vendor}: 회차 미확정 — 구체 근거 없이 미납/미처리 판정 금지`);
      } else if (source === 'contracts' || source === 'licenses') {
        const range = source === 'contracts' ? "'계약서 검색'!A6:N200" : "'프로그램(2026)'!A5:D60";
        const [values] = await batch(report.contractsSpreadsheetId, [range]);
        const parsed = source === 'contracts' ? parseContracts(values) : parseLicenses(values);
        for (const row of parsed.rows) {
          const end = row.end;
          if (!/^\d{4}-\d{2}-\d{2}$/.test(end) || new Date(end).toISOString().slice(0, 10) !== end) continue;
          const d = rules.daysBetween(date, end), bucket = rules.bucketOf(d);
          if (bucket) add(source, `${row.row}|${end}`, row.name, `${row.name}: ${row.what || ''} 종료 ${end}, ${bucket} (D-${d})${row.autoRenew ? ', 자동연장 표시' : ''}`, { date: end });
        }
        if (source === 'contracts') {
          const columns = await batch(report.contractsSpreadsheetId, ["'계약서(DB)'!C5:C300", "'계약서(DB)'!E5:E300", "'계약서(DB)'!I5:I300", "'계약서(DB)'!Q5:Q300"]);
          for (const row of parseVehicles(...columns)) if (row.end && !row.renewed && rules.daysBetween(date, row.end) < 0) add(source, `vehicle|${row.row}`, row.car, `${row.car}: 종료 ${row.end}, 계약서(DB) Q열 재가입 완료 표시 확인 필요(실제 미갱신 단정 금지)`);
        }
      } else if (source === 'welfare') {
        const tab = rules.welfareTab(date), [no, applied] = await batch(report.opsSpreadsheetId, [`'${tab}'!A8:A`, `'${tab}'!E8:E`]);
        for (const [when, count] of Object.entries(parseWelfare(no, applied).counts)) {
          const d = rules.daysBetween(date, when);
          if (d >= 0 && d <= 30) add(source, when, '복지포인트 적용', `${when} 복지포인트 적용 ${count}명 (D-${d})`, { date: when });
        }
      } else if (source === 'recurring') {
        if (!report.recurringSpreadsheetId) throw new Error('미설정');
        const raw = await readRecurringSource(sheets(), report.recurringSpreadsheetId);
        const holidays = await loadHolidays({ file: path.join(home, 'holidays.json'), today: date, save: false, fetcher });
        const lines = recurringLines(raw, makeCalendar(holidays, report), date);
        lines.forEach((text, i) => add(source, `${i}|${text}`, text.split(':')[0], text, { date: /\d{4}-\d{2}-\d{2}/.exec(text)?.[0] }));
      } else if (source === 'chat') {
        if (!Array.isArray(report.chatSpaces) || report.chatSpaces.length !== 2) throw new Error('지정 공간 확인 필요');
        for (const space of report.chatSpaces) {
          let pageToken, pages = 0;
          do {
            const parent = space.startsWith('spaces/') ? space : `spaces/${space}`;
            const response = await chat.spaces.messages.list({ parent, pageSize: 200, pageToken, orderBy: 'createTime asc',
              filter: `createTime > "${new Date(now.getTime() - 7 * 86400000).toISOString()}" AND createTime < "${now.toISOString()}"` });
            for (const m of response.data.messages || []) {
              if (!m.name || !m.text || m.sender?.type !== 'HUMAN') continue;
              add(source, m.name, '지정 스페이스 메시지', `원문 기재(업무 판정 아님): ${m.text.slice(0, 1500).replace(/01[016789]-?\d{3,4}-?\d{4}/g, '<전화번호 생략>')}${m.text.length > 1500 ? '…(이하 생략·일부 본문)' : ''}`, { truncated: m.text.length > 1500, link: `https://chat.google.com/room/${space.replace('spaces/', '')}/${m.name.split('/').pop()}` });
            }
            pageToken = response.data.nextPageToken;
            if (++pages >= 100 && pageToken) throw new Error('일부 조회/자료 누락');
          } while (pageToken);
        }
      } else throw new Error('허용되지 않은 자료');
      sources[source] = '연결';
    } catch {
      facts.splice(start); sources[source] = '조회 실패 또는 미설정';
    }
  }
  return { at: now.toISOString(), sources, facts };
}

/** Only sent regular report CHAT sections are comparison evidence. No ledger or report writes. */
export function recentReports(home, now = new Date()) {
  const ledger = JSON.parse(fs.readFileSync(path.join(home, 'ledger.json'), 'utf8'));
  const texts = [], items = [];
  let complete = true;
  for (const [key, entry] of Object.entries(ledger)) {
    if (!/^\d{4}-\d{2}-\d{2}\|(morning|afternoon)\|(codex|antigravity)$/.test(key) || entry.status !== 'sent') continue;
    const [date, slot, agent] = key.split('|');
    const age = Date.parse(kst(now).slice(0, 10)) - Date.parse(date);
    if (age < 0 || age > 7 * 86400000) continue;
    try {
      const raw = fs.readFileSync(path.join(home, 'reports', `${date}-${slot}-${agent}.md`), 'utf8');
      const chat = raw.slice(raw.lastIndexOf('=== CHAT ===') + 12).split('=== INTERNAL ===')[0].trim();
      if (!raw.includes('=== CHAT ===') || !chat) throw new Error('보고 형식');
      texts.push(chat);
      items.push({ reportId: key, at: new Date(`${date}T${slot === 'morning' ? '09:30' : '16:00'}:00+09:00`).toISOString(),
        historicalReportOnly: true, summary: chat.slice(0, 1000), truncated: chat.length > 1000 });
    } catch { complete = false; }
  }
  return { verified: complete && texts.length > 0, texts, items };
}
