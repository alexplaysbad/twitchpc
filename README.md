# TwitchPC

A TypeScript backend for turning Twitch events into automations on a streamer's PC.

- **Cloud control plane** — listens to Twitch EventSub (channel points, subs, gift subs, bits) and a chat bot (`!commands`), matches configurable rules, stores everything in SQLite, exposes a REST API and a minimal test UI, and forwards PC actions to the local agent.
- **Local agent** — runs on the streamer's Windows PC, connects **outbound** to the cloud over WebSockets, and executes allowlisted `exec`/`cmd`/hotkey actions plus OBS scene/source control.
- **Webhook action** — runs in the cloud. Use it as a generic hook to wire up your own overlay service (e.g. Pogly.GG); there is no overlay server in this project.

## Quick start

```powershell
npm install
copy .env.example .env
# edit .env
npm run build

# terminal 1 (cloud)
npm run start:cloud

# terminal 2 (agent, on the streamer's PC)
npm run start:agent
```

Open the test UI at `http://localhost:3000/ui/`. It has a form-based automation builder (no JSON needed), an event simulator with match preview, and live tables of recent events and commands.

For development: `npm run dev:cloud` / `npm run dev:agent` (auto-reload via `tsx watch`).
Run tests with `npm test`.

## Docker (cloud control plane)

The image runs the **cloud only**. The Windows agent still runs on the streamer's PC (as the standalone `.exe`) and connects outbound to the published TCP port.

```powershell
copy .env.example .env
# fill in the Twitch settings; PORT defaults to 3000
npm run docker:build
npm run docker:up
npm run docker:logs
```

Compose publishes `${PORT:-3000}` on the host, binds the cloud to `0.0.0.0` inside the container, and stores the SQLite DB, generated admin token and logs in the `twitchpc-data` named volume. It also mounts `./release` read-only so `/download/twitchpc-agent.exe` and `version.json` serve your latest agent build.

Open `http://localhost:<PORT>/ui/`. If `ADMIN_TOKEN` is empty, the token is generated on first start at `/data/admin-token.txt` inside the container:

```powershell
docker compose exec cloud cat /data/admin-token.txt
```

Or set `ADMIN_TOKEN` explicitly in `.env`. Stop with `npm run docker:down`; state survives restarts. Use `docker compose down -v` to delete it.

To run without Compose:

```bash
docker build -t twitchpc-cloud .
docker run -d --name twitchpc-cloud --restart unless-stopped \
  -p 2559:2559 \
  --env-file .env \
  -e HOST=0.0.0.0 -e PORT=2559 \
  -e DB_PATH=/data/twitchpc.db \
  -e ADMIN_TOKEN_FILE=/data/admin-token.txt \
  -e LOG_DIR=/data/logs \
  -v twitchpc-data:/data \
  -v "$PWD/release:/app/release:ro" \
  twitchpc-cloud
```

If you use Tailscale Serve on the Docker host, restrict the published port to loopback by changing the Compose mapping to `"127.0.0.1:${PORT:-3000}:${PORT:-3000}"`; `tailscale serve --bg <PORT>` can then proxy to it. Keep `HOST=0.0.0.0` inside the container.

> The agent cannot run in this Linux image: hotkeys, OBS WebSocket and the tray app are Windows-specific. Run `TwitchPC Agent.exe` on the PC and point `CLOUD_URL` at the Docker host.

## Standalone agent .exe (no Node needed on the streamer's PC)

On a Windows machine with Node installed:

```powershell
npm install
npm run build:exe
```

This creates a `release/` folder containing:

- `TwitchPC Agent.exe` — the graphical system-tray app (no console window) that streamers should launch
- `twitchpc-agent.exe` — the hidden agent engine with the Node runtime and dependencies bundled
- `.env.example` — copy to `.env` in the same folder and fill in `CLOUD_URL`, `EXEC_ALLOWLIST`, `CMD_ALLOWLIST`, OBS settings, and either `PAIRING_CODE` or a matching `AGENT_TOKEN`
- `install-agent.ps1` / `uninstall-agent.ps1` — optional hidden logon task + Start Menu installer
- `version.json` — version + SHA-256 manifest used to auto-update the engine
- `README.txt` — short instructions for the streamer

