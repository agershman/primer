import { useState } from "react";
import type { WorkContextSource } from "../types";
import { normalizeSlackText } from "../utils/text";

const EMOJI_MAP: Record<string, string> = {
  wave: "\u{1F44B}",
  eyes: "\u{1F440}",
  thinking_face: "\u{1F914}",
  thinking: "\u{1F914}",
  rocket: "\u{1F680}",
  fire: "\u{1F525}",
  tada: "\u{1F389}",
  party_popper: "\u{1F389}",
  white_check_mark: "\u2705",
  heavy_check_mark: "\u2714\uFE0F",
  check: "\u2705",
  x: "\u274C",
  warning: "\u26A0\uFE0F",
  rotating_light: "\u{1F6A8}",
  alert: "\u{1F6A8}",
  thumbsup: "\u{1F44D}",
  "+1": "\u{1F44D}",
  thumbsdown: "\u{1F44E}",
  "-1": "\u{1F44E}",
  heart: "\u2764\uFE0F",
  star: "\u2B50",
  sparkles: "\u2728",
  zap: "\u26A1",
  bug: "\u{1F41B}",
  wrench: "\u{1F527}",
  hammer: "\u{1F528}",
  gear: "\u2699\uFE0F",
  lock: "\u{1F512}",
  unlock: "\u{1F513}",
  key: "\u{1F511}",
  shield: "\u{1F6E1}\uFE0F",
  bulb: "\u{1F4A1}",
  memo: "\u{1F4DD}",
  clipboard: "\u{1F4CB}",
  bookmark: "\u{1F516}",
  link: "\u{1F517}",
  pushpin: "\u{1F4CC}",
  pin: "\u{1F4CC}",
  chart_with_upwards_trend: "\u{1F4C8}",
  chart_with_downwards_trend: "\u{1F4C9}",
  hourglass: "\u23F3",
  stopwatch: "\u23F1\uFE0F",
  clock: "\u{1F552}",
  speech_balloon: "\u{1F4AC}",
  thought_balloon: "\u{1F4AD}",
  point_right: "\u{1F449}",
  point_left: "\u{1F448}",
  point_up: "\u{1F446}",
  point_down: "\u{1F447}",
  raised_hands: "\u{1F64C}",
  clap: "\u{1F44F}",
  pray: "\u{1F64F}",
  muscle: "\u{1F4AA}",
  boom: "\u{1F4A5}",
  collision: "\u{1F4A5}",
  no_entry: "\u26D4",
  stop_sign: "\u{1F6D1}",
  question: "\u2753",
  exclamation: "\u2757",
  info: "\u2139\uFE0F",
  green_circle: "\u{1F7E2}",
  red_circle: "\u{1F534}",
  yellow_circle: "\u{1F7E1}",
  blue_circle: "\u{1F535}",
  large_green_circle: "\u{1F7E2}",
  large_red_circle: "\u{1F534}",
  smile: "\u{1F604}",
  grinning: "\u{1F600}",
  sob: "\u{1F62D}",
  sweat_smile: "\u{1F605}",
  sunglasses: "\u{1F60E}",
  skull: "\u{1F480}",
  shrug: "\u{1F937}",
  facepalm: "\u{1F926}",
  100: "\u{1F4AF}",
  infinity: "\u267E\uFE0F",
};

function replaceEmojiShortcodes(text: string): string {
  return text.replace(/:([a-z0-9_+-]+):/g, (match, code) => EMOJI_MAP[code] ?? match);
}

// Compose Slack mrkdwn normalization with the local (richer) emoji map, so
// titles like "ooh fun one. <https://…>" render as "ooh fun one. https://…".
function cleanText(text: string): string {
  return replaceEmojiShortcodes(normalizeSlackText(text));
}

interface WorkContextBarProps {
  sources: WorkContextSource[];
}

const SOURCE_ICONS: Record<string, string> = {
  linear_issue: "◆",
  linear: "◆",
  slack_thread: "◈",
  slack: "◈",
  incident: "▹",
  github_pr: "◇",
  github: "◇",
};

const SOURCE_SHORT: Record<string, string> = {
  linear_issue: "Linear",
  linear: "Linear",
  slack_thread: "Slack",
  slack: "Slack",
  incident: "Incidents",
  github_pr: "GitHub",
  github: "GitHub",
};

const INITIAL_SHOW = 5;

export function WorkContextBar({ sources }: WorkContextBarProps) {
  const [expanded, setExpanded] = useState(false);

  if (sources.length === 0) return null;

  const grouped = new Map<
    string,
    { count: number; icon: string; label: string; items: Array<{ id: string; title: string; url?: string }> }
  >();
  for (const s of sources) {
    const key = s.type;
    const existing = grouped.get(key);
    if (existing) {
      existing.count += s.count ?? 1;
      if (s.items) existing.items.push(...s.items);
    } else {
      grouped.set(key, {
        count: s.count ?? 1,
        icon: SOURCE_ICONS[key] || "○",
        label: SOURCE_SHORT[key] || key.replace(/_/g, " "),
        items: s.items ? [...s.items] : [],
      });
    }
  }

  const groups = Array.from(grouped.values());
  const hasItems = groups.some((g) => g.items.length > 0);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-mono text-[10px] text-text-faint uppercase tracking-wider">Sources</span>
        {groups.map((g, i) => (
          <span key={i} className="inline-flex items-center gap-1 font-mono text-xs text-text-dim">
            <span className="text-text-faint">{g.icon}</span>
            <span className="tabular-nums text-text-primary">{g.count}</span>
            {g.label}
          </span>
        ))}
        {hasItems && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="font-mono text-[10px] text-text-faint hover:text-text-dim transition-colors"
          >
            {expanded ? "hide" : "details"}
          </button>
        )}
      </div>

      {expanded && (
        <div className="mt-3 space-y-3">
          {groups
            .filter((g) => g.items.length > 0)
            .map((g, gi) => (
              <SourceGroup key={gi} icon={g.icon} label={g.label} items={g.items} />
            ))}
        </div>
      )}
    </div>
  );
}

function SourceGroup({
  icon,
  label,
  items,
}: {
  icon: string;
  label: string;
  items: Array<{ id: string; title: string; url?: string }>;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? items : items.slice(0, INITIAL_SHOW);
  const hasMore = items.length > INITIAL_SHOW;

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="text-text-faint text-xs">{icon}</span>
        <span className="font-mono text-[10px] text-text-dim uppercase tracking-wider">{label}</span>
        <span className="font-mono text-[10px] text-text-faint tabular-nums">({items.length})</span>
      </div>
      <div className="grid gap-1 min-w-0">
        {visible.map((item, i) => (
          <div
            key={i}
            className="flex items-center gap-2 rounded-md border border-border-subtle bg-surface px-2.5 py-1.5 min-w-0 overflow-hidden"
          >
            <span className="text-text-faint text-[10px] shrink-0">{icon}</span>
            {item.url ? (
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="font-ui text-xs text-link hover:text-link-hover no-underline hover:underline truncate min-w-0"
              >
                {cleanText(item.title)}
              </a>
            ) : (
              <span className="font-ui text-xs text-text-secondary truncate min-w-0">{cleanText(item.title)}</span>
            )}
          </div>
        ))}
      </div>
      {hasMore && (
        <button
          onClick={() => setShowAll(!showAll)}
          className="mt-1 font-mono text-[10px] text-text-faint hover:text-text-dim transition-colors"
        >
          {showAll ? "show less" : `show all ${items.length}`}
        </button>
      )}
    </div>
  );
}
