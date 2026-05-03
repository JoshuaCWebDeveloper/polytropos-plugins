import { loadConfig } from "../config/config.ts";
import { createSubsystemLogger } from "../logging/subsystem.ts";
import { resolveBrowserConfig } from "./config.ts";
import { ensureBrowserControlAuth } from "./control-auth.ts";
import { type BrowserServerState, createBrowserRouteContext } from "./server-context.ts";
import { ensureExtensionRelayForProfiles, stopKnownBrowserProfiles } from "./server-lifecycle.ts";

let state: BrowserServerState | null = null;
const log = createSubsystemLogger("browser");
const logService = log.child("service");

export function getBrowserControlState(): BrowserServerState | null {
  return state;
}

export function createBrowserControlContext() {
  return createBrowserRouteContext({
    getState: () => state,
    refreshConfigFromDisk: true,
    onEnsureAttachTarget: async (profile) => {
      // Lazy-create ephemeral attach targets (e.g. Browser Use Cloud sessions)
      const current = state;
      if (!current) {
        throw new Error("Browser control service not started");
      }

      const cfg = loadConfig();
      const bu = cfg.gateway?.browserUseCloud;
      if (!bu) {
        return;
      }
      if (profile.driver !== "clawd") {
        return;
      }
      if (!profile.attachOnly) {
        return;
      }

      const profileId = bu.profiles?.[profile.name];
      if (!profileId) {
        return;
      }

      // Only provision when cdpUrl is blank or a known placeholder.
      const raw = String(profile.cdpUrl ?? "").trim();
      const isPlaceholder =
        raw === "" ||
        raw === "browser-use" ||
        raw === "browser-use-cloud" ||
        raw === "browser-use:cloud";
      if (!isPlaceholder) {
        return;
      }

      const runtime = current.profiles.get(profile.name);
      if (runtime?.attachTarget?.kind === "browserUseCloud" && runtime.attachTarget.cdpUrl) {
        // Already provisioned.
        return;
      }

      const { createBrowserUseCloudSession } = await import("./browser-use-cloud.js");

      const timeoutMin = Math.max(1, Math.min(240, Math.round(bu.defaultTimeoutMin ?? 15)));
      const session = await createBrowserUseCloudSession({ cfg: bu, profileId, timeoutMin });
      const sessionId = String(session.id ?? "").trim();
      const cdpUrl = String(session.cdpUrl ?? "").trim();
      if (!sessionId || !cdpUrl) {
        throw new Error("Browser Use Cloud session response missing id/cdpUrl");
      }

      // Browser Use Cloud returns ws://... CDP urls; Playwright can connect directly.
      // For remote profiles, tab ops already use Playwright-based flows.
      profile.cdpUrl = cdpUrl;
      try {
        const u = new URL(cdpUrl);
        profile.cdpHost = u.hostname;
        profile.cdpPort = u.port ? Number(u.port) : u.protocol === "wss:" ? 443 : 80;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (profile as any).cdpIsLoopback = false;
      } catch {
        // best effort; keep cdpUrl
      }

      const existing = runtime ?? {
        profile,
        running: null,
        lastTargetId: null,
        attachTarget: null,
      };
      existing.profile = profile;
      existing.attachTarget = {
        kind: "browserUseCloud",
        sessionId,
        cdpUrl,
        liveUrl: session.liveUrl ?? null,
        startedAt: Date.now(),
      };
      current.profiles.set(profile.name, existing);
    },
    onStopAttachTarget: async (profile) => {
      const current = state;
      if (!current) {
        return { stopped: false };
      }

      const runtime = current.profiles.get(profile.name);
      const attach = runtime?.attachTarget;
      if (!attach || attach.kind !== "browserUseCloud") {
        return { stopped: false };
      }

      const cfg = loadConfig();
      const bu = cfg.gateway?.browserUseCloud;
      if (!bu) {
        return { stopped: false };
      }

      // Best-effort: disconnect Playwright first so no background calls keep the session alive.
      try {
        const pw = await import("./pw-ai.js");
        await pw.closePlaywrightBrowserConnection();
      } catch {
        // ignore
      }

      const { stopBrowserUseCloudSession } = await import("./browser-use-cloud.js");
      await stopBrowserUseCloudSession({ cfg: bu, sessionId: attach.sessionId });

      runtime.attachTarget = null;
      return { stopped: true };
    },
  });
}

export async function startBrowserControlServiceFromConfig(): Promise<BrowserServerState | null> {
  if (state) {
    return state;
  }

  const cfg = loadConfig();
  const resolved = resolveBrowserConfig(cfg.browser, cfg);
  if (!resolved.enabled) {
    return null;
  }
  try {
    const ensured = await ensureBrowserControlAuth({ cfg });
    if (ensured.generatedToken) {
      logService.info("No browser auth configured; generated gateway.auth.token automatically.");
    }
  } catch (err) {
    logService.warn(`failed to auto-configure browser auth: ${String(err)}`);
  }

  state = {
    server: null,
    port: resolved.controlPort,
    resolved,
    profiles: new Map(),
  };

  await ensureExtensionRelayForProfiles({
    resolved,
    onWarn: (message) => logService.warn(message),
  });

  logService.info(
    `Browser control service ready (profiles=${Object.keys(resolved.profiles).length})`,
  );
  return state;
}

export async function stopBrowserControlService(): Promise<void> {
  const current = state;
  if (!current) {
    return;
  }

  await stopKnownBrowserProfiles({
    getState: () => state,
    onWarn: (message) => logService.warn(message),
  });

  state = null;

  // Optional: Playwright is not always available (e.g. embedded gateway builds).
  try {
    const mod = await import("./pw-ai.js");
    await mod.closePlaywrightBrowserConnection();
  } catch {
    // ignore
  }
}
