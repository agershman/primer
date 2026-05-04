import { Link } from "react-router-dom";
import type { RedundantDraftEntry } from "../types";

/**
 * "No new movement" header chip for briefings.
 *
 * The continuation classifier silently filters drafts that would have
 * been near-duplicates of recent pieces. Without surfacing that fact,
 * the briefing would just feel suspiciously empty — the user wouldn't
 * know whether their topics were *considered* or simply forgotten.
 *
 * The chip lists each filtered topic by its predecessor's title, with
 * a Part-N suffix when the predecessor is in a series, and links each
 * entry back to that predecessor's briefing so the user can review
 * what was already covered. Subtle styling on purpose: this is
 * meta-context, not a primary surface.
 */
interface Props {
  drafts: RedundantDraftEntry[];
}

export function RedundantDraftsChip({ drafts }: Props) {
  if (drafts.length === 0) return null;

  const count = drafts.length;
  const heading = count === 1 ? "1 topic had no new movement today" : `${count} topics had no new movement today`;

  return (
    <div
      className="rounded-md border border-border-subtle bg-bg-warm px-3 py-2 mt-3"
      role="status"
      aria-label={heading}
    >
      <div className="font-mono text-[10px] uppercase tracking-wider text-text-dim mb-1">{heading}</div>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 font-ui text-[11px] text-text-secondary">
        {drafts.map((d, i) => {
          const partLabel = typeof d.predecessor_part_number === "number" ? ` (Part ${d.predecessor_part_number})` : "";
          // Deep-link to the predecessor's briefing using the
          // snapshotted date. Anchor target shape matches the
          // series-strip links so BriefingPage's hash-scroll picks
          // it up.
          return (
            <span key={d.predecessor_id} className="inline-flex items-center">
              <Link
                to={`/briefing/${d.predecessor_briefing_date}#piece-${d.predecessor_id}`}
                className="text-link hover:text-link-hover no-underline hover:underline"
                title={d.reason}
              >
                {d.predecessor_title}
                {partLabel}
              </Link>
              {i < drafts.length - 1 && <span className="text-text-faint ml-1.5">·</span>}
            </span>
          );
        })}
      </div>
    </div>
  );
}
