/**
 * One-time welcome dialog shown to a user when they are admin AND
 * haven't dismissed this dialog yet. The trigger is computed
 * server-side as `needsBootstrapWelcome` (see `/api/me`).
 *
 * Two paths reach this dialog:
 *
 *   1. Bootstrap admin: the first user to provision a fresh
 *      deployment is silently promoted to admin by the atomic
 *      INSERT-SELECT in `worker/middleware/user-context.ts`. Without
 *      this dialog they had no way to discover their admin status
 *      short of reading the help docs.
 *
 *   2. Promoted admin: an existing admin uses the Settings → Users
 *      panel to flip another user's `is_admin = 1`. Next time that
 *      user loads /api/me, this dialog explains what changed.
 *
 * Dismissing the dialog calls `POST /api/me/welcome-acknowledged`
 * which sets the timestamp server-side. The /api/me poll then
 * returns `needsBootstrapWelcome: false` and the dialog never
 * re-pops.
 */

import { useState } from "react";
import { createPortal } from "react-dom";
import { apiPost } from "../utils/api";

interface BootstrapAdminWelcomeProps {
  email: string;
  onDismissed: () => void;
}

export function BootstrapAdminWelcome({ email, onDismissed }: BootstrapAdminWelcomeProps) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDismiss = async () => {
    setWorking(true);
    setError(null);
    try {
      await apiPost("/api/me/welcome-acknowledged", {});
      onDismissed();
    } catch (err) {
      // Surface the failure but don't trap the user — they can
      // dismiss manually by reloading. Show the dialog again next
      // session if it really failed (server hasn't recorded
      // dismissal yet).
      setError(err instanceof Error ? err.message : "Failed to acknowledge welcome");
      setWorking(false);
    }
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="bootstrap-admin-welcome-title"
      className="fixed inset-0 z-[110] bg-black/50 backdrop-blur-sm grid place-items-center p-4"
    >
      <div
        className="w-full max-w-lg rounded-xl bg-bg border border-border shadow-2xl p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="bootstrap-admin-welcome-title" className="text-base font-semibold text-text-primary mb-2">
          You are the deployment admin
        </h2>
        <p className="text-xs font-mono text-text-secondary leading-relaxed mb-3">
          Welcome to Primer, <span className="text-text-primary">{email}</span>. As the first user to authenticate
          against this deployment, you've been automatically promoted to{" "}
          <span className="font-semibold text-text-primary">admin</span>. Subsequent users will start as regular users
          by default — you can promote them from{" "}
          <span className="font-semibold text-text-primary">Settings → Users</span>.
        </p>
        <div className="rounded-md border border-border-subtle bg-bg-warm p-3 mb-4 space-y-2">
          <div className="text-[10px] font-mono uppercase tracking-wider text-text-dim">What you can configure</div>
          <ul className="text-xs font-mono text-text-secondary leading-relaxed list-disc pl-4 space-y-1">
            <li>
              <span className="text-text-primary">Sources</span> — Linear, Slack, GitHub, incident.io, RSS / HN / ArXiv
              feeds and their per-source filters
            </li>
            <li>
              <span className="text-text-primary">Intelligence</span> — per-operation AI model picks (concept
              extraction, teaching pieces, deep dives, chat) and TTS voice defaults
            </li>
            <li>
              <span className="text-text-primary">Limits</span> — monthly budget cap, relevance threshold, near-miss
              floor
            </li>
            <li>
              <span className="text-text-primary">Users</span> — promote teammates to admin or demote them back to
              regular users
            </li>
          </ul>
        </div>
        <p className="text-xs font-mono text-text-dim leading-relaxed mb-4">
          Regular users can edit their own personalization (About, Focus, Relevance filter) but can't change
          deployment-wide settings. Server-side gates enforce this on every admin-only route — the UI hide is just to
          keep their panel calm.
        </p>
        {error && (
          <p className="text-xs font-mono text-negative mb-3" role="alert">
            {error} — try again, or reload to dismiss locally.
          </p>
        )}
        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleDismiss}
            disabled={working}
            className="px-4 py-1.5 rounded-md bg-accent text-bg text-xs font-mono font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {working ? "Saving…" : "Got it"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
