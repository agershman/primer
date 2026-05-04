import { LinearClient } from "@linear/sdk";

export function createLinearClient(apiKey: string): LinearClient {
  return new LinearClient({ apiKey });
}

export interface LinearIssueData {
  id: string;
  identifier: string;
  title: string;
  description: string | undefined;
  url: string;
  state: { name: string; type: string } | null;
  labels: Array<{ name: string }>;
  priority: number;
  updatedAt: Date;
  /**
   * The issue's `dueDate` field if set, in `YYYY-MM-DD` form. Linear
   * stores due dates as plain calendar dates (no time component), so
   * the rest of the pipeline treats this as "due at end of day in
   * the user's local timezone" when computing how soon the deadline
   * is. `null` when the issue has no due date set, which is the
   * common case.
   */
  dueDate: string | null;
}

export interface LinearCommentData {
  id: string;
  body: string;
  createdAt: Date;
  user: { name: string; email: string } | null;
}

export interface LinearFilterOptions {
  stateTypes?: string[];
  teamPrefixes?: string[];
  limit?: number;
  updatedWithinDays?: number;
}

function matchesTeamPrefixes(identifier: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => identifier.startsWith(prefix));
}

async function resolveIssueData(
  issues: { nodes: Array<Record<string, unknown>> },
  teamPrefixes?: string[],
): Promise<LinearIssueData[]> {
  const results: LinearIssueData[] = [];
  for (const issue of issues.nodes as Array<{
    id: string;
    identifier: string;
    title: string;
    description?: string;
    url: string;
    state: Promise<{ name: string; type: string } | undefined>;
    labels: () => Promise<{ nodes: Array<{ name: string }> }>;
    priority: number;
    updatedAt: Date;
    // Linear's GraphQL `dueDate` is a `TimelessDate` (string in
    // YYYY-MM-DD form, no time component). The SDK exposes it
    // directly as a string field on the issue object — we just need
    // to add it to our destructuring/shape.
    dueDate?: string | null;
  }>) {
    if (teamPrefixes?.length && !matchesTeamPrefixes(issue.identifier, teamPrefixes)) {
      continue;
    }
    const state = await issue.state;
    const labels = await issue.labels();
    results.push({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? undefined,
      url: issue.url,
      state: state ? { name: state.name, type: state.type } : null,
      labels: labels.nodes.map((l) => ({ name: l.name })),
      priority: issue.priority,
      updatedAt: issue.updatedAt,
      // Normalize empty / undefined to null so downstream code only
      // has one falsy shape to check.
      dueDate: (issue.dueDate ?? null) || null,
    });
  }
  return results;
}

export async function fetchAssignedIssues(
  client: LinearClient,
  opts: LinearFilterOptions = {},
): Promise<LinearIssueData[]> {
  const { stateTypes = ["started", "unstarted", "backlog"], teamPrefixes, limit = 25, updatedWithinDays } = opts;

  const filter: Record<string, unknown> = {
    state: { type: { in: stateTypes } },
  };
  if (updatedWithinDays && updatedWithinDays > 0) {
    const since = new Date(Date.now() - updatedWithinDays * 86400000).toISOString();
    filter.updatedAt = { gte: since };
  }

  const me = await client.viewer;
  const issues = await me.assignedIssues({ filter, first: limit });

  return resolveIssueData(issues as unknown as { nodes: Array<Record<string, unknown>> }, teamPrefixes);
}

export async function fetchSubscribedIssues(
  client: LinearClient,
  opts: LinearFilterOptions = {},
): Promise<LinearIssueData[]> {
  const { stateTypes = ["started", "unstarted", "backlog"], teamPrefixes, limit = 25, updatedWithinDays } = opts;

  const filterParts: string[] = [`state: { type: { in: ${JSON.stringify(stateTypes)} } }`];
  if (updatedWithinDays && updatedWithinDays > 0) {
    const since = new Date(Date.now() - updatedWithinDays * 86400000).toISOString();
    filterParts.push(`updatedAt: { gte: ${JSON.stringify(since)} }`);
  }

  const query = `
    query($first: Int) {
      viewer {
        subscribedIssues(
          filter: { ${filterParts.join(", ")} }
          first: $first
        ) {
          nodes {
            id identifier title description url priority updatedAt dueDate
            state { name type }
            labels { nodes { name } }
          }
        }
      }
    }
  `;

  // The Linear SDK doesn't expose subscribedIssues directly,
  // so we fall back to fetching via the graphQL client
  const gqlClient = (
    client as unknown as {
      _client: {
        rawRequest: (
          q: string,
          v: Record<string, unknown>,
        ) => Promise<{ data: { viewer: { subscribedIssues: { nodes: Array<Record<string, unknown>> } } } }>;
      };
    }
  )._client;
  if (!gqlClient?.rawRequest) {
    // Fallback: re-use assigned issues if graphql access unavailable
    return fetchAssignedIssues(client, opts);
  }

  try {
    const response = await gqlClient.rawRequest(query, { first: limit });
    const nodes = response.data.viewer.subscribedIssues.nodes;
    const results: LinearIssueData[] = [];
    for (const node of nodes) {
      const n = node as {
        id: string;
        identifier: string;
        title: string;
        description?: string;
        url: string;
        priority: number;
        updatedAt: string;
        state: { name: string; type: string } | null;
        labels: { nodes: Array<{ name: string }> };
        // `dueDate` is a TimelessDate string (`YYYY-MM-DD`); the
        // raw GraphQL response surfaces it directly. Optional —
        // the GraphQL query may or may not select it (we add it to
        // the query string just below).
        dueDate?: string | null;
      };
      if (teamPrefixes?.length && !matchesTeamPrefixes(n.identifier, teamPrefixes)) {
        continue;
      }
      results.push({
        id: n.id,
        identifier: n.identifier,
        title: n.title,
        description: n.description ?? undefined,
        url: n.url,
        state: n.state ? { name: n.state.name, type: n.state.type } : null,
        labels: n.labels.nodes.map((l) => ({ name: l.name })),
        priority: n.priority,
        updatedAt: new Date(n.updatedAt),
        dueDate: (n.dueDate ?? null) || null,
      });
    }
    return results;
  } catch {
    return fetchAssignedIssues(client, opts);
  }
}

export async function fetchTeams(client: LinearClient): Promise<Array<{ id: string; key: string; name: string }>> {
  const teams = await client.teams();
  return teams.nodes.map((t) => ({ id: t.id, key: t.key, name: t.name }));
}

export async function fetchIssueComments(client: LinearClient, issueId: string): Promise<LinearCommentData[]> {
  const issue = await client.issue(issueId);
  const comments = await issue.comments();

  const results: LinearCommentData[] = [];
  for (const comment of comments.nodes) {
    const user = await comment.user;
    results.push({
      id: comment.id,
      body: comment.body,
      createdAt: comment.createdAt,
      user: user ? { name: user.name, email: user.email ?? "" } : null,
    });
  }
  return results;
}
