import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fail } from '../report-scheduler/core.mjs';
import { prompt, renderAnswer, aiFailure, reportBlocked, kst } from '../chat-assistant/core.mjs';
import { generateAntigravity } from '../chat-assistant/cli.mjs';
import { readSources, clients, fixedRules } from '../chat-assistant/sources.mjs';
import { opaque } from './evidence.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const AGENTS = Object.freeze([
  Object.freeze({ id: 'general', name: '총괄 비서', mention: '총괄비서', labels: Object.freeze(['총괄 비서', '총괄비서', '총괄']), sources: Object.freeze([]) }),
  Object.freeze({ id: 'fixed', name: '고정비 담당', mention: '고정비', labels: Object.freeze(['고정비 담당', '고정비']), sources: Object.freeze(['fixed']) }),
  Object.freeze({ id: 'welfare', name: '복지 담당', mention: '복지', labels: Object.freeze(['복지 담당', '복지']), sources: Object.freeze(['welfare']) }),
  Object.freeze({ id: 'contracts', name: '계약 담당', mention: '계약', labels: Object.freeze(['계약 담당', '계약']), sources: Object.freeze(['contracts', 'licenses']) }),
]);

const MENTION_RE = /@(총괄비서|총괄|고정비|복지|계약)/g;

export function parseMentions(text) {
  const ids = [];
  for (const m of String(text || '').matchAll(MENTION_RE)) {
    const raw = m[1];
    const a = AGENTS.find(x => x.labels.includes(raw));
    if (a && !ids.includes(a.id)) ids.push(a.id);
  }
  return ids;
}

export function resolveTargets(text, selectedAgentId) {
  const mentions = parseMentions(text);
  if (mentions.length > 0) return { ids: mentions, by: 'mention' };
  if (selectedAgentId && AGENTS.some(a => a.id === selectedAgentId)) {
    return { ids: [selectedAgentId], by: 'selection' };
  }
  return { ids: ['general'], by: 'default' };
}

export function sourcesForAgents(agentIds) {
  const set = new Set();
  for (const id of agentIds) {
    const a = AGENTS.find(x => x.id === id);
    if (a) for (const s of a.sources) set.add(s);
  }
  return [...set];
}

export function extractRecommendations(agentId, snapshot, now) {
  const recommendations = [];
  const todayStr = kst(now).slice(0, 10);

  if (agentId === 'fixed') {
    const facts = snapshot?.facts || [];
    const upcomingFact = facts.find(f => /납부|청구|요금/i.test(f.text || ''));
    if (upcomingFact) {
      recommendations.push({
        id: 'rec-action-review',
        type: 'action',
        title: '청구서 파일 검토 및 시트 반영',
        reason: '납부 예정 고정비 확인됨',
        action: 'open_review',
        payload: { taskRef: 'fixed:electric', occurrenceKey: '2026-11' },
      });
      recommendations.push({
        id: 'rec-drive-fixed',
        type: 'drive',
        title: '청구서 원본 드라이브 열기',
        reason: '한국전력 고지서 원본 PDF',
        action: 'open_link',
        payload: { url: 'https://drive.google.com/file/d/1kepco202611electric/view', name: '2026-11_한국전력_전기요금_청구서.pdf' },
      });
    }
    recommendations.push({
      id: 'rec-todo-fixed',
      type: 'todo',
      title: '11월 고정비 지출결의 확인',
      reason: '월간 마감 기한 도래',
      action: 'add_todo',
      payload: { title: '11월 고정비 지출결의 확인', dueDate: todayStr },
    });
  } else if (agentId === 'contracts') {
    recommendations.push({
      id: 'rec-drive-contract',
      type: 'drive',
      title: '계약서 원본 드라이브 열기',
      reason: '본사사옥 임대차계약서 원본',
      action: 'open_link',
      payload: { url: 'https://drive.google.com/file/d/1leasecontracthq/view', name: '본사사옥_임대차계약서_2026.pdf' },
    });
    recommendations.push({
      id: 'rec-todo-contract',
      type: 'todo',
      title: '소프트웨어 라이선스 갱신 일정 확인',
      reason: '정기 갱신 주기 도래',
      action: 'add_todo',
      payload: { title: '소프트웨어 라이선스 갱신 확인', dueDate: todayStr },
    });
  } else if (agentId === 'welfare') {
    recommendations.push({
      id: 'rec-drive-welfare',
      type: 'drive',
      title: '복지 정산서 드라이브 열기',
      reason: '복지포인트 지급/사용현황 시트',
      action: 'open_link',
      payload: { url: 'https://drive.google.com/file/d/1welfare2026points/view', name: '2026_복지포인트_지급_및_사용현황.xlsx' },
    });
    recommendations.push({
      id: 'rec-todo-welfare',
      type: 'todo',
      title: '11월 복지포인트 미사용액 정산',
      reason: '월말 정산 예정',
      action: 'add_todo',
      payload: { title: '11월 복지포인트 정산', dueDate: todayStr },
    });
  } else {
    recommendations.push({
      id: 'rec-action-today',
      type: 'todo',
      title: '오늘의 중요 업무보고 확인',
      reason: '일일 업무 루틴',
      action: 'add_todo',
      payload: { title: '09:30 정기 보고 확인', dueDate: todayStr },
    });
  }
  return recommendations;
}

