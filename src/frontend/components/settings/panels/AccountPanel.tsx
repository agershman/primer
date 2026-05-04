import { useState } from "react";
import { apiPost } from "../../../utils/api";
import { ResetConceptsConfirm } from "../modals/ResetConceptsConfirm";
// `Card` is still used by the Identity section above; the Danger zone
// uses bespoke red styling instead so it doesn't blend into the
// neutral panel surface like everything else in Settings.
import { useSettingsCtx } from "../SettingsContext";
import { Card, Field, InfoRow, PanelHeader } from "../shared";

/**
 * Account / profile / danger-zone panel. Holds the small handful of
 * personal settings that don't belong to a source: displayed identity
 * and the destructive "reset concepts" action.
 *
 * GitHub username is managed via the GitHub source panel (Settings → GitHub).
 *
 * The Cloudflare Access auth status is read-only and surfaced here
 * (and only here, since the modal header was simplified to remove
 * the inline auth strip).
 */
export function AccountPanel() {
  const { user } = useSettingsCtx();

  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetMessage, setResetMessage] = useState<string | null>(null);

  const email = user?.email ?? "unknown";
  const displayName = user?.displayName ?? email.split("@")[0];
  const authMode = user?.identity?.type === "dev" ? "Development mode" : "Authenticated via Cloudflare Access";
  const isAdmin = user?.isAdmin === true;

  return (
    <div>
      <PanelHeader title="Account" description="Profile, authentication, and danger-zone actions." />

      <Field
        label="Identity"
        // Hint demystifies what "Admin" vs "Regular user" actually
        // gets you in the UI without making the reader chase a help
        // article. Matches the role description in the help docs.
        hint={
          isAdmin
            ? "As admin you can configure deployment-wide settings: sources, AI models, voice defaults, and budget caps. Regular users only see Personalization (About, Focus, Relevance filter)."
            : "Regular users can edit personalization (About, Focus, Relevance filter) but can't change deployment-wide settings. An admin can promote you from Settings → Users."
        }
      >
        <Card>
          <InfoRow label="Display name" value={displayName} />
          <InfoRow label="Email" value={email} />
          <InfoRow label="Authentication" value={authMode} />
          <InfoRow label="Role" value={isAdmin ? "Admin" : "Regular user"} />
        </Card>
      </Field>

      {/*
       * Danger zone is intentionally NOT using the shared <Field>/<Card>
       * primitives — those render with neutral text / subtle border, which
       * is fine for normal settings but wrong here. The user previously
       * could miss that this section was destructive (the "Reset concepts"
       * button alone carried a faint red tint that didn't broadcast risk).
       *
       * GitHub-style treatment: heavy red border on the container, red
       * heading, red explanatory copy. The button stays in its outline-red
       * state at rest and flips to solid red on hover/focus so the
       * commit-action gets a clear escalation in visual weight as you
       * approach it. Disabled state preserves the outline (for reduced
       * motion / colorblind users) and just dims the whole thing.
       *
       * `text-negative` is the same token used elsewhere for failure
       * states (notification bell "failed" rows, audio-error inline
       * banners) so this stays semantically consistent across the app.
       */}
      <div className="mb-4">
        <div className="text-xs font-semibold text-negative mb-1">Danger zone</div>
        <div className="text-[10px] font-mono text-negative/85 mb-2 leading-relaxed">
          Resetting wipes all of your concepts, depth scores, and calibration history. Past briefings and teaching
          pieces are preserved. The next briefing rebuilds the graph from scratch under your current focus.
        </div>
        <div className="rounded-lg border-2 border-negative/50 bg-negative-dim p-4">
          <button
            type="button"
            onClick={() => setResetOpen(true)}
            disabled={resetting}
            className="px-3 py-1.5 rounded-md border border-negative/60 bg-transparent text-negative text-xs font-mono hover:bg-negative hover:text-bg focus-visible:bg-negative focus-visible:text-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-negative/40 transition-colors disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-negative"
          >
            Reset concepts (start fresh)
          </button>
          {resetMessage && <div className="mt-2 text-[11px] font-mono text-text-secondary">{resetMessage}</div>}
        </div>
      </div>

      {resetOpen && (
        <ResetConceptsConfirm
          working={resetting}
          onCancel={() => setResetOpen(false)}
          onConfirm={async () => {
            setResetting(true);
            setResetMessage(null);
            try {
              // Routed through `apiPost` for the same reason as
              // every other call site: TZ header parity + uniform
              // error wrapping. The reset endpoint does the
              // dangerous work, so passing through the standard
              // helper also gives us the 503 retry semantics if
              // the worker happens to be cold-starting.
              const data = await apiPost<{ deletedConcepts: number }>("/api/concepts/reset");
              setResetMessage(
                `Deleted ${data.deletedConcepts} concept${data.deletedConcepts === 1 ? "" : "s"}. Generate a new briefing to rebuild your graph.`,
              );
              setResetOpen(false);
            } catch (err) {
              setResetMessage(`Reset failed: ${err instanceof Error ? err.message : "unknown error"}`);
            } finally {
              setResetting(false);
            }
          }}
        />
      )}
    </div>
  );
}
