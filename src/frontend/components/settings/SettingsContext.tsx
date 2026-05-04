import { createContext, type ReactNode, useContext } from "react";
import type { UseSettingsResult } from "../../hooks/useSettings";

/**
 * Per-user prop bundle the settings panels need. Mirrors the prop the
 * top-level <SettingsPanel> already received; we just carry it down
 * through context instead of drilling props through every panel.
 */
export interface SettingsUserProp {
  email: string;
  displayName: string | null;
  avatarUrl?: string | null;
  focusStatement?: string | null;
  focusVersionId?: string | null;
  aboutStatement?: string | null;
  aboutVersionId?: string | null;
  identity: { type?: string };
  /**
   * Drives the modal's nav filtering. See
   * `worker/middleware/require-admin.ts` for the server-side gate
   * that backs this UX hint.
   */
  isAdmin: boolean;
}

export interface TtsModelDescriptor {
  id: string;
  label: string;
  provider: string;
  tier: string;
  description: string;
  costPer1kChars: number;
}

/**
 * Bundle every panel might need. Keeping this in one shared context
 * lets each panel pull just what it cares about without prop drilling
 * through the shell. The shell builds the value once per render and
 * memo-stable references are not required because the panels are
 * cheap to re-render — settings rarely change at high frequency.
 */
export interface SettingsContextValue {
  settings: UseSettingsResult;
  user: SettingsUserProp | null;
  ttsModels: TtsModelDescriptor[];
  /** Fires when persona statements (focus/about) change so the parent
   *  can reload `useCurrentUser`. Optional because not every consumer
   *  cares. */
  onUserChanged: () => void;
  /** Closes the modal — surfaced to panels in case any of them want
   *  to dismiss after a destructive action (e.g. reset concepts). */
  onClose: () => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ value, children }: { value: SettingsContextValue; children: ReactNode }) {
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettingsCtx(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) {
    throw new Error("useSettingsCtx must be used inside <SettingsProvider>");
  }
  return ctx;
}