Give the whole `release/` folder to the streamer. They edit `.env` next to the exes, then double-click **`TwitchPC Agent.exe`**. It starts the engine hidden and shows a tray icon. Right-click the icon to open settings, pause/resume commands, restart the engine, or exit. The engine reads `.env` from the folder containing the exe even if launched from another working directory. Keep `.env` out of version control.

The engine uses Node's Single Executable Applications feature. It contains only code — no Twitch credentials — so each agent still needs its own `.env`.

### Install as an app

Right-click `install-agent.ps1` → **Run with PowerShell** to:

- register a hidden logon task that starts `TwitchPC Agent.exe`;
- add **Start Menu → TwitchPC → TwitchPC Agent** so the streamer can reopen it later;
- start the tray app immediately.

Run `uninstall-agent.ps1` to remove the task, shortcut, and running processes. It leaves the release folder and `.env` in place.

The tray app talks to the engine over a loopback-only control API on `127.0.0.1:4310` (configurable with `AGENT_CONTROL_PORT`). The settings window edits the same `.env` file and restarts the engine after saving.

## Twitch setup

### 1. Register a Twitch app

1. Go to <https://dev.twitch.tv/console/apps> and sign in.
2. Click **Register Your Application**.
3. Name it anything (e.g. `TwitchPC`), set **OAuth Redirect URL** to `https://localhost:3001/callback`, pick category **Other**, and create it. (Twitch requires HTTPS even for localhost. The helper runs a temporary local HTTPS server with a self-signed certificate.)
4. Open the app → **Manage** → copy the **Client ID** into `.env` as `TWITCH_CLIENT_ID`.
5. Click **New Secret**, copy it immediately (it is only shown once), and put it in `.env` as `TWITCH_CLIENT_SECRET`.

### 2. Get the broadcaster ID and login

The broadcaster login is the Twitch username (e.g. `mystreamer`). Look up the numeric ID with a tool like <https://twitchinsights.net/checkuser> (or Twitch's `/helix/users` API once the cloud is running). Put both in `.env` as `TWITCH_BROADCASTER_ID` and `TWITCH_BROADCASTER_LOGIN`.

### 3. Generate the tokens

With `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` in `.env`, run:

```powershell
npm run token:user
```

A browser opens. Your browser will warn that the certificate is self-signed — choose **Advanced / Proceed**. **Log in as the streamer account**, approve the requested scopes, and the terminal prints two lines — paste them into `.env`:

```
TWITCH_BROADCASTER_ACCESS_TOKEN=...
TWITCH_BROADCASTER_REFRESH_TOKEN=...
```

Scopes requested: `channel:read:redemptions`, `channel:read:subscriptions`, `bits:read`.

For chat commands, use a **separate bot account**:

```powershell
npm run token:bot
```

Log in as the **bot account**. This requests only `chat:read` (IRC read access) — `chat:write` is not a valid Twitch scope. Paste the printed `TWITCH_BOT_TOKEN` into `.env` and set `TWITCH_BOT_USERNAME` to the bot account's login. The bot must be able to chat in the channel.

Tokens are refreshed automatically and cached in SQLite; after the first refresh, the database values take precedence over `.env`. If you ever need to re-authorize, re-run the helper and update `.env`, then delete the `twitch_user_*` rows from the `settings` table (or delete the DB file).

### 4. Finish

Use the dashboard's **Pair agent** flow (or set the same `AGENT_TOKEN` in both cloud and agent environments for a legacy shared secret). EventSub runs over WebSockets, so no public HTTPS webhook URL is needed. Subscription IDs, statuses and session IDs are stored in SQLite and reused on reconnect; revoked or stale ones are recreated automatically.

### Recommended: Tailscale Serve + MagicDNS

Avoid hardcoding a `100.x` Tailscale IP. It can change. With Tailscale installed on the cloud machine:

```powershell
tailscale serve --bg 2559
```

Then set:

```dotenv
# cloud .env
HOST=127.0.0.1
PORT=2559
```

```dotenv
# agent .env
CLOUD_URL=wss://<machine-name>.<tailnet>.ts.net/agent
```

