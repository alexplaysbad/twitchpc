import 'dotenv/config';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { z } from 'zod';
import { ensureAdminToken } from './admin-token.js';
import type { HealthSnapshot } from './api/routes.js';
import { registerApiRoutes } from './api/routes.js';
import { AgentHub } from './agent-hub/hub.js';
import { loadCloudConfig, missingCloudConfig } from './config.js';
import { closeDb, getDb } from './db/client.js';
import { getLastEventAt, listAgents } from './db/repositories.js';
import { getMigrationVersion } from './db/migrations.js';
import { RuleExecutor } from './engine/executor.js';
import { createLogger } from './logger.js';
import { ChatClient } from './twitch/chat.js';
import { EventSubClient } from './twitch/eventsub.js';
import { TwitchTokens } from './twitch/tokens.js';

async function main(): Promise<void> {
  const config = loadCloudConfig();
  const adminToken = ensureAdminToken(config);
  const logger = createLogger(config.LOG_DIR || join(dirname(config.DB_PATH), 'logs'), 'cloud');
  const log = logger.info;

  const missing = missingCloudConfig(config);
  if (missing.length) log(`Warning: missing config: ${missing.join(', ')}`);
  if (adminToken.generated) {
    log(`Generated ADMIN_TOKEN at ${adminToken.path}: ${adminToken.token}`);
    log('Save this token in the UI Settings panel; it will not be printed again.');
  }

  const db = getDb(config.DB_PATH);
  const tokens = new TwitchTokens(config, db);
  const hub = new AgentHub(config, db, log);
  const executor = new RuleExecutor(config, db, hub, log);

  let eventsub: EventSubClient | undefined;
  let chat: ChatClient | undefined;

  const app = Fastify({ logger: false });
  app.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({ error: 'Invalid request', details: error.flatten() });
    }
    const message = error instanceof Error ? error.message : String(error);
    const statusCode = typeof (error as { statusCode?: number }).statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : 500;
    logger.error(`HTTP error: ${message}`);
    return reply.code(statusCode).send({ error: message });
  });

  await app.register(fastifyStatic, {
    root: fileURLToPath(new URL('./ui/public/', import.meta.url)),
    prefix: '/ui/'
  });

  const releaseDir = resolve(config.RELEASE_DIR);
  if (existsSync(releaseDir)) {
    await app.register(fastifyStatic, {
      root: releaseDir,
      prefix: '/download/',
      decorateReply: false
    });
  }

  const health = (): HealthSnapshot => {
    const agents = listAgents(db);
    return {
      eventSubConnected: eventsub?.isConnected() ?? false,
      chatConnected: chat?.isConnected() ?? false,
      schemaVersion: getMigrationVersion(db),
      lastEventAt: getLastEventAt(db),
      agents: { total: agents.length, online: agents.filter((agent) => agent.connected).length }
    };
  };

  app.get('/', async (_request, reply) => reply.redirect('/ui/'));
  registerApiRoutes(app, { config, db, executor, health, revokeAgent: (id) => hub.revokeAgent(id) });
  hub.attach(app.server);

  await app.listen({ port: config.PORT, host: config.HOST });
  log(`Cloud listening on http://${config.HOST}:${config.PORT} (UI at /ui/)`);

  eventsub = new EventSubClient(config, tokens, db, (event) => {
    logger.json('info', `Event: ${event.type} from ${event.user.login}`, { eventId: event.id, eventType: event.type });
    void executor.run(event).then((result) => {
      log(`Matched ${result.matched.length} automation(s), dispatched ${result.commands.length} action(s)`);
    });
  }, log);
  eventsub.start();

  chat = new ChatClient(config, (event) => {
    log(`Command from chat: ${event.type === 'chat_command' ? event.data.command : event.user.login}`);
    void executor.run(event).then((result) => {
      log(`Matched ${result.matched.length} automation(s), dispatched ${result.commands.length} action(s)`);
    });
  }, log);
  await chat.start();

  const shutdown = async (): Promise<void> => {
    log('Shutting down');
    eventsub?.stop();
    if (chat) await chat.stop();
    hub.close();
    await app.close();
    closeDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
