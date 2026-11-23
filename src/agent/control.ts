import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AgentConfig } from './config.js';

export interface AgentStatus {
  connected: boolean;
  configured: boolean;
  needsPairing: boolean;
  paused: boolean;
  agentId: string;
  version: string;
  uptimeSeconds: number;
  lastCommandAt: string | null;
}

export interface PairResult {
  agentId: string;
}

type PairHandler = (code: string, cloudUrl?: string) => Promise<PairResult>;

/** Small localhost-only API used by the Windows tray application. */
export class AgentControl {
  private readonly startedAt = Date.now();
  private paused = false;
  private connected = false;
  private needsPairing = false;
  private lastCommandAt: string | null = null;
  private server: Server | undefined;
  private pairHandler: PairHandler | undefined;

  constructor(
    private readonly config: AgentConfig,
    private readonly version: string,
    private readonly log: (message: string) => void,
    private readonly onShutdown?: () => void
  ) {}

  setPairHandler(handler: PairHandler): void {
    this.pairHandler = handler;
  }

  listen(): void {
    if (this.server) return;
    const server = createServer((request, response) => {
      void this.route(request, response);
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
      needsPairing: this.needsPairing || !Boolean(this.config.AGENT_TOKEN),
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

  setNeedsPairing(needed: boolean): void {
    this.needsPairing = needed;
  }

  noteCommand(): void {
    this.lastCommandAt = new Date().toISOString();
  }

  private async route(request: IncomingMessage, response: import('node:http').ServerResponse): Promise<void> {
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

    if (method === 'POST' && path === '/pair') {
      let code = '';
      let cloudUrl: string | undefined;
      try {
        const body = await this.readBody(request);
        code = typeof body.code === 'string' ? body.code.trim() : '';
        if (typeof body.cloudUrl === 'string' && body.cloudUrl.trim()) {
          cloudUrl = body.cloudUrl.trim();
        }
      } catch (error) {
        this.send(response, 400, { error: error instanceof Error ? error.message : 'Invalid request' });
        return;
      }
      if (!code) {
        this.send(response, 400, { error: 'Enter a pairing code' });
        return;
      }
      if (!this.pairHandler) {
        this.send(response, 503, { error: 'Pairing is not available yet' });
        return;
      }
      try {
        const result = await this.pairHandler(code, cloudUrl);
        this.needsPairing = false;
        this.send(response, 200, { ok: true, agentId: result.agentId });
      } catch (error) {
        this.send(response, 400, { error: error instanceof Error ? error.message : 'Pairing failed' });
      }
      return;
    }

    if (method === 'POST' && path === '/shutdown') {
      this.send(response, 200, { ok: true });
      if (this.onShutdown) setImmediate(this.onShutdown);
      return;
    }

    this.send(response, 404, { error: 'Not found' });
  }

  private readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let raw = '';
      request.on('data', (chunk: Buffer | string) => {
        raw += chunk.toString();
        if (raw.length > 8192) {
          reject(new Error('Request body too large'));
          request.destroy();
        }
      });
      request.on('end', () => {
        if (!raw.trim()) {
          resolve({});
          return;
        }
        try {
          const parsed = JSON.parse(raw) as unknown;
          resolve(parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {});
        } catch {
          reject(new Error('Invalid JSON body'));
        }
      });
      request.on('error', reject);
    });
  }

  private send(response: import('node:http').ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    });
    response.end(JSON.stringify(body));
  }
}
