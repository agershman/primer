import { type ReactNode, useRef, useState } from "react";

interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  /**
   * Tailwind width class controlling the tooltip's max size when its
   * content wraps. Defaults to `max-w-xs` (20rem). Override to
   * something tighter (e.g. `w-64`) when a default-sized tooltip
   * would be visually noisy, or to a fixed width when paired with
   * `noWrap`.
   */
  width?: string;
  /**
   * Horizontal positioning relative to the trigger:
   *   - "center" (default): tooltip centered above the trigger via
   *     `left-1/2 -translate-x-1/2`.
   *   - "start": tooltip's LEFT edge aligns with the trigger's left
   *     edge. Use when the trigger is near the right side of a
   *     viewport / container — a centered tooltip would be clipped
   *     or, worse, get squeezed by the browser into a tall
   *     one-word-per-line column. Right-anchor avoids that entirely.
   *   - "end": tooltip's RIGHT edge aligns with the trigger's right
   *     edge. Symmetric counterpart for triggers at left edges.
   */
  align?: "start" | "center" | "end";
  /**
   * If true, force the tooltip onto a single line via
   * `whitespace-nowrap` — `width` then becomes irrelevant. Use for
   * short, actionable descriptions where wrapping looks worse than
   * a wider tooltip.
   */
  noWrap?: boolean;
}

export function Tooltip({ content, children, width = "max-w-xs", align = "center", noWrap = false }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const triggerRef = useRef<HTMLSpanElement>(null);

  const alignClass = align === "start" ? "left-0" : align === "end" ? "right-0" : "left-1/2 -translate-x-1/2";

  return (
    <span
      ref={triggerRef}
      className="relative inline-flex"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
    >
      {children}
      {visible && (
        <span
          role="tooltip"
          className={`absolute bottom-full ${alignClass} mb-2 z-20 rounded-md border border-border bg-surface px-3 py-2 font-ui text-xs text-text-secondary shadow-sm ${
            noWrap ? "whitespace-nowrap" : width
          }`}
        >
          {content}
        </span>
      )}
    </span>
  );
}
