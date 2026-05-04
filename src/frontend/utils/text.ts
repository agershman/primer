// Frontend text-normalization helpers. Mirrors src/worker/integrations/slack.ts's
// `normalizeSlackText` and the emoji shortcode replacement that used to live
// inline in WorkContextBar. We apply both at render time as a defensive
// fallback so already-stored briefings (generated before the worker-side fix)
// render cleanly without requiring regeneration.

const EMOJI_MAP: Record<string, string> = {
  smile: "😄",
  grinning: "😀",
  joy: "😂",
  heart: "❤️",
  thumbsup: "👍",
  "+1": "👍",
  thumbsdown: "👎",
  "-1": "👎",
  fire: "🔥",
  "100": "💯",
  rocket: "🚀",
  tada: "🎉",
  warning: "⚠️",
  x: "❌",
  white_check_mark: "✅",
  heavy_check_mark: "✔️",
  eyes: "👀",
  thinking: "🤔",
  thinking_face: "🤔",
  raised_hands: "🙌",
  clap: "👏",
  pray: "🙏",
  point_right: "👉",
  point_left: "👈",
  point_up: "☝️",
  point_down: "👇",
  wave: "👋",
  ok_hand: "👌",
  muscle: "💪",
  facepalm: "🤦",
  shrug: "🤷",
  bug: "🐛",
  lock: "🔒",
  unlock: "🔓",
  key: "🔑",
  gear: "⚙️",
  zap: "⚡",
  bulb: "💡",
  chart_with_upwards_trend: "📈",
  chart_with_downwards_trend: "📉",
  computer: "💻",
  phone: "📱",
  email: "📧",
  calendar: "📅",
  clock: "🕐",
  hourglass: "⏳",
  alarm_clock: "⏰",
  question: "❓",
  exclamation: "❗",
  bangbang: "‼️",
  sparkles: "✨",
  star: "⭐",
  sun: "☀️",
  moon: "🌙",
  coffee: "☕",
  beer: "🍺",
  pizza: "🍕",
  taco: "🌮",
  cake: "🍰",
  cookie: "🍪",
  // Custom Slack emojis (no Unicode equivalent — leave shortcode visible)
};

/**
 * Replace `:emoji:` shortcodes with their Unicode equivalents where known.
 * Unknown shortcodes are left as-is so users still see what was intended.
 */
export function replaceEmojiShortcodes(text: string): string {
  if (!text) return text;
  return text.replace(/:([a-z0-9_+-]+):/g, (match, code) => EMOJI_MAP[code] ?? match);
}

/**
 * Strip Slack mrkdwn from text: angle-bracketed URLs, channel/user mentions,
 * HTML entities. Mirrors `normalizeSlackText` in the worker integration; lives
 * here so we can clean up titles at render time for briefings that were
 * generated before the worker-side normalization was added.
 */
export function normalizeSlackText(text: string): string {
  if (!text) return text;
  let out = text;
  // <https://example.com|Display Text> → Display Text
  out = out.replace(/<((?:https?:\/\/|mailto:)[^|>]+)\|([^>]+)>/g, "$2");
  // <https://example.com> → https://example.com
  out = out.replace(/<((?:https?:\/\/|mailto:)[^>]+)>/g, "$1");
  // <#C12345|name> → #name
  out = out.replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1");
  // <#C12345> → #channel
  out = out.replace(/<#[A-Z0-9]+>/g, "#channel");
  // <@U12345|name> → @name
  out = out.replace(/<@[A-Z0-9]+\|([^>]+)>/g, "@$1");
  // <@U12345> → @user
  out = out.replace(/<@[A-Z0-9]+>/g, "@user");
  // <!subteam^S12345|name> → @name
  out = out.replace(/<!subteam\^[A-Z0-9]+\|([^>]+)>/g, "@$1");
  // <!channel>, <!here>, <!everyone>
  out = out.replace(/<!(channel|here|everyone)>/g, "@$1");
  // HTML entities
  out = out.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  return out;
}

/** Apply both Slack mrkdwn normalization and emoji shortcode replacement. */
export function cleanSlackText(text: string): string {
  return replaceEmojiShortcodes(normalizeSlackText(text));
}
