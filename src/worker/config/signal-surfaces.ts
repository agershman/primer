export const DEFAULT_SIGNAL_SURFACE_MAP = {
  channelMappings: {
    infrastructure: ["#eng-infra", "#ire", "#errors-nonprod", "#errors-prod"],
    incidents: ["#inc-*", "#incident-announcements"],
    platform: ["#eng-platform", "#mothership"],
    product: ["#general-product", "#general-data"],
    security: ["#security"],
    customer: ["#am-*"],
    sales: ["#opp-*"],
  },
  teamMappings: {
    "INFRA-*": {
      channels: ["#ire", "#eng-infra"],
      people: ["Kyle", "James"],
    },
    "PLAT-*": { channels: ["#eng-platform"], people: [] },
    "MSHP-*": { channels: ["#mothership"], people: ["James"] },
    "SRE-*": {
      channels: ["#eng-infra", "#errors-nonprod", "#errors-prod"],
      people: [],
    },
    "SEC-*": { channels: ["#security"], people: [] },
  },
  externalSources: {
    hn: {
      url: "https://hacker-news.firebaseio.com/v0/beststories.json",
      limit: 30,
    },
    cncf: { url: "https://www.cncf.io/blog/feed/", limit: 20 },
    arxiv: {
      url: "http://export.arxiv.org/api/query",
      categories: ["cs.DC", "cs.SE"],
      limit: 20,
    },
    aws: {
      url: "https://aws.amazon.com/about-aws/whats-new/recent/feed/",
      limit: 20,
    },
    gcp: {
      url: "https://cloud.google.com/feeds/gcp-release-notes.xml",
      limit: 20,
    },
  },
};
