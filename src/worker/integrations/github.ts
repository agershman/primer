import { isRetryableStatus, parseRetryAfter, RETRY_CONFIG, retryDelay } from "../config/constants.js";

export interface GitHubPR {
  number: number;
  title: string;
  url: string;
  body: string | null;
  state: string;
  labels: string[];
  repository: string;
  author: string;
  reviewers: string[];
  createdAt: string;
  updatedAt: string;
}

interface SearchResult {
  total_count: number;
  items: Array<{
    number: number;
    title: string;
    html_url: string;
    body: string | null;
    state: string;
    labels: Array<{ name: string }>;
    user: { login: string };
    requested_reviewers?: Array<{ login: string }>;
    created_at: string;
    updated_at: string;
    pull_request?: { html_url: string };
    repository_url: string;
  }>;
}

export class GitHubClient {
  private baseUrl = "https://api.github.com";

  constructor(private token: string) {}

  private async apiCall<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    }

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < RETRY_CONFIG.MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(url.toString(), {
          headers: {
            Authorization: `token ${this.token}`,
            Accept: "application/vnd.github.v3+json",
            "User-Agent": "Primer/1.0",
          },
        });

        if (!res.ok) {
          if (attempt < RETRY_CONFIG.MAX_ATTEMPTS - 1 && isRetryableStatus(res.status)) {
            await new Promise((r) => setTimeout(r, retryDelay(attempt, parseRetryAfter(res))));
            continue;
          }
          const text = await res.text();
          throw new Error(`GitHub API ${res.status}: ${text.slice(0, 200)}`);
        }

        return (await res.json()) as T;
      } catch (err) {
        lastError = err as Error;
        if (attempt < RETRY_CONFIG.MAX_ATTEMPTS - 1) {
          await new Promise((r) => setTimeout(r, retryDelay(attempt)));
        }
      }
    }
    throw lastError;
  }

  private parseSearchItems(items: SearchResult["items"]): GitHubPR[] {
    return items.map((item) => {
      const repoUrl = item.repository_url ?? "";
      const repoParts = repoUrl.split("/");
      const repo = repoParts.slice(-2).join("/");
      return {
        number: item.number,
        title: item.title,
        url: item.html_url,
        body: item.body,
        state: item.state,
        labels: item.labels.map((l) => l.name),
        repository: repo,
        author: item.user.login,
        reviewers: item.requested_reviewers?.map((r) => r.login) ?? [],
        createdAt: item.created_at,
        updatedAt: item.updated_at,
      };
    });
  }

  async getReviewRequestedPRs(username: string, org?: string): Promise<GitHubPR[]> {
    const q = `type:pr state:open review-requested:${username}${org ? ` org:${org}` : ""}`;
    const result = await this.apiCall<SearchResult>("/search/issues", {
      q,
      sort: "updated",
      order: "desc",
      per_page: "30",
    });
    return this.parseSearchItems(result.items);
  }

  async getAssignedPRs(username: string, org?: string): Promise<GitHubPR[]> {
    const q = `type:pr state:open assignee:${username}${org ? ` org:${org}` : ""}`;
    const result = await this.apiCall<SearchResult>("/search/issues", {
      q,
      sort: "updated",
      order: "desc",
      per_page: "30",
    });
    return this.parseSearchItems(result.items);
  }

  async getCommentedPRs(username: string, org?: string, sinceDays = 7): Promise<GitHubPR[]> {
    const since = new Date(Date.now() - sinceDays * 86400_000).toISOString().split("T")[0];
    const q = `type:pr commenter:${username} updated:>=${since}${org ? ` org:${org}` : ""}`;
    const result = await this.apiCall<SearchResult>("/search/issues", {
      q,
      sort: "updated",
      order: "desc",
      per_page: "30",
    });
    return this.parseSearchItems(result.items);
  }

  async getTeamReviewPRs(org: string, teamSlugs: string[]): Promise<GitHubPR[]> {
    const allPRs: GitHubPR[] = [];
    for (const slug of teamSlugs.slice(0, 5)) {
      try {
        const q = `type:pr state:open team-review-requested:${org}/${slug}`;
        const result = await this.apiCall<SearchResult>("/search/issues", {
          q,
          sort: "updated",
          order: "desc",
          per_page: "20",
        });
        allPRs.push(...this.parseSearchItems(result.items));
      } catch (err) {
        console.error(`[github] Team review fetch failed for ${slug}:`, err);
      }
    }
    return allPRs;
  }

  async getRepoActivity(owner: string, repo: string, sinceDays = 7): Promise<GitHubPR[]> {
    const since = new Date(Date.now() - sinceDays * 86400_000).toISOString();
    const result = await this.apiCall<
      Array<{
        number: number;
        title: string;
        html_url: string;
        body: string | null;
        state: string;
        labels: Array<{ name: string }>;
        user: { login: string };
        requested_reviewers: Array<{ login: string }>;
        created_at: string;
        updated_at: string;
      }>
    >(`/repos/${owner}/${repo}/pulls`, {
      state: "all",
      sort: "updated",
      direction: "desc",
      per_page: "20",
      since,
    });

    return result.map((pr) => ({
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      body: pr.body,
      state: pr.state,
      labels: pr.labels.map((l) => l.name),
      repository: `${owner}/${repo}`,
      author: pr.user.login,
      reviewers: pr.requested_reviewers?.map((r) => r.login) ?? [],
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
    }));
  }

  async getPRComments(owner: string, repo: string, number: number): Promise<string[]> {
    const comments = await this.apiCall<
      Array<{
        body: string;
        user: { login: string };
      }>
    >(`/repos/${owner}/${repo}/issues/${number}/comments`, { per_page: "20" });
    return comments.filter((c) => c.body.length > 20).map((c) => `${c.user.login}: ${c.body}`);
  }

  async listUserTeams(org: string): Promise<Array<{ id: number; slug: string; name: string }>> {
    try {
      const teams = await this.apiCall<Array<{ id: number; slug: string; name: string }>>(`/orgs/${org}/teams`, {
        per_page: "100",
      });
      return teams;
    } catch {
      return [];
    }
  }

  async listOrgRepos(org: string): Promise<Array<{ name: string; fullName: string; description: string | null }>> {
    const repos = await this.apiCall<
      Array<{
        name: string;
        full_name: string;
        description: string | null;
        archived: boolean;
      }>
    >(`/orgs/${org}/repos`, {
      type: "all",
      sort: "updated",
      direction: "desc",
      per_page: "100",
    });
    return repos
      .filter((r) => !r.archived)
      .map((r) => ({ name: r.name, fullName: r.full_name, description: r.description }));
  }
}
