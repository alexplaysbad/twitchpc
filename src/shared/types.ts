/**
 * Shared contracts between the cloud control plane, the local agent and the
 * minimal test UI. Keep this file free of runtime dependencies.
 */

export type EventType =
  | 'channel_points'
  | 'subscription'
  | 'gift_subscription'
  | 'cheer'
  | 'chat_command';

export interface ChannelPointsData {
  rewardId: string;
  rewardTitle: string;
  userInput: string;
  status: string;
}

export interface SubscriptionData {
  tier: string;
  planName: string;
  months: number;
  streakMonths: number;
  message: string;
  isResub: boolean;
}

export interface GiftSubscriptionData {
  tier: string;
  total: number;
  amount: number;
}

export interface CheerData {
  bits: number;
  message: string;
}

export interface ChatCommandData {
  command: string;
  args: string[];
  message: string;
}

interface EventBase<T extends EventType, D> {
  id: string;
  type: T;
  receivedAt: string;
  broadcaster: { id: string; login: string };
  user: { id: string; login: string; displayName: string };
  data: D;
  raw: unknown;
}

export type TwitchEvent =
  | EventBase<'channel_points', ChannelPointsData>
  | EventBase<'subscription', SubscriptionData>
  | EventBase<'gift_subscription', GiftSubscriptionData>
  | EventBase<'cheer', CheerData>
  | EventBase<'chat_command', ChatCommandData>;

export type ThresholdMatchMode = 'highest' | 'cumulative';

export interface TriggerFilters {
  /** Channel points reward id (exact match). */
  rewardId?: string;
  /** Channel points reward title (case-insensitive exact match). */
  rewardTitle?: string;
  /** Chat command without the leading prefix, e.g. "reboot". */
  command?: string;
  /** Twitch login of the acting user, case-insensitive. */
  username?: string;
  /** Minimum cheer amount. */
  minBits?: number;
  /** Minimum subscribed month count. */
  minMonths?: number;
  /** Minimum number of gifted subs in one gift event. */
  minGiftAmount?: number;
  /**
   * For amount thresholds (bits, months, gift amount): `highest` only fires the
   * automation with the highest matching threshold; `cumulative` also fires lower ones.
   */
  thresholdMode?: ThresholdMatchMode;
  /** Allowed sub tiers: 1000, 2000, 3000. */
  tiers?: string[];
}

export interface Trigger {
  type: EventType;
  filters: TriggerFilters;
}

export type ActionTarget = 'cloud' | 'agent';

interface ActionBase {
  /** Stable id within an automation; used for logging. */
  id: string;
  label?: string;
  /** Optional agent id. Empty/undefined means "first connected agent". */
  agentId?: string;
}

export type Action =
  | (ActionBase & {
      type: 'exec';
      target: 'agent';
      command: string;
      args: string[];
      cwd?: string;
    })
  | (ActionBase & {
      type: 'cmd';
      target: 'agent';
      /** Full command line passed to cmd.exe /c. */
      command: string;
      cwd?: string;
    })
  | (ActionBase & {
      type: 'hotkey';
      target: 'agent';
      /** SendKeys-style sequence, e.g. "^+p" or "{ENTER}". */
      keys: string;
      /** Optional window title substring to focus before sending keys. */
      windowTitle?: string;
    })
  | (ActionBase & {
      type: 'obs_scene';
      target: 'agent';
      sceneName: string;
    })
  | (ActionBase & {
      type: 'obs_source';
      target: 'agent';
      sourceName: string;
      sceneName?: string;
      visible: boolean;
    })
  | (ActionBase & {
      type: 'webhook';
      target: 'cloud';
      url: string;
      method: 'GET' | 'POST' | 'PUT';
      headers: Record<string, string>;
      /** Request body; supports {{template.path}} placeholders. */
      body: string;
    });

export interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  actions: Action[];
  cooldownSeconds: number;
  cooldownPerUserSeconds?: number;
  lastTriggeredAt?: string | null;
  triggerCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ActionCommand {
  id: string;
  automationId: string;
  automationName: string;
  eventId: string;
  /** Agent this command should go to. Undefined means first connected agent. */
  agentId?: string;
  /** Action with all template placeholders already resolved. */
  action: Action;
  createdAt: string;
}

export type CommandStatus = 'pending' | 'sent' | 'done' | 'failed' | 'skipped';

export type CloudToAgentMessage =
  | { type: 'hello'; agentId: string; sentAt: string }
  | { type: 'command'; command: ActionCommand };

export type AgentToCloudMessage =
  | { type: 'register'; agentId: string }
  | { type: 'heartbeat'; agentId: string; at: string }
  | { type: 'ack'; commandId: string; ok: boolean; error?: string; at: string };

export interface AgentInfo {
  id: string;
  connected: boolean;
  lastSeen: string | null;
  /** Disabled agents cannot authenticate or receive commands. */
  enabled: boolean;
}
