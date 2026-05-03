import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// Minimal plugin: avoid external deps so it can load without its own node_modules.

type BudgetState = {
  version: 1;
  // UTC date string YYYY-MM-DD
  day: string;
  // key -> count
  counts: Record<string, number>;
};

function utcDayString(ts = Date.now()): string {
  const d = new Date(ts);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

async function loadState(filePath: string): Promise<BudgetState> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1) throw new Error("bad version");
    if (typeof parsed.day !== "string" || typeof parsed.counts !== "object") throw new Error("bad shape");
    return parsed as BudgetState;
  } catch {
    return { version: 1, day: utcDayString(), counts: {} };
  }
}

async function saveState(filePath: string, state: BudgetState) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function asInt(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function isGatewayRuntime(): boolean {
  return (
    process.env.OPENCLAW_SERVICE_KIND === "gateway" ||
    process.env.OPENCLAW_SYSTEMD_UNIT === "openclaw-gateway.service" ||
    !!process.env.OPENCLAW_SERVICE_MARKER
  );
}

export default function register(api: any) {
  if (!isGatewayRuntime()) return;

  // Register a factory so we can read config at runtime and choose tool name.
  api.registerTool(
    (ctx: any) => {
      const entry = ctx?.config?.plugins?.entries?.["web-search-budget"];
      const pluginCfg = entry?.config ?? {};

      const toolName = typeof pluginCfg.toolName === "string" ? pluginCfg.toolName : "web_search_budgeted";
      const dailyLimit = Math.max(1, asInt(pluginCfg.dailyLimit, 100));
      const keyScope = pluginCfg.keyScope === "session" ? "session" : "global";
      const tz = typeof pluginCfg.timezone === "string" ? pluginCfg.timezone : "UTC";

      const parameters = {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", description: "Search query string." },
          count: { type: "integer", minimum: 1, maximum: 10, description: "Number of results to return (1-10)." },
          country: { type: "string", description: "2-letter country code (e.g., US, DE, ALL)." },
          search_lang: { type: "string", description: "ISO language code for search results (e.g., en, de)." },
          ui_lang: { type: "string", description: "ISO language code for UI elements." },
          freshness: { type: "string", description: "Brave freshness: pd|pw|pm|py or YYYY-MM-DDtoYYYY-MM-DD." },
        },
        required: ["query"],
      };

      // Capture the plugin tool factory context (includes config + sessionKey).
      const capturedConfig = ctx?.config;
      const capturedSessionKey = ctx?.sessionKey;

      return {
        label: "Web Search (Budgeted)",
        name: toolName,
        description:
          "Search the web using Brave Search API with a daily request budget enforced by the gateway plugin.",
        parameters,
        execute: async (_toolCallId: string, params: any) => {
          // Only UTC supported for now (keep behavior deterministic)
          if (tz !== "UTC") {
            return {
              content: [
                {
                  type: "text",
                  text: `web-search-budget config error: timezone=${tz} is not supported yet (only UTC).`,
                },
              ],
            };
          }

          const statePath = path.join(os.homedir(), ".clawdbot", "state", "web-search-budget.json");
          const today = utcDayString();
          const key = keyScope === "session" ? String(capturedSessionKey ?? "unknown") : "global";

          const state = await loadState(statePath);
          if (state.day !== today) {
            state.day = today;
            state.counts = {};
          }

          const used = state.counts[key] ?? 0;
          if (used >= dailyLimit) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    `RATE_LIMITED: web_search daily budget exhausted (${used}/${dailyLimit}) for ${keyScope}=${key}. ` +
                    `Wait until tomorrow (UTC) or reduce searches.`,
                },
              ],
            };
          }

          // Enforce budget before performing the network call.
          state.counts[key] = used + 1;
          await saveState(statePath, state);

          // Try config-first, then fall back to reading the on-disk gateway config,
          // since some tool contexts may provide a redacted config object.
          let apiKey = capturedConfig?.tools?.web?.search?.apiKey || process.env.BRAVE_API_KEY;
          if (!apiKey) {
            try {
              const cfgPath = path.join(os.homedir(), ".clawdbot", "clawdbot.json");
              const raw = await fs.readFile(cfgPath, "utf8");
              const diskCfg = JSON.parse(raw);
              apiKey = diskCfg?.tools?.web?.search?.apiKey;
            } catch {
              // ignore
            }
          }
          if (!apiKey) {
            const snapshot = {
              hasCapturedConfig: Boolean(capturedConfig),
              capturedToolsWebSearch: capturedConfig?.tools?.web?.search,
              envHasBraveKey: Boolean(process.env.BRAVE_API_KEY),
            };
            return {
              content: [
                {
                  type: "text",
                  text:
                    "web-search-budget-v2: no Brave API key found (captured config, env, or disk). Debug: " +
                    JSON.stringify(snapshot),
                },
              ],
            };
          }

          const url = new URL("https://api.search.brave.com/res/v1/web/search");
          url.searchParams.set("q", String(params.query));
          const count = typeof params.count === "number" ? params.count : undefined;
          url.searchParams.set("count", String(Math.min(10, Math.max(1, count ?? 5))));
          if (params.country) url.searchParams.set("country", String(params.country));
          if (params.search_lang) url.searchParams.set("search_lang", String(params.search_lang));

          // Brave validates ui_lang against a strict enum (e.g. "en-US"), and will 422 on "en".
          // Coerce common/blank values to a safe default.
          let uiLang = params.ui_lang != null ? String(params.ui_lang) : "";
          if (!uiLang || uiLang.toLowerCase() === "en") uiLang = "en-US";
          url.searchParams.set("ui_lang", uiLang);

          if (params.freshness) url.searchParams.set("freshness", String(params.freshness));

          const start = Date.now();
          const res = await fetch(url.toString(), {
            method: "GET",
            headers: {
              Accept: "application/json",
              "X-Subscription-Token": String(apiKey),
            },
          });

          const bodyText = await res.text();
          if (!res.ok) {
            // If this is a client-side validation error, don't burn budget.
            if (res.status >= 400 && res.status < 500) {
              state.counts[key] = Math.max(0, (state.counts[key] ?? 1) - 1);
              await saveState(statePath, state);
            }

            const burned = state.counts[key] ?? 0;
            return {
              content: [
                {
                  type: "text",
                  text:
                    `Brave Search API error (${res.status}): ${bodyText || res.statusText}. ` +
                    `Budget ${res.status >= 400 && res.status < 500 ? "not" : ""} counted (${burned}/${dailyLimit}).`,
                },
              ],
            };
          }

          const data = JSON.parse(bodyText);
          const results = Array.isArray(data?.web?.results) ? data.web.results : [];
          const mapped = results.map((entry: any) => ({
            title: entry?.title ?? "",
            url: entry?.url ?? "",
            description: entry?.description ?? "",
            published: entry?.age ?? undefined,
            siteName: (() => {
              try {
                return new URL(entry?.url ?? "").hostname;
              } catch {
                return "";
              }
            })(),
          }));

          const payload = {
            query: String(params.query),
            provider: "brave",
            count: mapped.length,
            tookMs: Date.now() - start,
            results: mapped,
            budget: {
              day: today,
              scope: keyScope,
              key,
              used: state.counts[key],
              limit: dailyLimit,
              tool: toolName,
            },
          };

          return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
        },
      };
    },
    // Don't pin names here; allow the tool's runtime name (toolName) to be the canonical registered name.
  );

  api.logger?.info?.("web-search-budget plugin registered (budgeted web search tool factory)");
}
