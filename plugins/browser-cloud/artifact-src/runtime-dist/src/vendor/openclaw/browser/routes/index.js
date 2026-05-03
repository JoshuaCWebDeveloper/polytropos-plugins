import { registerBrowserAgentRoutes } from "./agent.ts";
import { registerBrowserBasicRoutes } from "./basic.ts";
import { registerBrowserTabRoutes } from "./tabs.ts";
export function registerBrowserRoutes(app, ctx) {
    registerBrowserBasicRoutes(app, ctx);
    registerBrowserTabRoutes(app, ctx);
    registerBrowserAgentRoutes(app, ctx);
}
//# sourceMappingURL=index.js.map