import type { BrowserRouteContext } from "../server-context.ts";
import { registerBrowserAgentRoutes } from "./agent.ts";
import { registerBrowserBasicRoutes } from "./basic.ts";
import { registerBrowserTabRoutes } from "./tabs.ts";
import type { BrowserRouteRegistrar } from "./types.ts";

export function registerBrowserRoutes(app: BrowserRouteRegistrar, ctx: BrowserRouteContext) {
  registerBrowserBasicRoutes(app, ctx);
  registerBrowserTabRoutes(app, ctx);
  registerBrowserAgentRoutes(app, ctx);
}
