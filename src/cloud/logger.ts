import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

type Level = 'info' | 'warn' | 'error';

export interface Logger {
  (message: string): void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  json: (level: Level, message: string, fields?: Record<string, unknown>) => void;
}

function cleanOldFiles(directory: string, prefix: string, maxDays = 7): void {
  try {
    const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000;
    for (const name of readdirSync(directory)) {
      if (!name.startsWith(prefix) || !name.endsWith('.log')) continue;
      const path = join(directory, name);
      const stat = statSync(path);
      if (stat.mtimeMs < cutoff) unlinkSync(path);
    }
  } catch {
    // Log cleanup is best-effort.
  }
}

export function createLogger(directory: string | undefined, name: string): Logger {
  const write = (level: Level, message: string, fields?: Record<string, unknown>): void => {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${level.toUpperCase()}: ${message}`;
    if (level === 'error') console.error(line);
    else console.log(line);

    if (!directory) return;
    try {
      mkdirSync(directory, { recursive: true });
      const file = join(directory, `${name}-${timestamp.slice(0, 10)}.log`);
      appendFileSync(file, `${JSON.stringify({ timestamp, level, message, ...fields })}\n`);
      cleanOldFiles(directory, name);
    } catch {
      // Never let logging break the process.
    }
  };

  const logger = ((message: string) => write('info', message)) as Logger;
  logger.info = (message) => write('info', message);
  logger.warn = (message) => write('warn', message);
  logger.error = (message) => write('error', message);
  logger.json = (level, message, fields) => write(level, message, fields);
  return logger;
}
