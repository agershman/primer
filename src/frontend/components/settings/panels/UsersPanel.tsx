/**
 * Admin-only Users panel — promote / demote users without dropping
 * to D1 SQL. Replaces the prior "no UI for promotion yet" recipe in
 * the help docs.
 *
 * Server gate: `worker/routes/users.ts` mounts every route in this
 * file behind `requireAdmin`, so a non-admin reaching this panel via
 * a forced URL still gets a 403 on every API call. The panel itself
 * is hidden from the Settings nav for non-admins; this is just the
 * defense-in-depth restatement.
 *
 * Last-admin demotion: the server returns 409 with
 * `{ error: "Last admin", reason: ... }` when demoting the only
 * admin would leave the deployment unconfigurable. We surface
 * `reason` inline on the row so the user knows why the action was
 * refused.
 */

import { useEffect, useState } from "react";
import { apiGet, apiPatch } from "../../../utils/api";
import { useSettingsCtx } from "../SettingsContext";
import { Card, Field, PanelHeader } from "../shared";

interface UserRow {
  id: string;
  email: string;
  displayName: string | null;
  isAdmin: boolean;
  createdAt: string;
  welcomedAsAdminAt: string | null;
}

interface PatchResponse {
  user: UserRow;
  selfDemoted: boolean;
}

export function UsersPanel() {
  const { user: currentUser, onUserChanged } = useSettingsCtx();
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [confirming, setConfirming] = useState<{ user: UserRow; toAdmin: boolean } | null>(null);

  const refresh = async () => {
    setLoadError(null);
    try {
      const data = await apiGet<{ users: UserRow[] }>("/api/users");
      setUsers(data.users);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load users");
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const handleConfirm = async () => {
    if (!confirming) return;
    const target = confirming.user;
    const toAdmin = confirming.toAdmin;
    setConfirming(null);
    setPendingId(target.id);
    setRowError(null);
    try {
      const res = await apiPatch<PatchResponse>(`/api/users/${target.id}`, { isAdmin: toAdmin });
      // Optimistic patch the local list with the server-truth row.
      setUsers((prev) => (prev ? prev.map((u) => (u.id === res.user.id ? res.user : u)) : prev));
      // If the admin demoted themselves, the SettingsModal nav needs
      // to collapse — refresh /api/me upstream so isAdmin flips.
      if (res.selfDemoted) {
        onUserChanged();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Update failed";
      // Pull the human-readable `reason` out of the 409 body when
      // it's the last-admin case. Everything else falls through to
      // the raw error string.
      const lastAdminReason = extractLastAdminReason(message);
      setRowError({
        id: target.id,
        message: lastAdminReason ?? message,
      });
    } finally {
      setPendingId(null);
    }
  };

  return (
    <div>
      <PanelHeader
        title="Users"
        description="Promote teammates to admin or demote them back to regular users. Server gates enforce the role on every admin-only mutation; this panel is just the management surface."
      />

      <Field
        label="All users"
        hint="The first user to authenticate against a fresh deployment is automatically promoted to admin (atomic INSERT-SELECT bootstrap). Subsequent users start as regular users — toggle them here. The deployment must always have at least one admin."
      >
        {loadError && (
          <p className="mb-3 text-xs font-mono text-negative" role="alert">
            {loadError}
          </p>
        )}
        {users === null && !loadError && <p className="text-xs font-mono text-text-dim">Loading…</p>}
        {users && users.length === 0 && <p className="text-xs font-mono text-text-dim italic">No users yet.</p>}
        {users && users.length > 0 && (
          <Card>
            <div className="divide-y divide-border-subtle">
              {users.map((u) => {
                const isCurrent = u.id === currentUser?.email ? false : u.email === currentUser?.email;
                const pending = pendingId === u.id;
                const error = rowError?.id === u.id ? rowError.message : null;
                return (
                  <div key={u.id} className="py-3 flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2 flex-wrap">
                        <span className="text-xs font-mono text-text-primary truncate">
                          {u.displayName ?? u.email.split("@")[0]}
                        </span>
                        {isCurrent && <span className="text-[10px] font-mono text-text-dim">(you)</span>}
                        <span
                          className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                            u.isAdmin
                              ? "bg-accent-dim text-accent border border-accent/20"
                              : "bg-bg-warm text-text-dim border border-border-subtle"
                          }`}
                        >
                          {u.isAdmin ? "Admin" : "Regular user"}
                        </span>
                      </div>
                      <div className="text-[10px] font-mono text-text-dim mt-0.5 truncate">{u.email}</div>
                      {error && (
                        <div className="text-[10px] font-mono text-negative mt-1" role="alert">
                          {error}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => setConfirming({ user: u, toAdmin: !u.isAdmin })}
                      className="shrink-0 px-2.5 py-1 rounded-md border border-border text-[11px] font-mono text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors disabled:opacity-50"
                    >
                      {pending ? "Saving…" : u.isAdmin ? "Demote to regular user" : "Promote to admin"}
                    </button>
                  </div>
                );
              })}
            </div>
          </Card>
        )}
      </Field>

      {confirming && (
        <ConfirmRoleChange
          user={confirming.user}
          toAdmin={confirming.toAdmin}
          onCancel={() => setConfirming(null)}
          onConfirm={handleConfirm}
          isSelf={confirming.user.email === currentUser?.email}
        />
      )}
    </div>
  );
}

function ConfirmRoleChange({
  user,
  toAdmin,
  onCancel,
  onConfirm,
  isSelf,
}: {
  user: UserRow;
  toAdmin: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  isSelf: boolean;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[120] bg-black/50 backdrop-blur-sm grid place-items-center p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-xl bg-bg border border-border shadow-2xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold text-text-primary mb-2">
          {toAdmin ? "Promote to admin?" : "Demote to regular user?"}
        </h3>
        <p className="text-xs font-mono text-text-secondary leading-relaxed mb-3">
          {toAdmin ? (
            <>
              <span className="text-text-primary">{user.displayName ?? user.email}</span> will be able to configure
              deployment-wide settings: sources, AI models, voice defaults, budget caps, and other users' admin status.
              They'll see a one-time welcome dialog explaining what changed on their next session.
            </>
          ) : (
            <>
              <span className="text-text-primary">{user.displayName ?? user.email}</span> will lose access to
              deployment-wide settings. They'll keep their personalization (About, Focus, Relevance filter).
              {isSelf && (
                <span className="block mt-2 text-warning">
                  You're demoting yourself. Your Settings nav will collapse to Personalization + Account on the next
                  request.
                </span>
              )}
            </>
          )}
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 rounded-md border border-border text-xs font-mono text-text-secondary hover:bg-surface-hover transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`px-3 py-1.5 rounded-md text-xs font-mono font-medium transition-opacity hover:opacity-90 ${
              toAdmin ? "bg-accent text-bg" : "bg-negative text-white"
            }`}
          >
            {toAdmin ? "Yes, promote to admin" : "Yes, demote"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Pulls the `reason` out of a 409 last-admin error string. The
 * shared `apiPatch` throws `Error("API 409: {json body}")` so we
 * parse the JSON tail to extract the human-readable reason.
 */
function extractLastAdminReason(message: string): string | null {
  const match = message.match(/^API 409: (.+)$/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as { reason?: string };
    return parsed.reason ?? null;
  } catch {
    return null;
  }
}
