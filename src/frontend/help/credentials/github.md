---
title: "GitHub token"
subtitle: "Personal access token (classic vs fine-grained) and the exact GitHub APIs Primer calls"
audiences: [admin, ops]
related:
  - reference/configuration
  - admins/admin-overview
---

GitHub is an optional work-context source. When configured, Primer surfaces pull requests you're reviewing or assigned to, and PRs your team has been tagged on, alongside Linear / Slack signals in each briefing.

## What Primer reads

The integration hits these GitHub REST endpoints (`https://api.github.com`):

| Endpoint | When | Why |
|----------|------|-----|
| **`GET /search/issues`** | Every briefing | Searches with `review-requested:`, `assignee:`, `commenter:`, `team-review-requested:org/slug` qualifiers to find PRs/issues that involve you or your team. |
| **`GET /repos/{owner}/{repo}/pulls`** | Every briefing | Listing recent pull requests on configured repos (`state=all`, `since=…`). |
| **`GET /repos/{owner}/{repo}/issues/{number}/comments`** | When relevant | PR / issue comment threads. |
| **`GET /orgs/{org}/teams`** | Settings panel | Populating the team picker for team-review-requested searches. |
| **`GET /orgs/{org}/repos`** | Settings panel | Populating the repo picker (`type=all`; archived repos are filtered out client-side). |

Read-only. No webhook installation, no PR comments / approvals / merges.

## Auth model

Primer uses a **personal access token** (PAT). The token can be either:

- **Classic PAT** — broader, simpler scopes. Easier setup, but the same key has access to every repo your account can see.
- **Fine-grained PAT** — recommended for security. Lets you restrict the token to a specific organization and a specific repository selection.

There's no GitHub App / installation flow today.

## Step-by-step setup (fine-grained PAT — recommended)

1. Go to <https://github.com/settings/tokens?type=beta> (or **Settings → Developer settings → Personal access tokens → Fine-grained tokens** in the GitHub UI).
2. Click **Generate new token**.
3. Name it `Primer (production)` or similar.
4. **Resource owner** — choose your organization. (Personal-account fine-grained tokens can't see org repos.)
5. **Repository access** — choose either **All repositories** (simplest) or **Only select repositories** and pick the repos you want Primer to scan.
6. **Permissions** — see the table below.
7. Click **Generate token**, then **Authorize** the token (if your org requires owner approval, this is when the request is sent).

## Step-by-step setup (classic PAT — simpler)

1. Go to <https://github.com/settings/tokens>.
2. Click **Generate new token (classic)**.
3. Name it, set an expiration.
4. Tick the scopes from the table below.
5. Click **Generate token** and copy the value.

## Required permissions

### Fine-grained PAT

| Permission | Access | Why |
|------------|--------|-----|
| **Contents** | Read-only | Required for `repos/{owner}/{repo}/pulls` (PR data lives under this permission). |
| **Metadata** | Read-only | Implicit; required for any repo-scoped call. |
| **Issues** | Read-only | Required for issue/PR comment listings. |
| **Pull requests** | Read-only | Required for `pulls` listings. |
| **Organization → Members** | Read-only | Required for `/orgs/{org}/teams` when populating the team picker. |

Fine-grained PATs are repo- and org-scoped, so the only org-level permission you need is **Members → Read** to enumerate teams.

### Classic PAT

| Scope | Why |
|-------|-----|
| **`repo`** | Read access to public + private repos for PR / issue search and pulls. (Classic scopes don't have a finer-grained "PRs only" option — `repo` is the minimum.) |
| **`read:org`** | Required for `/orgs/{org}/teams` and the `team-review-requested:org/slug` search qualifier. |

If you only care about public repos, you can use **`public_repo`** instead of full `repo`.

## Setting the secret on the worker

```bash
bunx wrangler secret put GITHUB_TOKEN --config wrangler.api.toml
```

For local dev, in `.dev.vars`:

```
GITHUB_TOKEN=ghp_...   # classic
# or
GITHUB_TOKEN=github_pat_...  # fine-grained
```

Also set `GITHUB_ORG` in `wrangler.api.toml`'s `[vars]` section to your organization slug — Primer uses it for org-scoped queries (teams, repos).

## Verifying

`GET /api/health` reports `github: ok`. In **Settings → Sources → GitHub**, the repo and team pickers populate with everything the token can see.

Common failure modes:

- **Empty repo / team picker** — Token doesn't have `read:org` (classic) or **Organization → Members: Read** (fine-grained). The `members:read` permission specifically is what gates the org-scoped enumeration.
- **`search/issues` returns 422 / no results** — The token can't see the repo the search would land on. Fine-grained tokens default to "selected repositories"; if you didn't include the repos involved in the search, GitHub silently filters them out.
- **Rate limits** — Classic PATs have generous limits (5000/hr). Fine-grained PATs are subject to the same limit per token. Primer's briefing makes a few dozen calls per run, so rate limits aren't typically a concern.

## Rotating the token

Both PAT types can be revoked from the same Settings page that issued them. After revoking, run `bunx wrangler secret put GITHUB_TOKEN` again. Fine-grained tokens auto-expire (max 1 year); set a calendar reminder so the next rotation isn't a surprise.
