import tmi from 'tmi.js';
import type { TwitchEvent } from '../../shared/types.js';
import type { CloudConfig } from '../config.js';
import { normalizeChatMessage } from './normalize.js';

export class ChatClient {
  private client: tmi.Client | undefined;
  private connected = false;

  constructor(
    private readonly config: CloudConfig,
    private readonly onEvent: (event: TwitchEvent) => void,
    private readonly log: (message: string) => void
  ) {}

  async start(): Promise<void> {
    if (!this.config.TWITCH_BOT_TOKEN || !this.config.TWITCH_BOT_USERNAME) {
      this.log('Chat: TWITCH_BOT_TOKEN/TWITCH_BOT_USERNAME not set; chat commands disabled');
      return;
    }

    this.client = new tmi.Client({
      connection: { secure: true, server: 'irc-ws.chat.twitch.tv', port: 443, reconnect: true },
      identity: {
        username: this.config.TWITCH_BOT_USERNAME,
        password: `oauth:${this.config.TWITCH_BOT_TOKEN.replace(/^oauth:/i, '')}`
      },
      channels: [this.config.TWITCH_BROADCASTER_LOGIN]
    });

    this.client.on('message', (_channel, tags, message, self) => {
      if (self) return;
      const username = tags.username ?? tags['display-name'] ?? '';
      if (!username) return;
      const event = normalizeChatMessage(username, message, this.config.CHAT_COMMAND_PREFIX, {
        id: this.config.TWITCH_BROADCASTER_ID,
        login: this.config.TWITCH_BROADCASTER_LOGIN
      });
      if (event) this.onEvent(event);
    });

    this.client.on('connected' as never, (address: string, port: number) => {
      this.connected = true;
      this.log(`Chat: connected to ${address}:${port}`);
    });

    this.client.on('disconnected' as never, () => {
      this.connected = false;
    });

    try {
      await this.client.connect();
    } catch (error) {
      this.log(`Chat connect failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  async stop(): Promise<void> {
    if (this.client) await this.client.disconnect();
    this.client = undefined;
  }
}
