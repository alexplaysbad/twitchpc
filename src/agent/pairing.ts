import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { AgentConfig } from './config.js';
import { httpOrigin } from './update.js';

interface PairResponse {
  agentId: string;
  token: string;
}

export interface PairResult {
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

/** Update or append values in the agent .env while preserving other lines. */
export function updateAgentEnv(values: Record<string, string>): string {
  const path = agentEnvPath();
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = existing.split(/\r?\n/).filter((line, index, all) =>
    !(index === all.length - 1 && line === ''));
  for (const [key, value] of Object.entries(values)) {
    setEnvValue(lines, key, value);
  }
  writeFileSync(path, `${lines.join('\r\n')}\r\n`);
  return path;
}

function persistPairing(agentId: string, token: string): string {
  return updateAgentEnv({
    AGENT_ID: agentId,
    AGENT_TOKEN: token,
    PAIRING_CODE: ''
  });
}

/**
 * Exchange a one-time dashboard code for a per-agent token. Updates the in-memory
 * config and the .env file, so this works at startup or from the tray app while
 * the agent is already running.
 */
export async function exchangePairingCode(
  config: AgentConfig,
  code: string,
  log: (message: string) => void
): Promise<PairResult> {
  const normalized = code.trim().toUpperCase();
  if (!normalized) throw new Error('Enter a pairing code');

  const url = `${httpOrigin(config.CLOUD_URL)}/api/agent/pair`;
  log(`Exchanging pairing code with ${url}`);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: normalized }),
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
  return { agentId: body.agentId, token: body.token };
}

/** Startup helper: pair only when a code was supplied and no token exists yet. */
export async function pairIfNeeded(config: AgentConfig, log: (message: string) => void): Promise<boolean> {
  if (config.AGENT_TOKEN) return false;
  if (!config.PAIRING_CODE) {
    log('No AGENT_TOKEN found. Enter the pairing code in the tray app, or set ' +
        'PAIRING_CODE in the agent .env (or copy AGENT_TOKEN manually).');
    return false;
  }
  await exchangePairingCode(config, config.PAIRING_CODE, log);
  return true;
}
