import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentConfig } from '../src/agent/config.js';
import { AgentControl } from '../src/agent/control.js';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('No test port allocated')));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function waitForStatus(base: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${base}/status`);
      if (response.ok) return await response.json() as Record<string, unknown>;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Local control server did not start');
}

describe('agent local control API', () => {
  let control: AgentControl | undefined;

  afterEach(() => {
    control?.close();
    control = undefined;
  });

  it('reports status and handles pause, resume and shutdown', async () => {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    let shutdowns = 0;

    control = new AgentControl(
      {
        AGENT_ID: 'test-pc',
        AGENT_TOKEN: 'token',
        AGENT_CONTROL_PORT: port
      } as AgentConfig,
      '0.0.0-test',
      () => {},
      () => { shutdowns += 1; }
    );
    control.listen();

    expect(await waitForStatus(base)).toMatchObject({
      connected: false,
      configured: true,
      paused: false,
      agentId: 'test-pc',
      version: '0.0.0-test'
    });

    control.setConnected(true);
    control.noteCommand();
    const active = await waitForStatus(base);
    expect(active.connected).toBe(true);
    expect(typeof active.lastCommandAt).toBe('string');

    const paused = await (await fetch(`${base}/pause`, { method: 'POST' })).json() as Record<string, unknown>;
    expect(paused.paused).toBe(true);
    expect(control.isPaused()).toBe(true);

    const resumed = await (await fetch(`${base}/resume`, { method: 'POST' })).json() as Record<string, unknown>;
    expect(resumed.paused).toBe(false);
    expect(control.isPaused()).toBe(false);

    expect((await fetch(`${base}/missing`)).status).toBe(404);

    await fetch(`${base}/shutdown`, { method: 'POST' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(shutdowns).toBe(1);
  });
});
