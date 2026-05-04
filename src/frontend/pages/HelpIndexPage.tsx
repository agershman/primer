import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useIsAdmin } from "../hooks/useCurrentUser";
import {
  getCategoryLabel,
  getHelpPagesGrouped,
  HELP_AUDIENCE_DESCRIPTIONS,
  HELP_AUDIENCE_LABELS,
  HELP_AUDIENCES,
  type HelpAudience,
  searchHelp,
} from "../lib/helpRegistry";

const CATEGORY_DESCRIPTIONS: Record<string, string> = {
  "getting-started": "What Primer is, how to set it up, and your first briefing",
  briefings: "Generation pipeline, teaching pieces, feedback, and deep dives",
  concepts: "Depth scale, concept graph, confidence, decay, and relations",
  calibration: "Quizzes, assessment methodology, and baseline calibration",
  reference: "Keyboard shortcuts, configuration, and API endpoints",
  troubleshooting: "Common issues and how to fix them",
  admins: "Configuring sources, AI models, voice defaults, and budget caps",
  credentials: "Step-by-step credential setup + the exact permissions Primer needs per integration",
  developers: "Adapter patterns, source providers, and where to plug in new code",
  ops: "Deploying, hosting, secrets, migrations, and monitoring",
};

const CATEGORY_ICONS: Record<string, string> = {
  "getting-started": "→",
  briefings: "◉",
  concepts: "◇",
  calibration: "△",
  reference: "▤",
  troubleshooting: "⚑",
  admins: "🛠",
  credentials: "🔑",
  developers: "🧑‍💻",
  ops: "📡",
};

const PERSONA_ICONS: Record<HelpAudience, string> = {
  user: "👤",
  admin: "🛠",
  developer: "🧑‍💻",
  ops: "📡",
};

type PersonaFilter = HelpAudience | "all";

const PERSONA_FILTERS: PersonaFilter[] = ["all", ...HELP_AUDIENCES];

function personaLabel(p: PersonaFilter): string {
  return p === "all" ? "All" : HELP_AUDIENCE_LABELS[p];
}

function isPersonaFilter(v: string | null): v is PersonaFilter {
  return v === "all" || v === "user" || v === "admin" || v === "developer" || v === "ops";
}

