import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  DB_PATH: z.string().default('./data/twitchpc.db'),
  ADMIN_TOKEN: z.string().default(''),
  ADMIN_TOKEN_FILE: z.string().default(''),
  DEFAULT_AGENT_ID: z.string().default('default'),
  COMMAND_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  LOG_DIR: z.string().default(''),
  RELEASE_DIR: z.string().default('./release'),
  TWITCH_CLIENT_ID: z.string().default(''),
  TWITCH_CLIENT_SECRET: z.string().default(''),
  TWITCH_BROADCASTER_ID: z.string().default(''),
  TWITCH_BROADCASTER_LOGIN: z.string().default(''),
  TWITCH_BROADCASTER_ACCESS_TOKEN: z.string().default(''),
  TWITCH_BROADCASTER_REFRESH_TOKEN: z.string().default(''),
  TWITCH_APP_TOKEN: z.string().default(''),
  TWITCH_BOT_TOKEN: z.string().default(''),
  TWITCH_BOT_USERNAME: z.string().default(''),
  CHAT_COMMAND_PREFIX: z.string().default('!'),
  AGENT_TOKEN: z.string().default(''),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(10000)
});

export type CloudConfig = z.infer<typeof schema>;

export function loadCloudConfig(env: NodeJS.ProcessEnv = process.env): CloudConfig {
  return schema.parse(env);
}

export function missingCloudConfig(config: CloudConfig): string[] {
  const missing: string[] = [];
  if (!config.TWITCH_CLIENT_ID) missing.push('TWITCH_CLIENT_ID');
  if (!config.TWITCH_CLIENT_SECRET) missing.push('TWITCH_CLIENT_SECRET');
  if (!config.TWITCH_BROADCASTER_ID) missing.push('TWITCH_BROADCASTER_ID');
  if (!config.TWITCH_BROADCASTER_LOGIN) missing.push('TWITCH_BROADCASTER_LOGIN');
  // AGENT_TOKEN is optional now: agents can pair from the dashboard and receive
  // their own token. It remains supported as a shared fallback secret.
  return missing;
}
