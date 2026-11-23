import type { DatabaseSync } from 'node:sqlite';
import type {
  Action,
  ActionCommand,
  AgentInfo,
  Automation,
  CommandStatus,
  EventType,
  Trigger
} from '../../shared/types.js';

type Row = Record<string, unknown>;

function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toAutomation(row: Row): Automation {
  return {
    id: String(row['id']),
    name: String(row['name']),
    enabled: Number(row['enabled']) === 1,
    trigger: json<Trigger>(row['trigger'], { type: 'chat_command', filters: {} }),
    actions: json<Action[]>(row['actions'], []),
    cooldownSeconds: Number(row['cooldown_seconds'] ?? 0),
    cooldownPerUserSeconds: Number(row['cooldown_per_user_seconds'] ?? 0),
    lastTriggeredAt: row['last_triggered_at'] === null || row['last_triggered_at'] === undefined
      ? null
      : String(row['last_triggered_at']),
    triggerCount: Number(row['trigger_count'] ?? 0),
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at'])
  };
}

function toCommand(row: Row): ActionCommand & { status: CommandStatus; error: string | null } {
  return {
    id: String(row['id']),
    automationId: String(row['automation_id']),
    automationName: String(row['automation_name']),
    eventId: String(row['event_id']),
    action: json<Action>(row['payload'], {
      id: 'invalid',
      type: 'webhook',
      target: 'cloud',
      url: '',
      method: 'POST',
      headers: {},
      body: ''
    }),
    createdAt: String(row['created_at']),
    status: String(row['status']) as CommandStatus,
    error: row['error'] === null || row['error'] === undefined ? null : String(row['error']),
    agentId: row['agent_id'] === null || row['agent_id'] === undefined ? undefined : String(row['agent_id'])
  };
}

export function listAutomations(db: DatabaseSync): Automation[] {
  const rows = db.prepare('SELECT * FROM automations ORDER BY name').all() as Row[];
  return rows.map(toAutomation);
}

export function getAutomation(db: DatabaseSync, id: string): Automation | undefined {
  const row = db.prepare('SELECT * FROM automations WHERE id = ?').get(id) as Row | undefined;
  return row ? toAutomation(row) : undefined;
}

export function saveAutomation(db: DatabaseSync, automation: Automation): void {
  db.prepare(`
    INSERT INTO automations (
      id, name, enabled, trigger, actions, cooldown_seconds,
      cooldown_per_user_seconds, last_triggered_at, trigger_count, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      enabled = excluded.enabled,
      trigger = excluded.trigger,
      actions = excluded.actions,
      cooldown_seconds = excluded.cooldown_seconds,
      cooldown_per_user_seconds = excluded.cooldown_per_user_seconds,
      updated_at = excluded.updated_at
  `).run(
    automation.id,
    automation.name,
    automation.enabled ? 1 : 0,
    JSON.stringify(automation.trigger),
    JSON.stringify(automation.actions),
    automation.cooldownSeconds,
    automation.cooldownPerUserSeconds ?? 0,
    automation.lastTriggeredAt ?? null,
    automation.triggerCount ?? 0,
    automation.createdAt,
    automation.updatedAt
  );
}

export function deleteAutomation(db: DatabaseSync, id: string): boolean {
  return db.prepare('DELETE FROM automations WHERE id = ?').run(id).changes > 0;
}

