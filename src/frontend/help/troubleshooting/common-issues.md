---
title: "Common Issues"
subtitle: "Troubleshooting guide"
audiences: [user, admin, ops]
related:
  - reference/configuration
  - getting-started/setup
---

## Briefing Didn't Generate

**Symptom:** You visit Primer in the morning and see no briefing for today.

**Possible causes:**
- The cron trigger didn't fire. Check Cloudflare Workers dashboard for cron execution logs.
- The `ANTHROPIC_API_KEY` is missing or invalid. Hit `/api/health` to check integration status.
- You've exceeded the monthly budget cap (`BUDGET_CAP_MONTHLY`). Check `/api/stats` for `monthlySpend` vs `budgetCap`.
- There are no work signals to generate from (no Linear issues, Slack activity, or incidents in the scan window).

**Fix:** Click **Generate now** at the top of the feed (or call `POST /api/briefing/generate`). Check the response for specific errors.

## Empty run — "Nothing new surfaced" toast

**Symptom:** You click **Generate now** and a quiet toast says nothing surfaced. The feed itself is unchanged.

**Why this happens:** The on-demand run ran successfully but found nothing worth a fresh piece — no new work signals, no adjacent reading material, no decaying concepts. The briefing row exists with `metadata.reason = "no_candidates"` and zero teaching pieces. The feed is piece-first, so zero-piece briefings stay out of the visible list to avoid noise.

**Fix:** None required. Tomorrow's scheduled run will try again with whatever has accumulated overnight. The bell also fires a `briefing_generation` notification with the outcome, so you can confirm in the tray later if you missed the toast.

## "Generation failed" toast

**Symptom:** A negative-tone toast appears after a Generate now run, and/or the bell shows a failed `briefing_generation` notification.

**Why this happens:** Candidates were selected for teaching pieces but every LLM call errored — usually transient (provider blip, network timeout, rate limit). The briefing row carries `metadata.reason = "all_pieces_failed"`. Other reasons that surface here: `monthly_budget_exceeded` (raise `BUDGET_CAP_MONTHLY` or wait for billing cycle reset) and `cancelled` (a previous run was cancelled before it finished).

**Fix:** Click **Generate now** again. If it persists, check `/api/health` and the worker logs.

## Partial Briefing

**Symptom:** The briefing loaded but only has 1–2 pieces instead of the usual 3–5.

**Possible causes:**
- Limited work context — if you had a quiet day, there may not be enough material for a full briefing.
- Some integration APIs failed during generation (e.g., Slack rate limit). The briefing was generated with whatever data was available.
- Budget is close to the cap, so Primer reduced the number of API calls.

**Fix:** Check the work context bar to see which sources were consulted and their counts. If counts are unexpectedly low, open **Settings** and click **Build full briefing preview** in the footer — each source's panel will then show an "In scope" subsection with the items it would actually pull, so you can tell whether the shortfall is a filter problem (easy to fix in that panel) or an API problem (check tokens).

## Budget Exceeded

**Symptom:** You see a budget warning or briefing generation is paused.

**Fix:** Either wait for the month to reset, increase `BUDGET_CAP_MONTHLY` in `wrangler.api.toml`, or redeploy with the updated value. Current spend is visible in the header and at `/api/stats`.

## Cancel Doesn't Stop Immediately

**Symptom:** You click **Cancel** on a generating briefing. The button shows "Cancelling…" but the run keeps going for a few more seconds.

**Why this happens:** Primer stops at the next checkpoint — it doesn't interrupt an in-flight LLM call. Checkpoints sit between each pipeline step and between each teaching piece. If the generator is currently mid-way through a long call (any provider), you'll wait for that call to finish before the run stops.

**Fix:** None needed — the cancel *will* take effect. Every LLM request has a 120-second hard timeout, so the longest possible wait is ~2 minutes per in-flight call. If the wait exceeds 15 seconds, the progress panel will surface a **Force stop** button that nukes the briefing row server-side (see below).

## Briefing Is Stuck / Zombie Generation

**Symptom:** The progress panel shows a step has been active for far longer than normal (many minutes or more). Cancel has no apparent effect. You see a warning banner: "Briefing generation is stuck — no progress for Ns".

**Why this happens:** A server-side work unit (usually an external API call — an LLM provider, Linear, Slack, or feed fetch) has hung. Primer's generator writes progress on every step transition — if the server hasn't written for more than **3 minutes**, the `/api/briefing/status` endpoint flags the run as `stuck: true` and the UI surfaces a **Force stop** button.

**Fix:** Click **Force stop**. This calls `POST /api/briefing/reset`, which deletes today's briefing row unconditionally — no cooperative cancellation required. Afterwards, trigger a fresh generation.

If Force stop doesn't appear because your browser tab is stale, reload the page. Alternatively, hit `/api/briefing/reset` directly:

```bash
curl -X POST http://localhost:8787/api/briefing/reset \
  -H "X-Primer-Dev-User: you@company.com"
```

Note that `POST /api/briefing/generate` also auto-heals zombies: if it finds an existing row marked `generating` but stuck for > 3 minutes, it'll delete that row and start a fresh run rather than returning "already generating".

## Cancel Button Does Nothing

**Symptom:** Cancel click seems to have no effect at all — no "Cancelling…" indicator, no progress timeline change, and generation completes normally.

