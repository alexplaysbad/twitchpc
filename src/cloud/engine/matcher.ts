import type { Trigger, TwitchEvent } from '../../shared/types.js';

function same(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
}

export function matches(trigger: Trigger, event: TwitchEvent): boolean {
  if (trigger.type !== event.type) return false;
  const filters = trigger.filters;

  if (filters.username !== undefined && !same(event.user.login, filters.username)) return false;

  switch (event.type) {
    case 'channel_points':
      if (filters.rewardId !== undefined && event.data.rewardId !== filters.rewardId) return false;
      if (filters.rewardTitle !== undefined && !same(event.data.rewardTitle, filters.rewardTitle)) return false;
      return true;

    case 'subscription':
      if (filters.minMonths !== undefined && event.data.months < filters.minMonths) return false;
      if (filters.tiers !== undefined && !filters.tiers.includes(event.data.tier)) return false;
      return true;

    case 'gift_subscription':
      if (filters.tiers !== undefined && !filters.tiers.includes(event.data.tier)) return false;
      return true;

    case 'cheer':
      if (filters.minBits !== undefined && event.data.bits < filters.minBits) return false;
      return true;

    case 'chat_command':
      if (filters.command !== undefined && !same(event.data.command, filters.command)) return false;
      return true;
  }
}
