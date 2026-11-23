import { timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { WebSocket, WebSocketServer } from 'ws';
import type { ActionCommand, AgentToCloudMessage, CloudToAgentMessage } from '../../shared/types.js';
import type { CloudConfig } from '../config.js';
import {
  failCommandsForAgent,
  failStaleSentCommands,
  getAgentStatus,
  getAgentTokenHash,
  listPendingCommands,
  markCommand,
  markCommandSent,
  touchAgentToken,
  updateAgentPresence,
  upsertAgent
} from '../db/repositories.js';
import type { CommandSink } from '../engine/executor.js';
import { hashSecret } from '../secrets.js';

interface ConnectedAgent {
  id: string;
  socket: WebSocket;
}

function secretsMatch(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function tokenHashMatches(token: string, expectedHash: string | undefined): boolean {
  if (!token || !expectedHash) return false;
  return secretsMatch(hashSecret(token), expectedHash);
}

export class AgentHub implements CommandSink {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly agents = new Map<string, ConnectedAgent>();
  private readonly pendingTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly config: CloudConfig,
    private readonly db: DatabaseSync,
    private readonly log: (message: string) => void
  ) {}

  attach(server: Server): void {
    const stale = failStaleSentCommands(
      this.db,
      new Date(Date.now() - this.config.COMMAND_TIMEOUT_MS).toISOString()
    );
    if (stale) this.log(`Marked ${stale} stale command(s) as failed after restart`);

    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname !== '/agent') return;

      const token = url.searchParams.get('token') ?? '';
      const id = url.searchParams.get('id') ?? 'default';
      const status = getAgentStatus(this.db, id);
      if (status && (!status.enabled || status.deleted)) {
        this.log(
          `Rejected agent connection from ${request.socket.remoteAddress ?? 'unknown'} ` +
          `(id=${id}): agent is ${status.deleted ? 'deleted' : 'disabled'}`
        );
        socket.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
        return;
      }

      const sharedTokenOk = secretsMatch(token, this.config.AGENT_TOKEN);
      const pairedTokenOk = tokenHashMatches(token, getAgentTokenHash(this.db, id));
      if (!sharedTokenOk && !pairedTokenOk) {
        this.log(
          `Rejected agent connection from ${request.socket.remoteAddress ?? 'unknown'} ` +
          `(id=${id}): invalid agent token`
        );
        socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
        return;
      }

      if (pairedTokenOk) touchAgentToken(this.db, id);
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit('connection', ws, request, id);
      });
    });

    this.wss.on('connection', (socket: WebSocket, _request: unknown, id: string) => {
      this.onConnected(id, socket);
    });
  }

  private onConnected(id: string, socket: WebSocket): void {
    const status = getAgentStatus(this.db, id);
    if (status && (!status.enabled || status.deleted)) {
      this.log(`Closed connection from ${status.deleted ? 'deleted' : 'disabled'} agent ${id}`);
      socket.close(1008, 'Agent unavailable');
      return;
    }

    this.log(`Agent connected: ${id}`);
    const previous = this.agents.get(id);
    if (previous && previous.socket !== socket) {
      this.log(`Agent ${id} reconnected; closing the previous socket`);
      previous.socket.close();
    }
    upsertAgent(this.db, id, 'configured');
    updateAgentPresence(this.db, id, true);
    this.agents.set(id, { id, socket });

    socket.on('message', (data) => this.onMessage(id, data.toString()));
    socket.on('close', () => {
      if (this.agents.get(id)?.socket !== socket) return;
      this.agents.delete(id);
      updateAgentPresence(this.db, id, false);
      this.log(`Agent disconnected: ${id}`);
    });
    socket.on('error', (error) => this.log(`Agent ${id} socket error: ${error.message}`));

    this.send(socket, { type: 'hello', agentId: id, sentAt: new Date().toISOString() });
    void this.flushPending();
  }

  private onMessage(agentId: string, raw: string): void {
    let message: AgentToCloudMessage;
    try {
      message = JSON.parse(raw) as AgentToCloudMessage;
    } catch {
      return;
    }

    if (message.type === 'heartbeat') {
      updateAgentPresence(this.db, agentId, true);
      return;
    }
    if (message.type === 'ack') {
      this.cancelAckTimer(message.commandId);
      markCommand(this.db, message.commandId, message.ok ? 'done' : 'failed', message.error);
      this.log(`Agent ${agentId} ack ${message.commandId}: ${message.ok ? 'ok' : message.error ?? 'failed'}`);
    }
  }

  private send(socket: WebSocket, message: CloudToAgentMessage): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  private isActiveAgent(id: string): boolean {
    const status = getAgentStatus(this.db, id);
    return status === undefined || status.enabled;
  }

  private selectAgent(command: ActionCommand): ConnectedAgent | undefined {
    const requested = command.agentId ?? command.action.agentId;
    if (requested) {
      const agent = this.agents.get(requested);
      return agent && this.isActiveAgent(agent.id) ? agent : undefined;
    }
    for (const agent of this.agents.values()) {
      if (this.isActiveAgent(agent.id)) return agent;
    }
    return undefined;
  }

  private cancelAckTimer(commandId: string): void {
    const timer = this.pendingTimers.get(commandId);
    if (!timer) return;
    clearTimeout(timer);
    this.pendingTimers.delete(commandId);
  }

  private scheduleAckTimeout(commandId: string): void {
    this.cancelAckTimer(commandId);
    const timer = setTimeout(() => {
      this.pendingTimers.delete(commandId);
      markCommand(this.db, commandId, 'failed', `Agent did not acknowledge within ${this.config.COMMAND_TIMEOUT_MS}ms`);
      this.log(`Command ${commandId} timed out waiting for agent ack`);
    }, this.config.COMMAND_TIMEOUT_MS);
    timer.unref();
    this.pendingTimers.set(commandId, timer);
  }

  private async flushPending(): Promise<void> {
    for (const command of listPendingCommands(this.db)) {
      const agent = this.selectAgent(command);
      if (!agent) continue;
      this.send(agent.socket, { type: 'command', command });
      markCommandSent(this.db, command.id, agent.id);
      this.scheduleAckTimeout(command.id);
      this.log(`Resent pending command ${command.id} to agent ${agent.id}`);
    }
  }

  async dispatch(command: ActionCommand): Promise<void> {
    const agent = this.selectAgent(command);
    if (!agent) {
      const requested = command.agentId ?? command.action.agentId;
      this.log(requested
        ? `Agent ${requested} is not connected; command left pending`
        : 'No agent connected; command left pending');
      return;
    }
    this.send(agent.socket, { type: 'command', command });
    markCommand(this.db, command.id, 'sent');
    this.scheduleAckTimeout(command.id);
    this.log(`Dispatched ${command.action.type} to agent ${agent.id}`);
  }

  /** Disconnect an agent and fail anything still waiting on it. */
  revokeAgent(id: string, reason = 'Agent revoked'): void {
    const failed = failCommandsForAgent(this.db, id, reason);
    for (const commandId of failed) this.cancelAckTimer(commandId);

    const agent = this.agents.get(id);
    if (!agent) {
      if (failed.length) this.log(`Failed ${failed.length} pending command(s) for agent ${id}: ${reason}`);
      return;
    }

    agent.socket.close(1008, reason.slice(0, 120));
    this.agents.delete(id);
    updateAgentPresence(this.db, id, false);
    this.log(`Disconnected agent ${id}: ${reason}`);
  }

  close(): void {
    for (const timer of this.pendingTimers.values()) clearTimeout(timer);
    this.pendingTimers.clear();
    for (const agent of this.agents.values()) agent.socket.close();
    this.agents.clear();
    this.wss.close();
  }
}
