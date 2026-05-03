import type { BrowserRouteContext } from "../server-context.ts";
import { registerBrowserAgentActRoutes } from "./agent.act.ts";
import { registerBrowserAgentDebugRoutes } from "./agent.debug.ts";
import { registerBrowserAgentSnapshotRoutes } from "./agent.snapshot.ts";
import { registerBrowserAgentStorageRoutes } from "./agent.storage.ts";
import type { BrowserRouteRegistrar } from "./types.ts";

export function registerBrowserAgentRoutes(app: BrowserRouteRegistrar, ctx: BrowserRouteContext) {
  registerBrowserAgentSnapshotRoutes(app, ctx);
  registerBrowserAgentActRoutes(app, ctx);
  registerBrowserAgentDebugRoutes(app, ctx);
  registerBrowserAgentStorageRoutes(app, ctx);
}