export function HelpIndexPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const isAdmin = useIsAdmin();

  // Persona filter is sticky in the URL via `?for=admins` so deep
  // links into a specific persona's content land on that filter
  // already applied. Default = "all" so brand-new readers see
  // everything; users in a specific persona role can switch and
  // their pick persists across reloads.
  const initialFromUrl = searchParams.get("for");
  const persona: PersonaFilter = isPersonaFilter(initialFromUrl) ? initialFromUrl : "all";

  const setPersona = (next: PersonaFilter) => {
    const params = new URLSearchParams(searchParams);
    if (next === "all") {
      params.delete("for");
    } else {
      params.set("for", next);
    }
    setSearchParams(params, { replace: true });
  };

  const [query, setQuery] = useState("");
  const audienceFilter = persona === "all" ? null : persona;

  const grouped = useMemo(() => getHelpPagesGrouped(audienceFilter), [audienceFilter]);
  const searchResults = query.trim() ? searchHelp(query, audienceFilter) : null;

  // First-load nudge: if the reader is *not* admin and hasn't picked
  // a persona, default to "user" so they don't see admin/developer/ops
  // content in their first impression. They can opt back into "All"
  // with one click. Admins see "All" by default since they typically
  // need both their config docs and the user content their team reads.
  //
  // Deliberately excluding `initialFromUrl` and `setPersona` from the
  // dep array — we want this to fire only when isAdmin transitions
  // (the async /api/me load), not every time the URL changes (which
  // would loop on the very setPersona call inside).
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    if (initialFromUrl) return; // user already picked
    if (!isAdmin) {
      setPersona("user");
    }
  }, [isAdmin]);

  return (
    <div className="animate-fade-in">
      <div className="mb-6">
        <h1 className="font-display text-2xl font-medium text-text-primary mb-1">Help</h1>
        <p className="font-ui text-sm text-text-secondary">
          Learn how Primer works, from briefing generation to concept calibration.
        </p>
      </div>

      {/* Persona chips. Reading by audience is the primary axis — most
          folks only ever care about user docs, but admins / developers
          / ops each have their own slice and shouldn't have to scan
          past content irrelevant to them. */}
      <div className="mb-6">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-ui text-[10px] uppercase tracking-wider text-text-faint mr-1">Audience:</span>
          {PERSONA_FILTERS.map((p) => {
            const active = p === persona;
            return (
              <button
                key={p}
                type="button"
                onClick={() => setPersona(p)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 font-ui text-xs transition-colors ${
                  active
                    ? "border-accent bg-accent-dim text-accent"
                    : "border-border-subtle bg-surface text-text-secondary hover:border-border hover:bg-surface-hover"
                }`}
                aria-pressed={active}
              >
                {p !== "all" && (
                  <span aria-hidden className="text-[11px]">
                    {PERSONA_ICONS[p]}
                  </span>
                )}
                <span>{personaLabel(p)}</span>
              </button>
            );
          })}
        </div>
        {persona !== "all" && (
          <p className="font-ui text-[11px] text-text-dim mt-2 leading-relaxed">
            {HELP_AUDIENCE_DESCRIPTIONS[persona]}
          </p>
        )}
      </div>

      <div className="mb-8">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search help articles..."
          className="w-full rounded-lg border border-border bg-surface px-4 py-2.5 font-ui text-sm text-text-primary placeholder:text-text-faint outline-none transition-colors focus:border-accent focus:ring-1 focus:ring-accent-dim"
          // Help is a search-first surface — autofocus saves a click
          // for keyboard-driven users hitting `H` to open it. Same
          // behavior as the original implementation.
          // biome-ignore lint/a11y/noAutofocus: intentional UX choice for the search-first help index
          autoFocus
        />
      </div>

      {searchResults ? (
        <div>
          <p className="font-ui text-xs text-text-dim mb-4">
            {searchResults.length} result{searchResults.length !== 1 ? "s" : ""} for "{query}"
            {persona !== "all" && <span className="text-text-faint"> · in {personaLabel(persona)}</span>}
          </p>
          {searchResults.length === 0 ? (
            <p className="font-ui text-sm text-text-secondary py-8 text-center">
              No articles match your search. Try different keywords{persona !== "all" ? " or switch to All" : ""}.
            </p>
          ) : (
            <div className="space-y-2">
              {searchResults.map((page) => (
                <Link
                  key={page.id}
                  to={`/help/${page.id}`}
                  className="block rounded-lg border border-border-subtle bg-surface p-4 no-underline transition-colors hover:border-border hover:bg-surface-hover"
                >
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="font-ui text-sm font-medium text-text-primary">{page.title}</span>
                    <span className="font-ui text-[10px] text-text-faint uppercase tracking-wide">
                      {getCategoryLabel(page.category)}
                    </span>
                    {page.audiences.map((a) => (
                      <span
                        key={a}
                        className="font-ui text-[9px] text-text-dim border border-border-subtle rounded px-1 py-px"
                        title={`Targeted at ${HELP_AUDIENCE_LABELS[a]}`}
                      >
                        {PERSONA_ICONS[a]} {HELP_AUDIENCE_LABELS[a]}
                      </span>
                    ))}
                  </div>
                  <p className="font-ui text-xs text-text-dim mt-1">{page.subtitle}</p>
                </Link>
              ))}
            </div>
          )}
        </div>
      ) : grouped.size === 0 ? (
        <p className="font-ui text-sm text-text-secondary py-8 text-center">
          No articles for this audience yet. Try{" "}
          <button type="button" onClick={() => setPersona("all")} className="text-accent underline">
            All
          </button>
          .
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {Array.from(grouped.entries()).map(([category, pages]) => (
            <Link
              key={category}
              to={`/help/${pages[0].id}`}
              className="group rounded-lg border border-border-subtle bg-surface p-5 no-underline transition-colors hover:border-border hover:bg-surface-hover"
            >
              <div className="flex items-center gap-2.5 mb-2">
                <span className="text-accent text-base leading-none" aria-hidden>
                  {CATEGORY_ICONS[category] ?? "•"}
                </span>
                <h2 className="font-ui text-sm font-semibold text-text-primary">{getCategoryLabel(category)}</h2>
              </div>
              <p className="font-ui text-xs text-text-dim leading-relaxed mb-3">
                {CATEGORY_DESCRIPTIONS[category] ?? ""}
              </p>
              <div className="space-y-0.5">
                {pages.map((page) => (
                  <div
                    key={page.id}
                    className="font-ui text-xs text-text-secondary group-hover:text-text-primary transition-colors"
                  >
                    {page.title}
                  </div>
                ))}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
