import { Hono } from "hono";
import { IncidentIoClient } from "../integrations/incident-io.js";
import { createLinearClient, fetchAssignedIssues, fetchSubscribedIssues } from "../integrations/linear.js";
import type { Env, UserContext } from "../types.js";

type AppEnv = { Bindings: Env; Variables: { user: UserContext } };

export const previewRoutes = new Hono<AppEnv>();

interface LinearFilters {
  includeAssigned?: boolean;
  includeSubscribed?: boolean;
  stateTypes?: string[];
  teamPrefixes?: string[];
  updatedWithinDays?: number;
}

interface SlackFilters {
  channels?: string[];
  channelNames?: string[];
  historyDays?: number;
}

interface LinearPreviewResult {
  total: number;
  issues: Array<{ identifier: string; title: string; url: string; reason: string }>;
  elapsedMs: number;
}

async function buildLinearPreview(apiKey: string | undefined, filters: LinearFilters): Promise<LinearPreviewResult> {
  const start = Date.now();
  const issues: LinearPreviewResult["issues"] = [];

  if (!apiKey) {
    return { total: 0, issues, elapsedMs: Date.now() - start };
  }

  const stateTypes = filters.stateTypes?.length ? filters.stateTypes : ["started", "unstarted", "backlog"];
  const teamPrefixes = filters.teamPrefixes?.length ? filters.teamPrefixes : undefined;
  const updatedWithinDays = filters.updatedWithinDays;
  const includeAssigned = filters.includeAssigned ?? true;
  const includeSubscribed = filters.includeSubscribed ?? false;

  const client = createLinearClient(apiKey);
  const byId = new Map<string, LinearPreviewResult["issues"][number] & { id: string }>();

  if (includeAssigned) {
    const assigned = await fetchAssignedIssues(client, {
      stateTypes,
      teamPrefixes,
      updatedWithinDays,
      limit: 50,
    });
    for (const issue of assigned) {
      byId.set(issue.id, {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        url: issue.url,
        reason: "assigned",
      });
    }
  }

  if (includeSubscribed) {
    const subscribed = await fetchSubscribedIssues(client, {
      stateTypes,
      teamPrefixes,
      updatedWithinDays,
      limit: 50,
    });
    for (const issue of subscribed) {
      if (!byId.has(issue.id)) {
        byId.set(issue.id, {
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          url: issue.url,
          reason: "subscribed",
        });
      }
    }
  }

  for (const v of byId.values()) {
    const { id: _id, ...rest } = v;
    issues.push(rest);
  }

  return { total: issues.length, issues, elapsedMs: Date.now() - start };
}

previewRoutes.post("/settings/preview/linear", async (c) => {
  const body = (await c.req.json<{ linear?: LinearFilters }>().catch(() => ({}))) as {
    linear?: LinearFilters;
  };
  try {
    const result = await buildLinearPreview(c.env.LINEAR_API_KEY, body.linear ?? {});
    return c.json(result);
  } catch (err) {
    console.error("[preview] Linear fetch failed:", err);
    return c.json({ total: 0, issues: [], elapsedMs: 0, error: (err as Error).message ?? "Linear fetch failed" }, 502);
  }
});

previewRoutes.post("/settings/preview/slack", async (c) => {
  const start = Date.now();
  const body = (await c.req.json<{ slack?: SlackFilters }>().catch(() => ({}))) as {
    slack?: SlackFilters;
  };
  const slack = body.slack ?? {};

  const channels = (slack.channels ?? []).map((id, i) => ({
    id,
    name: slack.channelNames?.[i] ?? id,
  }));

  return c.json({
    channelCount: channels.length,
    historyDays: slack.historyDays ?? 7,
    channels,
    elapsedMs: Date.now() - start,
  });
});

previewRoutes.get("/settings/preview/incidents", async (c) => {
  const start = Date.now();
  if (!c.env.INCIDENT_IO_API_KEY) {
    return c.json({ total: 0, elapsedMs: Date.now() - start });
  }

  try {
    const incidentClient = new IncidentIoClient(c.env.INCIDENT_IO_API_KEY);
    const incidents = await incidentClient.getActiveIncidents();
    return c.json({ total: incidents.length, elapsedMs: Date.now() - start });
  } catch (err) {
    console.error("[preview] incident.io fetch failed:", err);
    return c.json(
      { total: 0, elapsedMs: Date.now() - start, error: (err as Error).message ?? "incident.io fetch failed" },
      502,
    );
  }
});

previewRoutes.post("/settings/preview", async (c) => {
  const body = (await c.req.json<{ linear?: LinearFilters; slack?: SlackFilters }>().catch(() => ({}))) as {
    linear?: LinearFilters;
    slack?: SlackFilters;
  };

  const [linearResult, incidents] = await Promise.all([
    buildLinearPreview(c.env.LINEAR_API_KEY, body.linear ?? {}).catch((err) => {
      console.error("[preview] Linear fetch failed:", err);
      return { total: 0, issues: [] as LinearPreviewResult["issues"], elapsedMs: 0 };
    }),
    (async () => {
      if (!c.env.INCIDENT_IO_API_KEY) return { total: 0 };
      try {
        const client = new IncidentIoClient(c.env.INCIDENT_IO_API_KEY);
        const list = await client.getActiveIncidents();
        return { total: list.length };
      } catch (err) {
        console.error("[preview] incident.io fetch failed:", err);
        return { total: 0 };
      }
    })(),
  ]);

  const slack = body.slack ?? {};
  const slackChannels = (slack.channels ?? []).map((id, i) => ({
    id,
    name: slack.channelNames?.[i] ?? id,
  }));

  return c.json({
    linear: { total: linearResult.total, issues: linearResult.issues },
    slack: {
      channelCount: slackChannels.length,
      historyDays: slack.historyDays ?? 7,
      channels: slackChannels,
    },
    incidents,
  });
});