Open the dashboard at `https://<machine-name>.<tailnet>.ts.net/ui/`. Tailscale Serve provides HTTPS/WSS with a valid certificate, so there is no browser warning and the agent gets a secure TLS connection. If you do not use Serve, set `HOST=0.0.0.0` and use `ws://<magicdns-host>:2559/agent`.

### Admin token

If `ADMIN_TOKEN` is empty, the cloud generates a strong token at startup, stores it in `data/admin-token.txt`, and prints it once. Paste it into the dashboard's **Settings → Admin token** field. Set `ADMIN_TOKEN` explicitly in `.env` if you want to manage it yourself. `/api/health`, `/api/agent/version` and `/api/agent/pair` remain public; every other `/api` route requires `Authorization: Bearer <token>`.

### Agent manager (recommended)

You no longer have to copy a shared secret by hand:

1. Open the dashboard and click **Pair agent**.
2. Optionally enter an **Agent ID** (e.g. `stream-pc`). Click **Generate code**.
3. In the tray app, paste the code into the pairing prompt that appears automatically when the agent has no token or its token was revoked. You can also right-click the tray icon → **Enter pairing code...** at any time.
4. The agent exchanges the code immediately: it saves a unique `AGENT_TOKEN` into its `.env`, clears `PAIRING_CODE`, and reconnects **without a restart**.

If you prefer the file-based flow, copy the generated `AGENT_ID` / `PAIRING_CODE` snippet into the `.env` next to `twitchpc-agent.exe` and start the agent once. Codes expire after 10 minutes and work exactly once.

The dashboard Agent Manager also lets you:

- **Disable** an agent to disconnect it and reject future connections until you re-enable it.
- **Enable** a disabled agent so it can pair/connect again.
- **Revoke token** to disconnect a paired agent and force a fresh pairing code.
- **Delete** an agent to remove its token/pairing codes and keep a tombstone so that agent ID cannot reconnect with the old shared fallback token.

The old shared `AGENT_TOKEN` in the cloud `.env` still works as a fallback for existing installs; if it is set, any agent presenting that exact token can connect as any non-deleted, enabled ID.

### Troubleshooting: agent says `unexpected server response: 401`

The cloud rejects agent connections whose `?token=` is neither a valid per-agent token nor the cloud's shared `AGENT_TOKEN`. On the agent machine:

