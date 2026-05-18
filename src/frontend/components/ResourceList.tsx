import type { Resource } from "../types";

const TYPE_ICONS: Record<string, string> = {
  linear: "◆",
  docs: "◎",
  article: "▸",
  slack: "◈",
  incident: "▹",
  pr: "⊕",
  notion: "◎",
  google_doc: "◎",
  web: "◐",
  other: "○",
};

interface ResourceListProps {
  resources: Resource[];
}

export function ResourceList({ resources }: ResourceListProps) {
  if (resources.length === 0) return null;

  return (
    <div className="flex gap-2 overflow-x-auto flex-nowrap md:flex-wrap pb-1 -mb-1">
      {resources.map((resource, i) => (
        <a
          key={i}
          href={resource.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 shrink-0 rounded-md border border-border-subtle bg-surface px-2.5 py-1.5 font-ui text-xs text-text-secondary hover:border-accent hover:text-text-primary transition-colors min-h-[44px] md:min-h-0"
        >
          <span className="text-text-dim">{TYPE_ICONS[resource.type] || TYPE_ICONS.other}</span>
          <span className="truncate max-w-[200px]">{resource.label}</span>
        </a>
      ))}
    </div>
  );
}
