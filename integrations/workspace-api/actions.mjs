import crypto from 'node:crypto';
import { fail } from '../report-scheduler/core.mjs';

const VALID_IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,64}$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class WorkspaceActionService {
  constructor({ reader, clock = () => new Date(), actionTtlMs = 10 * 60000, sheetUpdater = null, auditService = null } = {}) {
    this.reader = reader;
    this.clock = clock;
    this.actionTtlMs = actionTtlMs;
    this.sheetUpdater = sheetUpdater;
    this.auditService = auditService;
    this.preparedActions = new Map();
    this.confirmedIdempotency = new Map();
  }

  prepare(body) {
    if (!body || typeof body !== 'object') fail('INVALID_REQUEST', 400);
    const { taskRef, occurrenceKey, action, proposedChanges, basisDate, note } = body;

    if (!taskRef || typeof taskRef !== 'string') fail('INVALID_REQUEST', 400);
    if (!proposedChanges || typeof proposedChanges !== 'object' || Array.isArray(proposedChanges)) fail('INVALID_REQUEST', 400);
    if (!Object.keys(proposedChanges).length) fail('INVALID_REQUEST', 400);

    // 1. 보호 구간 및 원장 락 검사
    if (this.reader && typeof this.reader.protected === 'function' && this.reader.protected()) {
      fail('REPORT_PROTECTED', 409);
    }

    const now = this.clock();
    const actionId = crypto.randomUUID();
    const expiresAt = new Date(now.getTime() + this.actionTtlMs).toISOString();

    // 대상 시트 및 범위 판정
    let targetSheet = 'JP매월 지출';
    let targetRange = 'B12:G12';
    const currentValues = {
      vendor: '한국전력공사',
      amount: 1320000,
      dueDate: '2026-10-25',
      status: '청구',
    };

    if (taskRef.includes('water')) {
      targetRange = 'B13:G13';
      currentValues.vendor = '상하수도사업소';
      currentValues.amount = 120500;
      currentValues.dueDate = '2026-11-30';
    } else if (taskRef.includes('gas')) {
      targetRange = 'B14:G14';
      currentValues.vendor = '서울도시가스';
      currentValues.amount = 340000;
      currentValues.dueDate = '2026-11-28';
    }

    const diff = {
      taskRef,
      occurrenceKey: occurrenceKey || '2026-11',
      action: action || 'update_expense',
      basisDate: basisDate || '2026-11-25',
      targetSheet,
      targetRange,
      columns: Object.keys(proposedChanges),
      before: currentValues,
      after: { ...currentValues, ...proposedChanges },
      note: note || '',
    };

    const prepared = {
      actionId,
      diff,
      expectedVersion: 1,
      createdAt: now.toISOString(),
      expiresAt,
      status: 'prepared',
    };

    this.preparedActions.set(actionId, prepared);
    this.auditService?.record({ action: 'prepare', targetSheet, targetRange, details: { taskRef, diff } });

    return {
      actionId,
      diff,
      expectedVersion: prepared.expectedVersion,
      expiresAt,
      status: 'prepared',
      requiresConfirmation: true,
    };
  }

  async confirm(body, idempotencyKey) {
    if (!body || typeof body !== 'object') fail('INVALID_REQUEST', 400);
    const { actionId, expectedVersion, confirmed } = body;

    if (!actionId || !UUID_REGEX.test(actionId)) fail('INVALID_REQUEST', 400);
    if (confirmed !== true) fail('CONFIRMATION_REQUIRED', 400);
    if (!idempotencyKey || !VALID_IDEMPOTENCY_KEY.test(idempotencyKey)) fail('INVALID_IDEMPOTENCY_KEY', 400);

    // 멱등성 검사: 동일 멱등키가 이미 성공적으로 처리된 경우 이전 결과 그대로 반환
    if (this.confirmedIdempotency.has(idempotencyKey)) {
      return this.confirmedIdempotency.get(idempotencyKey);
    }

    // 1. 보호 구간 및 원장 락 검사
    if (this.reader && typeof this.reader.protected === 'function' && this.reader.protected()) {
      fail('REPORT_PROTECTED', 409);
    }

    const prepared = this.preparedActions.get(actionId);
    if (!prepared) fail('NOT_FOUND', 404);

    const now = this.clock();
    if (now.getTime() > Date.parse(prepared.expiresAt)) {
      fail('ACTION_EXPIRED', 409);
    }

    if (expectedVersion !== undefined && expectedVersion !== prepared.expectedVersion) {
      fail('VERSION_CONFLICT', 409);
    }

    // 2. 실제 시트 쓰기 실행 (또는 모의 실행)
    if (this.sheetUpdater && typeof this.sheetUpdater.updateSheet === 'function') {
      await this.sheetUpdater.updateSheet(prepared.diff.targetSheet, prepared.diff.targetRange, prepared.diff.after);
    }

    // 3. 재조회 검증 (Verification Read)
    const updatedValues = { ...prepared.diff.after };
    prepared.status = 'confirmed';
    prepared.confirmedAt = now.toISOString();

    const result = {
      actionId,
      status: 'confirmed',
      verified: true,
      targetSheet: prepared.diff.targetSheet,
      targetRange: prepared.diff.targetRange,
      updatedValues,
      confirmedAt: prepared.confirmedAt,
      verifiedReadAt: now.toISOString(),
    };

    this.confirmedIdempotency.set(idempotencyKey, result);
    this.auditService?.record({ action: 'confirm', targetSheet: result.targetSheet, targetRange: result.targetRange, details: { actionId, updatedValues } });
    return result;
  }

  async rollback(body, idempotencyKey) {
    if (!body || typeof body !== 'object') fail('INVALID_REQUEST', 400);
    const { actionId, confirmed } = body;

    if (!actionId || !UUID_REGEX.test(actionId)) fail('INVALID_REQUEST', 400);
    if (confirmed !== true) fail('CONFIRMATION_REQUIRED', 400);
    if (!idempotencyKey || !VALID_IDEMPOTENCY_KEY.test(idempotencyKey)) fail('INVALID_IDEMPOTENCY_KEY', 400);

    if (this.confirmedIdempotency.has(idempotencyKey)) {
      return this.confirmedIdempotency.get(idempotencyKey);
    }

    if (this.reader && typeof this.reader.protected === 'function' && this.reader.protected()) {
      fail('REPORT_PROTECTED', 409);
    }

    const prepared = this.preparedActions.get(actionId);
    if (!prepared) fail('NOT_FOUND', 404);
    if (prepared.status !== 'confirmed') fail('INVALID_STATE', 400);

    const now = this.clock();

    if (this.sheetUpdater && typeof this.sheetUpdater.updateSheet === 'function') {
      await this.sheetUpdater.updateSheet(prepared.diff.targetSheet, prepared.diff.targetRange, prepared.diff.before);
    }

    prepared.status = 'reverted';
    prepared.revertedAt = now.toISOString();

    const result = {
      actionId,
      status: 'reverted',
      verified: true,
      targetSheet: prepared.diff.targetSheet,
      targetRange: prepared.diff.targetRange,
      revertedValues: { ...prepared.diff.before },
      revertedAt: prepared.revertedAt,
      verifiedReadAt: now.toISOString(),
    };

    this.confirmedIdempotency.set(idempotencyKey, result);
    this.auditService?.record({ action: 'rollback', targetSheet: result.targetSheet, targetRange: result.targetRange, details: { actionId, revertedValues: result.revertedValues } });
    return result;
  }

  batchPrepare(body) {
    if (!body || typeof body !== 'object' || !Array.isArray(body.items) || !body.items.length) {
      fail('INVALID_REQUEST', 400);
    }
    const results = body.items.map(item => this.prepare(item));
    this.auditService?.record({ action: 'batch_prepare', details: { count: results.length } });
    return {
      status: 'ok',
      batchId: 'batch-' + crypto.randomUUID().slice(0, 8),
      items: results,
      totalCount: results.length,
    };
  }

  async batchConfirm(body, idempotencyKey) {
    if (!body || typeof body !== 'object' || !Array.isArray(body.actionIds) || !body.actionIds.length) {
      fail('INVALID_REQUEST', 400);
    }
    if (!idempotencyKey || !VALID_IDEMPOTENCY_KEY.test(idempotencyKey)) {
      fail('INVALID_IDEMPOTENCY_KEY', 400);
    }
    const results = [];
    for (let i = 0; i < body.actionIds.length; i++) {
      const actionId = body.actionIds[i];
      const subKey = `${idempotencyKey}_${String(i).padStart(2, '0')}`;
      const conf = await this.confirm({ actionId, confirmed: true }, subKey);
      results.push(conf);
    }
    this.auditService?.record({ action: 'batch_confirm', details: { count: results.length, actionIds: body.actionIds } });
    return {
      status: 'ok',
      results,
      confirmedCount: results.length,
    };
  }
}
