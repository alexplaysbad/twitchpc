import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from './schema.js';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'baseline', sql: SCHEMA_SQL },
  {
    version: 2,
    name: 'agent-targeting-stats-replay',
    sql: `
      ALTER TABLE automations ADD COLUMN cooldown_per_user_seconds INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE automations ADD COLUMN last_triggered_at TEXT;
      ALTER TABLE automations ADD COLUMN trigger_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE commands ADD COLUMN agent_id TEXT;
      ALTER TABLE event_log ADD COLUMN event TEXT;
      CREATE INDEX IF NOT EXISTS idx_commands_agent ON commands(agent_id);
    `
  },
  {
    version: 3,
    name: 'pairing-and-eventsub-persistence',
    sql: `
      CREATE TABLE IF NOT EXISTS pairing_codes (
        code TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_tokens (
        agent_id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );
      CREATE TABLE IF NOT EXISTS eventsub_subscriptions (
        type TEXT PRIMARY KEY,
        subscription_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'enabled',
        session_id TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pairing_codes_expires ON pairing_codes(expires_at);
    `
  },
  {
    version: 4,
    name: 'agent-management',
    sql: `
      ALTER TABLE agents ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE agents ADD COLUMN deleted_at TEXT;
      CREATE INDEX IF NOT EXISTS idx_agents_deleted ON agents(deleted_at);
    `
  }
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 1;

export function getMigrationVersion(db: DatabaseSync): number {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (!exists) return 0;
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as
    | { version: number | null }
    | undefined;
  return Number(row?.version ?? 0);
}

function backupDatabase(db: DatabaseSync, dbPath: string): void {
  if (!dbPath || dbPath === ':memory:' || !existsSync(dbPath)) return;
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } catch {
    // A backup is best-effort; do not block startup if checkpointing fails.
  }
  mkdirSync(dirname(dbPath), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  copyFileSync(dbPath, join(dirname(dbPath), `${basename(dbPath)}.backup-${stamp}`));
}

export function runMigrations(db: DatabaseSync, dbPath: string): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const current = getMigrationVersion(db);
  const pending = MIGRATIONS.filter((migration) => migration.version > current);
  if (pending.length === 0) return current;

  backupDatabase(db, dbPath);
  for (const migration of pending) {
    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${migration.version} (${migration.name}) failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return LATEST_SCHEMA_VERSION;
}
