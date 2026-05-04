import type { ComponentType } from "react";
import { apiGet } from "../utils/api";
import type { SourceDescriptor } from "./types.js";

const customPanels: Record<string, ComponentType> = {};

export function registerCustomPanel(sourceId: string, component: ComponentType): void {
  customPanels[sourceId] = component;
}

export function getCustomPanel(sourceId: string): ComponentType | undefined {
  return customPanels[sourceId];
}

export function hasCustomPanel(sourceId: string): boolean {
  return sourceId in customPanels;
}

let cachedSources: SourceDescriptor[] | null = null;

export async function fetchSourceDescriptors(): Promise<SourceDescriptor[]> {
  if (cachedSources) return cachedSources;
  // Routed through `apiGet` so the call carries the standard
  // `X-Client-Timezone` header (the worker's user-context
  // middleware reads it for "today" resolution). Pre-fix this used
  // raw `fetch("/api/sources")` and silently lost the header on
  // every cold cache hit.
  try {
    const data = await apiGet<{ sources: SourceDescriptor[] }>("/api/sources");
    cachedSources = data.sources;
    return cachedSources;
  } catch {
    return [];
  }
}

export function invalidateSourceCache(): void {
  cachedSources = null;
}
