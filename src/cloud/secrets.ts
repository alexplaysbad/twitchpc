import { createHash, randomBytes } from 'node:crypto';

/** Hash a secret before storing it in SQLite. */
export function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Generate a URL-safe secret. Bytes are converted to hex. */
export function generateSecret(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

/** Short, human-friendly one-time pairing code. */
export function generatePairingCode(): string {
  return randomBytes(5).toString('hex').toUpperCase();
}
