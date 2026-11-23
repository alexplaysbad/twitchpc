import { config as loadEnv } from 'dotenv';
import WebSocket from 'ws';
import type { Action, ActionCommand, AgentToCloudMessage, CloudToAgentMessage } from '../shared/types.js';
import { ExecHandler } from './actions/exec.js';
import { HotkeyHandler } from './actions/hotkey.js';
import { ObsHandler } from './actions/obs.js';
import { allowedExecutables, loadAgentConfig } from './config.js';
import { AgentControl } from './control.js';
import { agentEnvPath, isStandaloneAgent, pairIfNeeded } from './pairing.js';
import { checkForUpdate, localUpdateInfo } from './update.js';

// When running as a packaged .exe, prefer a .env sitting next to the exe so the
// streamer can just drop it in the same folder and double-click.
loadEnv();
if (isStandaloneAgent()) loadEnv({ path: agentEnvPath() });

const config = loadAgentConfig();
const log = (message: string): void => console.log(`[${new Date().toISOString()}] ${message}`);
const version = localUpdateInfo();

let control: AgentControl | undefined;
const shutdown = (): void => {
  control?.close();
  process.exit(0);
};
control = new AgentControl(config, version, log, shutdown);
control.listen();
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const execHandler = new ExecHandler(allowedExecutables(config));
const hotkeyHandler = new HotkeyHandler();
const obsHandler = new ObsHandler(config);

async function executeAction(action: Action): Promise<void> {
  switch (action.type) {
    case 'exec':
      return execHandler.execute(action);
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

function connect(): void {
  const url = new URL(config.CLOUD_URL);
  url.searchParams.set('id', config.AGENT_ID);
  url.searchParams.set('token', config.AGENT_TOKEN);

  log(`Agent ${config.AGENT_ID} connecting to ${url.origin}${url.pathname}`);
  const socket = new WebSocket(url);
  let heartbeat: NodeJS.Timeout | undefined;

  const send = (message: AgentToCloudMessage): void => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };

  socket.on('open', () => {
    log('Connected to cloud');
    control?.setConnected(true);
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
      log('Cloud rejected the connection: this agent token is unknown or revoked. ' +
          'Generate a new code in the dashboard (or check AGENT_TOKEN in the .env file next to this agent).');
    }
  });
  socket.on('close', () => {
    if (heartbeat) clearInterval(heartbeat);
    control?.setConnected(false);
    log(`Disconnected; retrying in ${config.RECONNECT_DELAY_MS / 1000}s`);
    setTimeout(connect, config.RECONNECT_DELAY_MS);
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
