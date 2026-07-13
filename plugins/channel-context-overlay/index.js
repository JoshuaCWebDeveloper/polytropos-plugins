const fs = require("fs");

function extractDiscordChannelId(sessionKey) {
  if (!sessionKey) return null;
  const m = String(sessionKey).match(/:discord:channel:(\d+)/);
  return (m && m[1]) || null;
}

function normalizeDiscordChannelId(value) {
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return String(value);
  return null;
}

function extractDiscordChannelIdFromHook(event, ctx) {
  const dc = (ctx && ctx.deliveryContext) || (event && event.deliveryContext);
  const channelIdFromDc =
    dc && dc.provider === "discord"
      ? normalizeDiscordChannelId((dc.peer && dc.peer.id) || dc.chatId || dc.channelId || null)
      : null;

  const sessionKey =
    (ctx && ctx.sessionKey) || (event && (event.sessionKey || (event.session && event.session.key))) || null;
  const channelIdFromKey = extractDiscordChannelId(sessionKey);

  const messageProvider = (ctx && ctx.messageProvider) || (event && event.messageProvider) || null;
  const isDiscordContext =
    messageProvider === "discord" ||
    (dc && dc.provider === "discord") ||
    (typeof sessionKey === "string" && sessionKey.includes(":discord:"));

  const ctxCandidates = [
    ctx && ctx.channelId,
    event && event.channelId,
    ctx && ctx.channel && ctx.channel.id,
    event && event.channel && event.channel.id,
    ctx && ctx.peer && ctx.peer.id,
    event && event.peer && event.peer.id,
  ];
  const channelIdFromCtx = ctxCandidates.map(normalizeDiscordChannelId).find(Boolean) || null;

  if (channelIdFromDc) return { channelId: channelIdFromDc, source: "deliveryContext" };
  if (isDiscordContext && channelIdFromCtx) return { channelId: channelIdFromCtx, source: "hookContext" };
  if (channelIdFromKey) return { channelId: channelIdFromKey, source: "sessionKey" };
  return { channelId: null, source: null };
}

function formatOverlayDeveloperInstructions(channelId, text) {
  return [
    "OpenClaw plugin-injected system context. This block is not workspace file content.",
    "",
    `[Channel Context Overlay: discord channel ${channelId}]`,
    text,
  ].join("\n");
}

function compareFilenames(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function readChannelOverlayText(overlaysDir, channelId) {
  const channelDir = `${overlaysDir}/channel-${channelId}`;
  const files = fs
    .readdirSync(channelDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort(compareFilenames);

  const chunks = files
    .map((filename) => fs.readFileSync(`${channelDir}/${filename}`, "utf8").trim())
    .filter((text) => text.length > 0);

  return chunks.length > 0 ? chunks.join("\n\n") : null;
}

function resolveOverlay(api, event, ctx, hookName) {
  const { channelId, source } = extractDiscordChannelIdFromHook(event, ctx);
  if (!channelId) return null;

  const cfg = (api.config && api.config.get && api.config.get()) || {};
  const overlaysDir =
    cfg.overlaysDir || "/home/ec2-user/.openclaw/workspace-discord-general/context-overlays/discord";
  const channelDir = `${overlaysDir}/channel-${channelId}`;

  let text;
  try {
    text = readChannelOverlayText(overlaysDir, channelId);
  } catch {
    if (api.logger && api.logger.debug) {
      api.logger.debug(
        `[channel-context-overlay] MISS hook=${hookName} channelId=${channelId} source=${source || "unknown"} path=${channelDir}`
      );
    }
    return null;
  }

  if (!text) return null;

  if (api.logger && api.logger.info) {
    api.logger.info(
      `[channel-context-overlay] HIT hook=${hookName} channelId=${channelId} source=${source || "unknown"} chars=${text.length}`
    );
  }

  return { channelId, text };
}

function register(api) {
  api.on("before_prompt_build", (event, ctx) => {
    const overlay = resolveOverlay(api, event, ctx, "before_prompt_build");
    if (!overlay) return;

    return {
      appendSystemContext: formatOverlayDeveloperInstructions(overlay.channelId, overlay.text),
    };
  });

  api.on("before_turn_developer_instructions", (event, ctx) => {
    const overlay = resolveOverlay(api, event, ctx, "before_turn_developer_instructions");
    if (!overlay) return;

    return {
      appendDeveloperInstructions: formatOverlayDeveloperInstructions(overlay.channelId, overlay.text),
    };
  });

  api.logger &&
    api.logger.info &&
    api.logger.info("[channel-context-overlay] loaded - before_turn_developer_instructions hook active");
}

module.exports = register;
module.exports.readChannelOverlayText = readChannelOverlayText;
