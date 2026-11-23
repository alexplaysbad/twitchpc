import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../src/cloud/db/migrations.js';
import {
  consumePairingCode,
  createPairingCode,
  getAgentTokenHash,
  getPairingCode,
  storeAgentToken
} from '../src/cloud/db/repositories.js';
import { hashSecret } from '../src/cloud/secrets.js';

describe('agent pairing persistence', () => {
  it('consumes a one-time code once and stores hashed tokens', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db, ':memory:');

    const now = new Date();
    createPairingCode(db, {
      code: 'ABC123',
      agentId: 'stream-pc',
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      createdAt: now.toISOString()
    });

    expect(getPairingCode(db, 'ABC123')?.agentId).toBe('stream-pc');
    expect(consumePairingCode(db, 'ABC123')?.agentId).toBe('stream-pc');
    expect(consumePairingCode(db, 'ABC123')).toBeUndefined();

    const tokenHash = hashSecret('super-secret-token');
    storeAgentToken(db, 'stream-pc', tokenHash);
    expect(getAgentTokenHash(db, 'stream-pc')).toBe(tokenHash);
    expect(getAgentTokenHash(db, 'other-pc')).toBeUndefined();

    db.close();
  });

  it('rejects expired codes', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db, ':memory:');

    const now = new Date();
    createPairingCode(db, {
      code: 'EXPIRED',
      agentId: 'stream-pc',
      expiresAt: new Date(now.getTime() - 60_000).toISOString(),
      createdAt: new Date(now.getTime() - 120_000).toISOString()
    });

    expect(getPairingCode(db, 'EXPIRED')).toBeUndefined();
    expect(consumePairingCode(db, 'EXPIRED')).toBeUndefined();
    db.close();
  });
});
