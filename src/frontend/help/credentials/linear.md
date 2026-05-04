---
title: "Linear API key"
subtitle: "What Primer reads from Linear and how to set up credentials"
audiences: [admin, ops]
related:
  - reference/configuration
  - admins/admin-overview
---

Linear is one of Primer's primary work-context sources — issues you're assigned to, subscribed to, or have commented on flow into the daily briefing as raw signal for concept extraction.

## What Primer reads

The Linear integration uses the official `@linear/sdk` (which talks Linear's GraphQL under the hood). Specifically, Primer queries:

- **`viewer.assignedIssues`** — issues where you're the assignee, filtered by state type and `updatedAt`. Reads `id`, `identifier`, `title`, `description`, `url`, `state` (name + type), `labels`, `priority`, `updatedAt`, `dueDate`.
- **`viewer.subscribedIssues`** — issues you've subscribed to or commented on (same fields).
- **`teams`** — for the "Linear teams" picker in **Settings → Sources → Linear**. Reads `id`, `key`, `name`.
- **`issue(id).comments`** — used when fetching comment threads for an issue. Reads each comment's `body`, `createdAt`, and the author's `name` + `email`.

Primer does **not** mutate anything in Linear. The integration is strictly read-only.

## Auth model

Primer uses Linear's **personal API key** flow — the simplest option. There's no OAuth or installable Linear app. Personal keys are scoped to the issuing user's permissions: the key can see exactly what that user can see in Linear.

## Step-by-step setup

1. Sign in to your Linear workspace.
2. Open **Settings → Account → Security & access** (or go directly to <https://linear.app/settings/api>).
3. Under **Personal API keys**, click **Create key**.
4. Name it something like `Primer (production)` so it's clear what it's for if you later audit your keys.
5. Copy the key value — Linear shows it exactly once. If you lose it, revoke and recreate.

## Required permissions

Personal API keys don't expose granular scopes. The key inherits whatever access the issuing Linear user has. In practice that means:

- **Read access** to the workspace's issues, teams, comments, labels, and states for any team you want Primer to scan.
- The user issuing the key needs to be a member of every Linear team you'll list in **Settings → Sources → Linear**, otherwise Primer's `teams` query won't include them.

Treat the key as the equivalent of "log in as this user with read-only Linear access." If you don't want Primer to see private team work, issue the key from a workspace user that doesn't belong to those teams.

## Setting the secret on the worker

```bash
bunx wrangler secret put LINEAR_API_KEY --config wrangler.api.toml
```

Paste the key when prompted. Cloudflare propagates secret changes to all edge locations within seconds — no redeploy needed.

For local development, add the same line to your `.dev.vars`:

```
LINEAR_API_KEY=lin_api_xxx
```

## Verifying

After setting the key, hit `GET /api/health` (or open the debug section in your local dev tools) — the `linear` integration should report `status: "ok"`. You can also open **Settings → Sources → Linear** in the UI; the team picker fills with your workspace's teams once the key resolves.

A common failure mode: the key was issued by a user who isn't a member of any Linear team, in which case the picker is empty. Re-issue from a workspace member.

## Rotating the key

Linear lets you revoke a personal API key at any time from the same Settings page. After revoking, run the `wrangler secret put` command again with a fresh key. The currently-running Worker continues to use the old key in memory until the next request, so rotations during a briefing run can cause that one run to fail — easiest to rotate during off-hours.
