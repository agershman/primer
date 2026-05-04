import { useState } from "react";
import { ChannelPicker } from "../../ChannelPicker";
import { useSettingsCtx } from "../SettingsContext";
import { Card, Field, PanelHeader, SelectedSummary, ToggleRow } from "../shared";
import { InScopePreview, ScopeRow } from "./InScopePreview";

const HISTORY_OPTIONS = [
  { value: 3, label: "Last 3 days" },
  { value: 7, label: "Last 7 days" },
  { value: 14, label: "Last 14 days" },
  { value: 30, label: "Last 30 days" },
];

/**
 * Renders the bookmark reaction as the visual emoji followed by the
 * literal `:bookmark:` shortcode in parens, with the shortcode styled
 * as inline code. Pairs "what it looks like in Slack" with "what you
 * actually type" so a user reading the panel knows exactly which
 * reaction to use. Inline-code styling mirrors `RichText.tsx`.
 */
function BookmarkReactionTag() {
  return (
    <>
      <span aria-hidden>🔖</span>
      {" ("}
      <span className="font-mono text-text-primary bg-bg-warm border border-border-subtle rounded px-1 py-px text-[0.92em] whitespace-nowrap">
        :bookmark:
      </span>
      {")"}
    </>
  );
}

export function SlackPanel() {
  const { settings } = useSettingsCtx();
  const { settings: data, updateSettings, slackChannels, previewState } = settings;
  // Hooks live above the early return (rules of hooks: hook order
  // must be identical on every render).
  const [editingChannels, setEditingChannels] = useState(false);
  if (!data) return null;

  const slackDefaults = {
    channels: [] as string[],
    channelNames: [] as string[],
    historyDays: 7,
    includeBookmarked: false,
  };
  const slack = { ...slackDefaults, ...(data.signalSurfaceMap?.slack ?? {}) };
  const updateSlack = (partial: Partial<typeof slack>) => {
    updateSettings({
      signalSurfaceMap: { ...data.signalSurfaceMap, slack: { ...slack, ...partial } },
    });
  };

  const channelCount = previewState.slack.data?.channelCount ?? 0;
  const countLabel = `${channelCount} channel${channelCount === 1 ? "" : "s"}`;

  return (
    <div>
      <PanelHeader title="Slack" description="Channels Primer reads for work context." />

      <Field label="Channels" hint="Which Slack channels to read messages from.">
        {editingChannels ? (
          <div>
            <ChannelPicker
              channels={slackChannels}
              selected={slack.channels}
              onChange={(ids, names) => updateSlack({ channels: ids, channelNames: names })}
            />
            <div className="flex justify-end mt-2">
              <button
                type="button"
                onClick={() => setEditingChannels(false)}
                className="px-2.5 py-1 rounded-md border border-border text-xs font-mono text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <SelectedSummary
            items={[...slack.channelNames].sort().map((n) => `#${n}`)}
            onEdit={() => setEditingChannels(true)}
            emptyLabel="No channels selected"
          />
        )}
      </Field>

      <Field label="History window" hint="How far back to look in channel history.">
        <Card>
          <select
            value={slack.historyDays}
            onChange={(e) => updateSlack({ historyDays: Number(e.target.value) })}
            className="w-full bg-surface border border-border rounded-md px-3 py-1.5 text-xs font-mono text-text-primary outline-none focus:border-accent transition-colors"
          >
            {HISTORY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </Card>
      </Field>

      <Field
        label="Bookmarked messages"
        hint={
          // Match Slack's actual UX language: in Slack, bookmarking
          // is the colloquial verb for the :bookmark: reaction. Show
          // the rendered emoji alongside the literal shortcode so the
          // user sees both what it looks like and what to type.
          <>
            Pull in any message in your monitored channels reacted with <BookmarkReactionTag /> — even if it would
            otherwise be filtered as too short or too quiet. Bookmarked messages bypass the noise / brevity filters and
            sort to the top of the work-context bar.
          </>
        }
      >
        <Card>
          <ToggleRow
            label={
              <>
                Include <BookmarkReactionTag /> reactions
              </>
            }
            checked={!!slack.includeBookmarked}
            onChange={(v) => updateSlack({ includeBookmarked: v })}
            last
          />
        </Card>
      </Field>

      <InScopePreview
        source={previewState.slack}
        count={countLabel}
        renderList={(d) => (
          <>
            {d.channels.map((ch) => (
              <ScopeRow
                key={ch.id}
                ref={`#${ch.name}`}
                title={<span className="text-text-secondary">Channel</span>}
                meta={<span>id: {ch.id}</span>}
              />
            ))}
          </>
        )}
      />
    </div>
  );
}
