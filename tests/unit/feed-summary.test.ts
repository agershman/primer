/**
 * Tests for `summarizeFeedSources` — the helper that powers the
 * adjacent-scan progress strings ("Scanning feeds (HN, CNCF, ArXiv…)
 * for N concepts"). The strings used to be hardcoded as
 * "HN, CNCF, ArXiv, AWS, GCP" regardless of which feeds the user
 * actually had configured; this helper reads the live `source_instances`
 * table so the labels reflect the user's setup, with an ellipsis when
 * there are more enabled than we list inline.
 */
import { describe, it, expect } from "vitest";
import { summarizeFeedSources } from "../../src/worker/services/briefing-generator";

interface FakeRow {
  id: string;
  kind: string;
  label: string;
  url: string | null;
  config: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

function fakeDB(rows: FakeRow[]): D1Database {
  return {
    prepare(_sql: string) {
      return {
        async all() {
          return { results: rows, success: true, meta: {} };
        },
      };
    },
  } as unknown as D1Database;
}

function row(label: string, kind = "rss", enabled = true): FakeRow {
  return {
    id: `src-${label.toLowerCase().replace(/\s+/g, "-")}`,
    kind,
    label,
    url: `https://example.com/${label}`,
    config: "{}",
    enabled: enabled ? 1 : 0,
    created_at: "2026-04-27T00:00:00Z",
    updated_at: "2026-04-27T00:00:00Z",
  };
}

describe("summarizeFeedSources", () => {
  it("returns an empty suffix and zero total when nothing is enabled", async () => {
    const summary = await summarizeFeedSources(fakeDB([]));
    expect(summary).toEqual({ labels: [], total: 0, suffix: "" });
  });

  it("lists all configured feeds without an ellipsis when total ≤ max", async () => {
    const summary = await summarizeFeedSources(
      fakeDB([row("Hacker News", "hn"), row("CNCF Blog")]),
      3,
    );
    expect(summary.total).toBe(2);
    expect(summary.labels).toEqual(["Hacker News", "CNCF Blog"]);
    expect(summary.suffix).toBe(" (Hacker News, CNCF Blog)");
  });

  it("lists exactly `max` feeds without an ellipsis when total === max", async () => {
    const summary = await summarizeFeedSources(
      fakeDB([row("Hacker News", "hn"), row("CNCF Blog"), row("ArXiv", "arxiv")]),
      3,
    );
    expect(summary.total).toBe(3);
    expect(summary.suffix).toBe(" (Hacker News, CNCF Blog, ArXiv)");
    expect(summary.suffix).not.toMatch(/…/);
  });

  it("truncates with `…` when total > max", async () => {
    const summary = await summarizeFeedSources(
      fakeDB([
        row("Hacker News", "hn"),
        row("CNCF Blog"),
        row("ArXiv", "arxiv"),
        row("AWS What's New", "aws_changelog"),
        row("GCP Release Notes", "gcp_changelog"),
      ]),
      3,
    );
    expect(summary.total).toBe(5);
    expect(summary.labels).toHaveLength(3);
    expect(summary.suffix).toBe(" (Hacker News, CNCF Blog, ArXiv…)");
  });

  it("respects the user's actual labels rather than hardcoded names", async () => {
    const summary = await summarizeFeedSources(
      fakeDB([
        row("Cloudflare Blog"),
        row("Stripe Engineering"),
        row("First Round Review"),
      ]),
      3,
    );
    expect(summary.suffix).toBe(
      " (Cloudflare Blog, Stripe Engineering, First Round Review)",
    );
    // Sanity: no leftover hardcoded names from the old static string.
    expect(summary.suffix).not.toMatch(/HN|ArXiv|GCP/);
  });
});
