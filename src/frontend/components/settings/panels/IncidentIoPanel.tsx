import { useSettingsCtx } from "../SettingsContext";
import { PanelHeader, SourceEnabledRow, useSourceEnabled } from "../shared";
import { InScopePreview } from "./InScopePreview";

/**
 * incident.io is read-only by design — the worker fetches active and
 * recently-resolved incidents based on retention policy. There are no
 * user-tunable filters yet. Panel exists so the source is visible in
 * the sidenav (and the in-scope preview is a useful at-a-glance
 * "is this connected?" signal).
 */
export function IncidentIoPanel() {
  const { settings } = useSettingsCtx();
  const { previewState } = settings;
  const total = previewState.incidents.data?.total ?? 0;
  const countLabel = `${total} active incident${total === 1 ? "" : "s"}`;
  const { enabled, setEnabled } = useSourceEnabled("incident_io");

  return (
    <div>
      <PanelHeader
        title="incident.io"
        description="Active incidents and recently resolved post-mortems. No per-source filters yet — the briefing pipeline pulls everything visible to your token."
      />

      <SourceEnabledRow
        enabled={enabled}
        onChange={setEnabled}
        hint="Off by default. Turn on to fan active and recently-resolved incidents into your daily briefing."
      />

      {!enabled ? (
        <div className="text-[11px] font-mono text-text-dim italic">
          incident.io is off for your briefings. Toggle it on to start surfacing active incidents.
        </div>
      ) : (
        <InScopePreview
          source={previewState.incidents}
          count={countLabel}
          renderList={() => (
            <div className="text-xs font-mono text-text-dim">
              {total === 0
                ? "No active incidents — preview returned a count but no detailed list."
                : `${total} active incident${total === 1 ? "" : "s"} will be included in the next briefing.`}
            </div>
          )}
        />
      )}
    </div>
  );
}
