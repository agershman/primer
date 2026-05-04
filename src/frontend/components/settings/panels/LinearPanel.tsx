import { useState } from "react";
import { useSettingsCtx } from "../SettingsContext";
import { Card, Field, PanelHeader, SelectedSummary, SourceEnabledRow, ToggleRow, useSourceEnabled } from "../shared";
import { InScopePreview, MatchReason, MetaSep, ScopeRow } from "./InScopePreview";

const STATE_TYPE_LABELS: Record<string, string> = {
  triage: "Triage",
  backlog: "Backlog",
  unstarted: "Todo",
  started: "In Progress",
  completed: "Done",
  cancelled: "Cancelled",
};
const STATE_TYPES = Object.keys(STATE_TYPE_LABELS);

export function LinearPanel() {
  const { settings } = useSettingsCtx();
  const { settings: data, updateSettings, linearTeams, previewState } = settings;
  // Hooks live above the early return (rules of hooks: hook order
  // must be identical on every render, so they cannot live below
  // a conditional return).
  const [editingStates, setEditingStates] = useState(false);
  const [editingTeams, setEditingTeams] = useState(false);
  const { enabled, setEnabled } = useSourceEnabled("linear");
  if (!data) return null;

  const linearDefaults = {
    includeAssigned: true,
    includeSubscribed: true,
    includeTeamProjects: false,
    stateTypes: ["triage", "backlog", "unstarted", "started"],
    teamPrefixes: [] as string[],
    updatedWithinDays: 0,
  };
  const linear = { ...linearDefaults, ...(data.signalSurfaceMap?.linear ?? {}) };
  const updateLinear = (partial: Partial<typeof linear>) => {
    updateSettings({
      signalSurfaceMap: { ...data.signalSurfaceMap, linear: { ...linear, ...partial } },
    });
  };
  const toggleStateType = (st: string) => {
    const next = linear.stateTypes.includes(st)
      ? linear.stateTypes.filter((s) => s !== st)
      : [...linear.stateTypes, st];
    updateLinear({ stateTypes: next });
  };
  const toggleTeamPrefix = (prefix: string) => {
    const next = linear.teamPrefixes.includes(prefix)
      ? linear.teamPrefixes.filter((p) => p !== prefix)
      : [...linear.teamPrefixes, prefix];
    updateLinear({ teamPrefixes: next });
  };

  // Display the server's reported `total` (which can exceed the
  // length of the truncated `issues` list).
  const issueCount = previewState.linear.data?.total ?? 0;
  const issueCountLabel = `${issueCount} issue${issueCount === 1 ? "" : "s"}`;

  return (
    <div>
      <PanelHeader title="Linear" description="Which Linear issues to include in your daily briefing." />

      <SourceEnabledRow
        enabled={enabled}
        onChange={setEnabled}
        hint="Off by default. Turn on to fan Linear issues into your daily briefing — the filters below decide which ones."
      />

      {!enabled ? (
        <div className="text-[11px] font-mono text-text-dim italic">
          Linear is off for your briefings. Toggle it on to configure which issues to include.
        </div>
      ) : (
        <>
          <Field label="Issues">
            <Card>
              <ToggleRow
                label="Assigned to me"
                checked={linear.includeAssigned}
                onChange={(v) => updateLinear({ includeAssigned: v })}
              />
              <ToggleRow
                label="Subscribed / commented on"
                checked={linear.includeSubscribed}
                onChange={(v) => updateLinear({ includeSubscribed: v })}
              />
              <ToggleRow
                label="In team projects"
                checked={linear.includeTeamProjects}
                onChange={(v) => updateLinear({ includeTeamProjects: v })}
                last
              />
            </Card>
          </Field>

          <Field
            label="Status filter"
            hint={`Which issue states to include${linear.teamPrefixes.length > 0 ? ` (${linear.teamPrefixes.join(", ")})` : ""}.`}
          >
            {editingStates ? (
              <div>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {[...STATE_TYPES]
                    .sort((a, b) => (STATE_TYPE_LABELS[a] ?? a).localeCompare(STATE_TYPE_LABELS[b] ?? b))
                    .map((st) => (
                      <button
                        key={st}
                        type="button"
                        onClick={() => toggleStateType(st)}
                        className={`rounded-md border px-3 py-1.5 text-xs font-mono transition-colors ${
                          linear.stateTypes.includes(st)
                            ? "bg-accent-dim border-accent/20 text-accent"
                            : "border-border bg-surface text-text-dim hover:bg-surface-hover"
                        }`}
                      >
                        {STATE_TYPE_LABELS[st]}
                      </button>
                    ))}
                </div>
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => setEditingStates(false)}
                    className="px-2.5 py-1 rounded-md border border-border text-xs font-mono text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
                  >
                    Done
                  </button>
                </div>
              </div>
            ) : (
              <SelectedSummary
                items={[...linear.stateTypes].sort().map((st) => STATE_TYPE_LABELS[st] ?? st)}
                onEdit={() => setEditingStates(true)}
                emptyLabel="No states selected — briefings won't find issues"
              />
            )}
          </Field>

          <Field label="Time window" hint="Only include issues updated recently.">
            <select
              value={linear.updatedWithinDays ?? 0}
              onChange={(e) => updateLinear({ updatedWithinDays: Number(e.target.value) })}
              className="w-full bg-surface border border-border rounded-md px-3 py-1.5 text-xs font-mono text-text-primary outline-none focus:border-accent transition-colors"
            >
              <option value={0}>No time limit</option>
              <option value={3}>Last 3 days</option>
              <option value={7}>Last 7 days</option>
              <option value={14}>Last 14 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
            </select>
          </Field>

          {linearTeams.length > 0 && (
            <Field label="Teams" hint="Filter by Linear team (empty = all teams).">
              {editingTeams ? (
                <div>
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {[...linearTeams]
                      .sort((a, b) => a.key.localeCompare(b.key))
                      .map((team) => (
                        <button
                          key={team.key}
                          type="button"
                          onClick={() => toggleTeamPrefix(team.key)}
                          className={`rounded-md border px-3 py-1.5 text-xs font-mono transition-colors ${
                            linear.teamPrefixes.includes(team.key)
                              ? "bg-accent-dim border-accent/20 text-accent"
                              : "border-border bg-surface text-text-dim hover:bg-surface-hover"
                          }`}
                        >
                          {team.key} <span className="text-text-faint ml-1">{team.name}</span>
                        </button>
                      ))}
                  </div>
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => setEditingTeams(false)}
                      className="px-2.5 py-1 rounded-md border border-border text-xs font-mono text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
                    >
                      Done
                    </button>
                  </div>
                </div>
              ) : (
                <SelectedSummary
                  items={linear.teamPrefixes.length === 0 ? ["All teams"] : [...linear.teamPrefixes].sort()}
                  onEdit={() => setEditingTeams(true)}
                  emptyLabel="All teams"
                />
              )}
            </Field>
          )}

          <InScopePreview
            source={previewState.linear}
            count={issueCountLabel}
            renderList={(d) => (
              <>
                {d.issues.slice(0, 12).map((issue) => (
                  <ScopeRow
                    key={issue.identifier}
                    ref={issue.identifier}
                    title={issue.title}
                    meta={
                      <>
                        <MatchReason>{issue.reason}</MatchReason>
                      </>
                    }
                  />
                ))}
                {d.issues.length > 12 && (
                  <div className="text-[11px] font-mono text-text-dim italic">+ {d.issues.length - 12} more</div>
                )}
              </>
            )}
            renderNear={(d) => {
              // The current preview API doesn't surface near-misses for
              // Linear yet — we render a placeholder when issue count is 0
              // pointing at the most likely culprit (the status filter).
              if (d.issues.length > 0) return null;
              return {
                title: "Nothing in scope",
                subtitle: "check filters",
                node: (
                  <div className="text-[11px] font-mono text-text-dim leading-relaxed">
                    No Linear issues match your current filters. The most common cause is a narrow{" "}
                    <strong>Status filter</strong> or <strong>Time window</strong>. Try widening one and rebuild the
                    preview.
                  </div>
                ),
              };
            }}
          />
        </>
      )}
    </div>
  );
}
