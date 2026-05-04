---
title: "incident.io API key"
subtitle: "Reading active and recent incidents into your work context"
audiences: [admin, ops]
related:
  - reference/configuration
  - admins/admin-overview
---

incident.io is an optional work-context source. When configured, active and recently-resolved incidents flow into the briefing alongside Linear / Slack / GitHub signals — useful for surfacing post-incident learnings the same week the incident happens.

## What Primer reads

The integration calls incident.io's v2 REST API at `https://api.incident.io/v2`:

| Endpoint | Why |
|----------|-----|
| **`GET /incidents?status[one_of]=active,investigating`** | Pulls currently-open incidents for inclusion in today's work context. |
| **`GET /incidents?created_at[gte]={since}`** | Pulls recently-created incidents (over the configured time window). |

Read-only. No actions, comments, or status changes.

## Auth model

incident.io issues **API keys** scoped per-organization with a configurable role / set of permissions. Authentication is `Authorization: Bearer ${apiKey}`.

## Step-by-step setup

1. Sign in to your incident.io organization.
2. Open **Settings → API keys** (or go to `https://app.incident.io/settings/api-keys` for your tenant).
3. Click **Create API key**.
4. Name it `Primer (production)`.
5. **Roles / permissions** — pick the minimum the integration needs (see below).
6. Click **Create**, then copy the key value (shown only once).

## Required permissions

incident.io uses role-based permission groups. The minimum Primer needs is **read access to incidents**. In the API key creation flow, this typically maps to:

- **`incidents.read`** (or the equivalent role labeled "Can view incidents")

If your organization uses incident.io's classic permission model rather than the newer roles UI, the equivalent is "View incidents" / "Read-only viewer" access.

Primer does **not** need:

- Incident creation or editing permissions (`incidents.write`)
- Post-mortem / debrief permissions
- User / role management permissions
- Workflow / runbook permissions

If incident.io's UI doesn't let you scope further, document this when you create the key — restrict it to read-only for safety.

## Setting the secret on the worker

```bash
bunx wrangler secret put INCIDENT_IO_API_KEY --config wrangler.api.toml
```

For local dev, in `.dev.vars`:

```
INCIDENT_IO_API_KEY=...
```

## Verifying

`GET /api/health` reports `incident_io: ok`. In **Settings → Sources → incident.io**, the configured filters preview a count of active + recent incidents.

Common failure modes:

- **`401 Unauthorized`** — Key was revoked or pasted incorrectly. Re-create on incident.io and re-set the secret.
- **Empty incidents list** — The org genuinely has no active or recent incidents in the time window. Confirm by hitting the API directly: `curl -H "Authorization: Bearer $KEY" https://api.incident.io/v2/incidents`.
- **`403 Forbidden`** — The key's role doesn't include incident-read permissions. Edit the role in incident.io and reissue.

## Rotating the key

API keys can be revoked from the same Settings page. Rotation is the same `bunx wrangler secret put INCIDENT_IO_API_KEY` flow as the other integrations.
