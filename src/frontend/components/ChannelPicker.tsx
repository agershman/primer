import { useMemo, useState } from "react";
import type { SlackChannel } from "../hooks/useSettings";

interface ChannelPickerProps {
  channels: SlackChannel[];
  selected: string[];
  onChange: (channelIds: string[], channelNames: string[]) => void;
}

export function ChannelPicker({ channels, selected, onChange }: ChannelPickerProps) {
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    if (!filter.trim()) return channels;
    const q = filter.toLowerCase();
    return channels.filter((c) => c.name.toLowerCase().includes(q));
  }, [channels, filter]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const toggle = (channel: SlackChannel) => {
    const next = selectedSet.has(channel.id) ? selected.filter((id) => id !== channel.id) : [...selected, channel.id];
    const names = next.map((id) => channels.find((c) => c.id === id)?.name ?? id);
    onChange(next, names);
  };

  return (
    <div>
      <div className="relative mb-2">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-faint pointer-events-none"
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter channels…"
          className="w-full rounded-md border border-border bg-surface pl-8 pr-3 py-1.5 font-ui text-xs text-text-primary placeholder:text-text-faint outline-none transition-colors focus:border-accent"
        />
      </div>

      <div className="max-h-[300px] overflow-y-auto rounded-md border border-border-subtle">
        {filtered.length === 0 ? (
          <p className="px-3 py-4 text-center font-ui text-xs text-text-dim">No channels found</p>
        ) : (
          filtered.map((channel) => {
            const isSelected = selectedSet.has(channel.id);
            return (
              <label
                key={channel.id}
                className={`flex items-center gap-2.5 px-3 py-2 cursor-pointer transition-colors min-h-[44px] ${
                  isSelected ? "bg-accent-dim" : "hover:bg-surface-hover"
                }`}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggle(channel)}
                  className="h-4 w-4 rounded border-border accent-accent shrink-0"
                />
                <span className="flex-1 min-w-0 truncate font-ui text-xs text-text-primary">#{channel.name}</span>
                <span className="font-ui text-[10px] text-text-faint tabular-nums shrink-0">{channel.memberCount}</span>
              </label>
            );
          })
        )}
      </div>
    </div>
  );
}
