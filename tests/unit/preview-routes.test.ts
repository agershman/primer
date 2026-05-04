import { describe, it, expect, vi, beforeEach } from "vitest";
import { previewRoutes } from "../../src/worker/routes/preview";

vi.mock("../../src/worker/integrations/linear", () => ({
  createLinearClient: vi.fn(() => ({})),
  fetchAssignedIssues: vi.fn(async () => [
    {
      id: "i1",
      identifier: "PLAT-1",
      title: "Assigned issue",
      url: "https://linear.app/x/PLAT-1",
    },
  ]),
  fetchSubscribedIssues: vi.fn(async () => [
    {
      id: "i2",
      identifier: "PLAT-2",
      title: "Subscribed issue",
      url: "https://linear.app/x/PLAT-2",
    },
  ]),
}));

vi.mock("../../src/worker/integrations/incident-io", () => ({
  IncidentIoClient: class {
    constructor(_apiKey?: string) {}
    async getActiveIncidents() {
      return [{ id: "inc1" }, { id: "inc2" }];
    }
  },
}));

const MOCK_ENV = {
  LINEAR_API_KEY: "lin_xxx",
  INCIDENT_IO_API_KEY: "inc_xxx",
  SLACK_TOKEN: "xoxp-xxx",
  ANTHROPIC_API_KEY: "sk-xxx",
} as unknown as Record<string, string>;

async function call(path: string, init?: RequestInit) {
  const req = new Request(`https://example.com${path}`, init);
  return previewRoutes.fetch(req, MOCK_ENV);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("preview routes", () => {
  describe("POST /settings/preview/linear", () => {
    it("returns Linear issues with reason labels", async () => {
      const res = await call("/settings/preview/linear", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          linear: {
            includeAssigned: true,
            includeSubscribed: true,
            stateTypes: ["started"],
          },
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        total: number;
        issues: Array<{ identifier: string; reason: string }>;
        elapsedMs: number;
      };
      expect(body.total).toBe(2);
      expect(body.issues.map((i) => i.identifier).sort()).toEqual(["PLAT-1", "PLAT-2"]);
      expect(body.issues.find((i) => i.identifier === "PLAT-1")?.reason).toBe("assigned");
      expect(body.issues.find((i) => i.identifier === "PLAT-2")?.reason).toBe("subscribed");
      expect(typeof body.elapsedMs).toBe("number");
    });

    it("skips subscribed issues when flag is false", async () => {
      const res = await call("/settings/preview/linear", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          linear: { includeAssigned: true, includeSubscribed: false },
        }),
      });
      const body = (await res.json()) as { total: number };
      expect(body.total).toBe(1);
    });

    it("returns empty when no Linear API key", async () => {
      const req = new Request("https://example.com/settings/preview/linear", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ linear: {} }),
      });
      const res = await previewRoutes.fetch(req, {
        ...MOCK_ENV,
        LINEAR_API_KEY: undefined,
      } as unknown as Record<string, string>);
      const body = (await res.json()) as { total: number; issues: unknown[] };
      expect(body.total).toBe(0);
      expect(body.issues).toEqual([]);
    });
  });

  describe("POST /settings/preview/slack", () => {
    it("echoes configured channels without hitting Slack API", async () => {
      const res = await call("/settings/preview/slack", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slack: {
            channels: ["C123", "C456"],
            channelNames: ["eng-platform", "eng-security"],
            historyDays: 14,
          },
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        channelCount: number;
        historyDays: number;
        channels: Array<{ id: string; name: string }>;
      };
      expect(body.channelCount).toBe(2);
      expect(body.historyDays).toBe(14);
      expect(body.channels).toEqual([
        { id: "C123", name: "eng-platform" },
        { id: "C456", name: "eng-security" },
      ]);
    });

    it("defaults historyDays to 7 and handles missing slack block", async () => {
      const res = await call("/settings/preview/slack", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = (await res.json()) as { channelCount: number; historyDays: number };
      expect(body.channelCount).toBe(0);
      expect(body.historyDays).toBe(7);
    });
  });

  describe("GET /settings/preview/incidents", () => {
    it("returns active incident count", async () => {
      const res = await call("/settings/preview/incidents");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { total: number };
      expect(body.total).toBe(2);
    });

    it("returns 0 when no API key configured", async () => {
      const req = new Request("https://example.com/settings/preview/incidents");
      const res = await previewRoutes.fetch(req, {
        ...MOCK_ENV,
        INCIDENT_IO_API_KEY: undefined,
      } as unknown as Record<string, string>);
      const body = (await res.json()) as { total: number };
      expect(body.total).toBe(0);
    });
  });
});
