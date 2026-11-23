import OBSWebSocket from 'obs-websocket-js';
import type { Action } from '../../shared/types.js';
import type { AgentConfig } from '../config.js';

type SceneAction = Extract<Action, { type: 'obs_scene' }>;
type SourceAction = Extract<Action, { type: 'obs_source' }>;

export class ObsHandler {
  private readonly obs = new OBSWebSocket();
  private connected = false;
  private connecting: Promise<void> | undefined;

  constructor(private readonly config: AgentConfig) {}

  private async ensureConnected(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      await this.obs.connect(this.config.OBS_WS_URL, this.config.OBS_PASSWORD || undefined);
      this.connected = true;
      this.obs.on('ConnectionClosed', () => {
        this.connected = false;
      });
    })();

    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  async setScene(action: SceneAction): Promise<void> {
    await this.ensureConnected();
    await this.obs.call('SetCurrentProgramScene', { sceneName: action.sceneName });
  }

  async setSource(action: SourceAction): Promise<void> {
    await this.ensureConnected();
    const sceneName = action.sceneName ?? (await this.currentScene());
    const { sceneItemId } = await this.obs.call('GetSceneItemId', {
      sceneName,
      sourceName: action.sourceName
    });
    await this.obs.call('SetSceneItemEnabled', {
      sceneName,
      sceneItemId,
      sceneItemEnabled: action.visible
    });
  }

  private async currentScene(): Promise<string> {
    const response = await this.obs.call('GetCurrentProgramScene');
    return response.currentProgramSceneName;
  }
}
