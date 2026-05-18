import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { apiGet } from "../utils/api";

interface UserSettings {
  budgetCapMonthly: number;
  briefingCron: string;
  relevanceThreshold: number;
  nearMissFloor: number;
  retentionDays: number;
  signalSurfaceMap: Record<string, unknown>;
}

export interface CurrentUser {
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  focusStatement: string | null;
  focusVersionId: string | null;
  aboutStatement: string | null;
  aboutVersionId: string | null;
  settings: UserSettings;
  identity: { email: string; type?: string };
  /**
   * Drives Settings nav filtering + the per-piece "↻ try different
   * model" / inline `voice: <name> ↻` switcher visibility. Admins see
   * the full Sources / Intelligence / General panels; regular users
   * see only Personalization (About, Focus, Relevance filter) plus
   * Account. The server enforces the same gate on every admin-only
   * mutation route — this field is purely a UX hint.
   */
  isAdmin: boolean;
  /**
   * True when the user is admin AND hasn't dismissed the bootstrap
   * welcome dialog yet. App.tsx mounts `<BootstrapAdminWelcome>`
   * when this flips on; "Got it" hits
   * `POST /api/me/welcome-acknowledged` and refreshes /api/me, after
   * which this returns false on subsequent loads. Computed
   * server-side so a future client-side bug can't accidentally
   * suppress it.
   */
  needsBootstrapWelcome: boolean;
}

export function useCurrentUser() {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const data = await apiGet<CurrentUser>("/api/me");
      setUser(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load user");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  return { user, loading, error, refresh };
}

/**
 * Cross-cutting context so deep components (`TeachingPiece`,
 * `DeepDiveView`, `ChatPanel`, etc.) can read identity / admin
 * status without prop-drilling through every parent.
 *
 * `App.tsx` is the single provider — it already runs `useCurrentUser`
 * at the top, so we wrap `<Routes>` in `<CurrentUserContext.Provider>`
 * and let any descendant call `useCurrentUserContext()`.
 *
 * The default value is `null` so components that read it before the
 * /api/me fetch resolves can render in a "regular user" / loading
 * state without flashing admin-only UI. Server gates always have the
 * final say.
 */
const CurrentUserContext = createContext<CurrentUser | null>(null);

export function CurrentUserProvider({ user, children }: { user: CurrentUser | null; children: ReactNode }) {
  return <CurrentUserContext.Provider value={user}>{children}</CurrentUserContext.Provider>;
}

export function useCurrentUserContext(): CurrentUser | null {
  return useContext(CurrentUserContext);
}

/** Convenience selector used by per-piece UI (try different model,
 *  inline VoiceSwitcher) to decide whether to render admin-only
 *  affordances. Defaults to `false` while /api/me is loading or when
 *  the context isn't provided — better to under-show admin UI than
 *  flash it for a non-admin. */
export function useIsAdmin(): boolean {
  const u = useCurrentUserContext();
  return u?.isAdmin === true;
}

/**
 * Tiny wrapper that renders its children only for the deployment
 * admin. Useful for inline admin-only affordances (the per-piece "↻
 * try different model" button, the inline `voice: <name> ↻`
 * switcher, etc.) where a single admin check inline would otherwise
 * pollute the JSX. The `fallback` prop lets a caller render
 * something for non-admins (e.g. a static label) when the visual
 * slot needs to be preserved.
 */
export function AdminOnly({ children, fallback = null }: { children: ReactNode; fallback?: ReactNode }) {
  return useIsAdmin() ? <>{children}</> : <>{fallback}</>;
}
