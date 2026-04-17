import type { HookHandler } from "openclaw/plugin-sdk";
import { isAgentBootstrapEvent, resolveHookConfig } from "openclaw/plugin-sdk";

const HOOK_KEY = "sanitize-guard";

const ADDENDUM = `

## Output safety workaround (temporary)

There is a known false-rewrite bug in older releases that can replace normal assistant text with a generic provider-account warning if certain trigger-phrases appear.

Rules:
- Avoid using the small set of trigger-phrases that look like account-charge / plan / paywall status messages.
- If you must discuss that topic, use neutral wording like: "account status issue", "provider account problem", "check your provider dashboard", "try a different key".
- Prefer describing symptoms + next steps, not quoting provider text verbatim.
- Do not reproduce the exact warning banner text.
`;

const handler: HookHandler = async (event) => {
  if (!isAgentBootstrapEvent(event)) return;

  const cfg = event.context.cfg;
  const hookCfg = resolveHookConfig(cfg, HOOK_KEY);
  if (!hookCfg || hookCfg.enabled === false) return;

  const scope: "main-only" | "all" =
    hookCfg.scope === "all" ? "all" : "main-only";

  const sessionKey = event.context.sessionKey;
  const isMain = !sessionKey || String(sessionKey).includes(":main:");
  if (scope === "main-only" && !isMain) return;

  const files = event.context.bootstrapFiles;
  if (!Array.isArray(files)) return;

  const soul = files.find((f) => f.name === "SOUL.md");
  if (!soul) return;

  const current = soul.content ?? "";
  if (current.includes("Output safety workaround")) return;

  soul.content = current + ADDENDUM;
};

export default handler;
