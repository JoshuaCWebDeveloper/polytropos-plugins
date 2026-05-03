const fs = require("fs");

function extractDiscordChannelId(sessionKey) {
  if (!sessionKey) return null;
  const m = String(sessionKey).match(/:discord:channel:(\d+)/);
  return (m && m[1]) || null;
}

module.exports = function register(api) {
  api.on("before_prompt_build", (event) => {
    const dc = event && event.deliveryContext;
    const channelIdFromDc =
      dc && dc.provider === "discord" ? (dc.peer && dc.peer.id) || dc.chatId || null : null;

    const sessionKey = (event && (event.sessionKey || (event.session && event.session.key))) || null;
    const channelIdFromKey = extractDiscordChannelId(sessionKey);

    const channelId = (typeof channelIdFromDc === "string" ? channelIdFromDc : null) || channelIdFromKey;
    if (!channelId) return;

    const cfg = (api.config && api.config.get && api.config.get()) || {};
    const overlaysDir =
      cfg.overlaysDir || "/home/ec2-user/.openclaw/workspace-discord-general/context-overlays/discord";
    const path = `${overlaysDir}/channel-${channelId}.md`;

    let text;
    try {
      text = fs.readFileSync(path, "utf8");
    } catch {
      return;
    }

    const trimmed = String(text || "").trim();
    if (!trimmed) return;

    // Inject into system prompt space for stable behavior.
    return {
      appendSystemContext: `\n\n[Channel Context Overlay: discord channel ${channelId}]\n${trimmed}\n`,
    };
  });

  api.logger && api.logger.info && api.logger.info("[channel-context-overlay] loaded — before_prompt_build hook active");
};
