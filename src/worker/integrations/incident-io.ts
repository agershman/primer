import { isRetryableStatus, parseRetryAfter, RETRY_CONFIG, retryDelay } from "../config/constants.js";

export interface Incident {
  id: string;
  name: string;
  status: string;
  severity: { name: string } | null;
  created_at: string;
  updated_at: string;
  permalink: string;
}

export class IncidentIoClient {
  private baseUrl = "https://api.incident.io/v2";

  constructor(private apiKey: string) {}

  private async apiCall<T>(path: string): Promise<T> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < RETRY_CONFIG.MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(`${this.baseUrl}${path}`, {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
        });
        if (!res.ok) {
          if (attempt < RETRY_CONFIG.MAX_ATTEMPTS - 1 && isRetryableStatus(res.status)) {
            await new Promise((r) => setTimeout(r, retryDelay(attempt, parseRetryAfter(res))));
            continue;
          }
          throw new Error(`incident.io API ${res.status}: ${await res.text()}`);
        }
        return (await res.json()) as T;
      } catch (err) {
        lastError = err as Error;
        if (attempt < RETRY_CONFIG.MAX_ATTEMPTS - 1) {
          await new Promise((r) => setTimeout(r, retryDelay(attempt)));
        }
      }
    }
    throw lastError;
  }

  async getActiveIncidents(): Promise<Incident[]> {
    const result = await this.apiCall<{ incidents: Incident[] }>("/incidents?status[one_of]=active,investigating");
    return result.incidents;
  }

  async getRecentIncidents(days = 7): Promise<Incident[]> {
    const since = new Date(Date.now() - days * 86400000).toISOString().split("T")[0];
    const result = await this.apiCall<{ incidents: Incident[] }>(`/incidents?created_at[gte]=${since}`);
    return result.incidents;
  }
}
