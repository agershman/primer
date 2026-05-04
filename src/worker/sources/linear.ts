import type { LinearIssueData } from "../integrations/linear.js";
import { createLinearClient, fetchAssignedIssues, fetchSubscribedIssues, fetchTeams } from "../integrations/linear.js";
import type { Env } from "../types.js";
import type { SourceContext, SourceFetchContext, SourceFetchResult, SourceProvider, WorkContextItem } from "./types.js";

export const linearProvider: SourceProvider = {
  id: "linear",
  name: "Linear",
  requiredEnv: ["LINEAR_API_KEY"],
  multiInstance: false,

  isAvailable(env: Env) {
    return !!env.LINEAR_API_KEY;
  },

  isConfigured() {
    return true;
  },

  async fetch(ctx: SourceFetchContext): Promise<SourceFetchResult> {
    const sourceConfig = ctx.sourceConfig;
    const linearFilters = (sourceConfig.linear ?? {}) as {
      stateTypes?: string[];
      teamPrefixes?: string[];
      includeAssigned?: boolean;
      includeSubscribed?: boolean;
      updatedWithinDays?: number;
    };

    const filterOpts = {
      stateTypes: linearFilters.stateTypes,
      teamPrefixes: linearFilters.teamPrefixes,
      updatedWithinDays: linearFilters.updatedWithinDays,
    };
    const includeAssigned = linearFilters.includeAssigned !== false;
    const includeSubscribed = linearFilters.includeSubscribed === true;

    const client = createLinearClient(ctx.env.LINEAR_API_KEY);
    const results: LinearIssueData[] = [];

    if (includeAssigned) {
      results.push(...(await fetchAssignedIssues(client, filterOpts)));
    }
    if (includeSubscribed) {
      const subscribed = await fetchSubscribedIssues(client, filterOpts);
      const seen = new Set(results.map((r) => r.id));
      for (const issue of subscribed) {
        if (!seen.has(issue.id)) results.push(issue);
      }
    }

    const items: WorkContextItem[] = [];
    const details: string[] = [];

    for (const issue of results) {
      const dueAt = issue.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(issue.dueDate) ? `${issue.dueDate}T23:59:59Z` : null;
      items.push({
        type: "linear_issue",
        id: issue.id,
        title: issue.title,
        url: issue.url,
        description: issue.description,
        labels: issue.labels.map((l) => l.name),
        dueAt,
        dueReason: dueAt ? `Linear ticket ${issue.identifier} is due ${issue.dueDate}` : null,
      });
      details.push(`◆ ${issue.identifier} ${issue.title.slice(0, 50)}`);
    }

    return { items, details };
  },

  async getSettingsMetadata(ctx: SourceContext) {
    const client = createLinearClient(ctx.env.LINEAR_API_KEY);
    return { teams: await fetchTeams(client) };
  },

  settingsManifest: {
    nav: {
      label: "Linear",
      icon: "list-checks",
      group: "Sources",
      keywords: ["issues", "tickets", "tasks", "linear"],
    },
    metadata: {
      teams: {
        endpoint: "/api/linear/teams",
        labelKey: "name",
        valueKey: "key",
      },
    },
    preview: {
      endpoint: "/api/settings/preview/linear",
      method: "POST",
    },
  },

  userFields: [
    { type: "toggle", key: "includeAssigned", label: "Include assigned issues", default: true },
    { type: "toggle", key: "includeSubscribed", label: "Include subscribed issues", default: false },
    {
      type: "chips",
      key: "stateTypes",
      label: "Issue states",
      options: [
        { value: "started", label: "Started" },
        { value: "unstarted", label: "Unstarted" },
        { value: "backlog", label: "Backlog" },
        { value: "completed", label: "Completed" },
        { value: "cancelled", label: "Cancelled" },
      ],
    },
    { type: "multiSelect", key: "teamPrefixes", label: "Teams", metadataRef: "teams" },
    {
      type: "select",
      key: "updatedWithinDays",
      label: "Updated within",
      options: [
        { value: "1", label: "1 day" },
        { value: "3", label: "3 days" },
        { value: "7", label: "7 days" },
        { value: "14", label: "14 days" },
        { value: "30", label: "30 days" },
      ],
      default: "7",
    },
  ],
};
