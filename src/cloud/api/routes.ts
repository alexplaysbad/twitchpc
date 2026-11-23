import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Action, Automation, EventType, TwitchEvent } from '../../shared/types.js';
import type { CloudConfig } from '../config.js';
import {
  consumePairingCode,
  createPairingCode,
  deleteAgentToken,
  deleteAutomation,
  deleteExpiredPairingCodes,
  deletePairingCode,
  getAutomation,
  getEventLog,
  listAgentTokens,
  listAgents,
  listAutomations,
  listCommands,
  listEventLogs,
  listEventSubSubscriptions,
  listPairingCodes,
  saveAutomation,
  storeAgentToken,
  upsertAgent
} from '../db/repositories.js';
import type { RuleExecutor } from '../engine/executor.js';
import { generatePairingCode, generateSecret, hashSecret } from '../secrets.js';
import { simulateEvent } from '../twitch/normalize.js';

const eventTypes: EventType[] = [
  'channel_points',
  'subscription',
  'gift_subscription',
  'cheer',
  'chat_command'
];

const actionSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.string().default(() => randomUUID()),
    label: z.string().optional(),
    type: z.literal('exec'),
    target: z.literal('agent'),
    agentId: z.string().optional(),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    cwd: z.string().optional()
  }),
  z.object({
    id: z.string().default(() => randomUUID()),
    label: z.string().optional(),
    type: z.literal('hotkey'),
    target: z.literal('agent'),
    agentId: z.string().optional(),
    keys: z.string().min(1),
    windowTitle: z.string().optional()
  }),
  z.object({
    id: z.string().default(() => randomUUID()),
    label: z.string().optional(),
    type: z.literal('obs_scene'),
    target: z.literal('agent'),
    agentId: z.string().optional(),
    sceneName: z.string().min(1)
  }),
  z.object({
    id: z.string().default(() => randomUUID()),
    label: z.string().optional(),
    type: z.literal('obs_source'),
    target: z.literal('agent'),
    agentId: z.string().optional(),
    sourceName: z.string().min(1),
    sceneName: z.string().optional(),
    visible: z.boolean()
  }),
  z.object({
    id: z.string().default(() => randomUUID()),
    label: z.string().optional(),
    type: z.literal('webhook'),
    target: z.literal('cloud'),
    url: z.string().url(),
    method: z.enum(['GET', 'POST', 'PUT']).default('POST'),
    headers: z.record(z.string(), z.string()).default({}),
    body: z.string().default('')
  })
]);

const automationInput = z.object({
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  trigger: z.object({
    type: z.enum(eventTypes as [EventType, ...EventType[]]),
    filters: z.object({
      rewardId: z.string().optional(),
      rewardTitle: z.string().optional(),
      command: z.string().optional(),
      username: z.string().optional(),
      minBits: z.number().int().nonnegative().optional(),
      minMonths: z.number().int().nonnegative().optional(),
      tiers: z.array(z.string()).optional()
    }).default({})
  }),
  actions: z.array(actionSchema).default([]),
  cooldownSeconds: z.number().int().nonnegative().default(0),
  cooldownPerUserSeconds: z.number().int().nonnegative().default(0)
});

const simulateInput = z.object({
  type: z.enum(eventTypes as [EventType, ...EventType[]]),
  payload: z.record(z.string(), z.unknown()).default({}),
  execute: z.boolean().default(false)
});

const replayInput = z.object({
  execute: z.boolean().default(false)
});

const pairingCreateInput = z.object({
  agentId: z.string().min(1).max(128).optional()
});

const pairingExchangeInput = z.object({
  code: z.string().min(4).max(64)
});

export interface HealthSnapshot {
  eventSubConnected: boolean;
  chatConnected: boolean;
  schemaVersion: number;
  lastEventAt: string | null;
  agents: { total: number; online: number };
}

interface RouteDeps {
  config: CloudConfig;
  db: DatabaseSync;
  executor: RuleExecutor;
  health?: () => HealthSnapshot;
  revokeAgent?: (id: string) => void;
}

