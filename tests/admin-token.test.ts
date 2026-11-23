import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CloudConfig } from '../src/cloud/config.js';
import { ensureAdminToken } from '../src/cloud/admin-token.js';
import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'twitchpc-admin-'));
  directories.push(dir);
  return dir;
}

afterEach(() => {
  while (directories.length) rmSync(directories.pop() as string, { recursive: true, force: true });
});

describe('ensureAdminToken', () => {
  it('generates a token once and reuses it from disk', () => {
    const dir = tempDir();
    const config = { DB_PATH: join(dir, 'data', 'twitchpc.db'), ADMIN_TOKEN: '' } as CloudConfig;

    const first = ensureAdminToken(config);
    expect(first.generated).toBe(true);
    expect(first.token).toHaveLength(64);
    expect(readFileSync(first.path as string, 'utf8').trim()).toBe(first.token);

    config.ADMIN_TOKEN = '';
    const second = ensureAdminToken(config);
    expect(second.generated).toBe(false);
    expect(second.source).toBe('file');
    expect(second.token).toBe(first.token);
  });

  it('prefers an env token', () => {
    const dir = tempDir();
    const config = { DB_PATH: join(dir, 'twitchpc.db'), ADMIN_TOKEN: 'from-env' } as CloudConfig;
    const result = ensureAdminToken(config);
    expect(result.source).toBe('env');
    expect(result.token).toBe('from-env');
  });
});
