import crypto from 'node:crypto';
import { fail } from '../report-scheduler/core.mjs';

export class WorkspaceAuditService {
  constructor({ maxEntries = 500, clock = () => new Date() } = {}) {
    this.maxEntries = maxEntries;
    this.clock = clock;
    this.entries = [];
  }

  record({ action, targetSheet = null, targetRange = null, actor = 'local_session', details = {}, status = 'success' }) {
    if (!action || typeof action !== 'string') return null;
    const entry = {
      id: 'aud-' + crypto.randomUUID().slice(0, 12),
      timestamp: this.clock().toISOString(),
      action, // 'prepare', 'confirm', 'rollback', 'batch_confirm', 'todo_toggle', 'space_update'
      actor,
      targetSheet: targetSheet || null,
      targetRange: targetRange || null,
      details: details || {},
      status,
    };
    this.entries.unshift(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.length = this.maxEntries;
    }
    return entry;
  }

  list({ limit = 50, action = null } = {}) {
    let list = this.entries;
    if (action) list = list.filter(e => e.action === action);
    const numLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
    return {
      status: 'ok',
      data: {
        items: list.slice(0, numLimit),
        total: list.length,
      },
    };
  }
}