export function logEvent(
  db: DatabaseSync,
  event: { id: string; type: EventType; raw: unknown },
  matchedAutomationIds: string[],
  normalized?: unknown
): void {
  db.prepare(`
    INSERT INTO event_log (id, type, payload, matched, event, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    event.id,
    event.type,
    JSON.stringify(event.raw),
    JSON.stringify(matchedAutomationIds),
    normalized === undefined ? null : JSON.stringify(normalized),
    new Date().toISOString()
  );
}

export interface LogEntry {
  id: string;
  type: string;
  payload: unknown;
  matched: string[];
  event?: unknown;
  createdAt: string;
}

export function listEventLogs(db: DatabaseSync, limit = 50): LogEntry[] {
  const rows = db.prepare('SELECT * FROM event_log ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit) as Row[];
  return rows.map((row) => ({
    id: String(row['id']),
    type: String(row['type']),
    payload: json<unknown>(row['payload'], null),
    matched: json<string[]>(row['matched'], []),
    event: row['event'] === null || row['event'] === undefined ? undefined : json<unknown>(row['event'], undefined),
    createdAt: String(row['created_at'])
  }));
}

export function getEventLog(db: DatabaseSync, id: string): LogEntry | undefined {
  const row = db.prepare('SELECT * FROM event_log WHERE id = ?').get(id) as Row | undefined;
  if (!row) return undefined;
  return {
    id: String(row['id']),
    type: String(row['type']),
    payload: json<unknown>(row['payload'], null),
    matched: json<string[]>(row['matched'], []),
    event: row['event'] === null || row['event'] === undefined ? undefined : json<unknown>(row['event'], undefined),
    createdAt: String(row['created_at'])
  };
}

export function insertCommand(db: DatabaseSync, command: ActionCommand): void {
  const target = command.action.target;
  db.prepare(`
    INSERT INTO commands (
      id, automation_id, automation_name, event_id, agent_id, target, action_type,
      payload, status, error, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)
  `).run(
    command.id,
    command.automationId,
    command.automationName,
    command.eventId,
    command.agentId ?? command.action.agentId ?? null,
    target,
    command.action.type,
    JSON.stringify(command.action),
    command.createdAt,
    command.createdAt
  );
}

export function listPendingCommands(db: DatabaseSync): (ActionCommand & { status: CommandStatus; error: string | null })[] {
  const rows = db.prepare("SELECT * FROM commands WHERE status = 'pending' ORDER BY created_at, rowid").all() as Row[];
  return rows.map(toCommand);
}

export function listCommands(db: DatabaseSync, limit = 100): (ActionCommand & { status: CommandStatus; error: string | null })[] {
  const rows = db.prepare('SELECT * FROM commands ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit) as Row[];
  return rows.map(toCommand);
}

export function failStaleSentCommands(db: DatabaseSync, cutoffIso: string): number {
  const result = db.prepare(`
    UPDATE commands
    SET status = 'failed', error = ?, updated_at = ?
    WHERE status = 'sent' AND updated_at < ?
  `).run('Agent did not acknowledge before the cloud restarted', new Date().toISOString(), cutoffIso);
  return Number(result.changes);
}

export function markCommand(db: DatabaseSync, id: string, status: CommandStatus, error?: string): void {
  db.prepare('UPDATE commands SET status = ?, error = ?, updated_at = ? WHERE id = ?')
    .run(status, error ?? null, new Date().toISOString(), id);
}

export function upsertAgent(db: DatabaseSync, id: string, tokenHash: string): void {
  db.prepare(`
    INSERT INTO agents (id, token_hash, last_seen, connected) VALUES (?, ?, NULL, 0)
    ON CONFLICT(id) DO UPDATE SET
      token_hash = CASE WHEN excluded.token_hash = '' THEN agents.token_hash ELSE excluded.token_hash END
  `).run(id, tokenHash);
}

export function updateAgentPresence(db: DatabaseSync, id: string, connected: boolean): void {
  db.prepare('UPDATE agents SET connected = ?, last_seen = ? WHERE id = ?')
    .run(connected ? 1 : 0, new Date().toISOString(), id);
}

export function listAgents(db: DatabaseSync): AgentInfo[] {
  const rows = db.prepare('SELECT * FROM agents ORDER BY id').all() as Row[];
  return rows.map((row) => ({
    id: String(row['id']),
    connected: Number(row['connected']) === 1,
    lastSeen: row['last_seen'] === null || row['last_seen'] === undefined ? null : String(row['last_seen'])
  }));
}

export function getLastEventAt(db: DatabaseSync): string | null {
  const row = db.prepare('SELECT MAX(created_at) AS value FROM event_log').get() as { value: string | null } | undefined;
  return row?.value ?? null;
}

export function recordAutomationTrigger(db: DatabaseSync, id: string, at: string): void {
  db.prepare(`
    UPDATE automations
    SET trigger_count = COALESCE(trigger_count, 0) + 1, last_triggered_at = ?
    WHERE id = ?
  `).run(at, id);
}

export function getSetting(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined;
  return row === undefined ? undefined : String(row['value']);
}

export function setSetting(db: DatabaseSync, key: string, value: string): void {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

export interface PairingCodeRecord {
  code: string;
  agentId: string;
  expiresAt: string;
  createdAt: string;
}

function toPairingCode(row: Row): PairingCodeRecord {
  return {
    code: String(row['code']),
    agentId: String(row['agent_id']),
    expiresAt: String(row['expires_at']),
    createdAt: String(row['created_at'])
  };
}

export function createPairingCode(db: DatabaseSync, record: PairingCodeRecord): void {
  db.prepare(`
    INSERT INTO pairing_codes (code, agent_id, expires_at, used_at, created_at)
    VALUES (?, ?, ?, NULL, ?)
  `).run(record.code, record.agentId, record.expiresAt, record.createdAt);
}

export function listPairingCodes(db: DatabaseSync): PairingCodeRecord[] {
  const rows = db.prepare(`
    SELECT * FROM pairing_codes
    WHERE used_at IS NULL
    ORDER BY expires_at, created_at
  `).all() as Row[];
  return rows.map(toPairingCode);
}

export function deleteExpiredPairingCodes(db: DatabaseSync): void {
  db.prepare('DELETE FROM pairing_codes WHERE used_at IS NOT NULL OR expires_at <= ?')
    .run(new Date().toISOString());
}

export function getPairingCode(db: DatabaseSync, code: string): PairingCodeRecord | undefined {
  const row = db.prepare(`
    SELECT * FROM pairing_codes
    WHERE code = ? AND used_at IS NULL AND expires_at > ?
  `).get(code, new Date().toISOString()) as Row | undefined;
  return row ? toPairingCode(row) : undefined;
}

/** Atomically marks a code as used. Returns the code only if this call consumed it. */
export function consumePairingCode(db: DatabaseSync, code: string): PairingCodeRecord | undefined {
  db.exec('BEGIN');
  try {
    const record = getPairingCode(db, code);
    if (!record) {
      db.exec('ROLLBACK');
      return undefined;
    }
    const changes = db.prepare(`
      UPDATE pairing_codes SET used_at = ? WHERE code = ? AND used_at IS NULL AND expires_at > ?
    `).run(new Date().toISOString(), code, new Date().toISOString()).changes;
    db.exec('COMMIT');
    return Number(changes) === 1 ? record : undefined;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function deletePairingCode(db: DatabaseSync, code: string): void {
  db.prepare('DELETE FROM pairing_codes WHERE code = ?').run(code);
}

export function storeAgentToken(db: DatabaseSync, agentId: string, tokenHash: string): void {
  db.prepare(`
    INSERT INTO agent_tokens (agent_id, token_hash, created_at, last_used_at)
    VALUES (?, ?, ?, NULL)
    ON CONFLICT(agent_id) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at
  `).run(agentId, tokenHash, new Date().toISOString());
}

export function getAgentTokenHash(db: DatabaseSync, agentId: string): string | undefined {
  const row = db.prepare('SELECT token_hash FROM agent_tokens WHERE agent_id = ?').get(agentId) as
    | { token_hash: string }
    | undefined;
  return row?.token_hash;
}

export function deleteAgentToken(db: DatabaseSync, agentId: string): void {
  db.prepare('DELETE FROM agent_tokens WHERE agent_id = ?').run(agentId);
}

export function touchAgentToken(db: DatabaseSync, agentId: string): void {
  db.prepare('UPDATE agent_tokens SET last_used_at = ? WHERE agent_id = ?')
    .run(new Date().toISOString(), agentId);
}

export function listAgentTokens(db: DatabaseSync): Array<{ agentId: string; createdAt: string; lastUsedAt: string | null }> {
  const rows = db.prepare('SELECT agent_id, created_at, last_used_at FROM agent_tokens ORDER BY agent_id').all() as Row[];
  return rows.map((row) => ({
    agentId: String(row['agent_id']),
    createdAt: String(row['created_at']),
    lastUsedAt: row['last_used_at'] === null || row['last_used_at'] === undefined
      ? null
      : String(row['last_used_at'])
  }));
}

export interface EventSubSubscriptionRecord {
  type: string;
  subscriptionId: string;
  status: string;
  sessionId: string;
}

export function getEventSubSubscription(db: DatabaseSync, type: string): EventSubSubscriptionRecord | undefined {
  const row = db.prepare('SELECT * FROM eventsub_subscriptions WHERE type = ?').get(type) as Row | undefined;
  return row ? {
    type: String(row['type']),
    subscriptionId: String(row['subscription_id']),
    status: String(row['status']),
    sessionId: String(row['session_id'] ?? '')
  } : undefined;
}

export function listEventSubSubscriptions(db: DatabaseSync): EventSubSubscriptionRecord[] {
  const rows = db.prepare('SELECT * FROM eventsub_subscriptions ORDER BY type').all() as Row[];
  return rows.map((row) => ({
    type: String(row['type']),
    subscriptionId: String(row['subscription_id']),
    status: String(row['status']),
    sessionId: String(row['session_id'] ?? '')
  }));
}

export function saveEventSubSubscription(db: DatabaseSync, record: EventSubSubscriptionRecord): void {
  db.prepare(`
    INSERT INTO eventsub_subscriptions (type, subscription_id, status, session_id, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(type) DO UPDATE SET
      subscription_id = excluded.subscription_id,
      status = excluded.status,
      session_id = excluded.session_id,
      updated_at = excluded.updated_at
  `).run(record.type, record.subscriptionId, record.status, record.sessionId, new Date().toISOString());
}

export function deleteEventSubSubscription(db: DatabaseSync, type: string): void {
  db.prepare('DELETE FROM eventsub_subscriptions WHERE type = ?').run(type);
}

export function setEventSubSession(db: DatabaseSync, sessionId: string): void {
  db.prepare('UPDATE eventsub_subscriptions SET session_id = ?, updated_at = ?')
    .run(sessionId, new Date().toISOString());
}

