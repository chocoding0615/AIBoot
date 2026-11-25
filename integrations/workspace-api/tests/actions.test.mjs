import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { WorkspaceActionService } from '../actions.mjs';
import { createApi } from '../../report-scheduler/api.mjs';
import { createSessionBackend } from '../session.mjs';

test('WorkspaceActionService - prepare validates input and creates diff', () => {
  const service = new WorkspaceActionService();

  // Invalid bodies
  assert.throws(() => service.prepare(null), { code: 'INVALID_REQUEST' });
  assert.throws(() => service.prepare({}), { code: 'INVALID_REQUEST' });
  assert.throws(() => service.prepare({ taskRef: 'fixed:electric' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => service.prepare({ taskRef: 'fixed:electric', proposedChanges: {} }), { code: 'INVALID_REQUEST' });

  // Valid prepare
  const res = service.prepare({
    taskRef: 'fixed:electric',
    occurrenceKey: '2026-11',
    proposedChanges: { amount: 1450000, dueDate: '2026-11-25' },
    note: '11월분 청구서 반영',
  });

  assert.ok(res.actionId);
  assert.equal(res.status, 'prepared');
  assert.equal(res.requiresConfirmation, true);
  assert.equal(res.expectedVersion, 1);
  assert.ok(res.expiresAt);
  assert.equal(res.diff.targetSheet, 'JP매월 지출');
  assert.equal(res.diff.targetRange, 'B12:G12');
  assert.equal(res.diff.before.amount, 1320000);
  assert.equal(res.diff.after.amount, 1450000);
  assert.equal(res.diff.after.dueDate, '2026-11-25');
  assert.equal(res.diff.note, '11월분 청구서 반영');
});

test('WorkspaceActionService - protected mode rejects prepare and confirm with 409', async () => {
  let isProtected = true;
  const mockReader = { protected: () => isProtected };
  const service = new WorkspaceActionService({ reader: mockReader });

  assert.throws(
    () => service.prepare({ taskRef: 'fixed:electric', proposedChanges: { amount: 100 } }),
    { code: 'REPORT_PROTECTED', status: 409 }
  );

  isProtected = false;
  const prepared = service.prepare({ taskRef: 'fixed:electric', proposedChanges: { amount: 100 } });

  isProtected = true;
  await assert.rejects(
    async () => service.confirm({ actionId: prepared.actionId, expectedVersion: 1, confirmed: true }, 'idem-key-1234567890abcdef'),
    { code: 'REPORT_PROTECTED', status: 409 }
  );
});

test('WorkspaceActionService - confirm enforces validation, version, expiry and idempotency', async () => {
  let currentTime = 1000000000000;
  const clock = () => new Date(currentTime);
  let sheetUpdated = false;
  const sheetUpdater = {
    updateSheet: async (sheet, range, values) => {
      sheetUpdated = true;
    },
  };

  const service = new WorkspaceActionService({ clock, sheetUpdater });
  const prepared = service.prepare({
    taskRef: 'fixed:water',
    proposedChanges: { amount: 135000 },
  });

  // Invalid confirm params
  await assert.rejects(
    async () => service.confirm({}, 'idem-key-1234567890abcdef'),
    { code: 'INVALID_REQUEST' }
  );
  await assert.rejects(
    async () => service.confirm({ actionId: prepared.actionId, confirmed: false }, 'idem-key-1234567890abcdef'),
    { code: 'CONFIRMATION_REQUIRED' }
  );
  await assert.rejects(
    async () => service.confirm({ actionId: prepared.actionId, confirmed: true }, 'short'),
    { code: 'INVALID_IDEMPOTENCY_KEY' }
  );

  // Version conflict
  await assert.rejects(
    async () => service.confirm({ actionId: prepared.actionId, confirmed: true, expectedVersion: 999 }, 'idem-key-1234567890abcdef'),
    { code: 'VERSION_CONFLICT', status: 409 }
  );

  // Success confirm
  const key = 'idem-key-1234567890abcdef';
  const result1 = await service.confirm({ actionId: prepared.actionId, confirmed: true, expectedVersion: 1 }, key);
  assert.equal(result1.status, 'confirmed');
  assert.equal(result1.verified, true);
  assert.equal(result1.targetRange, 'B13:G13');
  assert.equal(result1.updatedValues.amount, 135000);
  assert.equal(sheetUpdated, true);

  // Idempotent retry returns identical result without re-executing
  sheetUpdated = false;
  const result2 = await service.confirm({ actionId: prepared.actionId, confirmed: true, expectedVersion: 1 }, key);
  assert.deepEqual(result1, result2);
  assert.equal(sheetUpdated, false);

  // Rollback test
  const rollbackKey = 'idem-key-rollback-1234567';
  const rollbackResult = await service.rollback({ actionId: prepared.actionId, confirmed: true }, rollbackKey);
  assert.equal(rollbackResult.status, 'reverted');
  assert.equal(rollbackResult.verified, true);
  assert.equal(rollbackResult.revertedValues.amount, 120500); // restored original before value

  // Expiry check
  const prep2 = service.prepare({ taskRef: 'fixed:gas', proposedChanges: { amount: 200 } });
  currentTime += 11 * 60000; // 11 mins later (TTL is 10 min)
  await assert.rejects(
    async () => service.confirm({ actionId: prep2.actionId, confirmed: true }, 'idem-key-9999999999abcdef'),
    { code: 'ACTION_EXPIRED', status: 409 }
  );
});

test('HTTP API & Session proxy for actions prepare and confirm', async () => {
  const token = 'a'.repeat(64);
  const pairingCode = 'b'.repeat(64);
  const actionService = new WorkspaceActionService();
  const control = createApi({ actionService, token, port: 0 });
  const controlAddr = await control.listen();

  const session = createSessionBackend({
    controlUrl: `http://127.0.0.1:${controlAddr.port}`,
    controlToken: token,
    pairingCode,
    pairingExpiresAt: Date.now() + 60000,
    uiOrigin: 'http://127.0.0.1:5173',
    port: 0,
  });
  const sessionAddr = await session.listen();

  try {
    // 1. Session pair
    const pairRes = await fetch(`http://127.0.0.1:${sessionAddr.port}/api/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://127.0.0.1:5173',
      },
      body: JSON.stringify({ code: pairingCode }),
    });
    assert.equal(pairRes.status, 200);
    const cookie = pairRes.headers.get('set-cookie');
    const { data: { csrfToken } } = await pairRes.json();

    // 2. Prepare action via session proxy
    const prepRes = await fetch(`http://127.0.0.1:${sessionAddr.port}/api/actions/prepare`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://127.0.0.1:5173',
        Cookie: cookie,
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({
        taskRef: 'fixed:electric',
        occurrenceKey: '2026-11',
        proposedChanges: { amount: 1500000 },
      }),
    });
    assert.equal(prepRes.status, 200);
    const prepJson = await prepRes.json();
    assert.equal(prepJson.status, 'ok');
    const { actionId, expectedVersion } = prepJson.data;

    // 3. Confirm action via session proxy with Idempotency-Key
    const idemKey = 'action-idem-key-1234567890';
    const confRes = await fetch(`http://127.0.0.1:${sessionAddr.port}/api/actions/confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://127.0.0.1:5173',
        Cookie: cookie,
        'X-CSRF-Token': csrfToken,
        'Idempotency-Key': idemKey,
      },
      body: JSON.stringify({
        actionId,
        expectedVersion,
        confirmed: true,
      }),
    });
    assert.equal(confRes.status, 200);
    const confJson = await confRes.json();
    assert.equal(confJson.status, 'ok');
    assert.equal(confJson.data.status, 'confirmed');
    assert.equal(confJson.data.verified, true);
    assert.equal(confJson.data.updatedValues.amount, 1500000);
  } finally {
    await session.close();
    await control.close();
  }
});
