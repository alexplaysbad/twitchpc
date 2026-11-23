import type { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import type { TwitchEvent } from '../../shared/types.js';
import type { CloudConfig } from '../config.js';
import {
  deleteEventSubSubscription,
  listEventSubSubscriptions,
  saveEventSubSubscription,
  setEventSubSession
} from '../db/repositories.js';
import { normalizeEventSubNotification } from './normalize.js';
import { TwitchTokens } from './tokens.js';

const EVENTSUB_WS = 'wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30';
const HELIX_SUBSCRIPTIONS = 'https://api.twitch.tv/helix/eventsub/subscriptions';

const TOPICS = [
  'channel.channel_points_custom_reward_redemption.add',
  'channel.subscription.message',
  'channel.subscription.gift',
  'channel.cheer'
] as const;

type MessageRecord = Record<string, unknown>;

interface HelixResult {
  ok: boolean;
  status: number;
  body: MessageRecord;
}

function record(value: unknown): MessageRecord {
  return value !== null && typeof value === 'object' ? (value as MessageRecord) : {};
}

function dataEntries(body: MessageRecord): MessageRecord[] {
  return Array.isArray(body['data']) ? body['data'].map((entry) => record(entry)) : [];
}

export class EventSubClient {
  private socket: WebSocket | undefined;
  private watchdog: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private lastMessageAt = 0;
  private reconnectUrl = EVENTSUB_WS;
  private attempt = 0;
  private pendingReconnect = false;
  private syncing = false;

  constructor(
    private readonly config: CloudConfig,
    private readonly tokens: TwitchTokens,
    private readonly db: DatabaseSync,
    private readonly onEvent: (event: TwitchEvent) => void,
    private readonly log: (message: string) => void
  ) {}

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.reconnectTimer = undefined;
    this.watchdog = undefined;
    this.socket?.close();
    this.socket = undefined;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const url = this.reconnectUrl;
    const usingReconnectUrl = url !== EVENTSUB_WS;
    this.reconnectUrl = EVENTSUB_WS;
    // If a reconnect URL failed and we fell back to the main endpoint, this is a
    // brand-new session: Twitch will not have migrated the old subscriptions.
    if (!usingReconnectUrl) this.pendingReconnect = false;
    this.log(`EventSub: connecting to ${usingReconnectUrl ? 'reconnect URL' : 'Twitch WebSocket'}`);

    try {
      const token = await this.tokens.appToken();
      const socket = new WebSocket(url, {
        headers: {
          'Client-ID': this.config.TWITCH_CLIENT_ID,
          Authorization: `Bearer ${token}`
        }
      });
      this.socket = socket;
      this.lastMessageAt = Date.now();

      socket.on('message', (data) => {
        this.lastMessageAt = Date.now();
        this.handleMessage(data.toString());
      });

      socket.on('close', () => {
        if (this.socket === socket) {
          this.socket = undefined;
          if (this.watchdog) clearInterval(this.watchdog);
          this.watchdog = undefined;
        }
        this.scheduleReconnect('closed');
      });

      socket.on('error', (error) => {
        this.log(`EventSub error: ${error.message}`);
      });

      if (!this.watchdog) {
        this.watchdog = setInterval(() => {
          if (Date.now() - this.lastMessageAt > 45_000) {
            this.log('EventSub: keepalive timed out, reconnecting');
            socket.terminate();
          }
        }, 5_000);
        this.watchdog.unref();
      }
    } catch (error) {
      this.log(`EventSub connect failed: ${error instanceof Error ? error.message : String(error)}`);
      this.scheduleReconnect('connect failed');
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped || this.reconnectTimer) return;
    this.attempt += 1;
    const delay = Math.min(1000 * 2 ** Math.min(this.attempt, 6), 60_000);
    this.log(`EventSub: ${reason}; retrying in ${delay / 1000}s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
    this.reconnectTimer.unref();
  }

  private handleMessage(raw: string): void {
    let message: MessageRecord;
    try {
      message = record(JSON.parse(raw));
    } catch {
      return;
    }

    const metadata = record(message['metadata']);
    switch (metadata['message_type']) {
      case 'session_welcome': {
        this.attempt = 0;
        const payload = record(message['payload']);
        const session = record(payload['session']);
        const sessionId = String(session['id'] ?? '');
        if (!sessionId) break;

        if (this.pendingReconnect) {
          // Twitch migrates subscriptions to the new session automatically.
          this.pendingReconnect = false;
          setEventSubSession(this.db, sessionId);
          this.log(`EventSub migrated subscriptions to session ${sessionId}`);
        } else {
          void this.syncSubscriptions(sessionId);
        }
        break;
      }
      case 'session_reconnect': {
        const payload = record(message['payload']);
        const session = record(payload['session']);
        const url = String(session['reconnect_url'] ?? '');
        if (url) {
          this.pendingReconnect = true;
          this.reconnectUrl = url;
          this.socket?.close();
        }
        break;
      }
      case 'notification': {
        const event = normalizeEventSubNotification(message, {
          id: this.config.TWITCH_BROADCASTER_ID,
          login: this.config.TWITCH_BROADCASTER_LOGIN
        });
        if (event) this.onEvent(event);
        break;
      }
      case 'revocation': {
        const payload = record(message['payload']);
        const subscription = record(payload['subscription']);
        const type = String(subscription['type'] ?? 'unknown');
        const subscriptionId = String(subscription['id'] ?? '');
        const saved = type === 'unknown' ? undefined : this.findSavedSubscription(type, subscriptionId);
        if (saved) {
          deleteEventSubSubscription(this.db, saved.type);
          this.log(`EventSub subscription revoked and removed: ${saved.type}`);
        } else {
          this.log(`EventSub subscription revoked: ${type}`);
        }
        break;
      }
    }
  }

  private findSavedSubscription(type: string, subscriptionId: string) {
    return listEventSubSubscriptions(this.db).find((entry) =>
      entry.type === type && (!subscriptionId || entry.subscriptionId === subscriptionId));
  }

  /**
   * Reuse subscriptions that Twitch still reports as enabled on this session,
   * remove stale ones, and create any that are missing. IDs and statuses are
   * persisted so a cloud restart does not blindly create duplicates.
   */
  private async syncSubscriptions(sessionId: string): Promise<void> {
    if (this.syncing || this.stopped) return;
    this.syncing = true;
    try {
      const appToken = await this.tokens.appToken();
      let accessToken = await this.tokens.userToken() ?? appToken;
      const saved = listEventSubSubscriptions(this.db);

      for (const type of TOPICS) {
        const existing = saved.find((entry) => entry.type === type);
        if (existing?.subscriptionId) {
          const valid = await this.subscriptionIsValid(existing.subscriptionId, sessionId, appToken);
          if (valid) {
            saveEventSubSubscription(this.db, {
              ...existing,
              status: 'enabled',
              sessionId
            });
            this.log(`EventSub reusing subscription ${type} (${existing.subscriptionId})`);
            continue;
          }
          this.log(`EventSub subscription for ${type} is stale; recreating`);
          deleteEventSubSubscription(this.db, type);
          await this.deleteSubscription(existing.subscriptionId, appToken);
        }

        let result = await this.subscribe(type, sessionId, accessToken);
        if (result.status === 401) {
          this.log(`EventSub token rejected for ${type}; refreshing user token`);
          const refreshed = await this.tokens.refreshUserToken();
          if (refreshed) {
            accessToken = refreshed;
            result = await this.subscribe(type, sessionId, accessToken);
          }
        }
        if (!result.ok) {
          this.log(`EventSub subscribe failed for ${type}: ${result.status} ${JSON.stringify(result.body)}`);
          continue;
        }

        const subscription = dataEntries(result.body)[0];
        const subscriptionId = String(subscription?.['id'] ?? '');
        if (!subscriptionId) {
          this.log(`EventSub subscribe returned no id for ${type}`);
          continue;
        }
        saveEventSubSubscription(this.db, {
          type,
          subscriptionId,
          status: String(subscription?.['status'] ?? 'enabled'),
          sessionId
        });
        this.log(`EventSub subscribed: ${type} (${subscriptionId})`);
      }
    } catch (error) {
      this.log(`EventSub subscription sync failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.syncing = false;
    }
  }

  private async subscriptionIsValid(id: string, sessionId: string, appToken: string): Promise<boolean> {
    const result = await this.helix('GET', `${HELIX_SUBSCRIPTIONS}?id=${encodeURIComponent(id)}`, appToken);
    if (!result.ok) return false;
    const subscription = dataEntries(result.body)[0];
    if (!subscription) return false;
    const transport = record(subscription['transport']);
    return String(subscription['status'] ?? '') === 'enabled' &&
      String(transport['method'] ?? '') === 'websocket' &&
      String(transport['session_id'] ?? '') === sessionId;
  }

  private async deleteSubscription(id: string, appToken: string): Promise<void> {
    try {
      await this.helix('DELETE', `${HELIX_SUBSCRIPTIONS}?id=${encodeURIComponent(id)}`, appToken);
    } catch (error) {
      this.log(`Could not delete stale EventSub subscription ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private subscribe(type: string, sessionId: string, token: string): Promise<HelixResult> {
    return this.helix('POST', HELIX_SUBSCRIPTIONS, token, {
      type,
      version: '1',
      condition: { broadcaster_user_id: this.config.TWITCH_BROADCASTER_ID },
      transport: { method: 'websocket', session_id: sessionId }
    });
  }

  private async helix(
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    token: string,
    body?: MessageRecord
  ): Promise<HelixResult> {
    const response = await fetch(url, {
      method,
      headers: {
        'Client-ID': this.config.TWITCH_CLIENT_ID,
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const parsed = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, body: record(parsed) };
  }
}
