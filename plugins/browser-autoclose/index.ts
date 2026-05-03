type PluginApi = {
  id: string;
  config: any;
  pluginConfig: any;
  logger: { info?: (msg: string) => void; warn?: (msg: string) => void; error?: (msg: string) => void; debug?: (msg: string) => void };
  on: (hookName: string, handler: (event: any, ctx: any) => any, opts?: { priority?: number }) => void;
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function isGatewayRuntime(): boolean {
  return (
    process.env.OPENCLAW_SERVICE_KIND === "gateway" ||
    process.env.OPENCLAW_SYSTEMD_UNIT === "openclaw-gateway.service" ||
    !!process.env.OPENCLAW_SERVICE_MARKER
  );
}

export default function register(api: PluginApi) {
  if (!isGatewayRuntime()) return;
  const state = {
    lastActivityAt: 0,
    timer: null as any,
    inFlight: false,
    guardTimer: null as any,
    guardInFlight: false,
    browserDownUntil: 0,
    lastBrowserTimeoutAt: 0,
    staleTarget: false,
    lastProfilesCheckAt: 0,
  };

  function logDebug(msg: string) {
    if (api.pluginConfig?.verbose) api.logger.info?.(`[browser-autoclose] ${msg}`);
    else api.logger.debug?.(`[browser-autoclose] ${msg}`);
  }

  async function stopBrowserIfIdle() {
    const cfg = api.pluginConfig ?? {};
    const enabled = cfg.enabled !== false;
    if (!enabled) return;

    const idleMs = Number(cfg.idleMs ?? 600000);
    const profile = String(cfg.profile ?? "openclaw");
    const stopMethod = String(cfg.stopMethod ?? "cli");
    const controlUrl = String(cfg.controlUrl ?? "http://127.0.0.1:18791");
    // NOTE: In OpenClaw we default to stopping *all* running profiles via CLI (dynamic, port-independent).
    // `profile` is kept for backward-compat/fallback only.

    const now = Date.now();
    const idleFor = now - state.lastActivityAt;
    if (idleFor < idleMs) return;

    if (state.inFlight) return;
    state.inFlight = true;
    try {
      // Small jitter to avoid racing with a near-simultaneous browser call.
      await sleep(250);

      const now2 = Date.now();
      const idleFor2 = now2 - state.lastActivityAt;
      if (idleFor2 < idleMs) return;

      logDebug(`idle ${idleFor2}ms >= ${idleMs}ms; stopping browser profile=${profile} via ${stopMethod}`);

      if (stopMethod === "http") {
        const url = new URL(controlUrl.replace(/\/$/, "") + "/stop");
        url.searchParams.set("profile", profile);

        const res = await fetch(url.toString(), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        }).catch((err) => {
          throw new Error(`fetch failed: ${String(err)}`);
        });

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`stop failed: HTTP ${res.status} ${text.slice(0, 300)}`);
        }

        const json = (await res.json().catch(() => null)) as any;
        logDebug(`stop ok: ${JSON.stringify(json)}`);
        return;
      }

      // Default: CLI method (works even when no browser control server port is exposed)
      const stopTimeoutMs = Number(cfg.stopTimeoutMs ?? 30000);
      const { execFile } = await import("node:child_process");

      function extractJson(text: string): any {
        const s = String(text ?? "");
        const iObj = s.indexOf("{");
        const iArr = s.indexOf("[");
        const i = iObj === -1 ? iArr : iArr === -1 ? iObj : Math.min(iObj, iArr);
        if (i === -1) return null;
        try {
          return JSON.parse(s.slice(i));
        } catch {
          return null;
        }
      }

      async function runCli(args: string[], timeoutMs: number) {
        return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
          execFile(
            "openclaw",
            args,
            { timeout: timeoutMs },
            (err: any, stdout: string, stderr: string) => {
              if (err) return reject(new Error(`${err.message ?? String(err)}; stderr=${String(stderr).slice(0, 300)}`));
              resolve({ stdout, stderr });
            }
          );
        });
      }

      function userDataDirForProfile(name: string): string | null {
        // Current OpenClaw conventions:
        // - headless profile user-data: ~/.openclaw/browser/<profile>/user-data
        // - headful script uses: ~/.openclaw/browser/headful-user-data
        if (!name) return null;
        if (name === "headful") return "/home/ec2-user/.openclaw/browser/headful-user-data";
        return `/home/ec2-user/.openclaw/browser/${name}/user-data`;
      }

      async function listProfiles(): Promise<any[]> {
        const profOut = await runCli(
          ["browser", "profiles", "--json", "--timeout", String(Math.max(5000, stopTimeoutMs))],
          Math.max(10000, stopTimeoutMs + 5000)
        );
        const profilesJson = extractJson(profOut.stdout) ?? extractJson(profOut.stderr);
        return Array.isArray(profilesJson?.profiles) ? profilesJson.profiles : Array.isArray(profilesJson) ? profilesJson : [];
      }

      async function findChromeParentsByUserDataDir(userDataDir: string): Promise<number[]> {
        // Find top-level Chromium processes for a given profile by matching --user-data-dir.
        // We avoid relying on OpenClaw's internal state because we've seen false-positive "stopped".
        const { execFile: ef } = await import("node:child_process");
        const out: string = await new Promise((resolve) => {
          ef("pgrep", ["-fa", "chrome-linux/chrome"], (err: any, stdout: string) => {
            if (err) return resolve("");
            resolve(stdout || "");
          });
        });

        const pids: number[] = [];
        for (const line of out.split(/\r?\n/)) {
          const m = line.match(/^(\d+)\s+(.*)$/);
          if (!m) continue;
          const pid = Number(m[1]);
          const cmd = m[2] ?? "";
          if (!cmd.includes(`--user-data-dir=${userDataDir}`)) continue;
          if (!cmd.includes("--remote-debugging-port=")) continue;
          if (cmd.includes(" --type=")) continue;
          if (Number.isFinite(pid)) pids.push(pid);
        }
        return pids;
      }

      async function killPids(pids: number[], signal: NodeJS.Signals) {
        if (!pids.length) return;
        for (const pid of pids) {
          try {
            process.kill(pid, signal);
          } catch {
            // ignore
          }
        }
      }

      async function ensureProfileStopped(name: string) {
        const userDataDir = userDataDirForProfile(name);
        if (!userDataDir) return;

        // Give the graceful stop a moment.
        for (let i = 0; i < 10; i++) {
          const pids = await findChromeParentsByUserDataDir(userDataDir);
          if (pids.length === 0) return;
          await sleep(250);
        }

        // Escalation: TERM then KILL.
        const pids1 = await findChromeParentsByUserDataDir(userDataDir);
        if (pids1.length) {
          api.logger.warn?.(`[browser-autoclose] profile=${name} still running after openclaw stop; sending SIGTERM to pids=${pids1.join(",")}`);
          await killPids(pids1, "SIGTERM");
          await sleep(1500);
        }

        const pids2 = await findChromeParentsByUserDataDir(userDataDir);
        if (pids2.length) {
          api.logger.warn?.(`[browser-autoclose] profile=${name} still running after SIGTERM; sending SIGKILL to pids=${pids2.join(",")}`);
          await killPids(pids2, "SIGKILL");
          await sleep(500);
        }
      }

      // Stop ALL running profiles (robust against profile name changes / new profiles)
      const profiles = await listProfiles();

      if (!profiles.length) {
        // Fallback: stop the configured profile (old behavior)
        const out = await runCli(
          ["browser", "stop", "--browser-profile", profile, "--timeout", String(stopTimeoutMs), "--json"],
          Math.max(10000, stopTimeoutMs + 5000)
        );
        const firstLine = (out.stdout || "").trim().split(/\r?\n/)[0] ?? "";
        logDebug(`cli stop (fallback profile=${profile}) ok: ${firstLine || "(no output)"}`);
        await ensureProfileStopped(profile);
        return;
      }

      const running = profiles.filter((p: any) => p && p.running);
      if (!running.length) {
        logDebug(`no running browser profiles; nothing to stop`);
        return;
      }

      for (const p of running) {
        const name = String(p.name ?? "").trim();
        if (!name) continue;
        const out = await runCli(
          ["browser", "stop", "--browser-profile", name, "--timeout", String(stopTimeoutMs), "--json"],
          Math.max(10000, stopTimeoutMs + 5000)
        );
        const firstLine = (out.stdout || "").trim().split(/\r?\n/)[0] ?? "";
        logDebug(`cli stop ok (profile=${name}): ${firstLine || "(no output)"}`);
        await ensureProfileStopped(name);
      }
    } catch (err) {
      api.logger.warn?.(`[browser-autoclose] stop attempt failed: ${String(err)}`);
    } finally {
      state.inFlight = false;
    }
  }

  async function guardTick() {
    const cfg = api.pluginConfig ?? {};
    const enabled = cfg.enabled !== false;
    if (!enabled) return;

    const guardIntervalMs = Number(cfg.guardIntervalMs ?? 30000);
    // NOTE: maxTabs guard used to rely on `openclaw browser profiles`, which spammed gateway.log with full profile dumps.
    // We now enforce maxParentsPerProfile + rogue 18800 kill without calling `openclaw browser profiles` on an interval.
    const maxParentsPerProfile = Number(cfg.maxParentsPerProfile ?? 1);
    const enforceNoManualCdp18800 = cfg.enforceNoManualCdp18800 !== false;
    const stopTimeoutMs = Number(cfg.stopTimeoutMs ?? 30000);

    if (!Number.isFinite(guardIntervalMs) || guardIntervalMs < 5000) return;

    if (state.guardInFlight || state.inFlight) return;
    state.guardInFlight = true;

    try {
      const { execFile } = await import("node:child_process");

      async function runCli(args: string[], timeoutMs: number) {
        return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
          execFile(
            "openclaw",
            args,
            { timeout: timeoutMs },
            (err: any, stdout: string, stderr: string) => {
              if (err) return reject(new Error(`${err.message ?? String(err)}; stderr=${String(stderr).slice(0, 300)}`));
              resolve({ stdout, stderr });
            }
          );
        });
      }

      function extractJson(text: string): any {
        const s = String(text ?? "");
        const iObj = s.indexOf("{");
        const iArr = s.indexOf("[");
        const i = iObj === -1 ? iArr : iArr === -1 ? iObj : Math.min(iObj, iArr);
        if (i === -1) return null;
        try {
          return JSON.parse(s.slice(i));
        } catch {
          return null;
        }
      }

      function userDataDirForProfile(name: string): string | null {
        if (!name) return null;
        if (name === "headful") return "/home/ec2-user/.openclaw/browser/headful-user-data";
        return `/home/ec2-user/.openclaw/browser/${name}/user-data`;
      }

      async function pgrepChromeLines(): Promise<string[]> {
        const out: string = await new Promise((resolve) => {
          execFile("pgrep", ["-fa", "chrome-linux/chrome"], (err: any, stdout: string) => {
            if (err) return resolve("");
            resolve(stdout || "");
          });
        });
        return out.split(/\r?\n/).filter(Boolean);
      }

      function parseParents(lines: string[]) {
        const parents: { pid: number; cmd: string; userDataDir?: string; port?: number }[] = [];
        for (const line of lines) {
          const m = line.match(/^(\d+)\s+(.*)$/);
          if (!m) continue;
          const pid = Number(m[1]);
          const cmd = m[2] ?? "";
          if (!cmd.includes("--remote-debugging-port=")) continue;
          if (cmd.includes(" --type=")) continue;

          const udd = (cmd.match(/--user-data-dir=([^ ]+)/)?.[1] ?? undefined) as any;
          const portStr = cmd.match(/--remote-debugging-port=(\d+)/)?.[1];
          const port = portStr ? Number(portStr) : undefined;
          parents.push({ pid, cmd, userDataDir: udd, port });
        }
        return parents;
      }

      async function findParentsByUserDataDir(userDataDir: string): Promise<number[]> {
        const lines = await pgrepChromeLines();
        const parents = parseParents(lines);
        return parents.filter((p) => p.userDataDir === userDataDir).map((p) => p.pid);
      }

      async function killPids(pids: number[], signal: NodeJS.Signals) {
        for (const pid of pids) {
          try {
            process.kill(pid, signal);
          } catch {
            // ignore
          }
        }
      }

      async function ensureProfileStoppedByForce(name: string) {
        const userDataDir = userDataDirForProfile(name);
        if (!userDataDir) return;

        // Grace period.
        for (let i = 0; i < 10; i++) {
          const pids = await findParentsByUserDataDir(userDataDir);
          if (!pids.length) return;
          await sleep(250);
        }

        const pids1 = await findParentsByUserDataDir(userDataDir);
        if (pids1.length) {
          api.logger.warn?.(`[browser-autoclose] guard: profile=${name} still has chrome parents after stop; SIGTERM pids=${pids1.join(",")}`);
          await killPids(pids1, "SIGTERM");
          await sleep(1500);
        }
        const pids2 = await findParentsByUserDataDir(userDataDir);
        if (pids2.length) {
          api.logger.warn?.(`[browser-autoclose] guard: profile=${name} still has chrome parents after SIGTERM; SIGKILL pids=${pids2.join(",")}`);
          await killPids(pids2, "SIGKILL");
          await sleep(500);
        }
      }

      // 1) Kill any rogue CDP instance on 18800 that is NOT the OpenClaw openclaw profile.
      if (enforceNoManualCdp18800) {
        const allowed = new Set<string>(["/home/ec2-user/.openclaw/browser/openclaw/user-data"]);
        const lines = await pgrepChromeLines();
        const parents = parseParents(lines);
        const rogue = parents.filter((p) => p.port === 18800 && p.userDataDir && !allowed.has(p.userDataDir));
        if (rogue.length) {
          api.logger.warn?.(`[browser-autoclose] guard: killing rogue CDP :18800 parents not using openclaw user-data-dir: ${rogue.map((r) => `${r.pid}:${r.userDataDir}`).join(" ")}`);
          await killPids(rogue.map((r) => r.pid), "SIGKILL");
        }
      }

      // 2) Enforce maxTabs (hard cap) on a controlled cadence, and immediately under low-memory pressure.
      const maxTabs = Number(cfg.maxTabs ?? 20);
      const profilesCheckIntervalMs = Number(cfg.profilesCheckIntervalMs ?? 300000);
      const memAvailableThresholdMb = Number(cfg.memAvailableThresholdMb ?? 600);

      async function getMemAvailableMb(): Promise<number | null> {
        try {
          const { readFile } = await import("node:fs/promises");
          const txt = await readFile("/proc/meminfo", "utf8");
          const m = txt.match(/^MemAvailable:\s+(\d+)\s+kB/m);
          if (!m) return null;
          const kb = Number(m[1]);
          if (!Number.isFinite(kb)) return null;
          return kb / 1024;
        } catch {
          return null;
        }
      }

      let shouldProfilesCheck = false;
      const nowMs = Date.now();
      if (Number.isFinite(profilesCheckIntervalMs) && profilesCheckIntervalMs > 0 && (nowMs - (state.lastProfilesCheckAt || 0)) >= profilesCheckIntervalMs) {
        shouldProfilesCheck = true;
      }
      const memMb = await getMemAvailableMb();
      if (memMb != null && Number.isFinite(memAvailableThresholdMb) && memMb < memAvailableThresholdMb) {
        shouldProfilesCheck = true;
      }

      if (shouldProfilesCheck && Number.isFinite(maxTabs) && maxTabs >= 1) {
        state.lastProfilesCheckAt = nowMs;
        try {
          const profOut = await runCli(["browser", "profiles", "--json", "--timeout", "5000"], 10000);
          const profJson = extractJson(profOut.stdout) ?? extractJson(profOut.stderr);
          const profiles = Array.isArray(profJson?.profiles) ? profJson.profiles : Array.isArray(profJson) ? profJson : [];

          for (const pr of profiles) {
            if (!pr?.running) continue;
            const name = String(pr.name ?? "").trim();
            if (!name) continue;
            if (name === "chrome") continue; // internal relay/control profile

            const tabCount = Number(pr.tabCount ?? 0);
            if (Number.isFinite(tabCount) && tabCount > maxTabs) {
              api.logger.warn?.(`[browser-autoclose] guard: profile=${name} tabCount=${tabCount} > maxTabs=${maxTabs}; force-stopping`);
              await runCli(["browser", "stop", "--browser-profile", name, "--timeout", String(stopTimeoutMs), "--json"], Math.max(10000, stopTimeoutMs + 5000));
              await ensureProfileStoppedByForce(name);
              if (cfg.resetProfileOnForceStop !== false) {
                api.logger.warn?.(`[browser-autoclose] guard: resetting profile=${name} to prevent tab/session restore`);
                await runCli(["browser", "--browser-profile", name, "reset-profile", "--json", "--timeout", String(stopTimeoutMs)], Math.max(10000, stopTimeoutMs + 5000));
              }
            }
          }
        } catch (err) {
          api.logger.warn?.(`[browser-autoclose] guard: profiles check failed: ${String(err)}`);
        }
      }

      // 2) Parent caps per profile (process-based, avoids noisy `openclaw browser profiles` polling)
      const lines = await pgrepChromeLines();
      const parents = parseParents(lines);

      // Group by user-data-dir
      const byUdd: Record<string, { pid: number; port?: number; cmd: string }[]> = {};
      for (const p of parents) {
        const udd = String(p.userDataDir ?? "");
        if (!udd) continue;
        (byUdd[udd] ??= []).push({ pid: p.pid, port: p.port, cmd: p.cmd });
      }

      function profileNameFromUserDataDir(udd: string): string | null {
        if (udd == '/home/ec2-user/.openclaw/browser/headful-user-data') return 'headful';
        const m = udd.match(/^\/home\/ec2-user\/\.openclaw\/browser\/([^/]+)\/user-data$/);
        return m ? m[1] : null;
      }

      for (const [udd, plist] of Object.entries(byUdd)) {
        const name = profileNameFromUserDataDir(udd);
        if (!name) continue;
        if (name === 'chrome') continue; // internal relay/control profile

        if (Number.isFinite(maxParentsPerProfile) && plist.length > maxParentsPerProfile) {
          api.logger.warn?.(`[browser-autoclose] guard: profile=${name} parentCount=${plist.length} > maxParentsPerProfile=${maxParentsPerProfile}; force-stopping`);
          await runCli(["browser", "stop", "--browser-profile", name, "--timeout", String(stopTimeoutMs), "--json"], Math.max(10000, stopTimeoutMs + 5000));
          await ensureProfileStoppedByForce(name);
          if (cfg.resetProfileOnForceStop !== false) {
            api.logger.warn?.(`[browser-autoclose] guard: resetting profile=${name} to prevent tab/session restore`);
            await runCli(["browser", "--browser-profile", name, "reset-profile", "--json", "--timeout", String(stopTimeoutMs)], Math.max(10000, stopTimeoutMs + 5000));
          }
        }
      }

    } catch (err) {
      api.logger.warn?.(`[browser-autoclose] guard failed: ${String(err)}`);
    } finally {
      state.guardInFlight = false;
    }
  }

  function resetTimer() {
    const cfg = api.pluginConfig ?? {};
    const enabled = cfg.enabled !== false;
    if (!enabled) return;

    const idleMs = Number(cfg.idleMs ?? 600000);
    if (!Number.isFinite(idleMs) || idleMs < 1000) return;

    state.lastActivityAt = Date.now();

    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      void stopBrowserIfIdle();
    }, idleMs + 50);
  }

  function isTabNotFound(err: unknown): boolean {
    const s = String(err ?? "");
    return s.includes("tab not found");
  }

  function isBrowserControlTimeout(err: unknown): boolean {
    const s = String(err ?? "");
    return (
      s.includes("Can't reach the OpenClaw browser control service") ||
      s.includes("timed out after") ||
      s.includes("browser control service")
    ) && !isTabNotFound(err);
  }

  async function browserSoftRecover(reason: string) {
    const cfg = api.pluginConfig ?? {};
    const enabled = cfg.enabled !== false;
    if (!enabled) return;

    const stopTimeoutMs = Number(cfg.stopTimeoutMs ?? 30000);
    const restartChromeProfile = cfg.restartChromeProfileOnTimeout !== false;
    const restartOpenclawProfile = cfg.restartOpenclawProfileOnTimeout !== false;
    const resetProfileOnTimeout = cfg.resetProfileOnTimeout !== false;

    const { execFile } = await import("node:child_process");
    const runCli = async (args: string[]) => {
      return await new Promise<void>((resolve) => {
        execFile("openclaw", args, { timeout: Math.max(10000, stopTimeoutMs + 5000) }, () => resolve());
      });
    };

    api.logger.warn?.(`[browser-autoclose] browser control timeout detected; soft-recovering (reason=${reason})`);

    // Step 1: stop the main automation browser profile.
    if (restartOpenclawProfile) {
      await runCli(["browser", "stop", "--browser-profile", "openclaw", "--timeout", String(stopTimeoutMs), "--json"]);
      await sleep(1000);

      // Critical: don't restore huge tab sets on the next start.
      if (resetProfileOnTimeout) {
        await runCli(["browser", "--browser-profile", "openclaw", "reset-profile", "--json", "--timeout", String(stopTimeoutMs)]);
        await sleep(500);
      }

      // Don't auto-start it; let the next browser call start it (prevents immediate tab explosion).
    }

    // Step 2: stop the internal chrome relay/control profile (can get wedged).
    if (restartChromeProfile) {
      await runCli(["browser", "stop", "--browser-profile", "chrome", "--timeout", String(stopTimeoutMs), "--json"]);
      await sleep(1000);
    }

    // Guard tick will also kill any rogue CDP on :18800 and enforce caps.
    await guardTick();
  }

  // NOTE: This hook is guaranteed to be called for tool calls as results are persisted.
  function summarizeBrowserPersistEvent(event: any): string {
    try {
      const bits: string[] = [];
      if (event?.sessionKey) bits.push(`sessionKey=${event.sessionKey}`);
      if (event?.runId) bits.push(`runId=${event.runId}`);
      if (event?.toolCallId) bits.push(`toolCallId=${event.toolCallId}`);
      if (event?.messageId) bits.push(`messageId=${event.messageId}`);
      if (event?.channelId) bits.push(`channelId=${event.channelId}`);

      // Sometimes result payload contains action info (start/stop/snapshot/etc.)
      const res = event?.toolResult ?? event?.result ?? null;
      const action = res?.action ?? res?.request?.kind ?? res?.kind ?? null;
      if (action) bits.push(`action=${action}`);

      // As a fallback, include shallow keys so we can see what fields are available.
      if (!bits.length && event && typeof event === "object") {
        bits.push(`keys=${Object.keys(event).slice(0, 12).join(",")}`);
      }
      return bits.join(" ") || "(no meta)";
    } catch {
      return "(summarize failed)";
    }
  }

  api.on(
    "tool_result_persist",
    (event: any) => {
      if (!event || event.toolName !== "browser") return;
      resetTimer();
      if (api.pluginConfig?.verbose) {
        api.logger.info?.(`[browser-autoclose] activity: ${summarizeBrowserPersistEvent(event)}`);
      }
    },
    { priority: 100 }
  );

  // Circuit breaker: if browser control service starts timing out, block further browser tool calls
  // for a short cooldown and attempt a soft recovery that does NOT restart the gateway.
  api.on(
    "before_tool_call",
    (event: any) => {
      if (!event || event.toolName !== "browser") return;

      const cfg = api.pluginConfig ?? {};
      const minTimeoutMs = Number(cfg.browserToolTimeoutMs ?? 60000);

      // 1) Circuit breaker: block browser calls during cooldown
      const now = Date.now();
      if (state.browserDownUntil && now < state.browserDownUntil) {
        const waitMs = state.browserDownUntil - now;
        return {
          block: true,
          blockReason: `Browser control service recently timed out; cooling down for ${Math.ceil(waitMs / 1000)}s to avoid cascading failures.`,
        };
      }

      // 2) Bump tool timeout to reduce false timeouts under load
      try {
        const params = event.params ?? {};
        const cur = Number((params as any).timeoutMs ?? 0);
        if (Number.isFinite(minTimeoutMs) && minTimeoutMs >= 5000) {
          const next = !Number.isFinite(cur) || cur <= 0 ? minTimeoutMs : Math.max(cur, minTimeoutMs);
          if (next !== cur) {
            return { params: { ...params, timeoutMs: next } };
          }
        }
      } catch {
        // ignore
      }

      // 3) Stale target recovery: clear targetId/ref to force fresh snapshot
      if (state.staleTarget) {
        api.logger.info?.(`[browser-autoclose] stale target detected; clearing targetId/ref for fresh snapshot`);
        const params = { ...event.params };
        delete (params as any).targetId;
        delete (params as any).ref;
        delete (params as any).targetRef;
        state.staleTarget = false;
        return { params };
      }
    },
    { priority: 200 }
  );

  api.on(
    "after_tool_call",
    async (event: any) => {
      if (!event || event.toolName !== "browser") return;
      if (!event.error) return;

      if (isTabNotFound(event.error)) {
        api.logger.warn?.(`[browser-autoclose] tab not found; marking stale target for next call (will force fresh snapshot)`);
        state.staleTarget = true;
        return; // Don't trigger full recovery or cooldown for stale tab — just refresh next time
      }

      if (!isBrowserControlTimeout(event.error)) return;

      const cfg = api.pluginConfig ?? {};
      const cooldownMs = Number(cfg.timeoutCooldownMs ?? 120000);
      state.lastBrowserTimeoutAt = Date.now();
      state.browserDownUntil = Date.now() + (Number.isFinite(cooldownMs) ? cooldownMs : 120000);

      // Fire-and-forget recovery, but don't block tool pipeline.
      void browserSoftRecover(String(event.error).slice(0, 200));
    },
    { priority: 200 }
  );

  // Periodic safety guard (no cron): prevents runaway tabs / multiple parents / rogue CDP port usage.
  const guardIntervalMs = Number(api.pluginConfig?.guardIntervalMs ?? 30000);
  if (Number.isFinite(guardIntervalMs) && guardIntervalMs >= 5000) {
    state.guardTimer = setInterval(() => {
      void guardTick();
    }, guardIntervalMs);
  }

  api.logger.info?.(
    `[browser-autoclose] loaded (idleMs=${api.pluginConfig?.idleMs ?? 600000}, stopTimeoutMs=${api.pluginConfig?.stopTimeoutMs ?? 30000}, maxTabs=${api.pluginConfig?.maxTabs ?? 20}, maxParentsPerProfile=${api.pluginConfig?.maxParentsPerProfile ?? 1}, guardIntervalMs=${api.pluginConfig?.guardIntervalMs ?? 30000}, enforceNoManualCdp18800=${api.pluginConfig?.enforceNoManualCdp18800 ?? true}, profile=${api.pluginConfig?.profile ?? "openclaw"}, stopMethod=${api.pluginConfig?.stopMethod ?? "cli"}, controlUrl=${api.pluginConfig?.controlUrl ?? "http://127.0.0.1:18791"})`
  );
}

