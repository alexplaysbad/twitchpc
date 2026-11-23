import { DatabaseSync } from 'node:sqlite';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerApiRoutes } from '../src/cloud/api/routes.js';
import { runMigrations } from '../src/cloud/db/migrations.js';
import {
  getAgentStatus,
  getAgentTokenHash,
  listAgentTokens,
  listPairingCodes,
  storeAgentToken,
  upsertAgent
} from '../src/cloud/db/repositories.js';
import { hashSecret } from '../src/cloud/secrets.js';
import type { CloudConfig } from '../src/cloud/config.js';

function testConfig(): CloudConfig {
  return {
    PORT: 3000,
    HOST: '127.0.0.1',
    DB_PATH: ':memory:',
    ADMIN_TOKEN: '',
    ADMIN_TOKEN_FILE: '',
    DEFAULT_AGENT_ID: 'default',
    COMMAND_TIMEOUT_MS: 30000,
    LOG_DIR: '',
    RELEASE_DIR: './release',
    TWITCH_CLIENT_ID: '',
    TWITCH_CLIENT_SECRET: '',
    TWITCH_BROADCASTER_ID: '',
    TWITCH_BROADCASTER_LOGIN: '',
    TWITCH_BROADCASTER_ACCESS_TOKEN: '',
    TWITCH_BROADCASTER_REFRESH_TOKEN: '',
    TWITCH_APP_TOKEN: '',
    TWITCH_BOT_TOKEN: '',
    TWITCH_BOT_USERNAME: '',
    CHAT_COMMAND_PREFIX: '!',
    AGENT_TOKEN: '',
    WEBHOOK_TIMEOUT_MS: 10000
  };
}

describe('agent manager routes', () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];
  const dbs: DatabaseSync[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    for (const db of dbs.splice(0)) db.close();
  });

  async function setup() {
    const db = new DatabaseSync(':memory:');
    runMigrations(db, ':memory:');
    dbs.push(db);

    const revokeAgent = vi.fn();
    const app = Fastify();
    apps.push(app);
    registerApiRoutes(app, {
      config: testConfig(),
      db,
      executor: { run: vi.fn() } as never,
      revokeAgent
    });
    await app.ready();
    return { app, db, revokeAgent };
  }

  it('disables and re-enables an agent', async () => {
    const { app, db, revokeAgent } = await setup();
    upsertAgent(db, 'stream-pc', 'hash');
    db.prepare('UPDATE agents SET enabled = 1, connected = 1 WHERE id = ?').run('stream-pc');

    const disable = await app.inject({
      method: 'PATCH',
      url: '/api/agents/stream-pc/enabled',
      payload: { enabled: false }
    });
    expect(disable.statusCode).toBe(200);
    expect(disable.json()).toEqual({ id: 'stream-pc', enabled: false });
    expect(getAgentStatus(db, 'stream-pc')).toEqual({ enabled: false, deleted: false });
    expect(revokeAgent).toHaveBeenCalledWith('stream-pc', 'Agent disabled');

    const enable = await app.inject({
      method: 'PATCH',
      url: '/api/agents/stream-pc/enabled',
      payload: { enabled: true }
    });
    expect(enable.statusCode).toBe(200);
    expect(getAgentStatus(db, 'stream-pc')).toEqual({ enabled: true, deleted: false });
  });

  it('deletes an agent, removes tokens/codes, and blocks pairing', async () => {
    const { app, db, revokeAgent } = await setup();
    upsertAgent(db, 'stream-pc', hashSecret('token'));
    storeAgentToken(db, 'stream-pc', hashSecret('token'));
    db.prepare(
      'INSERT INTO pairing_codes (code, agent_id, expires_at, used_at, created_at) VALUES (?, ?, ?, NULL, ?)'
    ).run('PAIR123', 'stream-pc', new Date(Date.now() + 60_000).toISOString(), new Date().toISOString());

    const deleted = await app.inject({ method: 'DELETE', url: '/api/agents/stream-pc' });
    expect(deleted.statusCode).toBe(204);
    expect(getAgentStatus(db, 'stream-pc')).toEqual({ enabled: false, deleted: true });
    expect(listAgentTokens(db)).toEqual([]);
    expect(listPairingCodes(db)).toEqual([]);
    expect(revokeAgent).toHaveBeenCalledWith('stream-pc', 'Agent deleted');

    const pair = await app.inject({
      method: 'POST',
      url: '/api/pairing',
      payload: { agentId: 'stream-pc' }
    });
    expect(pair.statusCode).toBe(409);
  });

  it('revokes an agent token and disconnects the agent', async () => {
    const { app, db, revokeAgent } = await setup();
    storeAgentToken(db, 'stream-pc', hashSecret('token'));
    upsertAgent(db, 'stream-pc', hashSecret('token'));
    expect(getAgentTokenHash(db, 'stream-pc')).toBeTruthy();

    const response = await app.inject({ method: 'DELETE', url: '/api/agents/stream-pc/token' });
    expect(response.statusCode).toBe(204);
    expect(getAgentTokenHash(db, 'stream-pc')).toBeUndefined();
    expect(revokeAgent).toHaveBeenCalledWith('stream-pc', 'Token revoked');
  });
});
