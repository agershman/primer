import { Hono } from "hono";
import { GitHubClient } from "../integrations/github.js";
import type { Env, UserContext } from "../types.js";

type AppEnv = { Bindings: Env; Variables: { user: UserContext } };

export const githubRoutes = new Hono<AppEnv>();

githubRoutes.get("/github/repos", async (c) => {
  if (!c.env.GITHUB_TOKEN) {
    return c.json({ repos: [], error: "GitHub not configured" });
  }
  if (!c.env.GITHUB_ORG) {
    return c.json({ repos: [], error: "GitHub org not configured" });
  }
  try {
    const client = new GitHubClient(c.env.GITHUB_TOKEN);
    const repos = await client.listOrgRepos(c.env.GITHUB_ORG);
    return c.json({ repos });
  } catch (err) {
    console.error("[github] Failed to list repos:", err);
    return c.json({ repos: [], error: "Failed to fetch repos" });
  }
});

githubRoutes.post("/github/preview", async (c) => {
  if (!c.env.GITHUB_TOKEN) {
    return c.json({ total: 0, prs: [], error: "GitHub not configured" });
  }
  const user = c.get("user");
  const body = await c.req.json<{
    github?: {
      repos?: string[];
      includeReviewRequested?: boolean;
      includeAssigned?: boolean;
      includeCommented?: boolean;
      includeTeamReviews?: boolean;
      teams?: string[];
      updatedWithinDays?: number;
    };
  }>();

  const filters = body.github ?? {};
  const org = c.env.GITHUB_ORG;
  const ghUsername = (user.settings.signalSurfaceMap?.github as Record<string, unknown> | undefined)?.username as
    | string
    | undefined;

  if (!ghUsername) {
    return c.json({ total: 0, prs: [], error: "Set your GitHub username in Settings first" });
  }

  try {
    const client = new GitHubClient(c.env.GITHUB_TOKEN);
    const days = filters.updatedWithinDays ?? 7;
    const seen = new Set<string>();
    const allPRs: Array<{ number: number; title: string; url: string; repo: string; author: string }> = [];

    const addUnique = (
      items: Array<{ number: number; title: string; url: string; repository: string; author: string }>,
    ) => {
      for (const pr of items) {
        const key = `${pr.repository}#${pr.number}`;
        if (!seen.has(key)) {
          seen.add(key);
          allPRs.push({ number: pr.number, title: pr.title, url: pr.url, repo: pr.repository, author: pr.author });
        }
      }
    };

    if (filters.includeReviewRequested !== false) {
      addUnique(await client.getReviewRequestedPRs(ghUsername, org));
    }
    if (filters.includeAssigned !== false) {
      addUnique(await client.getAssignedPRs(ghUsername, org));
    }
    if (filters.includeCommented !== false) {
      addUnique(await client.getCommentedPRs(ghUsername, org, days));
    }

    return c.json({ total: allPRs.length, prs: allPRs.slice(0, 20) });
  } catch (err) {
    console.error("[github] Preview failed:", err);
    return c.json({ total: 0, prs: [], error: "GitHub fetch failed" });
  }
});

githubRoutes.get("/github/teams", async (c) => {
  if (!c.env.GITHUB_TOKEN) {
    return c.json({ teams: [], error: "GitHub not configured" });
  }
  if (!c.env.GITHUB_ORG) {
    return c.json({ teams: [], error: "GitHub org not configured" });
  }
  try {
    const client = new GitHubClient(c.env.GITHUB_TOKEN);
    const teams = await client.listUserTeams(c.env.GITHUB_ORG);
    return c.json({ teams });
  } catch (err) {
    console.error("[github] Failed to list teams:", err);
    return c.json({ teams: [], error: "Failed to fetch teams" });
  }
});