- Preferred: generate a fresh code with **Pair agent** in the dashboard, put `PAIRING_CODE` in the `.env` file **next to `twitchpc-agent.exe`**, and restart the agent.
- If you use a shared token instead, put `AGENT_TOKEN` in that same `.env` file (copy it exactly from the cloud's `.env`). Leaving `change-me` from an old `.env.example` causes 401.
- Set `CLOUD_URL=wss://<machine-name>.<tailnet>.ts.net/agent` with Tailscale Serve, or `ws://<magicdns-host>:2559/agent` for direct Tailscale HTTP (not `localhost` when the agent is on another machine).
- Launch from the `release/` folder so no other `.env` in the current directory overrides it.
- Restart the agent after editing `.env`. A revoked token produces the same 401; pair again to get a new one.

## OBS

Enable OBS WebSocket (Tools → WebSocket Server Settings), set a password, and point the agent at it:

```
OBS_WS_URL=ws://localhost:4455
OBS_PASSWORD=your-password
```

## Security notes

- The cloud can trigger code execution on the agent. Use WSS in production (`CLOUD_URL=wss://...`) and unique per-agent tokens from the pairing flow. The shared `AGENT_TOKEN` fallback is convenient but less isolated.
- `EXEC_ALLOWLIST` is a comma-separated list of executable names/paths the agent will accept. Cloud rules must use one of those exact strings as the `command`.
- `CMD_ALLOWLIST` is a list of **exact** `cmd.exe /c` command lines the agent will accept. Separate entries with `|` or newlines. Example: `CMD_ALLOWLIST=shutdown /s /t 0|shutdown /r /t 0`. The final rendered command is checked against the allowlist, so template values cannot escape it.
- `ADMIN_TOKEN` is generated automatically on first run if left empty; enter it in the UI's **Settings → Admin token** field.
- Commands that are not acknowledged within `COMMAND_TIMEOUT_MS` (default 30s) are marked `failed`, including commands left in flight after a cloud restart.

## Automation model

An automation has:

```json
{
  "name": "Example",
  "enabled": true,
  "trigger": { "type": "chat_command", "filters": { "command": "reboot" } },
  "actions": [
    {
      "type": "hotkey",
      "target": "agent",
      "agentId": "stream-pc",
      "keys": "%{F4}",
      "windowTitle": "OBS"
    }
  ],
  "cooldownSeconds": 5,
  "cooldownPerUserSeconds": 0
}
```

Trigger types: `channel_points`, `subscription`, `gift_subscription`, `cheer`, `chat_command`.

Filters: `rewardId`, `rewardTitle`, `command`, `username`, `minBits`, `minMonths`, `tiers` (`["1000","2000","3000"]`).

Action types:

| Type | Target | Description |
| --- | --- | --- |
| `exec` | agent | Launch an allowlisted executable with args |
| `cmd` | agent | Run an exact allowlisted command line through `cmd.exe /c` (e.g. shutdown) |
| `hotkey` | agent | Send keys via PowerShell SendKeys, optionally focusing a window by title |
| `obs_scene` | agent | Switch the current program scene |
| `obs_source` | agent | Enable/disable a scene item |
| `webhook` | cloud | HTTP POST/PUT/GET with templated URL, headers and body |

Templates use `{{user.login}}`, `{{user.displayName}}`, `{{data.bits}}`, `{{data.rewardTitle}}`, etc. They work in all string action fields, so a webhook body can carry event data to your own overlay integration. For `cmd`, the **final rendered** command is checked against `CMD_ALLOWLIST`, so keep allowed entries as exact command lines.

## Dashboard

Open `/ui/`. It is form-based — no JSON editing required.

- Use the header master switch to disable/enable the whole system (stops Twitch listening and automation dispatch).
- Generate one-time agent codes with **Pair agent**, then manage agents from the same panel: per-agent enable switches, revoke tokens, or delete them.
- Switch between light and dark mode with the header toggle; the choice is remembered locally.
- Build automations with a guided **When this happens → Do this** form.
- Add actions for programs, CMD commands, hotkeys, OBS scenes/sources and webhooks; reorder or remove them.
- Choose a target agent per agent action (`First online agent` or a specific `AGENT_ID`).
- Insert event variables into text fields with the variable picker.
- Set global and per-user cooldowns.
- Simulate events with **Check matches** (dry run) or **Run for real**.
- Replay a recent event against your current rules.
- Import/export automations as JSON.
- View recent events and commands with status pills, trigger counts and last-triggered times; the page auto-refreshes.

## API

`GET /api/health`, `GET /api/system`, `PATCH /api/system`, `GET /api/agent/version`, `POST /api/agent/pair`, `GET|POST /api/pairing`, `DELETE /api/pairing/:code`, `GET /api/agents/tokens`, `PATCH /api/agents/:id/enabled`, `DELETE /api/agents/:id`, `DELETE /api/agents/:id/token`, `GET /api/eventsub/subscriptions`, `GET|POST /api/automations`, `POST /api/automations/import`, `PUT|DELETE /api/automations/:id`, `PATCH /api/automations/:id/toggle`, `POST /api/simulate`, `POST /api/events/:id/replay`, `GET /api/logs`, `GET /api/commands`, `GET /api/agents`.

## CI

GitHub Actions runs on every push and pull request: TypeScript build, Vitest suite, `npm audit --audit-level=high`, and a separate Windows job that builds the standalone agent and uploads the whole `release/` folder as an artifact. To publish a new agent build, download that artifact, replace the files on the cloud host's `RELEASE_DIR`, and restart the cloud. Agents verify the SHA-256 in `version.json` before swapping executables; set `AGENT_AUTO_UPDATE=false` to opt out.

## Known limitations

- EventSub subscriptions are persisted in SQLite and normally reused. Twitch can still revoke them (e.g. if app access is removed); the cloud logs revocations and recreates subscriptions on the next session.
- Chat bot uses TMI; EventSub chat message subscriptions are not used.
- Hotkeys use Windows PowerShell SendKeys — the target window must be focused (optionally by title).
- Overlays are intentionally out of scope; wire your own service through the webhook action.
