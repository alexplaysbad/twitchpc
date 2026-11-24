import { config as loadEnv } from 'dotenv';
import WebSocket from 'ws';
import type { Action, ActionCommand, AgentToCloudMessage, CloudToAgentMessage } from '../shared/types.js';
import { CmdHandler } from './actions/cmd.js';
import { ExecHandler } from './actions/exec.js';
import { HotkeyHandler } from './actions/hotkey.js';
import { ObsHandler } from './actions/obs.js';
import { loadAgentConfig } from './config.js';
import { AgentControl } from './control.js';
import { agentEnvPath, exchangePairingCode, isStandaloneAgent, pairIfNeeded, updateAgentEnv } from './pairing.js';
import { checkForUpdate, localUpdateInfo } from './update.js';

// When running as a packaged .exe, prefer a .env sitting next to the exe so the
// streamer can just drop it in the same folder and double-click.
loadEnv();
if (isStandaloneAgent()) loadEnv({ path: agentEnvPath() });

const config = loadAgentConfig();
const log = (message: string): void => console.log(`[${new Date().toISOString()}] ${message}`);
const version = localUpdateInfo();

let control: AgentControl | undefined;
let currentSocket: WebSocket | undefined;
let reconnectTimer: NodeJS.Timeout | undefined;
let stopping = false;

const clearReconnect = (): void => {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
};

const shutdown = (): void => {
  stopping = true;
  clearReconnect();
  control?.close();
  process.exit(0);
};

control = new AgentControl(config, version, log, shutdown);
control.setPairHandler(async (code, cloudUrl) => {
  if (cloudUrl) {
    try {
      // Validate before saving so a typo does not overwrite a working URL.
      const parsed = new URL(cloudUrl);
      if (!['ws:', 'wss:'].includes(parsed.protocol)) throw new Error('Use ws:// or wss://');
      config.CLOUD_URL = cloudUrl;
      updateAgentEnv({ CLOUD_URL: cloudUrl });
      log(`Cloud URL saved: ${cloudUrl}`);
    } catch (error) {
      throw new Error(`Invalid cloud URL: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const result = await exchangePairingCode(config, code, log);
  clearReconnect();
  control?.setNeedsPairing(false);
  if (currentSocket) {
    const oldSocket = currentSocket;
    currentSocket = undefined;
    oldSocket.close();
  }
  connect();
  return { agentId: result.agentId };
});
control.listen();
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const execHandler = new ExecHandler();
const cmdHandler = new CmdHandler(config.CMD_TIMEOUT_MS);
const hotkeyHandler = new HotkeyHandler();
const obsHandler = new ObsHandler(config);

async function executeAction(action: Action): Promise<void> {
  switch (action.type) {
    case 'exec':
      return execHandler.execute(action);
    case 'cmd':
      return cmdHandler.execute(action);
    case 'hotkey':
      return hotkeyHandler.execute(action);
    case 'obs_scene':
      return obsHandler.setScene(action);
    case 'obs_source':
      return obsHandler.setSource(action);
    case 'webhook':
      throw new Error('Webhook actions run in the cloud, not on the agent');
  }
}

function scheduleReconnect(): void {
  if (stopping) return;
  clearReconnect();
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connect();
  }, config.RECONNECT_DELAY_MS);
  reconnectTimer.unref();
}

function connect(): void {
  clearReconnect();
  if (currentSocket && (
    currentSocket.readyState === WebSocket.OPEN ||
    currentSocket.readyState === WebSocket.CONNECTING
  )) return;

  const url = new URL(config.CLOUD_URL);
  url.searchParams.set('id', config.AGENT_ID);
  url.searchParams.set('token', config.AGENT_TOKEN);

  log(`Agent ${config.AGENT_ID} connecting to ${url.origin}${url.pathname}`);
  const socket = new WebSocket(url);
  currentSocket = socket;
  let heartbeat: NodeJS.Timeout | undefined;

  const send = (message: AgentToCloudMessage): void => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };

  socket.on('open', () => {
    log('Connected to cloud');
    control?.setConnected(true);
    control?.setNeedsPairing(false);
    heartbeat = setInterval(() => {
      send({ type: 'heartbeat', agentId: config.AGENT_ID, at: new Date().toISOString() });
    }, config.HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();
  });

  socket.on('message', (data) => {
    let message: CloudToAgentMessage;
    try {
      message = JSON.parse(data.toString()) as CloudToAgentMessage;
    } catch {
      return;
    }

    if (message.type === 'hello') {
      log('Cloud acknowledged agent');
      return;
    }

    if (message.type === 'command') {
      const command: ActionCommand = message.command;
      control?.noteCommand();
      log(`Received command ${command.id} (${command.action.type})`);
      if (control?.isPaused()) {
        log(`Command ${command.id} skipped: agent is paused`);
        send({ type: 'ack', commandId: command.id, ok: false, error: 'Agent is paused', at: new Date().toISOString() });
        return;
      }
      void executeAction(command.action)
        .then(() => {
          log(`Command ${command.id} completed`);
          send({ type: 'ack', commandId: command.id, ok: true, at: new Date().toISOString() });
        })
        .catch((error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error);
          log(`Command ${command.id} failed: ${detail}`);
          send({ type: 'ack', commandId: command.id, ok: false, error: detail, at: new Date().toISOString() });
        });
    }
  });

  socket.on('error', (error) => {
    log(`Socket error: ${error.message}`);
    if (error.message.includes('401')) {
      control?.setNeedsPairing(true);
      log('Cloud rejected the connection: this agent token is unknown or revoked. ' +
          'Enter a fresh pairing code in the tray app (or check AGENT_TOKEN in the .env file next to this agent).');
    } else if (error.message.includes('403')) {
      log('Cloud has disabled or removed this agent. Re-enable or re-pair it in the dashboard Agent Manager.');
    }
  });
  socket.on('close', () => {
    if (heartbeat) clearInterval(heartbeat);
    // A newer socket (e.g. after tray pairing) has replaced this one.
    if (currentSocket !== socket) return;
    currentSocket = undefined;
    control?.setConnected(false);
    log(`Disconnected; retrying in ${config.RECONNECT_DELAY_MS / 1000}s`);
    scheduleReconnect();
  });
}

async function start(): Promise<void> {
  try {
    await pairIfNeeded(config, log);
  } catch (error) {
    log(`Pairing failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!config.AGENT_TOKEN) {
    log('Agent is not connecting until a token is configured.');
    return;
  }

  log(`Agent version: ${version}`);
  const restarting = await checkForUpdate(config, log);
  if (restarting) {
    // The tray supervisor (or update batch) will start the new exe.
    control?.close();
    process.exit(0);
  }
  connect();
}

void start();
