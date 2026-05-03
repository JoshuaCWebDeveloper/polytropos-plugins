// Channel Context Overlay plugin
//
// Injects per-channel system context from live-editable overlay files:
//   <overlaysDir>/channel-<discordChannelId>.md
//
// This runs on every prompt build. Keep it lightweight.

const fs = require("fs");

function extractDiscordChannelId(sessionKey?: string): string | null {
  if (!sessionKey) return null;
  const m = String(sessionKey).match(/:discord:channel:(\d+)/);
  return (m && m[1]) || null;
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

  api.on("before_prompt_build", (event: any, ctx: any) => {
    const dc = ctx?.deliveryContext ?? event?.deliveryContext;
    const channelIdFromDc = dc?.provider === "discord" ? (dc?.peer?.id ?? dc?.chatId ?? null) : null;

    const sessionKey = ctx?.sessionKey ?? event?.sessionKey ?? event?.session?.key;
    const channelIdFromKey = extractDiscordChannelId(sessionKey);

    const channelId = (typeof channelIdFromDc === "string" ? channelIdFromDc : null) ?? channelIdFromKey;
    if (!channelId) return;

    const cfg = api.config?.get?.() ?? {};
    const overlaysDir = cfg.overlaysDir || "/home/ec2-user/.openclaw/workspace-discord-general/context-overlays/discord";
    const path = `${overlaysDir}/channel-${channelId}.md`;

    let text: string;
    try {
      text = fs.readFileSync(path, "utf8");
    } catch {
      return;
    }

    const trimmed = String(text || "").trim();
    if (!trimmed) return;

    if (channelId === "1483991614736039936" || channelId === "1477482956523049052") {
      api.logger?.info?.(`[channel-context-overlay] HIT channelId=${channelId} chars=${trimmed.length}`);
    }

    // Inject into system prompt space.
    return {
      appendSystemContext: `\n\n[Channel Context Overlay: discord channel ${channelId}]\n${trimmed}\n`,
    };
  });

  api.logger?.info?.("[channel-context-overlay] loaded — before_prompt_build hook active");
}
