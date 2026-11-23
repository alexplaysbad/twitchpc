import { randomUUID } from 'node:crypto';
import type { EventType, TwitchEvent } from '../../shared/types.js';

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === 'object' ? (value as UnknownRecord) : {};
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? fallback : String(value);
}

function num(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function base(
  raw: unknown,
  event: UnknownRecord,
  broadcaster: { id: string; login: string }
): Pick<TwitchEvent, 'id' | 'receivedAt' | 'broadcaster' | 'user' | 'raw'> {
  return {
    id: str(event['id']) || randomUUID(),
    receivedAt: new Date().toISOString(),
    broadcaster: {
      id: str(event['broadcaster_user_id'], broadcaster.id),
      login: str(event['broadcaster_user_login'], broadcaster.login)
    },
    user: {
      id: str(event['user_id']),
      login: str(event['user_login']),
      displayName: str(event['user_name'], str(event['user_login']))
    },
    raw
  };
}

export interface BroadcasterIdentity {
  id: string;
  login: string;
}

const SUBSCRIPTION_TYPES: Record<string, EventType> = {
  'channel.channel_points_custom_reward_redemption.add': 'channel_points',
  'channel.subscription.message': 'subscription',
  'channel.subscription.gift': 'gift_subscription',
  'channel.cheer': 'cheer'
};

export function normalizeEventSubNotification(
  message: UnknownRecord,
  broadcaster: BroadcasterIdentity
): TwitchEvent | undefined {
  // EventSub WebSocket notifications wrap the subscription and event in
  // `payload`. Accept a bare payload as well for simple/internal callers.
  const payload = record(message['payload']);
  const body = payload['subscription'] !== undefined || payload['event'] !== undefined
    ? payload
    : message;
  if (body['subscription'] === undefined) return undefined;
  const subscription = record(body['subscription']);
  const type = SUBSCRIPTION_TYPES[str(subscription['type'])];
  if (type === undefined) return undefined;

  const event = record(body['event']);
  const common = base(message, event, broadcaster);

  switch (type) {
    case 'channel_points': {
      const reward = record(event['reward']);
      return {
        ...common,
        type,
        data: {
          rewardId: str(reward['id']),
          rewardTitle: str(reward['title']),
          userInput: str(event['user_input']),
          status: str(event['status'])
        }
      };
    }
    case 'subscription': {
      const subMessage = record(event['sub_message']);
      return {
        ...common,
        type,
        data: {
          tier: str(event['tier']),
          planName: str(event['plan_name']),
          months: num(event['months']),
          streakMonths: num(event['streak_months']),
          message: str(subMessage['message'], str(event['message'])),
          isResub: num(event['streak_months']) > 0
        }
      };
    }
    case 'gift_subscription':
      return {
        ...common,
        type,
        data: {
          tier: str(event['tier']),
          total: num(event['total']),
          amount: num(event['amount'])
        }
      };
    case 'cheer':
      return {
        ...common,
        type,
        data: {
          bits: num(event['bits']),
          message: str(event['message'])
        }
      };
  }
}

export function normalizeChatMessage(
  username: string,
  message: string,
  prefix: string,
  broadcaster: BroadcasterIdentity
): TwitchEvent | undefined {
  const trimmed = message.trim();
  if (!trimmed.startsWith(prefix)) return undefined;
  const withoutPrefix = trimmed.slice(prefix.length).trim();
  if (!withoutPrefix) return undefined;

  const [command = '', ...args] = withoutPrefix.split(/\s+/);
  return {
    id: randomUUID(),
    type: 'chat_command',
    receivedAt: new Date().toISOString(),
    broadcaster: { id: broadcaster.id, login: broadcaster.login },
    user: { id: '', login: username.toLowerCase(), displayName: username },
    data: { command: command.toLowerCase(), args, message: trimmed },
    raw: { channel: broadcaster.login, username, message: trimmed }
  };
}

/** Builds an event from the minimal test UI payload. */
export function simulateEvent(
  type: EventType,
  payload: UnknownRecord,
  broadcaster: BroadcasterIdentity
): TwitchEvent {
  const event = {
    ...payload,
    broadcaster_user_id: str(payload['broadcaster_user_id'], broadcaster.id),
    broadcaster_user_login: str(payload['broadcaster_user_login'], broadcaster.login)
  };
  const common = base(payload, event, broadcaster);

  switch (type) {
    case 'channel_points': {
      const reward = record(payload['reward']);
      return {
        ...common,
        type,
        data: {
          rewardId: str(reward['id'], str(payload['rewardId'])),
          rewardTitle: str(reward['title'], str(payload['rewardTitle'])),
          userInput: str(payload['user_input'], str(payload['userInput'])),
          status: str(payload['status'], 'fulfilled')
        }
      };
    }
    case 'subscription': {
      const subMessage = record(payload['sub_message']);
      return {
        ...common,
        type,
        data: {
          tier: str(payload['tier'], '1000'),
          planName: str(payload['plan_name'], 'Tier 1'),
          months: num(payload['months'], 1),
          streakMonths: num(payload['streak_months']),
          message: str(subMessage['message'], str(payload['message'])),
          isResub: num(payload['streak_months']) > 0
        }
      };
    }
    case 'gift_subscription':
      return {
        ...common,
        type,
        data: {
          tier: str(payload['tier'], '1000'),
          total: num(payload['total']),
          amount: num(payload['amount'], 1)
        }
      };
    case 'cheer':
      return {
        ...common,
        type,
        data: {
          bits: num(payload['bits'], 100),
          message: str(payload['message'])
        }
      };
    case 'chat_command': {
      const rawMessage = str(payload['message'], '!reboot');
      const prefix = str(payload['prefix'], '!');
      const [command = '', ...args] = rawMessage.replace(/^\s*\S/, '').trim().split(/\s+/);
      return {
        ...common,
        type,
        data: {
          command: str(payload['command'], command.toLowerCase()),
          args: Array.isArray(payload['args']) ? payload['args'].map((a) => str(a)) : args,
          message: rawMessage
        }
      };
    }
  }
}
