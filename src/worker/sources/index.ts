import { arxivProvider } from "./arxiv.js";
import { githubProvider } from "./github.js";
import { hnProvider } from "./hn.js";
import { incidentIoProvider } from "./incident-io.js";
import { linearProvider } from "./linear.js";
import { SourceRegistry } from "./registry.js";
import { rssProvider } from "./rss.js";
import { slackProvider } from "./slack.js";

export const sourceRegistry = new SourceRegistry();

sourceRegistry.register(linearProvider);
sourceRegistry.register(slackProvider);
sourceRegistry.register(githubProvider);
sourceRegistry.register(incidentIoProvider);
sourceRegistry.register(hnProvider);
sourceRegistry.register(rssProvider);
sourceRegistry.register(arxivProvider);

export { SourceRegistry } from "./registry.js";
export type {
  SettingsFieldType,
  SettingsManifest,
  SourceContext,
  SourceFetchContext,
  SourceFetchResult,
  SourceInstanceRow,
  SourceProvider,
  WorkContextItem,
} from "./types.js";
