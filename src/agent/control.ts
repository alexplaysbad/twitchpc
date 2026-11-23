import { createServer, type Server } from 'node:http';
import type { AgentConfig } from './config.js';

export interface AgentStatus {
  connected: boolean;
  configured: boolean;
  paused: boolean;
  agentId: string;
  version: string;
  uptimeSeconds: number;
  lastCommandAt: string | null;
}

/** Small localhost-only API used by the Windows tray application. */
export class AgentControl {
  private readonly startedAt = Date.now();
  private paused = false;
  private connected = false;
  private lastCommandAt: string | null = null;
  private server: Server | undefined;

  constructor(
    private readonly config: AgentConfig,
    private readonly version: string,
    private readonly log: (message: string) => void,
    private readonly onShutdown?: () => void
  ) {}

  listen(): void {
    if (this.server) return;
    const server = createServer((request, response) => {
      const path = (request.url ?? '/').split('?')[0];
      const method = request.method ?? 'GET';

      if (method === 'GET' && path === '/status') {
        this.send(response, 200, this.status());
        return;
      }
      if (method === 'POST' && path === '/pause') {
        this.paused = true;
        this.log('Commands paused from tray');
        this.send(response, 200, this.status());
        return;
      }
      if (method === 'POST' && path === '/resume') {
        this.paused = false;
        this.log('Commands resumed from tray');
        this.send(response, 200, this.status());
        return;
      }
      if (method === 'POST' && path === '/shutdown') {
        this.send(response, 200, { ok: true });
        if (this.onShutdown) setImmediate(this.onShutdown);
        return;
      }
      this.send(response, 404, { error: 'Not found' });
    });

    server.on('error', (error) => {
      this.log(`Local control server unavailable on port ${this.config.AGENT_CONTROL_PORT}: ${error.message}`);
    });
    server.listen(this.config.AGENT_CONTROL_PORT, '127.0.0.1', () => {
      this.log(`Local control API listening on http://127.0.0.1:${this.config.AGENT_CONTROL_PORT}`);
    });
    this.server = server;
  }

  close(): void {
    this.server?.close();
    this.server = undefined;
  }

  status(): AgentStatus {
    return {
      connected: this.connected,
      configured: Boolean(this.config.AGENT_TOKEN),
      paused: this.paused,
      agentId: this.config.AGENT_ID,
      version: this.version,
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      lastCommandAt: this.lastCommandAt
    };
  }

  isPaused(): boolean {
    return this.paused;
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
  }

  noteCommand(): void {
    this.lastCommandAt = new Date().toISOString();
  }

  private send(response: import('node:http').ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    });
    response.end(JSON.stringify(body));
  }
}
