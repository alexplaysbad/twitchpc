import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { getMigrationVersion, runMigrations } from '../src/cloud/db/migrations.js';
import { SCHEMA_SQL } from '../src/cloud/db/schema.js';

describe('database migrations', () => {
  it('upgrades a legacy database and is idempotent', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);

    expect(getMigrationVersion(db)).toBe(0);
    expect(runMigrations(db, ':memory:')).toBe(3);
    expect(getMigrationVersion(db)).toBe(3);

    const automationColumns = db.prepare('PRAGMA table_info(automations)').all() as Array<{ name: string }>;
    const names = automationColumns.map((column) => column.name);
    expect(names).toContain('cooldown_per_user_seconds');
    expect(names).toContain('last_triggered_at');
    expect(names).toContain('trigger_count');

    const eventColumns = db.prepare('PRAGMA table_info(event_log)').all() as Array<{ name: string }>;
    expect(eventColumns.map((column) => column.name)).toContain('event');

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    expect(tables.map((table) => table.name)).toContain('pairing_codes');
    expect(tables.map((table) => table.name)).toContain('agent_tokens');
    expect(tables.map((table) => table.name)).toContain('eventsub_subscriptions');

    expect(runMigrations(db, ':memory:')).toBe(3);
    db.close();
  });

  it('initializes a fresh database', () => {
    const db = new DatabaseSync(':memory:');
    expect(runMigrations(db, ':memory:')).toBe(3);
    expect(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({ count: 3 });
    db.close();
  });
});
