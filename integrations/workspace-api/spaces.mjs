import crypto from 'node:crypto';
import { fail } from '../report-scheduler/core.mjs';

const SPACE_URL_REGEX = /^https:\/\/chat\.google\.com\/(?:room|space|u\/\d+\/room|u\/\d+\/space)\/([A-Za-z0-9_-]+)/i;
const ALLOWED_AGENTS = ['general', 'fixed', 'welfare', 'contracts'];
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class WorkspaceSpaceService {
  constructor({ reader, clock = () => new Date(), initialSpaces = null } = {}) {
    this.reader = reader;
    this.clock = clock;
    this.spaces = new Map();

    const defaults = initialSpaces || [
      {
        id: 'space-default-1',
        name: '업무 공유 (운영)',
        url: 'https://chat.google.com/room/AAAABBBBCCCC',
        spaceId: 'AAAABBBBCCCC',
        enabled: true,
        agents: ['general', 'fixed'],
        status: 'connected',
        createdAt: this.clock().toISOString(),
      },
      {
        id: 'space-default-2',
        name: '경영지원 (운영)',
        url: 'https://chat.google.com/room/DDDEEEEFFFF',
        spaceId: 'DDDEEEEFFFF',
        enabled: true,
        agents: ['general', 'welfare'],
        status: 'connected',
        createdAt: this.clock().toISOString(),
      },
    ];

    for (const s of defaults) {
      this.spaces.set(s.id, s);
    }
  }

  list() {
    return {
      items: Array.from(this.spaces.values()),
    };
  }

  get(id) {
    const item = this.spaces.get(id);
    if (!item) fail('NOT_FOUND', 404);
    return item;
  }

  add(body) {
    if (!body || typeof body !== 'object') fail('INVALID_REQUEST', 400);
    const { name, url, agents } = body;

    if (!name || typeof name !== 'string' || !name.trim() || name.length > 50) {
      fail('INVALID_REQUEST', 400);
    }

    const match = String(url || '').match(SPACE_URL_REGEX);
    if (!match) {
      fail('INVALID_URL', 400);
    }

    const validAgents = Array.isArray(agents)
      ? agents.filter((a) => ALLOWED_AGENTS.includes(a))
      : ['general'];

    const id = crypto.randomUUID();
    const now = this.clock();

    const space = {
      id,
      name: name.trim(),
      url: url.trim(),
      spaceId: match[1],
      enabled: false, // 기본 비활성 안전 원칙
      agents: validAgents.length ? validAgents : ['general'],
      status: 'unverified',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    this.spaces.set(id, space);
    return space;
  }

  update(id, body) {
    if (!id || !this.spaces.has(id)) fail('NOT_FOUND', 404);
    if (!body || typeof body !== 'object') fail('INVALID_REQUEST', 400);

    const space = this.spaces.get(id);

    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') fail('INVALID_REQUEST', 400);
      space.enabled = body.enabled;
    }

    if (body.agents !== undefined) {
      if (!Array.isArray(body.agents)) fail('INVALID_REQUEST', 400);
      space.agents = body.agents.filter((a) => ALLOWED_AGENTS.includes(a));
    }

    space.updatedAt = this.clock().toISOString();
    return space;
  }

  remove(id) {
    if (!id || !this.spaces.has(id)) fail('NOT_FOUND', 404);
    this.spaces.delete(id);
    return { removed: true, id };
  }

  async verify(id) {
    if (!id || !this.spaces.has(id)) fail('NOT_FOUND', 404);

    if (this.reader && typeof this.reader.protected === 'function' && this.reader.protected()) {
      fail('REPORT_PROTECTED', 409);
    }

    const space = this.spaces.get(id);
    space.status = 'connected';
    space.verifiedAt = this.clock().toISOString();
    return {
      verified: true,
      spaceId: space.spaceId,
      status: space.status,
      verifiedAt: space.verifiedAt,
    };
  }
}
