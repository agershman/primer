import { IncidentIoClient } from "../integrations/incident-io.js";
import type { Env } from "../types.js";
import type { SourceFetchContext, SourceFetchResult, SourceProvider, WorkContextItem } from "./types.js";

export const incidentIoProvider: SourceProvider = {
  id: "incident_io",
  name: "incident.io",
  requiredEnv: ["INCIDENT_IO_API_KEY"],
  multiInstance: false,

  isAvailable(env: Env) {
    return !!env.INCIDENT_IO_API_KEY;
  },

  isConfigured() {
    return true;
  },

  async fetch(ctx: SourceFetchContext): Promise<SourceFetchResult> {
    const client = new IncidentIoClient(ctx.env.INCIDENT_IO_API_KEY);
    const incidents = await client.getRecentIncidents(7);

    const items: WorkContextItem[] = incidents.map((inc) => ({
      type: "incident",
      id: inc.id,
      title: inc.name,
      url: inc.permalink,
      description: `Status: ${inc.status}, Severity: ${inc.severity?.name ?? "unknown"}`,
    }));

    const details: string[] = [];
    if (incidents.length > 0) {
      details.push(`▹ ${incidents.length} recent incidents`);
    }

    return { items, details };
  },

  settingsManifest: {
    nav: {
      label: "incident.io",
      icon: "siren",
      group: "Sources",
      keywords: ["incidents", "alerts", "outages"],
    },
    preview: {
      endpoint: "/api/settings/preview/incidents",
      method: "GET",
    },
  },
};
