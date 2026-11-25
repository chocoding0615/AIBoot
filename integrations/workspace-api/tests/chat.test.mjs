import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WorkspaceReader } from '../reader.mjs';
import { WorkspaceChatService, AGENTS, resolveTargets } from '../chat.mjs';
import { createApi } from '../../report-scheduler/api.mjs';
import { createSessionBackend } from '../session.mjs';

const token = 'c'.repeat(64);
const pairing = 'd'.repeat(64);
const uiOrigin = 'http://127.0.0.1:5173';
const fixedDate = new Date('2026-11-25T13:00:00+09:00');

function fixture(t, { delayMs = 0, failAi = null, aiFactIds = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiboot-chat-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const write = (name, v) => {
    fs.mkdirSync(path.dirname(path.join(home, name)), { recursive: true });
    fs.writeFileSync(path.join(home, name), typeof v === 'string' ? v : JSON.stringify(v));
  };

  const config = {
    spreadsheetId: 'fixed-sheet-id',
    opsSpreadsheetId: 'ops-sheet-id',
    recurringSpreadsheetId: 'recurring-sheet-id',
    contractsSpreadsheetId: 'contract-sheet-id',
    chatSpaces: ['spaces/test-1', 'spaces/test-2'],
    sourceSheetIds: { fixed: 1, daily: 2, contracts: 3, licenses: 4, welfare: 5, recurring: 6, history: 7, master: 8 },
  };

  write('config.json', config);
  write('ledger.json', {});
  write('holidays.json', { fetched: '2026-11-25', names: {}, days: [] });

  const calls = [];
  const io = {
    chat: {
      spaces: {
        messages: {
          list: async (a, o) => {
            calls.push({ service: 'chat', args: a });
            return { data: { messages: [] } };
          },
        },
      },
    },
    sheets: () => ({
      get: async (a, o) => {
        calls.push({ service: 'sheets', args: a });
        if (!a.ranges) {
          const defs = a.spreadsheetId === 'fixed-sheet-id'
            ? ['[MS] AD_관리비 내역', [[1, 'JP매월 지출'], [2, 'AIBoot_데일리마감']]]
            : a.spreadsheetId === 'ops-sheet-id'
            ? ['[MS] AD_운영 관리', [[5, '복지포인트 관리(2026)']]]
            : a.spreadsheetId === 'contract-sheet-id'
            ? ['[MS] AD_계약서 관리', [[3, '계약서(DB)'], [4, '프로그램(2026)']]]
            : ['[MS] 김현호', [[6, '업무'], [7, '반복업무_처리이력'], [8, 'Master_Sheet']]];
          return { data: { properties: { title: defs[0] }, sheets: defs[1].map(([sheetId, title]) => ({ properties: { sheetId, title, hidden: true } })) } };
        }
        if (a.spreadsheetId === 'fixed-sheet-id') {
          return {
            data: {
              sheets: [
                {
                  data: [
                    {
                      rowData: [
                        { values: [{ formattedValue: '2026-11' }, { formattedValue: '전기요금' }, { formattedValue: '한국전력' }] },
                      ],
                    },
                  ],
                },
              ],
            },
          };
        }
        return { data: { sheets: [{ data: [{ rowData: [] }] }] } };
      },
      values: {
        batchGet: async (a, o) => {
          calls.push({ service: 'sheets.values.batchGet', args: a });
          if (a.spreadsheetId === 'contract-sheet-id') {
            // ranges: 6개(C5:C, D5:D, E5:E, I5:I, N5:N, O5:O) 또는 4개 차량보험(C5:C300, E5:E300, I5:I300, Q5:Q300)
            if (a.ranges.length === 6) {
              return {
                data: {
                  valueRanges: [
                    { values: [['용역']] }, // C: 분류
                    { values: [['더존비즈온']] }, // D: 거래처
                    { values: [['ERP 유지보수']] }, // E: 계약명
                    { values: [['2026-11-28']] }, // I: 종료일
                    { values: [['N']] }, // N: 자동연장
                    { values: [['N']] }, // O: 해지
                  ],
                },
              };
            }
            if (a.ranges.length === 4) {
              return {
                data: {
                  valueRanges: [
                    { values: [['보험료']] },
                    { values: [['법인차량 1234']] },
                    { values: [['2026-11-28']] },
                    { values: [['재가입 완료']] },
                  ],
                },
              };
            }
          }
          if (a.spreadsheetId === 'ops-sheet-id') {
            return {
              data: {
                valueRanges: [
                  { values: [['1'], ['2'], ['3']] }, // A: 번호
                  { values: [['2026-11-28'], ['2026-11-28'], ['2026-11-28']] }, // E: 적용일
                ],
              },
            };
          }
          return { data: { valueRanges: [] } };
        },
      },
    }),
  };

  const rules = {
    fixedFacts: (date, jp) => ({
      imminent: [{ vendor: '한국전력', date: '2026-11-28' }],
      lines: ['- 한국전력: 전기요금 2026-11-28 (D-3)'],
      sched: [],
    }),
    daysBetween: () => 3,
    bucketOf: () => '7일 임박',
    welfareTab: () => '복지포인트 관리(2026)',
  };

  const reader = new WorkspaceReader({
    home,
    clock: () => fixedDate,
    makeClients: () => io,
    rules,
  });

  const mockGenerate = async (promptText, blocked) => {
    if (delayMs > 0) {
      await new Promise(r => setTimeout(r, delayMs));
    }
    if (failAi) throw Object.assign(new Error(failAi), { code: failAi });
    if (blocked()) throw Object.assign(new Error('AI_REPORT_PROTECTION'), { code: 'AI_REPORT_PROTECTION' });

    // promptText 안에 있는 snapshot JSON 파싱
    const marker = '{"question":';
    const jsonIdx = promptText.indexOf(marker);
    let facts = [];
    if (jsonIdx >= 0) {
      try {
        const payload = JSON.parse(promptText.slice(jsonIdx));
        facts = payload.fresh?.facts || [];
      } catch {}
    }

    const factIds = aiFactIds !== null ? aiFactIds : facts.slice(0, 3).map(f => f.id);
    return JSON.stringify({
      factIds,
      advice: factIds.length ? '사전 준비를 검토하세요.' : '',
    });
  };

  const chatService = new WorkspaceChatService({
    reader,
    generate: mockGenerate,
    clock: () => fixedDate,
    home,
    jobTimeoutMs: 500,
  });

  return { home, write, reader, chatService, calls, mockGenerate };
}

test('에이전트 멘션 파싱 및 우선순위 검증', () => {
  assert.deepEqual(resolveTargets('@고정비 전기요금 알려줘', null).ids, ['fixed']);
  assert.deepEqual(resolveTargets('@복지 포인트 언제 나와?', 'fixed').ids, ['welfare']); // 멘션 우선
  assert.deepEqual(resolveTargets('@고정비 @복지 같이 확인해줘', null).ids, ['fixed', 'welfare']); // 복수 멘션
  assert.deepEqual(resolveTargets('@계약 만료일 언제야?', 'general').ids, ['contracts']);
  assert.deepEqual(resolveTargets('@총괄비서 이번 주 일정 요약해줘', null).ids, ['general']);
  assert.deepEqual(resolveTargets('단순 질문입니다', 'fixed').ids, ['fixed']); // 선택된 에이전트
  assert.deepEqual(resolveTargets('단순 질문입니다', null).ids, ['general']); // 기본값 총괄 비서
});

test('고정비 담당 질문: fixed 소스만 조회하고 답변 생성', async t => {
  const f = fixture(t);
  const sub = f.chatService.submit({ text: '@고정비 11월 전기요금 언제까지 내야 해?' });
  assert.ok(['queued', 'processing'].includes(sub.status));
  assert.deepEqual(sub.targetAgents, ['fixed']);

  // 작업 완료 대기
  let res;
  for (let i = 0; i < 20; i++) {
    res = f.chatService.get(sub.jobId);
    if (res.status === 'completed' || res.status === 'failed') break;
    await new Promise(r => setTimeout(r, 50));
  }

  assert.equal(res.status, 'completed');
  assert.equal(res.items.length, 1);
  assert.equal(res.items[0].id, 'fixed');
  assert.equal(res.items[0].name, '고정비 담당');
  assert.ok(res.items[0].text.includes('최신 원본 확인'));
  assert.ok(res.items[0].text.includes('한국전력'));
  // 조회한 외부 호출 확인: fixed 시트만 호출되고 ops/contract/chat은 호출되지 않음
  assert.ok(f.calls.some(c => c.args.spreadsheetId === 'fixed-sheet-id'));
  assert.ok(!f.calls.some(c => c.args.spreadsheetId === 'contract-sheet-id'));
  assert.ok(!f.calls.some(c => c.args.spreadsheetId === 'ops-sheet-id'));
});

test('복지 담당 질문: welfare 소스만 조회', async t => {
  const f = fixture(t);
  const sub = f.chatService.submit({ text: '@복지 이번 달 복지포인트 적용일 알려줘' });
  let res;
  for (let i = 0; i < 20; i++) {
    res = f.chatService.get(sub.jobId);
    if (res.status === 'completed' || res.status === 'failed') break;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.equal(res.status, 'completed');
  assert.equal(res.items[0].id, 'welfare');
  assert.ok(f.calls.some(c => c.args.spreadsheetId === 'ops-sheet-id'));
  assert.ok(!f.calls.some(c => c.args.spreadsheetId === 'fixed-sheet-id'));
});

test('계약 담당 질문: contracts 소스만 조회', async t => {
  const f = fixture(t);
  const sub = f.chatService.submit({ text: '@계약 만료 임박한 계약서 있어?' });
  let res;
  for (let i = 0; i < 20; i++) {
    res = f.chatService.get(sub.jobId);
    if (res.status === 'completed' || res.status === 'failed') break;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.equal(res.status, 'completed');
  assert.equal(res.items[0].id, 'contracts');
  assert.ok(f.calls.some(c => c.args.spreadsheetId === 'contract-sheet-id'));
  assert.ok(!f.calls.some(c => c.args.spreadsheetId === 'fixed-sheet-id'));
});

test('총괄 비서 질문 (모호한 질문): 직접 조회 0건 및 안내 메시지 즉시 반환', async t => {
  const f = fixture(t);
  const sub = f.chatService.submit({ text: '안녕하세요 오늘 날씨 어때요?' });
  let res;
  for (let i = 0; i < 20; i++) {
    res = f.chatService.get(sub.jobId);
    if (res.status === 'completed' || res.status === 'failed') break;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.equal(res.status, 'completed');
  assert.equal(res.items[0].id, 'general');
  assert.ok(res.items[0].text.includes('어떤 업무를 확인할까요'));
  assert.equal(f.calls.length, 0); // 직접 시트 조회 0건
});

test('총괄 비서 질문 (업무 키워드 포함): 해당 담당으로 조율 연결', async t => {
  const f = fixture(t);
  const sub = f.chatService.submit({ text: '이번 달 전기요금 지출 관련해서 확인해줘' });
  let res;
  for (let i = 0; i < 20; i++) {
    res = f.chatService.get(sub.jobId);
    if (res.status === 'completed' || res.status === 'failed') break;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.equal(res.status, 'completed');
  assert.ok(res.items.some(it => it.id === 'general' && it.text.includes('총괄 비서 조율')));
  assert.ok(res.items.some(it => it.id === 'fixed'));
  assert.ok(f.calls.some(c => c.args.spreadsheetId === 'fixed-sheet-id'));
});

test('복수 담당 호출: @고정비 @복지 모두 응답 생성', async t => {
  const f = fixture(t);
  const sub = f.chatService.submit({ text: '@고정비 @복지 이번 달 지출과 복지 현황 둘 다 알려줘' });
  let res;
  for (let i = 0; i < 20; i++) {
    res = f.chatService.get(sub.jobId);
    if (res.status === 'completed' || res.status === 'failed') break;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.equal(res.status, 'completed');
  assert.equal(res.items.length, 2);
  assert.ok(res.items.some(it => it.id === 'fixed'));
  assert.ok(res.items.some(it => it.id === 'welfare'));
});

test('근거 없는 AI 응답 (factIds 불일치)은 AI_EVIDENCE 에러로 차단', async t => {
  const f = fixture(t, { aiFactIds: ['fake-fact-id-not-in-snapshot'] });
  const sub = f.chatService.submit({ text: '@고정비 전기요금 알려줘' });
  let res;
  for (let i = 0; i < 20; i++) {
    res = f.chatService.get(sub.jobId);
    if (res.status === 'completed' || res.status === 'failed') break;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.equal(res.status, 'failed');
  assert.equal(res.error.code, 'AI_EVIDENCE');
});

test('실행 시간 초과 시 AI_EXECUTION_TIMEOUT으로 안전 종료', async t => {
  const f = fixture(t, { delayMs: 800 }); // timeout is 500ms
  const sub = f.chatService.submit({ text: '@고정비 전기요금 알려줘' });
  let res;
  for (let i = 0; i < 25; i++) {
    res = f.chatService.get(sub.jobId);
    if (res.status === 'completed' || res.status === 'failed') break;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.equal(res.status, 'failed');
  assert.equal(res.error.code, 'AI_EXECUTION_TIMEOUT');
});

test('사용자 취소 시 즉시 cancelled 처리', async t => {
  const f = fixture(t, { delayMs: 500 });
  const sub = f.chatService.submit({ text: '@고정비 전기요금 알려줘' });
  const cancelRes = f.chatService.cancel(sub.jobId);
  assert.equal(cancelRes.status, 'cancelled');
  const res = f.chatService.get(sub.jobId);
  assert.equal(res.status, 'cancelled');
  assert.equal(res.error.code, 'CLIENT_CANCELLED');
});

test('동시 요청 시 RATE_LIMITED(429) 거절', async t => {
  const f = fixture(t, { delayMs: 500 });
  f.chatService.submit({ text: '@고정비 전기요금 1' });
  assert.throws(() => f.chatService.submit({ text: '@고정비 전기요금 2' }), { code: 'RATE_LIMITED' });
});

test('정기 보고 보호 시간대에는 409 REPORT_PROTECTED 거절', async t => {
  const f = fixture(t);
  f.reader.clock = () => new Date('2026-11-25T09:30:00+09:00'); // 정기 보고 보호 시간대
  assert.throws(() => f.chatService.submit({ text: '@고정비 전기요금' }), { code: 'REPORT_PROTECTED' });
});

test('세션 백엔드 및 제어 API 엔드포인트 통합 검증', async t => {
  const f = fixture(t);
  const control = createApi({
    reader: f.reader,
    service: { list: () => ({ items: [] }), mutate: () => {} },
    chatService: f.chatService,
    token,
  });
  const a = await control.listen();
  t.after(() => control.close());

  const browser = createSessionBackend({
    controlUrl: 'http://127.0.0.1:' + a.port,
    controlToken: token,
    pairingCode: pairing,
    pairingExpiresAt: Date.now() + 600000,
    uiOrigin,
  });
  const b = await browser.listen();
  t.after(() => browser.close());

  const base = 'http://127.0.0.1:' + b.port;

  // 1) 로그인 없이 요청 -> 401
  const unauth = await fetch(base + '/api/chat/messages', { method: 'POST', body: '{}' });
  assert.equal(unauth.status, 401);

  // 2) 정상 로그인
  const loginRes = await fetch(base + '/api/session', {
    method: 'POST',
    headers: { origin: uiOrigin, 'content-type': 'application/json' },
    body: JSON.stringify({ code: pairing }),
  });
  assert.equal(loginRes.status, 200);
  const cookie = loginRes.headers.get('set-cookie').split(';')[0];
  const csrf = (await loginRes.json()).data.csrfToken;
  const headers = { origin: uiOrigin, cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' };

  // 3) POST /api/chat/messages (접수 성공 -> 202)
  const submitRes = await fetch(base + '/api/chat/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify({ text: '@고정비 전기요금 얼마야?' }),
  });
  assert.equal(submitRes.status, 202);
  const subBody = await submitRes.json();
  assert.equal(subBody.status, 'ok');
  assert.ok(subBody.data.jobId);
  const jobId = subBody.data.jobId;

  // 4) GET /api/chat/messages/:jobId (폴링 -> 완료 시 200)
  let getRes, getBody;
  for (let i = 0; i < 20; i++) {
    getRes = await fetch(base + '/api/chat/messages/' + jobId, { headers });
    assert.equal(getRes.status, 200);
    getBody = await getRes.json();
    if (getBody.data.status === 'completed') break;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.equal(getBody.data.status, 'completed');
  assert.equal(getBody.data.items[0].id, 'fixed');

  // 5) POST /api/chat/messages/:jobId/cancel
  const cancelRes = await fetch(base + '/api/chat/messages/' + jobId + '/cancel', {
    method: 'POST',
    headers,
    body: '{}',
  });
  assert.equal(cancelRes.status, 200);
});
