import { describe, expect, it } from 'vitest';
import { matches } from '../src/cloud/engine/matcher.ts';
import { simulateEvent } from '../src/cloud/twitch/normalize.ts';

const broadcaster = { id: 'bc', login: 'streamer' };

describe('matches', () => {
  it('filters chat commands case-insensitively', () => {
    const event = simulateEvent('chat_command', { message: '!REBOOT', user_login: 'Viewer' }, broadcaster);
    expect(matches({ type: 'chat_command', filters: { command: 'reboot' } }, event)).toBe(true);
    expect(matches({ type: 'chat_command', filters: { command: 'shutdown' } }, event)).toBe(false);
  });

  it('filters channel points by reward and user', () => {
    const event = simulateEvent(
      'channel_points',
      { reward: { id: 'r1', title: 'Beep' }, user_login: 'viewer' },
      broadcaster
    );
    expect(matches({ type: 'channel_points', filters: { rewardId: 'r1', username: 'VIEWER' } }, event)).toBe(true);
    expect(matches({ type: 'channel_points', filters: { rewardId: 'r2' } }, event)).toBe(false);
    expect(matches({ type: 'cheer', filters: {} }, event)).toBe(false);
  });

  it('applies minimum bits and months', () => {
    const cheer = simulateEvent('cheer', { bits: 500 }, broadcaster);
    expect(matches({ type: 'cheer', filters: { minBits: 1000 } }, cheer)).toBe(false);
    expect(matches({ type: 'cheer', filters: { minBits: 500 } }, cheer)).toBe(true);

    const sub = simulateEvent('subscription', { months: 12, tier: '2000' }, broadcaster);
    expect(matches({ type: 'subscription', filters: { minMonths: 6, tiers: ['2000'] } }, sub)).toBe(true);
    expect(matches({ type: 'subscription', filters: { tiers: ['1000'] } }, sub)).toBe(false);
  });
});
