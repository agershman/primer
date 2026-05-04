---
title: "Keyboard Shortcuts"
subtitle: "Quick navigation"
audiences: [user]
related:
  - reference/configuration
---

Primer supports a handful of keyboard shortcuts for navigating the interface without reaching for the mouse. All shortcuts are **case-insensitive** and fire at the document level.

## Command Palette

| Keys | Action |
|------|--------|
| **Cmd + K** (macOS) / **Ctrl + K** (Windows / Linux) | Open the command palette |

The command palette is a Cmd+K-style launcher (modeled on Cursor / VS Code / Linear) for jumping anywhere in Primer without taking your hands off the keyboard:

- **Navigate** — every top-level page (Briefing, Concepts, Archive, Analytics, Bookmarks, Help).
- **Actions** — open Settings, edit your current focus, open chat, show this shortcuts dialog. Each is a single ↵ press.
- **Theme** — switch to light / dark / system mode. The current mode is annotated.
- **Font size** — small / medium / large. Same annotation pattern.
- **Help** — every help article shows up here too, so the palette doubles as a fuzzy-search over the docs without leaving your current page.

Inside the palette, **↑ / ↓** moves the highlight, **↵** runs the highlighted command, and **Esc** closes the palette. Hovering with the mouse also moves the highlight, so click and keyboard stay in sync. Cmd + K **toggles** the palette — pressing it again from inside any input dismisses the palette without firing any action.

Cmd + K works everywhere, including from inside text fields. If a specific input ever needs to opt out (e.g. a code editor with its own command palette), it can set `data-allow-cmdk="false"` to suppress the global handler for that field only.

## Help

| Key | Action |
|-----|--------|
| **H** | Open the help index |
| **?** | Open the keyboard shortcuts dialog |

## Navigation

Chord-style shortcuts — press **G**, then the next key within ¾ of a second:

| Keys | Action |
|------|--------|
| **G** then **B** | Go to today's briefing |
| **G** then **C** | Go to concepts page |
| **G** then **A** | Go to archive |
| **G** then **H** | Go to help |

If you wait too long or press any other key after **G**, the chord is cancelled silently.

## Dismissing Modals

| Key | Action |
|-----|--------|
| **Escape** | Close the currently open modal, panel, or dialog |

Escape works in layers — if the chat model picker is open, Escape closes that first. If nothing is open inside the chat, Escape closes the chat panel itself. The shortcuts dialog also closes on Escape.

If a microphone is actively listening (any voice-mode dictation field — quiz answers, chat input, About / Focus editors), the **first** Escape stops the mic *only*, without closing the surrounding panel; a **second** Escape then closes the panel as usual. That way an accidental voice-mode tap doesn't force you to choose between killing the mic and losing your draft.

## Audio Player

When focus is on a Listen audio player (click anywhere on the player or `Tab` to it), these shortcuts work:

| Key | Action |
|-----|--------|
| **Space** | Play / pause |
| **←** / **→** | Skip backward / forward 15 seconds |
| **Shift + ←** / **Shift + →** | Fine jump backward / forward 5 seconds |
| **Home** | Jump to the start |
| **End** | Jump to the end |
| **`[`** | Step playback rate down (slower) |
| **`]`** | Step playback rate up (faster) |

You can also click and drag the playhead thumb on the progress bar to scrub anywhere. Drag scrubbing only commits the new position when you release, so the audio doesn't re-buffer with every pixel of motion.

The skip-back and skip-forward buttons (with the rotating-arrow `15` icons) flank the play button on every player. They work even while audio is still streaming and total duration is unknown — useful for re-listening to the last sentence of a chat reply that was cut off by background noise.

To the right of the time display, a small **playback-rate button** (e.g. `1×`, `1.5×`) cycles through `0.75 / 1 / 1.25 / 1.5 / 1.75 / 2`× when clicked. **Shift-click** or **right-click** cycles the other direction. The button is highlighted in accent when you're listening at a non-1× speed so you don't forget you've changed it. Your choice persists across sessions (localStorage) and is mirrored across every other audio player on the page in real time.

## When Shortcuts Don't Fire

Shortcuts are deliberately suppressed when:

- Focus is inside a text input, textarea, select, or any `contenteditable` element — so typing `h` in the chat input doesn't bounce you to the help page.
- Any modifier key is held (Cmd, Ctrl, Alt, or Meta) — browser/OS shortcuts take precedence.

Click any empty area of the page to restore global shortcut focus if your input has grabbed it.
