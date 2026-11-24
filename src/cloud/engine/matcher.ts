import type { Automation, Trigger, TwitchEvent } from '../../shared/types.js';

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
      if (filters.minGiftAmount !== undefined && event.data.amount < filters.minGiftAmount) return false;
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

/** Returns the threshold value used for highest/cumulative amount matching. */
export function thresholdValue(trigger: Trigger): number | undefined {
  switch (trigger.type) {
    case 'cheer':
      return trigger.filters.minBits;
    case 'subscription':
      return trigger.filters.minMonths;
    case 'gift_subscription':
      return trigger.filters.minGiftAmount;
    default:
      return undefined;
  }
}

function thresholdGroupKey(automation: Automation, event: TwitchEvent): string | undefined {
  const threshold = thresholdValue(automation.trigger);
  if (threshold === undefined) return undefined;
  const filters = automation.trigger.filters;
  // Group only automations that compete on the same event type + same non-threshold constraints.
  const tiers = [...(filters.tiers ?? [])].sort().join(',');
  const user = (filters.username ?? '').toLowerCase();
  return [event.type, tiers, user].join('|');
}

/**
 * Applies "highest matching threshold" by default for amount filters, unless an
 * automation opts into cumulative mode. Cumulative automations still run when lower
 * than the highest match.
 */
export function selectTriggeredAutomations(automations: Automation[], event: TwitchEvent): Automation[] {
  const candidates = automations.filter((automation) => automation.enabled && matches(automation.trigger, event));
  const highestByGroup = new Map<string, number>();

  for (const automation of candidates) {
    const key = thresholdGroupKey(automation, event);
    const threshold = thresholdValue(automation.trigger);
    if (!key || threshold === undefined) continue;
    if ((automation.trigger.filters.thresholdMode ?? 'highest') !== 'highest') continue;
    highestByGroup.set(key, Math.max(highestByGroup.get(key) ?? -Infinity, threshold));
  }

  return candidates.filter((automation) => {
    const key = thresholdGroupKey(automation, event);
    const threshold = thresholdValue(automation.trigger);
    if (!key || threshold === undefined) return true;
    if ((automation.trigger.filters.thresholdMode ?? 'highest') === 'cumulative') return true;
    return threshold === highestByGroup.get(key);
  });
}
