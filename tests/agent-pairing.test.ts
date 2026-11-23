import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAgentConfig } from '../src/agent/config.js';
import { pairIfNeeded } from '../src/agent/pairing.js';

describe('agent first-run pairing', () => {
  const originalCwd = process.cwd();
  let server: Server | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    process.chdir(originalCwd);
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    if (dir) rmSync(dir, { recursive: true, force: true });
    server = undefined;
    dir = undefined;
  });

  it('exchanges a code and persists the token in the agent .env', async () => {
    dir = mkdtempSync(join(tmpdir(), 'twitchpc-pair-'));
    process.chdir(dir);
    let receivedBody = '';

    server = createServer((request, response) => {
      request.on('data', (chunk) => { receivedBody += chunk.toString(); });
      request.on('end', () => {
        response.writeHead(201, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ agentId: 'test-pc', token: 'agent-token-123' }));
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server?.address();
    if (!address || typeof address === 'string') throw new Error('No test server address');

    const config = loadAgentConfig({
      ...process.env,
      CLOUD_URL: `ws://127.0.0.1:${address.port}/agent`,
      AGENT_ID: 'default',
      AGENT_TOKEN: '',
      PAIRING_CODE: 'AA11BB22'
    });

    const paired = await pairIfNeeded(config, () => {});
    expect(paired).toBe(true);
    expect(receivedBody).toContain('AA11BB22');
    expect(config.AGENT_ID).toBe('test-pc');
    expect(config.AGENT_TOKEN).toBe('agent-token-123');
    expect(config.PAIRING_CODE).toBe('');

    const env = readFileSync(join(dir, '.env'), 'utf8');
    expect(env).toContain('AGENT_ID=test-pc');
    expect(env).toContain('AGENT_TOKEN=agent-token-123');
    expect(env).toContain('PAIRING_CODE=');
  });
});
