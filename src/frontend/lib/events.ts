/**
 * Typed event bus for cross-tree DOM events.
 *
 * The full architectural rationale for using DOM custom events
 * instead of React context lives in [ADR 0001](../../../dev-docs/adrs/0001-custom-event-bus.md) —
 * read that BEFORE proposing to migrate this to context / a state
 * library. The decision was deliberate; the trade-offs are
 * documented; undoing it without surfacing the ADR is a
 * regression.
 *
 * @see dev-docs/adrs/0001-custom-event-bus.md — why this exists
 * @see .cursor/rules/frontend-conventions.mdc — auto-surfaces when editing frontend
 *
 * Why this exists
 * ---------------
 * Pre-extraction the codebase used raw `window.dispatchEvent(new
 * CustomEvent("primer:open-chat"))` and matching
 * `window.addEventListener("primer:open-chat", handler)` calls
 * scattered across `Header.tsx`, `App.tsx`, `CommandPalette.tsx`,
 * `VoiceSwitcher.tsx`, `RichText.tsx`, etc. That worked but had
 * three problems:
 *
 *   1. Event names were string literals duplicated across files
 *      (and one file's typo became another file's silent dead
 *      listener — happened twice in this codebase's history).
 *   2. `event.detail` was untyped — listeners reached into it with
 *      `(event as any).detail.surface`-style casts, defeating
 *      TypeScript at the exact junction where it would have
 *      helped most.
 *   3. The event vocabulary was invisible to grep — finding "what
 *      events does this app fire?" required `rg "dispatchEvent"`
 *      and visually filtering for primer-prefixed strings.
 *
 * The typed bus below addresses all three: a single declared
 * `PrimerEvents` map gives autocomplete on event names AND
 * payload types, listeners receive a strongly-typed `detail` field,
 * and a single grep on `lib/events` turns up the entire event
 * surface area. Existing call sites that import named constants
 * from `CommandPalette` etc. continue to work because those
 * constants are now thin re-exports of the keys here.
 *
 * Migration path
 * --------------
 * Existing call sites can adopt this incrementally. The event
 * names below are bit-identical to the strings already in use, so
 * you can mix `bus.dispatch("open-chat")` and the legacy
 * `window.dispatchEvent(new CustomEvent("primer:open-chat"))` —
 * both reach the same listeners. New call sites should use the
 * bus.
 */

/**
 * The full vocabulary of `primer:*` events the app fires.
 *
 * Adding a new event means adding ONE line here. The bus enforces
 * that dispatch / on / off all agree on the payload shape.
 *
 * Naming convention: kebab-case verb-or-noun, no `primer:` prefix
 * (that's the bus's job to add). Keep payloads small — full
 * objects belong in component state, not events.
 */
export interface PrimerEvents {
  /** Open the chat panel. Fires from CommandPalette + Header. */
  "open-chat": undefined;
  /** Open the Settings modal. Fires from CommandPalette + Header. */
  "open-settings": undefined;
  /** Open the focus editor (quick-edit modal). */
  "open-focus-editor": undefined;
  /** Open the keyboard-shortcuts dialog. */
  "open-shortcuts": undefined;
  /** Open the command palette itself (Cmd+K toggle). */
  "open-command-palette": undefined;
  /**
   * Site-wide light/dark theme changed. Per-block code-block
   * theme-toggles listen to this so they reset to "follow site"
   * when the site theme changes underneath them.
   */
  "theme-changed": { mode: "light" | "dark" | "system" };
  /**
   * The per-block code theme override changed. Other code blocks
   * on the same page subscribe so they can re-render with the
   * new theme without remount. `"site"` means "follow the site's
   * light/dark mode"; `"light"` / `"dark"` are explicit overrides.
   */
  "code-theme-changed": { theme: "site" | "light" | "dark" };
  /**
   * The audio playback rate changed. AudioPlayer instances on the
   * same page subscribe so they all update together when the
   * user changes rate from any one of them.
   */
  "audio-rate-changed": { rate: number };
  /**
   * The user picked a different TTS voice for a per-piece /
   * deep-dive / chat surface. The `surface` discriminates which
   * VoiceSwitcher fired so listening AudioPlayer instances only
   * react to their own surface's change. `surface` is optional —
   * when omitted, the change is treated as a global default
   * update (Settings → Voice panel "Default voice", legacy callers
   * without a surface tag) and ALL surface listeners refresh.
   */
  "tts-voice-changed": {
    surface?: "teachingPiece" | "deepDive" | "chat";
    voiceId: string;
  };
}

/** All known event names. */
export type PrimerEventName = keyof PrimerEvents;

/** The payload type for a given event. */
export type PrimerEventPayload<E extends PrimerEventName> = PrimerEvents[E];

/**
 * Build the on-the-wire DOM event name from a logical name. Pinning
 * the prefix here means call sites don't hand-roll
 * `"primer:foo"` strings and risk typos. Useful when you need to
 * pass the raw string to a non-bus consumer (e.g. a third-party
 * lib that takes a string event name).
 */
export function primerEventName<E extends PrimerEventName>(name: E): `primer:${E}` {
  return `primer:${name}` as const;
}

/**
 * Dispatch a typed event on `window`. Round-trips through the
 * native CustomEvent under the hood so existing
 * `addEventListener("primer:open-chat")` callers (the legacy
 * pattern) keep firing — this is the migration-friendly path.
 */
export function dispatchPrimerEvent<E extends PrimerEventName>(
  name: E,
  ...args: PrimerEventPayload<E> extends undefined ? [] : [detail: PrimerEventPayload<E>]
): void {
  if (typeof window === "undefined") return;
  const detail = (args[0] ?? undefined) as PrimerEventPayload<E> | undefined;
  window.dispatchEvent(new CustomEvent(primerEventName(name), { detail }));
}

/**
 * Subscribe to a typed primer event. Returns an unsubscribe fn so
 * `useEffect` consumers can do
 * `useEffect(() => onPrimerEvent("open-chat", handler), [...])`
 * with no manual `removeEventListener` plumbing.
 */
export function onPrimerEvent<E extends PrimerEventName>(
  name: E,
  handler: PrimerEventPayload<E> extends undefined ? () => void : (detail: PrimerEventPayload<E>) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const wrapped = (event: Event) => {
    const detail = (event as CustomEvent<PrimerEventPayload<E>>).detail;
    // The conditional handler signature above already enforces
    // void / non-void at the call site, so a single cast is safe
    // here — it just narrows the runtime parameter to whatever
    // the handler actually expects.
    (handler as (d: PrimerEventPayload<E> | undefined) => void)(detail);
  };
  const eventName = primerEventName(name);
  window.addEventListener(eventName, wrapped);
  return () => {
    window.removeEventListener(eventName, wrapped);
  };
}
