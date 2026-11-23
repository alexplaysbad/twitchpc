import { z } from 'zod';

const schema = z.object({
  CLOUD_URL: z.string().default('ws://localhost:3000/agent'),
  AGENT_ID: z.string().default('default'),
  AGENT_TOKEN: z.string().default(''),
  /** One-time code from the dashboard; exchanged for AGENT_TOKEN on first run. */
  PAIRING_CODE: z.string().default(''),
  /** Comma-separated executable names/paths the cloud is allowed to launch. */
  EXEC_ALLOWLIST: z.string().default(''),
  OBS_WS_URL: z.string().default('ws://localhost:4455'),
  OBS_PASSWORD: z.string().default(''),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(15000),
  RECONNECT_DELAY_MS: z.coerce.number().int().positive().default(3000),
  /** Local-only HTTP port used by the tray app for status/pause/resume. */
  AGENT_CONTROL_PORT: z.coerce.number().int().positive().default(4310),
  /** Set by the tray launcher so auto-update lets the tray restart the agent. */
  AGENT_SUPERVISED: z.preprocess(
    (value) => {
      if (value === '' || value === undefined) return false;
      return String(value).toLowerCase() === 'true' || value === '1';
    },
    z.boolean()
  ),
  AGENT_AUTO_UPDATE: z.preprocess(
    (value) => {
      if (value === '' || value === undefined) return true;
      return String(value).toLowerCase() === 'true' || value === '1';
    },
    z.boolean()
  )
});

export type AgentConfig = z.infer<typeof schema>;

export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  return schema.parse(env);
}

export function allowedExecutables(config: AgentConfig): string[] {
  return config.EXEC_ALLOWLIST.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}
