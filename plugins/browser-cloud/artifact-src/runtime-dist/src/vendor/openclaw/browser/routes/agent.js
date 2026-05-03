import { registerBrowserAgentActRoutes } from "./agent.act.ts";
import { registerBrowserAgentDebugRoutes } from "./agent.debug.ts";
import { registerBrowserAgentSnapshotRoutes } from "./agent.snapshot.ts";
import { registerBrowserAgentStorageRoutes } from "./agent.storage.ts";
export function registerBrowserAgentRoutes(app, ctx) {
    registerBrowserAgentSnapshotRoutes(app, ctx);
    registerBrowserAgentActRoutes(app, ctx);
    registerBrowserAgentDebugRoutes(app, ctx);
    registerBrowserAgentStorageRoutes(app, ctx);
}
//# sourceMappingURL=agent.js.map