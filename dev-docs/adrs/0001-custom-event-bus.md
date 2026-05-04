# 0001 — Custom DOM event bus instead of context

**Status:** accepted

## Context

Several actions in Primer need to be triggerable from any component in the React tree:

- The Cmd+K command palette can open the chat panel, the Settings modal, the Focus editor, the keyboard-shortcuts dialog.
- Per-piece **VoiceSwitcher** instances need to broadcast voice changes so other AudioPlayer instances on the same page update.
- Per-block code-theme overrides need to broadcast so other code blocks on the page reset.
- Site theme changes need to broadcast so per-block code themes can fall back to "follow site".

A naive "lift the state up" approach (props / context) would require threading callbacks through every layer of the component tree, including layers that have no business knowing about chat panels (e.g. the Header passing an `onOpenChat` callback to a deeply nested AvatarMenu, which passes it to a CommandPalette mounted inside it). The callbacks would also need to be re-created or re-bound every time their owners re-rendered.

## Decision

Use the native DOM `CustomEvent` mechanism with a shared prefix (`primer:`):

```ts
window.dispatchEvent(new CustomEvent("primer:open-chat"));
window.addEventListener("primer:open-chat", handler);
```

Wrapped in a small typed helper (`src/frontend/lib/events.ts`) that pins the event vocabulary, payload types, and prefix in one place.

## Consequences

**Wins:**

- Producer and consumer don't need to share a parent. The Header's keyboard shortcut + the Cmd+K palette can both fire `open-chat`; the App's chat panel listens once.
- No re-renders on event dispatch — the event is purely imperative.
- The vocabulary is enumerable in one file (`lib/events.ts`), so the entire app's event surface is greppable in one place.

**Losses:**

- Discoverability is weaker than React context — a new contributor reading `App.tsx` doesn't immediately see "what triggers chat to open?". The typed bus partially mitigates this (you can `Find Usages` on `dispatchPrimerEvent("open-chat")`).
- No type-checking that a dispatched event has at least one listener. We accept this — these are notifications, not RPCs.
- Server-side rendering is out (the listeners reach into `window`). Not a concern for Primer (Cloudflare Pages serves static HTML, hydration runs entirely client-side).

## Alternatives considered

- **React context with a setter API.** Rejected because the chat-open state lives at App-level but the dispatchers are distributed. We'd need a Provider near the root anyway, and the consumers would still call a `setOpen(true)` callback — same shape, more boilerplate.
- **Zustand / Jotai.** Rejected as over-engineering for ~6 events. The Pages bundle size matters; pulling in another state lib for this is wrong-sized.
- **Pub-sub library (mitt, nanoevents).** Considered; declined because the typed wrapper around native DOM events is ~50 lines and ships zero new dependencies.

## See also

- `src/frontend/lib/events.ts` — the typed wrapper.
- ADR 0002 (testing) — explains why we have source-text contract tests pinning event names.
