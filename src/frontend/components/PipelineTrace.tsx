import { useCallback, useEffect, useMemo, useState } from "react";
import { apiGet } from "../utils/api";
import { BriefingWaterfall } from "./BriefingWaterfall";

interface PipelineStep {
  stepKey: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  itemsProcessed: number | null;
  modelUsed: string | null;
  metadata: Record<string, unknown> | null;
}

interface ProviderStat {
  id: string;
  name: string;
  enabled: boolean;
  fetched: boolean;
  itemCount: number;
  errored: boolean;
  sampleItems: Array<{ title: string; url?: string }>;
}

interface FilterDroppedItem {
  id?: string;
  sourceType?: string;
  title: string;
  score?: number;
  reason?: string;
}

interface ConceptBucket {
  filterLabel: string;
  sourceTypes: string[];
  itemCount: number;
}

interface SelectionOutcome {
  conceptName: string;
  conceptId: string;
  priority: number;
  depthScore: number;
  sourceType: string;
  focusScore: number;
  selected: boolean;
  droppedReason: string | null;
}

interface ContinuationOutcome {
  classification: string;
  predecessor_title: string | null;
  reason: string | null;
}

interface NearMiss {
  title: string;
  sourceType: string;
  sourceLabel: string | null;
  relevanceScore: number | null;
  exclusionReason: string | null;
  url: string | null;
}

interface DiscoveredItem {
  title: string;
  sourceType: string;
  url: string;
  summary: string | null;
  relevanceScore: number | null;
  relevanceConcepts: string[];
}

interface PipelinePiece {
  id: string;
  title: string;
  selectionReasoning: string | null;
  sourceType: string;
  seriesId: string | null;
  partNumber: number | null;
  position: number;
  targetDepth: number | null;
}

interface PipelineResponse {
  briefingId: string;
  status: string;
  finalize: {
    reason: string | null;
    conceptsExtracted: number | null;
    existingConceptsReferenced: number | null;
    adjacentItemsScored: number | null;
    candidateCount: number | null;
    selectedCount: number | null;
    totalPieces: number | null;
    errors: string[];
  };
  modelsUsed: Record<string, string>;
  redundantDrafts: Array<{
    predecessor_title: string;
    predecessor_series_id: string | null;
    predecessor_part_number: number | null;
    reason: string;
  }>;
  steps: PipelineStep[];
  nearMisses: NearMiss[];
  discovered: DiscoveredItem[];
  pieces: PipelinePiece[];
}

const STEP_LABELS: Record<string, string> = {
  work_context: "Fetching sources",
  slack_filter: "Relevance filter (Slack)",
  concepts: "Extracting concepts",
  adjacent: "Scanning feeds",
  selecting: "Selecting targets",
  generating_pieces: "Writing teaching pieces",
  teaching_piece: "Each teaching piece",
  quiz: "Calibration quiz",
  finishing: "Finishing up",
};

const DROP_REASON_LABELS: Record<string, string> = {
  cap_max_pieces: "exceeded max pieces per briefing",
  cap_adjacent: "exceeded adjacent-feed cap",
  cap_decay: "exceeded decay-recalibration cap",
  duplicate_concept: "another candidate already covered this concept",
};

