import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceAuditService } from '../audit.mjs';
import { createApi } from '../../report-scheduler/api.mjs';
import { createSessionBackend } from '../session.mjs';

test('WorkspaceAuditService - record and list audit entries', () => {
  const audit = new WorkspaceAuditService({ maxEntries: 10 });

  // Record prepare
  const p = audit.record({
    action: 'prepare',
    targetSheet: 'JP매월 지출',
    targetRange: 'B12:G12',
    details: { taskRef: 'fixed:electric', amount: 1450000 },
  });
  assert.ok(p.id.startsWith('aud-'));
  assert.equal(p.action, 'prepare');
  assert.equal(p.status, 'success');

  // Record confirm
  const c = audit.record({
    action: 'confirm',
    targetSheet: 'JP매월 지출',
    targetRange: 'B12:G12',
    details: { actionId: 'test-act-1', updatedValues: { amount: 1450000 } },
  });
  assert.equal(c.action, 'confirm');

  // Record rollback
  const r = audit.record({
    action: 'rollback',
    targetSheet: 'JP매월 지출',
    targetRange: 'B12:G12',
    details: { actionId: 'test-act-1', revertedValues: { amount: 1320000 } },
  });
  assert.equal(r.action, 'rollback');

  // List all
  const listAll = audit.list();
  assert.equal(listAll.status, 'ok');
  assert.equal(listAll.data.total, 3);
  assert.equal(listAll.data.items[0].action, 'rollback'); // newest first

  // Filter by action
  const listConfirm = audit.list({ action: 'confirm' });
  assert.equal(listConfirm.data.total, 1);
  assert.equal(listConfirm.data.items[0].action, 'confirm');
});

test('HTTP API & Session proxy for /api/audit', async () => {
  const token = 'c'.repeat(64);
  const auditService = new WorkspaceAuditService();
  auditService.record({ action: 'confirm', targetSheet: 'JP매월 지출', targetRange: 'B12:G12' });

  const control = createApi({
    token,
    auditService,
  });
  const { port: controlPort } = await control.listen();

  const session = createSessionBackend({
    controlUrl: `http://127.0.0.1:${controlPort}`,
    controlToken: token,
    pairingCode: 'd'.repeat(64),
    pairingExpiresAt: Date.now() + 60000,
    uiOrigin: 'http://127.0.0.1:5173',
  });
  const { port: uiPort } = await session.listen();

  try {
    // 1. Pair session
    const pairRes = await fetch(`http://127.0.0.1:${uiPort}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' },
      body: JSON.stringify({ code: 'd'.repeat(64) }),
    });
    assert.equal(pairRes.status, 200);
    const cookie = pairRes.headers.get('set-cookie');
    const { data: { csrfToken } } = await pairRes.json();

    // 2. Fetch /api/audit
    const auditRes = await fetch(`http://127.0.0.1:${uiPort}/api/audit`, {
      headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken },
    });
    assert.equal(auditRes.status, 200);
    const body = await auditRes.json();
    assert.equal(body.status, 'ok');
    assert.ok(Array.isArray(body.data.items));
    assert.equal(body.data.items.length, 1);
    assert.equal(body.data.items[0].action, 'confirm');
  } finally {
    await session.close();
    await control.close();
  }
});
