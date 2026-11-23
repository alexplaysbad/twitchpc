import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { AgentConfig } from './config.js';
import { httpOrigin } from './update.js';

interface PairResponse {
  agentId: string;
  token: string;
}

/** Plain node.exe also ends in ".exe" on Windows, so check the actual name. */
export function isStandaloneAgent(): boolean {
  return basename(process.execPath).toLowerCase() === 'twitchpc-agent.exe';
}

/** The agent .env lives beside the exe on a streamer's PC, or in cwd in dev. */
export function agentEnvPath(): string {
  return isStandaloneAgent()
    ? join(dirname(process.execPath), '.env')
    : join(process.cwd(), '.env');
}

function setEnvValue(lines: string[], key: string, value: string): void {
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`, 'i');
  const index = lines.findIndex((line) => pattern.test(line));
  const assignment = `${key}=${value}`;
  if (index === -1) lines.push(assignment);
  else lines[index] = assignment;
}

function persistPairing(agentId: string, token: string): string {
  const path = agentEnvPath();
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = existing.split(/\r?\n/).filter((line, index, all) =>
    !(index === all.length - 1 && line === ''));
  setEnvValue(lines, 'AGENT_ID', agentId);
  setEnvValue(lines, 'AGENT_TOKEN', token);
  setEnvValue(lines, 'PAIRING_CODE', '');
  writeFileSync(path, `${lines.join('\r\n')}\r\n`);
  return path;
}

/**
 * If the agent has no token yet, exchange the one-time code from the dashboard
 * for a per-agent token and save it in .env so future starts need no code.
 */
export async function pairIfNeeded(config: AgentConfig, log: (message: string) => void): Promise<boolean> {
  if (config.AGENT_TOKEN) return false;
  if (!config.PAIRING_CODE) {
    log('No AGENT_TOKEN found. Open the dashboard, generate a pairing code, ' +
        'then set PAIRING_CODE in the agent .env (or copy AGENT_TOKEN manually).');
    return false;
  }

  const code = config.PAIRING_CODE.trim().toUpperCase();
  const url = `${httpOrigin(config.CLOUD_URL)}/api/agent/pair`;
  log(`Exchanging pairing code with ${url}`);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
    signal: AbortSignal.timeout(15_000)
  });

  const body = await response.json().catch(() => ({})) as Partial<PairResponse> & { error?: string };
  if (!response.ok || !body.agentId || !body.token) {
    throw new Error(body.error ?? `pairing failed with HTTP ${response.status}`);
  }

  const path = persistPairing(body.agentId, body.token);
  config.AGENT_ID = body.agentId;
  config.AGENT_TOKEN = body.token;
  config.PAIRING_CODE = '';
  log(`Paired as '${body.agentId}'. Token saved to ${path}. The code cannot be reused.`);
  return true;
}
