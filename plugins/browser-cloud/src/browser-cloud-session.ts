import { buCreateBrowserSession, buGetBrowserSession, buStopBrowserSession, type BuSession } from "./bu-api.ts";
import { closePlaywrightBrowserConnection } from "./vendor/openclaw/browser/pw-session.ts";

export type BrowserCloudSessionStatus = {
  // NOTE: this is "local knowledge" from our last create/stop calls, not an authoritative BU API check.
  // Use diagnose() to probe BU + CDP endpoints.

  running: boolean;
  sessionId: string | null;
  /** The BU API base CDP URL (typically https://<id>.cdp0.browser-use.com). */
  cdpBaseUrl: string | null;
  /** The websocket endpoint Playwright should connect to (resolved from base URL). */
  cdpWsUrl: string | null;
  liveUrl: string | null;
  startedAt: string | null;
  lastUsedAt: string | null;
};

export class BrowserUseCloudSessionManager {
  private apiKey: string;
  private profileId: string;
  private timeoutMin: number;
  private idleStopMs: number;

  public session: BuSession | null = null;
  // We intentionally do NOT cache the websocket debugger URL, because BU may rotate it.
  private lastResolvedWsUrl: string | null = null;
  private startedAtMs: number | null = null;
  private lastUsedAtMs: number | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private inFlight: number = 0;
  private creating: Promise<BuSession> | null = null;
  private stopping: Promise<boolean> | null = null;

  constructor(opts: {
    apiKey: string;
    profileId: string;
    timeoutMin: number;
    idleStopMs: number;
  }) {
    this.apiKey = opts.apiKey;
    this.profileId = opts.profileId;
    this.timeoutMin = opts.timeoutMin;
    this.idleStopMs = Math.max(1000, Math.floor(opts.idleStopMs));
  }

  status(): BrowserCloudSessionStatus {
    return {
      running: Boolean(this.session?.id && this.session?.cdpUrl),
      sessionId: this.session?.id ?? null,
      cdpBaseUrl: this.session?.cdpUrl ?? null,
      cdpWsUrl: this.lastResolvedWsUrl,
      liveUrl: this.session?.liveUrl ?? null,
      startedAt: this.startedAtMs ? new Date(this.startedAtMs).toISOString() : null,
      lastUsedAt: this.lastUsedAtMs ? new Date(this.lastUsedAtMs).toISOString() : null,
    };
  }

