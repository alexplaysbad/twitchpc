import { describe, expect, it } from 'vitest';
import { matches, selectTriggeredAutomations } from '../src/cloud/engine/matcher.ts';
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

  it('applies minimum bits, months, and gift amount', () => {
    const cheer = simulateEvent('cheer', { bits: 500 }, broadcaster);
    expect(matches({ type: 'cheer', filters: { minBits: 1000 } }, cheer)).toBe(false);
    expect(matches({ type: 'cheer', filters: { minBits: 500 } }, cheer)).toBe(true);

    const sub = simulateEvent('subscription', { months: 12, tier: '2000' }, broadcaster);
    expect(matches({ type: 'subscription', filters: { minMonths: 6, tiers: ['2000'] } }, sub)).toBe(true);
    expect(matches({ type: 'subscription', filters: { tiers: ['1000'] } }, sub)).toBe(false);

    const gift = simulateEvent('gift_subscription', { amount: 7, tier: '1000' }, broadcaster);
    expect(matches({ type: 'gift_subscription', filters: { minGiftAmount: 5 } }, gift)).toBe(true);
    expect(matches({ type: 'gift_subscription', filters: { minGiftAmount: 10 } }, gift)).toBe(false);
  });

  it('uses highest threshold by default and supports cumulative mode', () => {
    const gift = simulateEvent('gift_subscription', { amount: 11, tier: '1000', user_login: 'viewer' }, broadcaster);
    const automations = [
      { id: 'a5', enabled: true, trigger: { type: 'gift_subscription', filters: { minGiftAmount: 5 } } },
      { id: 'a10', enabled: true, trigger: { type: 'gift_subscription', filters: { minGiftAmount: 10 } } },
      { id: 'a5c', enabled: true, trigger: { type: 'gift_subscription', filters: { minGiftAmount: 5, thresholdMode: 'cumulative' } } }
    ] as any;

    expect(selectTriggeredAutomations(automations, gift).map((a) => a.id).sort()).toEqual(['a10', 'a5c']);

    const cheer = simulateEvent('cheer', { bits: 1100 }, broadcaster);
    const cheerAutomations = [
      { id: 'b100', enabled: true, trigger: { type: 'cheer', filters: { minBits: 100 } } },
      { id: 'b1000', enabled: true, trigger: { type: 'cheer', filters: { minBits: 1000 } } }
    ] as any;
    expect(selectTriggeredAutomations(cheerAutomations, cheer).map((a) => a.id)).toEqual(['b1000']);
  });
});
