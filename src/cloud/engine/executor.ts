import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ActionCommand, Automation, TwitchEvent } from '../../shared/types.js';
import type { CloudConfig } from '../config.js';
import {
  insertCommand,
  listAutomations,
  logEvent,
  markCommand,
  recordAutomationTrigger,
  setSetting
} from '../db/repositories.js';
import { matches } from './matcher.js';
import { renderAction } from './template.js';

/** Implemented by the agent hub: sends agent-targeted commands and marks them sent. */
export interface CommandSink {
  dispatch(command: ActionCommand): Promise<void>;
}

export interface RunResult {
  matched: string[];
  commands: ActionCommand[];
  cooldownSkipped: string[];
}

export class RuleExecutor {
  private readonly lastRun = new Map<string, number>();

  constructor(
    private readonly config: CloudConfig,
    private readonly db: DatabaseSync,
    private readonly sink: CommandSink,
    private readonly log: (message: string) => void
  ) {}

  async run(event: TwitchEvent, dryRun = false): Promise<RunResult> {
    const result: RunResult = { matched: [], commands: [], cooldownSkipped: [] };
    const automations: Automation[] = listAutomations(this.db);
    const now = Date.now();

    for (const automation of automations) {
      if (!automation.enabled || !matches(automation.trigger, event)) continue;
      result.matched.push(automation.id);

      const cooldownKey = automation.cooldownPerUserSeconds
        ? `${automation.id}:${event.user.login}`
        : automation.id;
      const cooldownSeconds = automation.cooldownPerUserSeconds || automation.cooldownSeconds;
      const last = this.lastRun.get(cooldownKey) ?? 0;
      if (cooldownSeconds > 0 && now - last < cooldownSeconds * 1000) {
        result.cooldownSkipped.push(automation.id);
        continue;
      }
      if (!dryRun) {
        this.lastRun.set(cooldownKey, now);
        recordAutomationTrigger(this.db, automation.id, new Date(now).toISOString());
      }

      for (const action of automation.actions) {
        let resolved;
        try {
          resolved = renderAction(action, event);
        } catch (error) {
          this.log(`Failed to render action ${action.id}: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }

        const command: ActionCommand = {
          id: randomUUID(),
          automationId: automation.id,
          automationName: automation.name,
          eventId: event.id,
          agentId: resolved.agentId,
          action: resolved,
          createdAt: new Date().toISOString()
        };

        if (dryRun) {
          result.commands.push(command);
          continue;
        }

        insertCommand(this.db, command);
        result.commands.push(command);

        if (resolved.target === 'agent') {
          await this.sink.dispatch(command);
        } else {
          void this.executeWebhook(command);
        }
      }
    }

    logEvent(this.db, event, result.matched, event);
    setSetting(this.db, 'last_event_at', new Date().toISOString());
    return result;
  }

  private async executeWebhook(command: ActionCommand): Promise<void> {
    if (command.action.type !== 'webhook') return;
    const { url, method, headers, body } = command.action;
    try {
      const response = await fetch(url, {
        method,
        headers,
        body: method === 'GET' ? undefined : body,
        signal: AbortSignal.timeout(this.config.WEBHOOK_TIMEOUT_MS)
      });
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
      markCommand(this.db, command.id, 'done');
      this.log(`Webhook ${command.id} succeeded (${response.status})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      markCommand(this.db, command.id, 'failed', message);
      this.log(`Webhook ${command.id} failed: ${message}`);
    }
  }
}