  /**
   * Probe BU + CDP endpoints to understand whether the session is actually alive.
   * This does NOT create a session.
   */
  async diagnose(): Promise<{
    ok: true;
    sessionId: string | null;
    bu?: { ok: true; session: BuSession } | { ok: false; error: string };
    cdp?:
      | {
          ok: true;
          httpStatus: number;
          contentType: string | null;
          hasWebSocketDebuggerUrl: boolean;
          webSocketDebuggerUrl: string | null;
        }
      | { ok: false; error: string };
  }> {
    const sessionId = this.session?.id ?? null;
    const cdpBaseUrl = String(this.session?.cdpUrl ?? "").trim() || null;

    const out: {
      ok: true;
      sessionId: string | null;
      bu?: { ok: true; session: BuSession } | { ok: false; error: string };
      cdp?:
        | {
            ok: true;
            httpStatus: number;
            contentType: string | null;
            hasWebSocketDebuggerUrl: boolean;
            webSocketDebuggerUrl: string | null;
          }
        | { ok: false; error: string };
    } = { ok: true, sessionId };

    if (sessionId) {
      try {
        const session = await buGetBrowserSession({ apiKey: this.apiKey, sessionId });
        out.bu = { ok: true, session };
      } catch (e) {
        out.bu = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }

    if (cdpBaseUrl) {
      try {
        const res = await fetch(cdpBaseUrl, { method: "GET" });
        const contentType = res.headers.get("content-type");
        let ws: string | null = null;
        let hasWs = false;
        if (res.ok) {
          const json = (await res.json().catch(() => null)) as any;
          const s = String(json?.webSocketDebuggerUrl ?? "").trim();
          if (s) {
            ws = s;
            hasWs = true;
            this.lastResolvedWsUrl = s;
          }
        }
        out.cdp = {
          ok: true,
          httpStatus: res.status,
          contentType,
          hasWebSocketDebuggerUrl: hasWs,
          webSocketDebuggerUrl: ws,
        };
      } catch (e) {
        out.cdp = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }

    return out;
  }

  touch(): void {
    this.lastUsedAtMs = Date.now();
    this.resetIdleTimer();
  }

  beginAction(action: string): void {
    this.inFlight += 1;
    this.touch();
    // eslint-disable-next-line no-console
    console.error("[browser-cloud] beginAction", {
      action,
      inFlight: this.inFlight,
      sessionId: this.session?.id ?? null,
    });
  }

  endAction(action: string): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.touch();
    // eslint-disable-next-line no-console
    console.error("[browser-cloud] endAction", {
      action,
      inFlight: this.inFlight,
      sessionId: this.session?.id ?? null,
    });
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    // While a tool action is in-flight, do not allow idle timeout to stop the session.
    // Reschedule instead.
    this.idleTimer = setTimeout(() => {
      if (this.inFlight > 0) {
        // eslint-disable-next-line no-console
        console.error("[browser-cloud] idle-timeout skipped (in-flight)", {
          inFlight: this.inFlight,
          sessionId: this.session?.id ?? null,
        });
        this.resetIdleTimer();
        return;
      }
      void this.stop({ reason: "idle-timeout" }).catch(() => {});
    }, this.idleStopMs);

    // Don't keep the Node process alive just for the idle timer.
    this.idleTimer.unref?.();
  }

  async ensure(): Promise<{ session: BuSession; cdpUrl: string }> {
    if (this.session?.id && this.session?.cdpUrl) {
      // eslint-disable-next-line no-console
      console.error("[browser-cloud] ensure(): reuse", { sessionId: this.session.id, cdpUrl: this.session.cdpUrl });
      this.touch();
      return { session: this.session, cdpUrl: this.session.cdpUrl };
    }
    if (this.creating) {
      const created = await this.creating;
      this.touch();
      const baseUrl = String(created?.cdpUrl ?? "").trim();
      if (!baseUrl) {
        throw new Error("Browser Use Cloud session created but cdpUrl missing");
      }
      return { session: created, cdpUrl: baseUrl };
    }

    // eslint-disable-next-line no-console
    console.error("[browser-cloud] ensure(): create", { profileId: this.profileId, timeoutMin: this.timeoutMin });
    this.creating = (async () => {
      const created = await buCreateBrowserSession({
        apiKey: this.apiKey,
        profileId: this.profileId,
        timeoutMin: this.timeoutMin,
      });
      const baseUrl = String(created?.cdpUrl ?? "").trim();
      const id = String(created?.id ?? "").trim();
      if (!id || !baseUrl) {
        throw new Error("Browser Use Cloud session create returned missing id/cdpUrl");
      }

      this.session = created;
      this.startedAtMs = Date.now();
      this.lastUsedAtMs = Date.now();
      this.resetIdleTimer();
      return created;
    })().finally(() => {
      this.creating = null;
    });

    const created = await this.creating;
    const baseUrl = String(created?.cdpUrl ?? "").trim();
    if (!baseUrl) {
      throw new Error("Browser Use Cloud session created but cdpUrl missing");
    }
    return { session: created, cdpUrl: baseUrl };
  }

  async stop(opts?: { reason?: string }): Promise<boolean> {
    if (this.stopping) {
      return await this.stopping;
    }
    if (!this.session?.id) {
      return false;
    }

    // eslint-disable-next-line no-console
    console.error("[browser-cloud] stop() called", {
      reason: opts?.reason ?? "unknown",
      sessionId: this.session.id,
      cdpUrl: this.session?.cdpUrl ?? null,
      at: new Date().toISOString(),
      stack: new Error().stack,
    });

    const sessionId = this.session.id;

    this.stopping = (async () => {
      if (this.idleTimer) {
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
      }
      // Close any cached Playwright CDP connection first (best-effort).
      await closePlaywrightBrowserConnection().catch(() => {});
      await buStopBrowserSession({ apiKey: this.apiKey, sessionId }).catch((err) => {
        // If stop fails, preserve session for troubleshooting, but still clear PW connection.
        throw new Error(
          `Browser Use Cloud stop failed (reason=${opts?.reason ?? "unknown"}): ${String(err)}`,
        );
      });
      this.session = null;
      this.lastResolvedWsUrl = null;
      this.startedAtMs = null;
      this.lastUsedAtMs = null;
      return true;
    })().finally(() => {
      this.stopping = null;
    });

    return await this.stopping;
  }
}

