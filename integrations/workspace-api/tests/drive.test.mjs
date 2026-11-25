import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceDriveService } from '../drive.mjs';
import { createApi } from '../../report-scheduler/api.mjs';
import { createSessionBackend } from '../session.mjs';

describe('WorkspaceDriveService (Stage 7)', () => {
  it('searches mock corporate drive files when query provided', async () => {
    const service = new WorkspaceDriveService({ useCli: false });
    const res = await service.search({ q: '전기요금' });
    assert.ok(Array.isArray(res.items));
    assert.ok(res.items.length > 0);
    assert.equal(res.items[0].id, '1kepco202611electric');
    assert.ok(res.items[0].webViewLink.includes('drive.google.com'));
  });

  it('searches files by category or taskRef', async () => {
    const service = new WorkspaceDriveService({ useCli: false });
    const res = await service.search({ q: 'welfare' });
    assert.ok(res.items.some((f) => f.taskRef === 'welfare:points'));
  });

  it('resolves file link by taskRef', async () => {
    const service = new WorkspaceDriveService({ useCli: false });
    const resolved = await service.resolve('fixed:electric');
    assert.equal(resolved.resolved, true);
    assert.equal(resolved.id, '1kepco202611electric');
    assert.ok(resolved.link.includes('drive.google.com/file/d/1kepco202611electric/view'));

    const notFound = await service.resolve('unknown:task');
    assert.equal(notFound.resolved, false);
    assert.equal(notFound.link, null);
  });
});

describe('Workspace Drive HTTP API & Session Proxy (Stage 7)', () => {
  it('serves /api/drive/search and /api/drive/resolve over authenticated session proxy', async () => {
    const token = 'c'.repeat(64);
    const pairingCode = 'd'.repeat(64);
    const driveService = new WorkspaceDriveService({ useCli: false });

    const control = createApi({
      token,
      driveService,
      port: 0,
    });
    const { port: controlPort } = await control.listen();

    const session = createSessionBackend({
      controlUrl: `http://127.0.0.1:${controlPort}`,
      controlToken: token,
      pairingCode,
      pairingExpiresAt: Date.now() + 600000,
      uiOrigin: 'http://127.0.0.1:5173',
      port: 0,
    });
    const { port: sessionPort } = await session.listen();

    try {
      // 1. Authenticate session
      const authRes = await fetch(`http://127.0.0.1:${sessionPort}/api/session`, {
        method: 'POST',
        headers: {
          'Origin': 'http://127.0.0.1:5173',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ code: pairingCode }),
      });
      assert.equal(authRes.status, 200);
      const authData = await authRes.json();
      const csrfToken = authData.data.csrfToken;
      const setCookie = authRes.headers.get('set-cookie');
      const cookie = setCookie.split(';')[0];

      // 2. Query /api/drive/search?q=전기요금
      const searchRes = await fetch(`http://127.0.0.1:${sessionPort}/api/drive/search?q=%EC%A0%84%EA%B8%B0%EC%9A%94%EA%B8%88`, {
        method: 'GET',
        headers: {
          'Origin': 'http://127.0.0.1:5173',
          'Cookie': cookie,
          'X-CSRF-Token': csrfToken,
        },
      });
      assert.equal(searchRes.status, 200);
      const searchJson = await searchRes.json();
      assert.equal(searchJson.status, 'ok');
      assert.ok(searchJson.data.items.length > 0);
      assert.equal(searchJson.data.items[0].id, '1kepco202611electric');

      // 3. Query /api/drive/resolve?ref=fixed:electric
      const resolveRes = await fetch(`http://127.0.0.1:${sessionPort}/api/drive/resolve?ref=fixed:electric`, {
        method: 'GET',
        headers: {
          'Origin': 'http://127.0.0.1:5173',
          'Cookie': cookie,
          'X-CSRF-Token': csrfToken,
        },
      });
      assert.equal(resolveRes.status, 200);
      const resolveJson = await resolveRes.json();
      assert.equal(resolveJson.status, 'ok');
      assert.equal(resolveJson.data.resolved, true);
      assert.equal(resolveJson.data.id, '1kepco202611electric');
      assert.ok(resolveJson.data.link.includes('drive.google.com'));
    } finally {
      await session.close();
      await control.close();
    }
  });
});
