/**
 * Header avatar-menu icons — `FocusIcon` (target / "aim") and
 * `GearIcon` (settings).
 *
 * Extracted from `Header.tsx` so the main component file doesn't
 * carry inline SVG bodies. Keep the per-icon comment that explains
 * the iconography choice so future swaps preserve the intent.
 *
 * @see ../Header.tsx — consumer
 */

export function FocusIcon() {
  // Concentric-circle "target" mark — focus / aim. Mirrors the mental
  // model of "what you're aiming at" rather than a generic person /
  // edit pencil, both of which would clash with the Settings gear and
  // the avatar itself.
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-text-dim shrink-0 mt-0.5"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.5" />
      <circle cx="8" cy="8" r="3.5" />
      <circle cx="8" cy="8" r="1" fill="currentColor" />
    </svg>
  );
}

export function GearIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-text-dim shrink-0"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1v2M8 13v2M14.5 8h-2M3.5 8h-2M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4M12.6 12.6l-1.4-1.4M4.8 4.8L3.4 3.4" />
    </svg>
  );
}
