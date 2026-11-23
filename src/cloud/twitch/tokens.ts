import type { DatabaseSync } from 'node:sqlite';
import type { CloudConfig } from '../config.js';
import { getSetting, setSetting } from '../db/repositories.js';

const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

const USER_ACCESS_KEY = 'twitch_user_access_token';
const USER_REFRESH_KEY = 'twitch_user_refresh_token';
const USER_EXPIRY_KEY = 'twitch_user_expires_at';

export class TwitchTokens {
  private appTokenCache: { value: string; expiresAt: number } | undefined;

  constructor(
    private readonly config: CloudConfig,
    private readonly db: DatabaseSync
  ) {}

  async appToken(): Promise<string> {
    if (this.config.TWITCH_APP_TOKEN) return this.config.TWITCH_APP_TOKEN;
    if (this.appTokenCache && this.appTokenCache.expiresAt > Date.now() + 60_000) return this.appTokenCache.value;

    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.TWITCH_CLIENT_ID,
        client_secret: this.config.TWITCH_CLIENT_SECRET,
        grant_type: 'client_credentials'
      })
    });
    if (!response.ok) throw new Error(`Failed to obtain app token: ${response.status} ${await response.text()}`);

    const data = (await response.json()) as TokenResponse;
    this.appTokenCache = {
      value: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000
    };
    return data.access_token;
  }

  async userToken(): Promise<string | undefined> {
    const stored = getSetting(this.db, USER_ACCESS_KEY);
    const expiresAt = Number(getSetting(this.db, USER_EXPIRY_KEY) ?? 0);

    if (stored && (expiresAt === 0 || expiresAt > Date.now() + 60_000)) return stored;

    // No stored token yet: the env token has unknown expiry, so use it until
    // Twitch tells us it is invalid (then refreshUserToken is called).
    if (!stored && this.config.TWITCH_BROADCASTER_ACCESS_TOKEN) {
      return this.config.TWITCH_BROADCASTER_ACCESS_TOKEN;
    }
    return this.refreshUserToken();
  }

  async refreshUserToken(): Promise<string | undefined> {
    const refreshToken = getSetting(this.db, USER_REFRESH_KEY) ?? this.config.TWITCH_BROADCASTER_REFRESH_TOKEN;
    if (!refreshToken) return undefined;

    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.TWITCH_CLIENT_ID,
        client_secret: this.config.TWITCH_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: refreshToken
      })
    });
    if (!response.ok) throw new Error(`Failed to refresh user token: ${response.status} ${await response.text()}`);

    const data = (await response.json()) as TokenResponse;
    this.storeUserTokens(data.access_token, data.refresh_token ?? refreshToken, data.expires_in);
    return data.access_token;
  }

  storeUserTokens(accessToken: string, refreshToken?: string, expiresIn = 0): void {
    setSetting(this.db, USER_ACCESS_KEY, accessToken);
    setSetting(this.db, USER_EXPIRY_KEY, String(expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0));
    if (refreshToken) setSetting(this.db, USER_REFRESH_KEY, refreshToken);
  }

  clearStoredUserToken(): void {
    setSetting(this.db, USER_ACCESS_KEY, '');
    setSetting(this.db, USER_REFRESH_KEY, '');
    setSetting(this.db, USER_EXPIRY_KEY, '0');
  }
}
