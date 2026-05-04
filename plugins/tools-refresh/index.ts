import fs from "node:fs/promises";
import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(_execFile);

type PluginApi = {
  config: any;
  on: (hookName: string, handler: (event: any, ctx: any) => any, opts?: { priority?: number }) => void;
};

type PluginCfg = {
  enabled?: boolean;
  allowFromDiscord?: string[];
  agentId?: string;
};

function getCfg(api: PluginApi): PluginCfg {
  return (api?.config?.plugins?.entries?.["tools-refresh"]?.config ?? {}) as PluginCfg;
}

function isAllowedDiscordSender(senderId: string | null | undefined, cfg: PluginCfg): boolean {
  if (!senderId) return false;
  const allow = cfg.allowFromDiscord;
  if (!Array.isArray(allow) || allow.length === 0) {
    // default to the global authorized sender if not specified
    return senderId === "404067372379668491";
  }
  return allow.includes(senderId);
}

function parseCommand(contentRaw: string): { cmd: "refresh" | "report" | null } {
  const content = (contentRaw ?? "").trim();
  if (!content.startsWith("/tools")) return { cmd: null };
  const parts = content.split(/\s+/g);
  const sub = (parts[1] ?? "").toLowerCase();
  if (sub === "refresh") return { cmd: "refresh" };
  if (sub === "report") return { cmd: "report" };
  return { cmd: null };
}

function guessSessionKeys(store: Record<string, any>, conversationId: string): string[] {
  const keys = Object.keys(store);
  const hits = keys.filter((k) => k.includes(conversationId));
  hits.sort((a, b) => a.length - b.length);
  return hits;
}

async function loadSessionStore(agentId: string): Promise<{ storePath: string; store: Record<string, any> }> {
  const storePath = `/home/ec2-user/.openclaw/agents/${agentId}/sessions/sessions.json`;
  const raw = await fs.readFile(storePath, "utf8");
  const store = JSON.parse(raw);
  if (!store || typeof store !== "object") throw new Error("sessions.json is not an object");
  return { storePath, store };
}

async function persistSessionStore(storePath: string, store: Record<string, any>) {
  const tmp = `${storePath}.tmp.${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2) + "\n", "utf8");
  await fs.rename(tmp, storePath);
}

function refreshEntry(entry: any): { changed: boolean; entry: any } {
  if (!entry || typeof entry !== "object") return { changed: false, entry };
  let changed = false;
  const next: any = { ...entry };
  if (next.systemSent !== false) {
    next.systemSent = false;
    changed = true;
  }
  if (next.systemPromptReport != null) {
    next.systemPromptReport = null;
    changed = true;
  }
  if (next.skillsSnapshot != null) {
    delete next.skillsSnapshot;
    changed = true;
  }
  return { changed, entry: next };
}

async function sendDiscordMessage(conversationId: string, text: string) {
  await execFile("openclaw", [
    "message",
    "send",
    "--channel",
    "discord",
    "--target",
    conversationId,
    "--message",
    text,
  ]);
}

function isGatewayRuntime(): boolean {
  const a0 = String(process.argv[0] ?? "").split(/[\\/]/).pop();
  const a1 = String(process.argv[1] ?? "").split(/[\\/]/).pop();
  return a0 === "openclaw-gateway" || a1 === "openclaw-gateway";
}

export default function toolsRefreshPlugin(api: PluginApi) {
  if (!isGatewayRuntime()) return;

  const cfg = getCfg(api);
  if (cfg.enabled === false) return;

  api.on(
    "message_received",
    async (event: any, ctx: any) => {
      const content = String(event?.content ?? "");
      const { cmd } = parseCommand(content);
      if (!cmd) return;

      // Discord sender id extraction
      const senderId =
        String((event?.metadata as any)?.sender_id ?? (event?.metadata as any)?.discord?.authorId ?? "")
          .trim() || null;
      if (!isAllowedDiscordSender(senderId, cfg)) return;

      const conversationId = String(ctx?.conversationId ?? "").trim();
      if (!conversationId) return;

      try {
        const agentId = (cfg.agentId ?? "discord-general").trim();
        const { storePath, store } = await loadSessionStore(agentId);
        const keys = guessSessionKeys(store, conversationId);

        if (cmd === "report") {
          const lines: string[] = [];
          lines.push("🧰 /tools report");
          lines.push(`conversationId=${conversationId}`);
          lines.push(`matchedSessions=${keys.length}`);
          for (const k of keys.slice(0, 5)) {
            const rep = store[k]?.systemPromptReport;
            const entries = rep?.tools?.entries;
            const names = Array.isArray(entries) ? entries.map((t: any) => t?.name).filter(Boolean) : [];
            lines.push(`- ${k}`);
            lines.push(`  systemSent=${store[k]?.systemSent ?? null}`);
            lines.push(`  tools=${names.join(", ") || "(none)"}`);
          }
          await sendDiscordMessage(conversationId, lines.join("\n").slice(0, 1800));
          return;
        }

        let changedAny = false;
        let changedCount = 0;
        for (const k of keys) {
          const cur = store[k];
          const { changed, entry } = refreshEntry(cur);
          if (changed) {
            store[k] = entry;
            changedAny = true;
            changedCount += 1;
          }
        }

        if (changedAny) {
          await persistSessionStore(storePath, store);
        }

        const reply = changedAny
          ? `✅ Marked ${changedCount} session(s) for tool-manifest reinjection. Next message in this thread should include newly available tools.\n\nTry: browser_cloud status`
          : `ℹ️ No session entries changed. Try /tools report`;
        await sendDiscordMessage(conversationId, reply);
      } catch (e: any) {
        await sendDiscordMessage(
          conversationId,
          `⚠️ /tools ${cmd} failed: ${String(e?.message ?? e)}`.slice(0, 1800),
        ).catch(() => {});
      }
    },
    { priority: 50 },
  );
}
