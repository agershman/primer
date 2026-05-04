---
title: "Slack app + token"
subtitle: "Creating a Slack app, choosing the right token, and the exact OAuth scopes Primer needs"
audiences: [admin, ops]
related:
  - reference/configuration
  - admins/admin-overview
---

Slack is one of Primer's most useful work-context sources — channels your team uses for discussion, decisions, and ad-hoc Q&A become teaching pieces about the topics that emerge.

## What Primer reads

The integration calls these Slack Web API methods:

| Method | When | Why |
|--------|------|-----|
| **`conversations.list`** | Settings panel | Populating the channel picker (public channels only — `types: public_channel`). |
| **`conversations.history`** | Every briefing | Pulling messages from each configured channel within the configured time window. |
| **`conversations.replies`** | Every briefing | Fetching thread replies for substantive conversations. |
| **`team.info`** | First request | Resolving your workspace's domain so message permalinks can be rendered. |
| **`search.messages`** | Briefings, only when configured | A fallback path that searches `from:me` to surface messages you sent across channels. Optional — if you only configure explicit channel IDs, this method is never called. |

Reactions (including the optional `:bookmark:` bypass — see [Configuration → Bookmarked messages](/help/reference/configuration)) are read **inline** from `conversations.history` — Primer does not call `reactions.get`.

The integration is strictly read-only. No `chat.postMessage`, no message edits, no reactions added.

## Auth model

Slack apps issue two kinds of tokens:

- **Bot tokens (`xoxb-…`)** — what most installs should use. Bot tokens are tied to the app, not a person, and only see channels the bot has been invited to. This is the principle-of-least-privilege option.
- **User tokens (`xoxp-…`)** — issued in the user's name; can see anything that user can see. **Required** if you plan to use the `search.messages` fallback path (`search:read` is documented as a user-token scope).

If you stick to the explicit-channel-ID setup (configure channels in **Settings → Sources → Slack → Channels**), a bot token is sufficient and recommended. Only switch to a user token if you need the `from:me` search behavior.

## Step-by-step setup

1. Go to <https://api.slack.com/apps> and click **Create New App** → **From scratch**.
2. Name the app (e.g. "Primer") and pick your workspace.
3. In the app's settings, open **OAuth & Permissions**.
4. Under **Scopes → Bot Token Scopes**, add the scopes from the table below.
5. Click **Install to Workspace** at the top of the same page. Approve the install.
6. Copy the **Bot User OAuth Token** (starts with `xoxb-`).
7. Invite the bot to every channel you want Primer to read:

   ```
   /invite @primer
   ```

   Bot tokens only see channels the bot has explicitly joined. Public channels you haven't invited the bot to don't show up.

If you need the `search.messages` path: scroll down to **User Token Scopes** in the same OAuth screen, add `search:read`, reinstall, and use the **User OAuth Token** (`xoxp-…`) instead.

## Required permissions (bot token)

| Scope | What it unlocks | Required? |
|-------|------------------|-----------|
| **`channels:read`** | List public channels (drives the Settings picker) | Yes |
| **`channels:history`** | Read messages + thread replies in public channels | Yes |
| **`team:read`** | Read workspace info (used to render message permalinks) | Yes |
| **`search:read`** | Search messages (only needed if you want the `from:me` fallback) | Optional |
| **`groups:history`** + **`groups:read`** | Read **private** channels the bot is invited to | Optional |

All four `channels:*` / `team:*` scopes are public-channel-scoped. Add the `groups:*` pair only if you want Primer to read private channels — and remember the bot still has to be invited to each one.

Primer does **not** need `chat:write`, `users:read`, or any write-capable scope. If you see those listed by mistake, remove them.

## Setting the secret on the worker

```bash
bunx wrangler secret put SLACK_TOKEN --config wrangler.api.toml
```

Paste the bot or user token when prompted.

For local development:

```
SLACK_TOKEN=xoxb-...
```

## Verifying

`GET /api/health` should show `slack: ok`. In **Settings → Sources → Slack**, the channel picker should populate with every public channel in your workspace.

Common failure modes:

- **Channel picker is empty** — Check that the token has `channels:read` and that the app was actually installed (not just configured). The OAuth & Permissions page shows an "Installed App Settings" link once the install is complete.
- **A channel is configured but no messages flow** — The bot hasn't been invited to that channel. Run `/invite @primer` in the channel.
- **`search.messages` returns errors** — You're using a bot token; either drop the `from:me` search behavior or switch to a user token with `search:read`.

## Rotating the token

Slack lets you revoke any token from the app's **OAuth & Permissions** page. After revoking, reinstall and update the secret. As with Linear, rotating during a briefing run can cause that run to fail — prefer off-hours.