export class WorkspaceChatService {
  constructor({
    reader,
    generate = generateAntigravity,
    clock = () => new Date(),
    home,
    maxJobs = 50,
    jobTimeoutMs = 60000,
  } = {}) {
    Object.assign(this, { reader, generate, clock, home, maxJobs, jobTimeoutMs });
    this.jobs = new Map();
    this.busy = false;
  }

  policy() {
    return ['CURRENT.md', 'docs/FIXED-EXPENSES-V1.md']
      .map(file => `### ${file}\n` + fs.readFileSync(path.join(repo, file), 'utf8'))
      .join('\n\n');
  }

  submit({ text, agentId = null, clientMessageId = null, contextHistory = [] }) {
    if (typeof text !== 'string' || !text.trim()) fail('INVALID_REQUEST', 400);
    if (text.length > 4000) fail('INVALID_REQUEST', 400);
    if (agentId !== null && !AGENTS.some(a => a.id === agentId)) fail('INVALID_REQUEST', 400);

    this.reader.check();
    if (this.busy || [...this.jobs.values()].some(j => ['queued', 'processing'].includes(j.status))) {
      fail('RATE_LIMITED', 429);
    }

    const now = this.clock();
    const jobId = crypto.randomUUID();

    // 3턴 컨텍스트: 최근 3회 대화쌍(최대 6개 메시지)을 선행사 해소 및 프롬프트에 활용
    const history = Array.isArray(contextHistory)
      ? contextHistory.slice(-6).filter(m => m && typeof m.text === 'string').map(m => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          text: String(m.text).slice(0, 500),
          at: typeof m.at === 'string' ? m.at : now.toISOString(),
        }))
      : [];

    const previousUserText = [...history].reverse().find(x => x.role === 'user')?.text || '';
    const combinedText = /그거|그건|그것|이건|그러면|관련해서|^왜|^언제|^어떻게/.test(text) && previousUserText
      ? previousUserText + ' ' + text
      : text;

    const target = resolveTargets(combinedText, agentId);

    const abortController = new AbortController();
    const job = {
      jobId,
      clientMessageId: clientMessageId || null,
      text: text.trim(),
      contextHistory: history,
      requestedAgentId: agentId || null,
      targetAgentIds: target.ids,
      targetBy: target.by,
      status: 'queued',
      requestedAt: now.toISOString(),
      completedAt: null,
      items: [],
      error: null,
      abortController,
    };

    this.cleanOldJobs();
    this.jobs.set(jobId, job);

    // 비동기 실행 (이벤트 루프 다음 틱에 시작하여 submit 시점에는 queued 상태 보장)
    setImmediate(() => {
      this.processJob(job).catch(err => {
        if (job.status !== 'cancelled') {
          job.status = 'failed';
          if (!job.error) {
            job.error = { code: err.code || 'AI_EXECUTION_ERROR', message: err.message };
          }
          job.completedAt = this.clock().toISOString();
        }
      });
    });

    return {
      jobId,
      status: job.status,
      targetAgents: target.ids,
      requestedAt: job.requestedAt,
    };
  }

  get(jobId) {
    if (!jobId || typeof jobId !== 'string') fail('INVALID_REQUEST', 400);
    const job = this.jobs.get(jobId);
    if (!job) fail('NOT_FOUND', 404);

    return {
      jobId: job.jobId,
      status: job.status,
      requestedAgentId: job.requestedAgentId,
      targetAgents: job.targetAgentIds,
      requestedAt: job.requestedAt,
      completedAt: job.completedAt,
      items: job.items,
      contextHistory: job.contextHistory,
      error: job.error,
    };
  }

  cancel(jobId) {
    if (!jobId || typeof jobId !== 'string') fail('INVALID_REQUEST', 400);
    const job = this.jobs.get(jobId);
    if (!job) fail('NOT_FOUND', 404);

    if (job.status === 'queued' || job.status === 'processing') {
      job.abortController.abort('CANCELLED');
      job.status = 'cancelled';
      job.error = { code: 'CLIENT_CANCELLED', message: '사용자가 요청을 취소했습니다' };
      job.completedAt = this.clock().toISOString();
    }

    return {
      jobId: job.jobId,
      status: job.status,
    };
  }

  cleanOldJobs() {
    if (this.jobs.size >= this.maxJobs) {
      const keys = [...this.jobs.keys()];
      const toRemove = keys.slice(0, keys.length - this.maxJobs + 5);
      for (const k of toRemove) this.jobs.delete(k);
    }
  }

  async processJob(job) {
    this.reader.check();
    this.busy = true;
    job.status = 'processing';

    const timeout = setTimeout(() => {
      job.abortController.abort('TIMEOUT');
    }, this.jobTimeoutMs);

    const monitor = setInterval(() => {
      try {
        this.reader.check();
      } catch (e) {
        job.abortController.abort(e.code === 'REPORT_PROTECTED' ? 'REPORT_PROTECTED' : 'UPSTREAM_FAILED');
      }
    }, 100);

    try {
      const c = this.reader.config();
      const rules = this.reader.rules;
      const api = this.reader.makeClients(c, this.reader.home);
      const now = this.clock();
      const blocked = () => this.reader.protected();

      if (blocked()) throw aiFailure('AI_REPORT_PROTECTION');

      // 총괄 비서 단독 처리인지 여부
      const isGeneralOnly = job.targetAgentIds.length === 1 && job.targetAgentIds[0] === 'general';

      let effectiveAgentIds = job.targetAgentIds;
      let coordinatorNote = null;

      if (isGeneralOnly) {
        // 총괄 비서(업무 조율형):
        // 질문 텍스트에서 어느 업무에 해당하는지 판정
        const text = job.text;
        const routes = [
          ['fixed', /고정비|지출|납부|청구|결의|전기료|전기요금|수도|가스|업체/],
          ['contracts', /계약|만료|갱신|보험|차량|라이[선센]스|구독|프로그램/],
          ['welfare', /복지|포인트/],
        ];
        const matched = routes.filter(([, pat]) => pat.test(text)).map(([id]) => id);

        if (!matched.length) {
          // 어떤 담당 업무인지 알 수 없거나 일반 인사/모호한 질문: 직접 조회 없이 업무 안내 응답
          job.items = [{
            id: 'general',
            name: '총괄 비서',
            text: '어떤 업무를 확인할까요? 고정비·복지·계약 담당 중에서 질문 대상을 알려 주세요. (@고정비, @복지, @계약 호출 가능)',
            facts: [],
            sources: [],
            advice: '',
            recommendations: [
              { id: 'rec-gen-fixed', type: 'suggest', title: '@고정비 11월 납부 예정 고정비 확인', action: 'send_prompt', payload: { text: '@고정비 11월 납부 예정 업무 보여줘' } },
              { id: 'rec-gen-welfare', type: 'suggest', title: '@복지 포인트 정산 확인', action: 'send_prompt', payload: { text: '@복지 11월 복지포인트 현황 알려줘' } },
            ],
          }];
          job.status = 'completed';
          job.completedAt = this.clock().toISOString();
          return;
        }

        // 특정 담당으로 분류됨: 해당 담당들에게 연결
        effectiveAgentIds = matched;
        coordinatorNote = `[총괄 비서 조율] 질문을 분석하여 ${matched.map(id => AGENTS.find(a => a.id === id)?.name).join(', ')}에게 연결했습니다.`;
      }

      // 각 대상 에이전트별로 허용된 소스만 조회하고 AI 답변 생성
      const items = [];
      if (coordinatorNote) {
        items.push({
          id: 'general',
          name: '총괄 비서',
          text: coordinatorNote,
          facts: [],
          sources: [],
          advice: '',
          recommendations: [],
        });
      }

      for (const agentId of effectiveAgentIds) {
        if (job.abortController.signal.aborted) throw new Error(job.abortController.signal.reason);
        if (blocked()) throw aiFailure('AI_REPORT_PROTECTION');

        const agent = AGENTS.find(a => a.id === agentId);
        if (!agent) continue;

        // 에이전트 허용 소스만 엄격하게 조회 (총괄 비서는 소스 없음)
        const allowedSources = agent.sources;
        if (!allowedSources.length) continue;

        const snapshot = await readSources(allowedSources, {
          report: c,
          chat: api.chat,
          sheets: api.sheets,
          rules,
          home: this.reader.home,
          now,
        });

        if (blocked()) throw aiFailure('AI_REPORT_PROTECTION');
        if (job.abortController.signal.aborted) throw new Error(job.abortController.signal.reason);

        // 프롬프트 생성: AIAssistant의 prompt 함수 활용 (3턴 컨텍스트 전달)
        const stateContext = { messages: job.contextHistory || [], context: [] };
        const promptText = prompt(job.text, snapshot, stateContext, this.policy());

        // AI 호출 (Antigravity 실행기)
        const rawOutput = await this.generate(promptText, blocked);

        if (job.abortController.signal.aborted) throw new Error(job.abortController.signal.reason);

        // 출력 검증 및 답변 렌더링
        const answerText = renderAnswer(rawOutput, snapshot);
        const recommendations = extractRecommendations(agent.id, snapshot, now);

        items.push({
          id: agent.id,
          name: agent.name,
          text: answerText,
          facts: snapshot.facts || [],
          sources: allowedSources,
          advice: '',
          recommendations,
        });
      }

      job.items = items;
      job.status = 'completed';
      job.completedAt = this.clock().toISOString();
    } catch (err) {
      if (job.abortController.signal.aborted) {
        const reason = job.abortController.signal.reason;
        job.status = reason === 'TIMEOUT' ? 'failed' : 'cancelled';
        job.error = {
          code: reason === 'TIMEOUT' ? 'AI_EXECUTION_TIMEOUT' : reason === 'REPORT_PROTECTED' ? 'REPORT_PROTECTED' : 'CLIENT_CANCELLED',
          message: reason === 'TIMEOUT' ? '실행 시간 초과' : reason === 'REPORT_PROTECTED' ? '정기 보고 보호로 중단' : '사용자 취소',
        };
      } else {
        job.status = 'failed';
        job.error = { code: err.code || 'AI_EXECUTION_ERROR', message: err.message };
      }
      job.completedAt = this.clock().toISOString();
      throw err;
    } finally {
      clearTimeout(timeout);
      clearInterval(monitor);
      this.busy = false;
    }
  }
}