**Possible causes:**
- The browser is offline or the `/api/briefing/cancel` request failed silently. Check dev tools Network tab for a 200 response.
- You're looking at a stale tab — the generation already finished in another tab.
- In very old builds (before migration 0004), the cancel flag lived in a JSON metadata field that could be overwritten by a concurrent progress write. Upgrading to the latest schema (`bun run db:migrate`) fixes this.

**Fix:** Reload the page. If generation is still running, click Cancel again. If the problem persists, check `/api/briefing/status` directly — it returns `cancelRequested: true/false` and `stuck: true/false` so you can verify the server-side state. Use **Force stop** or `POST /api/briefing/reset` as the ultimate escape hatch.

## Stale Concepts

**Symptom:** Concepts are showing decay warnings even though you're actively working with them.

**Possible causes:**
- The concepts in your graph may not match the terms being used in current work signals. Check aliases — if you're discussing "K8s" but the concept is stored as "Kubernetes" without that alias, Primer won't link the exposure.
- You're reading pieces but not giving feedback or answering quizzes, so the engagement isn't registering beyond passive exposure.

**Fix:** Engage actively — answer the daily quiz, give feedback on pieces. If alias issues persist, they'll typically resolve as the concept extractor encounters new variations.

## Concepts Page Has Too Much Noise

**Symptom:** Your trails view is full of organizational/process phrases ("standup", "OKR review", "weekly sync") or technically-valid concepts that are clearly outside what you actually want to learn about.

**Why this happens:** This usually means your **Focus** statement isn't filtering well, or you're early in usage and the graph still contains pre-overhaul noise.

**Fix:**
1. Use the `✕` not-interested button on each noisy concept row. The system never re-extracts what you've explicitly suppressed.
2. Click your **avatar → Set focus** (or open **Settings → Current focus**) and refine your statement to be more specific about what you care about, and explicit about what you don't (e.g. "I don't care about people/process topics like standups or OKRs"). Click **✨ Refine with AI** if you'd like Claude to tighten your draft. The avatar-menu route is the express lane; Settings is for when you want to also browse history / per-version analytics.
3. If a single Focus version is producing >25% suppression rate, **Settings → Current focus → View history** will flag it as a focus mismatch with a warning. Iterate.
4. As a last resort, **Settings → General → Account → Reset concepts** wipes your graph and lets the next briefing rebuild from scratch under your refined Focus + About statements.

## OpenAI Voices Don't Appear in the TTS Picker

**Symptom:** Settings → Intelligence → Voice and the per-article voice picker only show Cloudflare Aura + MeloTTS; no OpenAI voices.

**Why:** OpenAI voices are filtered out when `OPENAI_API_KEY` isn't configured.

**Fix:** Set the secret on the deployed API worker:

```bash
bunx wrangler secret put OPENAI_API_KEY --config wrangler.api.toml
```

The key needs the **Text-to-speech (`/v1/audio/speech`)** permission set to **Request** in the OpenAI dashboard. No redeploy is needed — secrets propagate to all edge locations within seconds, and `/api/tts-models` checks the env at request time. If OpenAI voices still don't appear after a refresh, the most common cause is that the secret in the worker is a *different* key than the one whose permissions you set. Re-`secret put` the exact key string you intended.

## ElevenLabs Voices Don't Appear in the TTS Picker

**Symptom:** The voice picker doesn't surface any ElevenLabs voices (multilingual / turbo / flash).

**Why:** ElevenLabs voices are filtered out when `ELEVENLABS_API_KEY` isn't configured. `/api/tts-models` checks `env.ELEVENLABS_API_KEY` at request time and only returns the ElevenLabs entries when it's present.

**Fix:** Set the secret on the deployed API worker (or in `.dev.vars` locally):

```bash
bunx wrangler secret put ELEVENLABS_API_KEY --config wrangler.api.toml
```

Then refresh the page. The ElevenLabs adapter authenticates with `xi-api-key` against the ElevenLabs streaming endpoint; usage is charged per character and lands in the same `usage_events` ledger as every other TTS request.

## Baseline Calibration Stuck on "Preparing your calibration…"

**Symptom:** You clicked **Start calibration** on the Concepts page; the button reads **Preparing your calibration…** but never flips to a notification or a ready state.

**Why:** Baseline question generation runs server-side under `ctx.waitUntil` and writes a `baseline_calibration` notification when it completes. If the worker died mid-flight (rare — usually a deploy boundary), the notification can be left in `in_progress`.

**Fix:** The Sunday 3 AM UTC maintenance cron reaps any notification that hasn't moved for **5+ minutes** and flips it to `failed`, freeing the button — but you usually don't want to wait until Sunday. The fastest unblock is to dismiss the in-flight notification from the bell dropdown (× on hover), then call `POST /api/quiz/baseline/prepare` again. The endpoint is idempotent on a still-`in_progress` row, but once the dismissed row is gone it'll spawn a fresh one cleanly.

## Database Reset

If local development data gets into a bad state:

```bash
bun run db:reset
```

This removes all local Wrangler state and re-runs every migration. You'll go through the cold-start flow again on next visit. This only affects local development — production data on Cloudflare D1 is not touched.

If you want to reset only your concepts (not the whole DB), use **Settings → General → Account → Reset concepts** in the UI. Past briefings and teaching pieces are preserved as an audit trail; only the concept graph + depth/calibration history are wiped.
