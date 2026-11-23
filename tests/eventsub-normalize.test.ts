import { describe, expect, it } from 'vitest';
import { normalizeEventSubNotification } from '../src/cloud/twitch/normalize.ts';

const broadcaster = { id: '1310399861', login: 'j4yvix' };

function notification(type: string, event: Record<string, unknown>): Record<string, unknown> {
  return {
    metadata: {
      message_id: 'message-1',
      message_type: 'notification',
      message_timestamp: '2026-11-23T08:00:00Z',
      subscription_type: type,
      subscription_version: '1'
    },
    payload: {
      subscription: {
        id: 'subscription-1',
        status: 'enabled',
        type,
        version: '1',
        condition: { broadcaster_user_id: broadcaster.id },
        transport: { method: 'websocket', session_id: 'session-1' },
        created_at: '2026-11-23T07:00:00Z',
        cost: 1
      },
      event
    }
  };
}

describe('normalizeEventSubNotification', () => {
  it('normalizes channel point notifications from EventSub WebSocket envelopes', () => {
    const message = notification('channel.channel_points_custom_reward_redemption.add', {
      id: 'redemption-1',
      broadcaster_user_id: broadcaster.id,
      broadcaster_user_login: broadcaster.login,
      user_id: '42',
      user_login: 'viewer',
      user_name: 'Viewer',
      user_input: 'hello',
      status: 'fulfilled',
      reward: { id: 'reward-1', title: 'Desktop' }
    });

    const event = normalizeEventSubNotification(message, broadcaster);

    expect(event).toBeDefined();
    expect(event?.type).toBe('channel_points');
    expect(event?.id).toBe('redemption-1');
    expect(event?.broadcaster.id).toBe(broadcaster.id);
    expect(event?.user.login).toBe('viewer');
    expect(event?.data).toMatchObject({
      rewardId: 'reward-1',
      rewardTitle: 'Desktop',
      userInput: 'hello',
      status: 'fulfilled'
    });
  });

  it('normalizes other supported WebSocket notification types', () => {
    const message = notification('channel.cheer', {
      id: 'cheer-1',
      broadcaster_user_id: broadcaster.id,
      broadcaster_user_login: broadcaster.login,
      user_id: '42',
      user_login: 'viewer',
      bits: 500,
      message: 'Go go go'
    });

    const event = normalizeEventSubNotification(message, broadcaster);

    expect(event?.type).toBe('cheer');
    expect(event?.data).toMatchObject({ bits: 500, message: 'Go go go' });
  });

  it('still accepts a bare payload without metadata', () => {
    const envelope = notification('channel.channel_points_custom_reward_redemption.add', {
      id: 'redemption-2',
      user_login: 'viewer',
      reward: { id: 'reward-2', title: 'Cam' }
    });

    const event = normalizeEventSubNotification(envelope['payload'] as Record<string, unknown>, broadcaster);

    expect(event?.type).toBe('channel_points');
    expect(event?.data).toMatchObject({ rewardId: 'reward-2', rewardTitle: 'Cam' });
  });

  it('ignores unsupported subscription types', () => {
    const message = notification('channel.follow', { id: 'follow-1', user_login: 'viewer' });
    expect(normalizeEventSubNotification(message, broadcaster)).toBeUndefined();
  });
});