export function registerApiRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { config, db, executor, health, revokeAgent } = deps;

  app.get('/api/health', async () => ({
    ok: true,
    uptimeSeconds: Math.round(process.uptime()),
    ...(health ? { ...health() } : {})
  }));

  app.get('/api/agent/version', async (_request, reply) => {
    try {
      const manifest = JSON.parse(
        readFileSync(resolve(config.RELEASE_DIR, 'version.json'), 'utf8')
      ) as { version: string; sha256: string; file: string };
      return {
        version: manifest.version,
        sha256: manifest.sha256,
        file: manifest.file ?? 'twitchpc-agent.exe',
        downloadUrl: `/download/${encodeURIComponent(manifest.file ?? 'twitchpc-agent.exe')}`
      };
    } catch {
      return reply.code(404).send({ error: 'No agent release manifest found' });
    }
  });

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    if (!config.ADMIN_TOKEN) return;
    if (
      request.url.startsWith('/api/health') ||
      request.url.startsWith('/api/agent/version') ||
      request.url.startsWith('/api/agent/pair')
    ) return;
    const header = request.headers.authorization ?? '';
    if (header !== `Bearer ${config.ADMIN_TOKEN}`) {
      return reply.code(401).send({ error: 'Invalid admin token' });
    }
    return undefined;
  });

  // Public: an agent with a one-time code exchanges it for its own token.
  app.post('/api/agent/pair', async (request, reply) => {
    const { code } = pairingExchangeInput.parse(request.body);
    const pairing = consumePairingCode(db, code.trim().toUpperCase());
    if (!pairing) return reply.code(400).send({ error: 'Pairing code is invalid, expired, or already used' });

    const token = generateSecret(32);
    const tokenHash = hashSecret(token);
    storeAgentToken(db, pairing.agentId, tokenHash);
    upsertAgent(db, pairing.agentId, tokenHash);
    return reply.code(201).send({ agentId: pairing.agentId, token });
  });

  app.get('/api/pairing', async () => listPairingCodes(db));

  app.post('/api/pairing', async (request, reply) => {
    const input = pairingCreateInput.parse(request.body ?? {});
    deleteExpiredPairingCodes(db);
    const agentId = input.agentId ?? config.DEFAULT_AGENT_ID;
    const code = generatePairingCode();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + 10 * 60_000);
    createPairingCode(db, {
      code,
      agentId,
      expiresAt: expiresAt.toISOString(),
      createdAt: createdAt.toISOString()
    });
    return reply.code(201).send({ code, agentId, expiresAt: expiresAt.toISOString() });
  });

  app.delete('/api/pairing/:code', async (request, reply) => {
    const { code } = request.params as { code: string };
    deletePairingCode(db, code.toUpperCase());
    return reply.code(204).send();
  });

  app.get('/api/agents/tokens', async () => listAgentTokens(db));

  app.delete('/api/agents/:id/token', async (request, reply) => {
    const { id } = request.params as { id: string };
    deleteAgentToken(db, id);
    revokeAgent?.(id);
    return reply.code(204).send();
  });

  app.get('/api/eventsub/subscriptions', async () => listEventSubSubscriptions(db));

  app.get('/api/automations', async () => listAutomations(db));

  app.post('/api/automations', async (request, reply) => {
    const input = automationInput.parse(request.body);
    const now = new Date().toISOString();
    const automation: Automation = {
      id: randomUUID(),
      ...input,
      actions: input.actions as Action[],
      createdAt: now,
      updatedAt: now
    };
    saveAutomation(db, automation);
    return reply.code(201).send(automation);
  });

  app.post('/api/automations/import', async (request, reply) => {
    const inputs = z.array(automationInput).parse(request.body);
    const now = new Date().toISOString();
    const saved: Automation[] = inputs.map((input) => {
      const automation: Automation = {
        id: randomUUID(),
        ...input,
        actions: input.actions as Action[],
        createdAt: now,
        updatedAt: now
      };
      saveAutomation(db, automation);
      return automation;
    });
    return reply.code(201).send({ imported: saved.length, automations: saved });
  });

  app.put('/api/automations/:id', async (request, reply) => {
    const params = request.params as { id: string };
    const existing = getAutomation(db, params.id);
    if (!existing) return reply.code(404).send({ error: 'Not found' });

    const input = automationInput.parse(request.body);
    const automation: Automation = {
      ...existing,
      ...input,
      actions: input.actions as Action[],
      updatedAt: new Date().toISOString()
    };
    saveAutomation(db, automation);
    return automation;
  });

  app.patch('/api/automations/:id/toggle', async (request, reply) => {
    const params = request.params as { id: string };
    const existing = getAutomation(db, params.id);
    if (!existing) return reply.code(404).send({ error: 'Not found' });
    const automation: Automation = {
      ...existing,
      enabled: !existing.enabled,
      updatedAt: new Date().toISOString()
    };
    saveAutomation(db, automation);
    return automation;
  });

  app.delete('/api/automations/:id', async (request, reply) => {
    const params = request.params as { id: string };
    return reply.code(deleteAutomation(db, params.id) ? 204 : 404).send();
  });

  app.post('/api/simulate', async (request) => {
    const input = simulateInput.parse(request.body);
    const event = simulateEvent(input.type, input.payload, {
      id: config.TWITCH_BROADCASTER_ID,
      login: config.TWITCH_BROADCASTER_LOGIN
    });
    const result = await executor.run(event, !input.execute);
    return { event, result };
  });

  app.post('/api/events/:id/replay', async (request, reply) => {
    const { id } = request.params as { id: string };
    const entry = getEventLog(db, id);
    if (!entry) return reply.code(404).send({ error: 'Event not found' });

    const input = replayInput.parse((request.body ?? {}) as unknown);
    const stored = entry.event as TwitchEvent | undefined;
    const original = stored?.id && stored?.type
      ? stored
      : simulateEvent(entry.type as EventType, (entry.payload ?? {}) as Record<string, unknown>, {
          id: config.TWITCH_BROADCASTER_ID,
          login: config.TWITCH_BROADCASTER_LOGIN
        });
    // Executor logs every event, so give each replay a fresh id.
    const event: TwitchEvent | undefined = original
      ? { ...original, id: `${original.id}-replay-${randomUUID()}` }
      : undefined;
    if (!event) return reply.code(400).send({ error: 'Stored event cannot be replayed' });

    const result = await executor.run(event, !input.execute);
    return { event, result };
  });

  app.get('/api/logs', async (request) => {
    const query = request.query as { limit?: string };
    return listEventLogs(db, query.limit ? Number(query.limit) : 50);
  });

  app.get('/api/commands', async (request) => {
    const query = request.query as { limit?: string };
    return listCommands(db, query.limit ? Number(query.limit) : 100);
  });

  app.get('/api/agents', async () => listAgents(db));
}
