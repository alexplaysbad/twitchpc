import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CloudConfig } from './config.js';

export interface AdminTokenResult {
  token: string;
  generated: boolean;
  source: 'env' | 'file' | 'generated';
  path?: string;
}

export function ensureAdminToken(config: CloudConfig): AdminTokenResult {
  if (config.ADMIN_TOKEN) return { token: config.ADMIN_TOKEN, generated: false, source: 'env' };

  const path = config.ADMIN_TOKEN_FILE || join(dirname(config.DB_PATH), 'admin-token.txt');
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing) {
      config.ADMIN_TOKEN = existing;
      return { token: existing, generated: false, source: 'file', path };
    }
  }

  const token = randomBytes(32).toString('hex');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, token, { mode: 0o600 });
  config.ADMIN_TOKEN = token;
  return { token, generated: true, source: 'generated', path };
}
