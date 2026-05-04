import Fuse from "fuse.js";

/**
 * Help-doc audience taxonomy. Each `.md` file in `src/frontend/help/`
 * declares one or more `audiences` in its frontmatter so the help
 * index can section content by persona:
 *
 *   - `user`      — the default reader. Briefings, calibration,
 *                   concepts, troubleshooting.
 *   - `admin`     — the deployment owner. Sources, AI model picks,
 *                   voice defaults, budget caps, promoting users.
 *   - `developer` — extending Primer. Source providers, LLM/TTS
 *                   adapter patterns, internal architecture.
 *   - `ops`       — running Primer in production. CI/CD, secrets,
 *                   D1 migrations, monitoring, scaling.
 *
 * Multi-tagging is normal — the configuration doc serves admins
 * primarily but a curious user might want to read it too. The Help
 * index page lets the reader pick a persona chip to filter the grid.
 */
export type HelpAudience = "user" | "admin" | "developer" | "ops";

export const HELP_AUDIENCES: readonly HelpAudience[] = ["user", "admin", "developer", "ops"] as const;

export const HELP_AUDIENCE_LABELS: Record<HelpAudience, string> = {
  user: "Users",
  admin: "Admins",
  developer: "Developers",
  ops: "Ops",
};

export const HELP_AUDIENCE_DESCRIPTIONS: Record<HelpAudience, string> = {
  user: "Read briefings, take quizzes, edit your About / Focus.",
  admin: "Configure sources, AI models, voice defaults, budget caps.",
  developer: "Extend Primer — adapters, source providers, internals.",
  ops: "Host Primer — deploy, manage secrets, run migrations.",
};

export interface HelpPageMeta {
  id: string;
  title: string;
  subtitle: string;
  category: string;
  content: string;
  related: string[];
  /**
   * Personas this page is written for. A page that lists multiple
   * audiences appears under each persona's filter. Defaults to
   * `["user"]` when frontmatter omits the field — most existing docs
   * are user-facing, so the default is the safe / most-permissive
   * choice.
   */
  audiences: HelpAudience[];
}

const modules = import.meta.glob("../help/**/*.md", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

function parseFrontmatter(raw: string): {
  title: string;
  subtitle: string;
  related: string[];
  audiences: HelpAudience[];
  body: string;
} {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { title: "", subtitle: "", related: [], audiences: ["user"], body: raw };
  }

  const closingIdx = lines.indexOf("---", 1);
  if (closingIdx === -1) {
    return { title: "", subtitle: "", related: [], audiences: ["user"], body: raw };
  }

  const frontmatterLines = lines.slice(1, closingIdx);
  const body = lines
    .slice(closingIdx + 1)
    .join("\n")
    .trim();

  let title = "";
  let subtitle = "";
  const related: string[] = [];
  const audiences: HelpAudience[] = [];
  // Tracks which list-style frontmatter key we're currently appending
  // entries to. The frontmatter parser is intentionally tiny and
  // newline/indent-aware rather than a full YAML implementation —
  // both `related:` and `audiences:` use the same `- value` shape.
  type ListKey = "related" | "audiences" | null;
  let listKey: ListKey = null;

  for (const line of frontmatterLines) {
    if (line.startsWith("title:")) {
      title = line.replace("title:", "").trim().replace(/^"|"$/g, "");
      listKey = null;
    } else if (line.startsWith("subtitle:")) {
      subtitle = line.replace("subtitle:", "").trim().replace(/^"|"$/g, "");
      listKey = null;
    } else if (line.startsWith("related:")) {
      listKey = "related";
    } else if (line.startsWith("audiences:")) {
      // Inline form: `audiences: [user, admin]` or single value
      // `audiences: user`. Falls back to multi-line list if the rest
      // of the line is empty.
      const rest = line.replace("audiences:", "").trim();
      if (rest.startsWith("[")) {
        const inner = rest.replace(/^\[/, "").replace(/\]$/, "");
        for (const part of inner.split(",")) {
          const v = part.trim().replace(/^"|"$/g, "");
          if (isAudience(v)) audiences.push(v);
        }
        listKey = null;
      } else if (rest && rest !== "") {
        const v = rest.replace(/^"|"$/g, "");
        if (isAudience(v)) audiences.push(v);
        listKey = null;
      } else {
        listKey = "audiences";
      }
    } else if (listKey && line.trim().startsWith("- ")) {
      const value = line.trim().slice(2).trim().replace(/^"|"$/g, "");
      if (listKey === "related") {
        related.push(value);
      } else if (listKey === "audiences" && isAudience(value)) {
        audiences.push(value);
      }
    } else {
      listKey = null;
    }
  }

  return {
    title,
    subtitle,
    related,
    audiences: audiences.length > 0 ? audiences : ["user"],
    body,
  };
}

