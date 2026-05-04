import type { Env } from "../types.js";
import type { SourceContext, SourceFetchContext, SourceFetchResult, SourceProvider, WorkContextItem } from "./types.js";

export const githubProvider: SourceProvider = {
  id: "github",
  name: "GitHub",
  requiredEnv: ["GITHUB_TOKEN"],
  optionalEnv: ["GITHUB_ORG"],
  multiInstance: false,

  isAvailable(env: Env) {
    return !!env.GITHUB_TOKEN;
  },

  isConfigured(ctx: SourceContext) {
    return !!ctx.db;
  },

  async fetch(ctx: SourceFetchContext): Promise<SourceFetchResult> {
    const sourceConfig = ctx.sourceConfig;
    const githubFilters = (sourceConfig.github ?? {}) as {
      username?: string;
      repos?: string[];
      includeReviewRequested?: boolean;
      includeAssigned?: boolean;
      includeCommented?: boolean;
      includeTeamReviews?: boolean;
      teams?: string[];
      updatedWithinDays?: number;
    };

    const githubUsername = githubFilters.username;
    if (!githubUsername) {
      return { items: [], details: [] };
    }

    const { GitHubClient } = await import("../integrations/github.js");
    const client = new GitHubClient(ctx.env.GITHUB_TOKEN!);
    const org = ctx.env.GITHUB_ORG;
    const days = githubFilters.updatedWithinDays ?? 7;
    const seen = new Set<string>();
    const prs: Array<import("../integrations/github.js").GitHubPR> = [];

    const addUnique = (items: Array<import("../integrations/github.js").GitHubPR>) => {
      for (const pr of items) {
        const key = `${pr.repository}#${pr.number}`;
        if (!seen.has(key)) {
          seen.add(key);
          prs.push(pr);
        }
      }
    };

    if (githubFilters.includeReviewRequested !== false) {
      addUnique(await client.getReviewRequestedPRs(githubUsername, org));
    }
    if (githubFilters.includeAssigned !== false) {
      addUnique(await client.getAssignedPRs(githubUsername, org));
    }
    if (githubFilters.includeCommented !== false) {
      addUnique(await client.getCommentedPRs(githubUsername, org, days));
    }
    if (githubFilters.includeTeamReviews && githubFilters.teams?.length && org) {
      addUnique(await client.getTeamReviewPRs(org, githubFilters.teams));
    }

    if (githubFilters.repos?.length && org) {
      for (const repo of githubFilters.repos.slice(0, 5)) {
        try {
          addUnique(await client.getRepoActivity(org, repo, days));
        } catch (err) {
          console.error(`[github] Failed to fetch repo ${repo}:`, err);
        }
      }
    }

    const items: WorkContextItem[] = prs.map((pr) => {
      const desc = pr.body?.slice(0, 500) ?? "";
      const labelStr = pr.labels.length > 0 ? pr.labels.join(", ") : undefined;
      return {
        type: "github_pr",
        id: `${pr.repository}#${pr.number}`,
        title: `${pr.title} (${pr.repository}#${pr.number})`,
        url: pr.url,
        description: desc || undefined,
        labels: labelStr ? [labelStr] : undefined,
      };
    });

    const details: string[] = [];
    if (prs.length > 0) {
      details.push(`◇ ${prs.length} GitHub PRs`);
    }

    return { items, details };
  },

  settingsManifest: {
    nav: {
      label: "GitHub",
      icon: "github",
      group: "Sources",
      keywords: ["pull requests", "PRs", "repos", "code review"],
    },
  },

  userFields: [
    { type: "text", key: "username", label: "GitHub username", placeholder: "your-username" },
    { type: "toggle", key: "includeReviewRequested", label: "Review requested", default: true },
    { type: "toggle", key: "includeAssigned", label: "Assigned PRs", default: true },
    { type: "toggle", key: "includeCommented", label: "Commented PRs", default: true },
    { type: "toggle", key: "includeTeamReviews", label: "Team review requests", default: false },
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
    { type: "readonlyTags", key: "repos", label: "Repositories" },
    { type: "readonlyTags", key: "teams", label: "Teams" },
  ],
};