function stepLabel(key: string): string {
  return STEP_LABELS[key] ?? key;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

interface PipelineTraceProps {
  briefingId: string;
}

export function PipelineTrace({ briefingId }: PipelineTraceProps) {
  const [expanded, setExpanded] = useState(false);
  const [data, setData] = useState<PipelineResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (loaded) return;
    try {
      const payload = await apiGet<PipelineResponse>(`/api/briefing/${briefingId}/pipeline`);
      setData(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load");
    }
    setLoaded(true);
  }, [briefingId, loaded]);

  useEffect(() => {
    if (expanded && !loaded) load();
  }, [expanded, loaded, load]);

  return (
    <div className="mt-8 pt-6 border-t border-border-subtle">
      <button
        onClick={() => setExpanded(!expanded)}
        className="font-ui text-xs text-text-faint hover:text-text-dim transition-colors min-h-[44px] flex items-center"
      >
        {expanded ? "▾" : "▸"} Generation details
      </button>
      {expanded && (
        <div className="mt-3 space-y-6">
          {error && <p className="font-ui text-xs text-negative">Couldn't load trace: {error}</p>}
          {!error && !data && <p className="font-ui text-xs text-text-faint">Loading…</p>}
          {data && <TraceBody data={data} />}
        </div>
      )}
    </div>
  );
}

function TraceBody({ data }: { data: PipelineResponse }) {
  const totalMs = useMemo(() => data.steps.reduce((s, t) => s + t.durationMs, 0), [data.steps]);
  const stepsByKey = useMemo(() => {
    const map = new Map<string, PipelineStep[]>();
    for (const s of data.steps) {
      const list = map.get(s.stepKey) ?? [];
      list.push(s);
      map.set(s.stepKey, list);
    }
    return map;
  }, [data.steps]);

  // Iterate over whatever step_keys the data carries — no hardcoded
  // list — so adding a future step or removing one in a deployment
  // doesn't break this UI. The renderer maps step_key → component.
  const renderedStepKeys = new Set<string>();
  const stepSections: React.ReactNode[] = [];
  for (const step of data.steps) {
    if (renderedStepKeys.has(step.stepKey)) continue;
    renderedStepKeys.add(step.stepKey);
    const rows = stepsByKey.get(step.stepKey) ?? [];
    stepSections.push(<StepSection key={step.stepKey} stepKey={step.stepKey} rows={rows} data={data} />);
  }

  return (
    <div className="space-y-6">
      {/* ── Summary chips ── */}
      <div className="flex flex-wrap items-center gap-2">
        <SummaryChip label="Status" value={data.status} />
        <SummaryChip label="Total" value={formatMs(totalMs)} />
        {data.finalize.candidateCount !== null && (
          <SummaryChip
            label="Selected"
            value={`${data.finalize.selectedCount ?? 0} / ${data.finalize.candidateCount}`}
          />
        )}
        {data.finalize.totalPieces !== null && <SummaryChip label="Pieces" value={String(data.finalize.totalPieces)} />}
        {data.finalize.reason && <SummaryChip label="Reason" value={data.finalize.reason} tone="warn" />}
        {data.finalize.errors.length > 0 && (
          <SummaryChip label="Errors" value={String(data.finalize.errors.length)} tone="warn" />
        )}
      </div>

      {/* ── Waterfall ── */}
      <BriefingWaterfall steps={data.steps} totalMs={totalMs} stepLabels={STEP_LABELS} />

      {/* ── Per-step kept/dropped ── */}
      <div className="space-y-4">{stepSections}</div>

      {/* ── Redundant drafts (continuation classifier) ── */}
      {data.redundantDrafts.length > 0 && (
        <Section title="Drafts dropped as redundant" count={data.redundantDrafts.length}>
          <ul className="space-y-2 mt-2">
            {data.redundantDrafts.map((d, i) => (
              <li key={i} className="font-ui text-xs">
                <span className="text-text-secondary">{d.predecessor_title}</span>
                <span className="text-text-faint"> — {d.reason}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* ── Per-piece rollup ── */}
      {data.pieces.length > 0 && (
        <Section title="Pieces persisted" count={data.pieces.length}>
          <ul className="space-y-2 mt-2">
            {data.pieces.map((p) => (
              <li key={p.id} className="font-ui text-xs flex flex-wrap items-baseline gap-2">
                <span className="text-text-secondary">{p.title}</span>
                <SourceTag value={p.sourceType} />
                {p.partNumber !== null && (
                  <span className="font-mono text-[10px] text-text-faint">part {p.partNumber}</span>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function StepSection({ stepKey, rows, data }: { stepKey: string; rows: PipelineStep[]; data: PipelineResponse }) {
  // Fanout summary (one step_key appears multiple times — e.g.
  // teaching_piece). We collapse durations and surface the
  // classifier outcomes inline.
  if (rows.length > 1) {
    return (
      <Section
        title={stepLabel(stepKey)}
        count={rows.length}
        meta={`× ${rows.length} runs · ${formatMs(rows.reduce((s, r) => s + r.durationMs, 0))} total`}
      >
        {stepKey === "teaching_piece" ? <TeachingPieceFanout rows={rows} /> : null}
      </Section>
    );
  }
  const row = rows[0];
  const meta = row.metadata ?? {};
  return (
    <Section
      title={stepLabel(stepKey)}
      meta={`${formatMs(row.durationMs)}${row.modelUsed ? ` · ${row.modelUsed}` : ""}${row.itemsProcessed !== null ? ` · ${row.itemsProcessed} items` : ""}`}
    >
      {stepKey === "work_context" && <WorkContextDetail meta={meta} />}
      {stepKey === "slack_filter" && <RelevanceFilterDetail meta={meta} />}
      {stepKey === "concepts" && <ConceptsDetail meta={meta} />}
      {stepKey === "adjacent" && <AdjacentDetail discovered={data.discovered} nearMisses={data.nearMisses} />}
      {stepKey === "selecting" && <SelectingDetail meta={meta} />}
      {stepKey !== "work_context" &&
        stepKey !== "slack_filter" &&
        stepKey !== "concepts" &&
        stepKey !== "adjacent" &&
        stepKey !== "selecting" && <GenericMetaDetail meta={meta} />}
    </Section>
  );
}

function WorkContextDetail({ meta }: { meta: Record<string, unknown> }) {
  const providers = (meta.providers as ProviderStat[] | undefined) ?? [];
  if (providers.length === 0) {
    return <p className="font-ui text-xs text-text-faint mt-2">No source providers configured.</p>;
  }
  return (
    <ul className="space-y-1 mt-2">
      {providers.map((p) => {
        let badge: { label: string; tone: "ok" | "off" | "warn" };
        if (!p.enabled) badge = { label: "disabled", tone: "off" };
        else if (p.errored) badge = { label: "errored", tone: "warn" };
        else if (p.itemCount === 0) badge = { label: "no items", tone: "off" };
        else badge = { label: `${p.itemCount} items`, tone: "ok" };
        return (
          <li key={p.id} className="font-ui text-xs flex items-baseline gap-2 flex-wrap">
            <span className="text-text-secondary">{p.name}</span>
            <SourceTag value={p.id} />
            <Badge tone={badge.tone}>{badge.label}</Badge>
            {p.sampleItems.length > 0 && (
              <span className="text-text-faint truncate">
                {p.sampleItems
                  .slice(0, 3)
                  .map((s) => s.title)
                  .join(", ")}
                {p.sampleItems.length > 3 && "…"}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function RelevanceFilterDetail({ meta }: { meta: Record<string, unknown> }) {
  const dropped = (meta.droppedItems as FilterDroppedItem[] | undefined) ?? [];
  const total = (meta.totalSlackCount as number | undefined) ?? null;
  const kept = (meta.keptSlackCount as number | undefined) ?? null;
  const failedOpen = (meta.failedOpen as boolean | undefined) ?? false;
  if (failedOpen) {
    return (
      <p className="font-ui text-xs text-text-faint mt-2">
        Scoring failed — items passed through unchanged ({kept} kept).
      </p>
    );
  }
  if (dropped.length === 0) {
    return (
      <p className="font-ui text-xs text-text-faint mt-2">All {kept ?? total ?? 0} items passed the relevance bar.</p>
    );
  }
  return (
    <div className="mt-2 space-y-2">
      <p className="font-ui text-xs text-text-dim">
        {dropped.length} of {total ?? "?"} dropped · {kept ?? "?"} kept
      </p>
      <ul className="space-y-1">
        {dropped.map((d, i) => (
          <li key={i} className="font-ui text-xs flex items-baseline gap-2 flex-wrap">
            <span className="text-text-secondary truncate max-w-[60ch]">{d.title}</span>
            {d.sourceType && <SourceTag value={d.sourceType} />}
            {d.score !== undefined && (
              <span className="font-mono text-[10px] text-text-faint">{(d.score * 100).toFixed(0)}%</span>
            )}
            {d.reason && <span className="text-text-faint">— {d.reason}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ConceptsDetail({ meta }: { meta: Record<string, unknown> }) {
  const buckets = (meta.buckets as ConceptBucket[] | undefined) ?? [];
  const newCount = meta.newConceptIds as number | undefined;
  const existingCount = meta.existingConceptIds as number | undefined;
  return (
    <div className="mt-2 space-y-2">
      <p className="font-ui text-xs text-text-dim">
        {newCount ?? 0} new · {existingCount ?? 0} existing referenced
      </p>
      {buckets.length > 0 && (
        <ul className="space-y-1">
          {buckets.map((b, i) => (
            <li key={i} className="font-ui text-xs flex items-baseline gap-2 flex-wrap">
              <Badge tone="ok">{b.filterLabel}</Badge>
              <span className="text-text-faint">{b.itemCount} items</span>
              <span className="text-text-faint">
                from{" "}
                {b.sourceTypes.map((s) => (
                  <SourceTag key={s} value={s} inline />
                ))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AdjacentDetail({ discovered, nearMisses }: { discovered: DiscoveredItem[]; nearMisses: NearMiss[] }) {
  return (
    <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-4">
      <div>
        <p className="font-ui text-xs text-text-dim mb-1">Kept ({discovered.length})</p>
        {discovered.length === 0 ? (
          <p className="font-ui text-xs text-text-faint italic">None</p>
        ) : (
          <ul className="space-y-1">
            {discovered.slice(0, 10).map((d, i) => (
              <li key={i} className="font-ui text-xs flex items-baseline gap-2 flex-wrap">
                {d.url ? (
                  <a
                    href={d.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-link hover:text-link-hover truncate max-w-[40ch]"
                  >
                    {d.title}
                  </a>
                ) : (
                  <span className="text-text-secondary truncate max-w-[40ch]">{d.title}</span>
                )}
                <SourceTag value={d.sourceType} />
                {d.relevanceScore !== null && (
                  <span className="font-mono text-[10px] text-text-faint">{(d.relevanceScore * 100).toFixed(0)}%</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <p className="font-ui text-xs text-text-dim mb-1">Dropped ({nearMisses.length})</p>
        {nearMisses.length === 0 ? (
          <p className="font-ui text-xs text-text-faint italic">None</p>
        ) : (
          <ul className="space-y-1">
            {nearMisses.slice(0, 10).map((n, i) => (
              <li key={i} className="font-ui text-xs flex items-baseline gap-2 flex-wrap">
                {n.url ? (
                  <a
                    href={n.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-link hover:text-link-hover truncate max-w-[40ch]"
                  >
                    {n.title}
                  </a>
                ) : (
                  <span className="text-text-secondary truncate max-w-[40ch]">{n.title}</span>
                )}
                <SourceTag value={n.sourceLabel ?? n.sourceType} />
                {n.relevanceScore !== null && (
                  <span className="font-mono text-[10px] text-text-faint">{(n.relevanceScore * 100).toFixed(0)}%</span>
                )}
                {n.exclusionReason && <span className="text-text-faint">— {n.exclusionReason}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function SelectingDetail({ meta }: { meta: Record<string, unknown> }) {
  const outcomes = (meta.outcomes as SelectionOutcome[] | undefined) ?? [];
  if (outcomes.length === 0) {
    return <p className="font-ui text-xs text-text-faint mt-2">No candidates considered.</p>;
  }
  const selected = outcomes.filter((o) => o.selected);
  const dropped = outcomes.filter((o) => !o.selected);
  return (
    <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-4">
      <div>
        <p className="font-ui text-xs text-text-dim mb-1">Selected ({selected.length})</p>
        {selected.length === 0 ? (
          <p className="font-ui text-xs text-text-faint italic">None</p>
        ) : (
          <ul className="space-y-1">
            {selected.map((o, i) => (
              <li key={i} className="font-ui text-xs flex items-baseline gap-2 flex-wrap">
                <span className="text-text-secondary truncate max-w-[36ch]">{o.conceptName}</span>
                <SourceTag value={o.sourceType} />
                <span className="font-mono text-[10px] text-text-faint">
                  P{o.priority} · depth {o.depthScore.toFixed(1)} · focus {(o.focusScore * 100).toFixed(0)}%
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <p className="font-ui text-xs text-text-dim mb-1">Dropped ({dropped.length})</p>
        {dropped.length === 0 ? (
          <p className="font-ui text-xs text-text-faint italic">None</p>
        ) : (
          <ul className="space-y-1">
            {dropped.map((o, i) => (
              <li key={i} className="font-ui text-xs flex items-baseline gap-2 flex-wrap">
                <span className="text-text-secondary truncate max-w-[36ch]">{o.conceptName}</span>
                <SourceTag value={o.sourceType} />
                <span className="font-mono text-[10px] text-text-faint">
                  P{o.priority} · focus {(o.focusScore * 100).toFixed(0)}%
                </span>
                {o.droppedReason && (
                  <span className="text-text-faint">— {DROP_REASON_LABELS[o.droppedReason] ?? o.droppedReason}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function TeachingPieceFanout({ rows }: { rows: PipelineStep[] }) {
  return (
    <ul className="space-y-1 mt-2">
      {rows.map((r, i) => {
        const meta = (r.metadata ?? {}) as Record<string, unknown>;
        const conceptName = (meta.conceptName as string) ?? "(unknown)";
        const continuation = meta.continuation as ContinuationOutcome | null | undefined;
        return (
          <li key={i} className="font-ui text-xs flex items-baseline gap-2 flex-wrap">
            <span className="text-text-secondary truncate max-w-[36ch]">{conceptName}</span>
            <span className="font-mono text-[10px] text-text-faint">{formatMs(r.durationMs)}</span>
            {continuation && (
              <Badge tone={continuation.classification === "NOVEL" ? "ok" : "warn"}>
                {continuation.classification.toLowerCase()}
                {continuation.predecessor_title && `: "${continuation.predecessor_title}"`}
              </Badge>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function GenericMetaDetail({ meta }: { meta: Record<string, unknown> }) {
  const keys = Object.keys(meta);
  if (keys.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1">
      {keys.map((k) => (
        <li key={k} className="font-mono text-[10px] text-text-faint flex gap-2">
          <span>{k}:</span>
          <span className="text-text-dim truncate max-w-[60ch]">{formatMetaValue(meta[k])}</span>
        </li>
      ))}
    </ul>
  );
}

function formatMetaValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return "[unserializable]";
  }
}

function Section({
  title,
  count,
  meta,
  children,
}: {
  title: string;
  count?: number;
  meta?: string;
  children?: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-baseline gap-2 flex-wrap">
        <h3 className="font-display text-sm text-text-primary">{title}</h3>
        {count !== undefined && <span className="font-mono text-[10px] text-text-faint">× {count}</span>}
        {meta && <span className="font-mono text-[10px] text-text-faint">{meta}</span>}
      </div>
      {children}
    </div>
  );
}

function SummaryChip({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "neutral" | "warn" }) {
  return (
    <span
      className={`font-mono text-[10px] px-2 py-0.5 rounded border ${
        tone === "warn" ? "border-negative-dim text-text-secondary" : "border-border-subtle text-text-faint"
      }`}
    >
      {label}: {value}
    </span>
  );
}

function Badge({ children, tone }: { children: React.ReactNode; tone: "ok" | "warn" | "off" }) {
  const cls =
    tone === "ok"
      ? "border-border-subtle text-text-dim"
      : tone === "warn"
        ? "border-negative-dim text-text-secondary"
        : "border-border-subtle text-text-faint";
  return <span className={`font-mono text-[10px] px-1.5 py-0.5 rounded border ${cls}`}>{children}</span>;
}

function SourceTag({ value, inline = false }: { value: string; inline?: boolean }) {
  const cls = inline ? "" : "ml-0";
  return (
    <span className={`font-mono text-[10px] text-text-faint px-1 py-0.5 rounded bg-surface-active ${cls}`}>
      {value}
    </span>
  );
}
