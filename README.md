# slack-tools

Slack webhook lifecycle helpers + MCP tools. Mounts as a Claude Code plugin via [slack-claude-code](https://github.com/agiterra/slack-claude-code).

## Model

Each agent persona maps 1:1 to its own Slack app. The app is installed to one workspace per persona (e.g. Herald → Mivid Studios, Brioche → Fabrica). The bot drinks the firehose — every event the bot's scopes allow — and the agent decides what to read via Wire's per-webhook filter expression. Default filter = null = pure firehose.

## One-time setup per persona

1. **Create the Slack app** at <https://api.slack.com/apps>. Pick the persona-named workspace.
2. **Scopes** (Bot Token Scopes): start with `channels:history`, `groups:history`, `im:history`, `mpim:history`, `chat:write`, `reactions:write`, `users:read`. Add `users:read.email` if you want `lookupUserByEmail`.
3. **Install to workspace.** Slack issues a bot token (`xoxb-…`); copy it into the persona's `.env` as `SLACK_BOT_TOKEN`. Copy the Signing Secret as `SLACK_SIGNING_SECRET`.
4. **Event Subscriptions:** call `register_slack_app` (this plugin's MCP tool) — it returns the Request URL. Paste it into Slack's Event Subscriptions page. Add the events you want under "Subscribe to bot events" (commonly `message.channels`, `message.im`, `message.groups`, `message.mpim`, `app_mention`).
5. Slack URL-verifies the endpoint once. *(Note: URL verification requires a small Wire-side handler — see open issue agiterra/wire#N.)*

## MCP tools

- `register_slack_app({workspace, signing_secret?, filter?, session_id?})` — register the wire webhook. Returns the Slack Request URL.
- `unregister_webhook({webhook_id, agent_id?})` — tear down a registration.
- `post_message({channel, text, thread_ts?, blocks?, bot_token?})` — `chat.postMessage`.
- `add_reaction({channel, ts, name, bot_token?})` — `reactions.add`.

## Env

| Var | Required | Purpose |
|---|---|---|
| `AGENT_ID` | yes | This persona's wire id |
| `AGENT_PRIVATE_KEY` | yes | Ed25519 PKCS8 base64; signs wire API calls |
| `WIRE_URL` | yes | Wire broker URL (default `http://localhost:9800`) |
| `WIRE_EXTERNAL_URL` | yes if behind ngrok | Externally-reachable Wire URL — published as the Slack Request URL |
| `SLACK_BOT_TOKEN` | per-persona | Bot token (`xoxb-…`) |
| `SLACK_SIGNING_SECRET` | per-persona | Slack app signing secret (validator key) |