function isAudience(v: string): v is HelpAudience {
  return v === "user" || v === "admin" || v === "developer" || v === "ops";
}

function buildRegistry(): HelpPageMeta[] {
  const pages: HelpPageMeta[] = [];

  for (const [path, raw] of Object.entries(modules)) {
    const match = path.match(/\.\.\/help\/(.+)\/(.+)\.md$/);
    if (!match) continue;

    const category = match[1];
    const slug = match[2];
    const id = `${category}/${slug}`;
    const { title, subtitle, related, audiences, body } = parseFrontmatter(raw);

    pages.push({ id, title, subtitle, category, content: body, related, audiences });
  }

  return pages;
}

const registry = buildRegistry();

const fuse = new Fuse(registry, {
  keys: [
    { name: "title", weight: 0.4 },
    { name: "subtitle", weight: 0.2 },
    { name: "content", weight: 0.3 },
    { name: "category", weight: 0.1 },
  ],
  threshold: 0.4,
  includeScore: true,
  ignoreLocation: true,
});

export function getAllHelpPages(): HelpPageMeta[] {
  return registry;
}

export function getHelpPage(id: string): HelpPageMeta | undefined {
  return registry.find((p) => p.id === id);
}

/**
 * Category ordering for the index. New persona-anchor categories
 * (`admins`, `developers`, `ops`) sit at the bottom so the most-read
 * user content stays at the top. The registry still falls back to
 * any unknown category found in the filesystem (see
 * `getHelpPagesGrouped`'s second pass).
 */
const CATEGORY_ORDER = [
  "getting-started",
  "briefings",
  "concepts",
  "calibration",
  "reference",
  "troubleshooting",
  "admins",
  "credentials",
  "developers",
  "ops",
];

const CATEGORY_LABELS: Record<string, string> = {
  "getting-started": "Getting Started",
  briefings: "Briefings",
  concepts: "Concepts",
  calibration: "Calibration",
  reference: "Reference",
  troubleshooting: "Troubleshooting",
  admins: "For Admins",
  credentials: "Credentials & Permissions",
  developers: "For Developers",
  ops: "For Ops",
};

export function getCategoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

/**
 * Group pages by category, optionally filtered to a single audience.
 * `audience: null` (or omitted) returns every page — used by the
 * Help index's "All" chip. Filtering preserves category order so the
 * grid remains stable as the reader toggles personas.
 */
export function getHelpPagesGrouped(audience?: HelpAudience | null): Map<string, HelpPageMeta[]> {
  const grouped = new Map<string, HelpPageMeta[]>();
  const matches = (p: HelpPageMeta) => !audience || p.audiences.includes(audience);

  for (const cat of CATEGORY_ORDER) {
    const pages = registry.filter((p) => p.category === cat && matches(p));
    if (pages.length > 0) {
      grouped.set(cat, pages);
    }
  }

  for (const page of registry) {
    if (!grouped.has(page.category)) {
      const pages = registry.filter((p) => p.category === page.category && matches(p));
      if (pages.length > 0) grouped.set(page.category, pages);
    }
  }

  return grouped;
}

export function getFirstPageInCategory(category: string): HelpPageMeta | undefined {
  return registry.find((p) => p.category === category);
}

export function searchHelp(query: string, audience?: HelpAudience | null): HelpPageMeta[] {
  const filter = (pages: HelpPageMeta[]) => (audience ? pages.filter((p) => p.audiences.includes(audience)) : pages);
  if (!query.trim()) return filter(registry);
  return filter(fuse.search(query).map((result) => result.item));
}
