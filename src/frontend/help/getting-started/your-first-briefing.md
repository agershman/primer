---
title: "Your First Briefing"
subtitle: "What happens when you visit Primer for the first time"
audiences: [user]
related:
  - calibration/baseline
  - briefings/how-generation-works
---

The first time you visit Primer, you'll go through a cold-start flow that takes roughly 5–8 minutes (most of which is reading and writing, not waiting). This initial setup builds the foundation for all future briefings.

## Recommended cold-start sequence

**1. First-run onboarding wizard** — The first time you load Primer, a two-step welcome overlay appears automatically. Step 1 walks you through writing your **About you** statement; Step 2 walks you through your **Current focus** statement. Each step has placeholder example text to anchor your draft, and a **✨ Refine with AI** button that asks Claude to tighten your paragraph into a prompt-ready version. You can save with one click or skip for now (the prompt re-appears in the next session until both are set).

If you skip and want to come back to it later, both fields live in **Settings → About you** and **Settings → Current focus** with the same flow plus full version history.

**2. Configure source filters** — Pick which Linear issues (assigned, subscribed, team projects), which Slack channels, which GitHub repos, and which time windows to pull from. Click **Build full briefing preview** in the Settings footer to confirm what's in scope (each source's panel fills in its own "In scope" list).

**3. Generate your first briefing** — Visit the briefing page and trigger generation. Primer:
- Pulls in recent activity from your configured integrations
- Extracts concepts from the work context, biased by your Focus statement
- Scans external sources for adjacent material
- Selects teaching targets based on your concept graph + relevance
- Generates teaching pieces calibrated to your depth on each concept *and* the voice/tone preferences from your About statement
- Generates a calibration quiz on the lowest-confidence concept

**4. Take the calibration quiz** — Open-ended questions probe your understanding. Quiz difficulty is calibrated to your About statement, so it assumes your stated experience level rather than starting from zero. Your answers refine your concept graph so future briefings hit at the right depth.

## After Setup

Once the cold start is complete, your daily briefings generate automatically at **5:00 AM local time, Monday through Friday** via cron trigger. You can also trigger a manual briefing at any time from the briefing page.

Each subsequent briefing refines your concept graph further.

### Updating focus from the avatar menu

Your **Current focus** statement evolves naturally as you switch teams, tackle new problem domains, or get curious about new areas. Click your **avatar** in the top-right and choose **Set focus** — a quick editor opens showing your current focus and lets you save a new version with one click. The menu's preview shows the first ~2 lines of your current focus so you can confirm what's active without opening the editor.

Today's briefing was already generated against your *previous* focus, so the change won't reshape today's content. The next briefing run picks up the new statement automatically.

The full versioning UI (timeline of every version, inline diffs, per-version analytics, restore old versions, delete unwanted ones) still lives in **Settings → Current focus → View history**. The avatar menu's focus entry is the express lane for keeping focus current; Settings is where you go to look back at how your focus has evolved.

Every concept and briefing is attributed to the focus version active when it was created (server-side via the `focus_version_id` column on briefings, joined against `focus_statement_versions` on read), so you can see in **View history → analytics** how your output has changed across iterations.

## If your first briefing surfaces noise

If the concept graph from your first briefing has too many off-topic phrases:

- Use the `✕` "not interested" button on each concept row to suppress them. The system never re-extracts what you've suppressed.
- Refine your **Focus** statement to be more specific about what you care about (and what you don't).
- If things feel really off, **Settings → General → Account → Reset concepts** wipes the graph entirely and lets the next briefing rebuild under your refined Focus + About.
