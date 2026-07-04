// Channel Context Overlay plugin
//
// Injects per-channel developer context from live-editable overlay directories:
//   <overlaysDir>/channel-<discordChannelId>/*
//
// This runs on every Codex turn. Keep it lightweight.

import fs from "node:fs";

const ChannelContextOverlayToolSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["status"] },
  },
  required: ["action"],
} as const;

function extractDiscordChannelId(sessionKey?: string): string | null {
  if (!sessionKey) return null;
  const m = String(sessionKey).match(/:discord:channel:(\d+)/);
  return (m && m[1]) || null;
}

function normalizeDiscordChannelId(value: unknown): string | null {
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return String(value);
  return null;
}

function extractDiscordChannelIdFromHook(
  event: any,
  ctx: any
): { channelId: string | null; source: string | null } {
  const dc = ctx?.deliveryContext ?? event?.deliveryContext;
  const channelIdFromDc =
    dc?.provider === "discord"
      ? normalizeDiscordChannelId(dc?.peer?.id ?? dc?.chatId ?? dc?.channelId ?? null)
      : null;

  const sessionKey = ctx?.sessionKey ?? event?.sessionKey ?? event?.session?.key;
  const channelIdFromKey = extractDiscordChannelId(sessionKey);

  const messageProvider = ctx?.messageProvider ?? event?.messageProvider ?? null;
  const isDiscordContext =
    messageProvider === "discord" ||
    dc?.provider === "discord" ||
    (typeof sessionKey === "string" && sessionKey.includes(":discord:"));

  const ctxCandidates = [
    ctx?.channelId,
    event?.channelId,
    ctx?.channel?.id,
    event?.channel?.id,
    ctx?.peer?.id,
    event?.peer?.id,
  ];
  const channelIdFromCtx = ctxCandidates.map(normalizeDiscordChannelId).find(Boolean) ?? null;

  if (channelIdFromDc) return { channelId: channelIdFromDc, source: "deliveryContext" };
  if (isDiscordContext && channelIdFromCtx) return { channelId: channelIdFromCtx, source: "hookContext" };
  if (channelIdFromKey) return { channelId: channelIdFromKey, source: "sessionKey" };
  return { channelId: null, source: null };
}

function formatOverlayDeveloperInstructions(channelId: string, text: string): string {
  return [
    "OpenClaw plugin-injected system context. This block is not workspace file content.",
    "",
    `[Channel Context Overlay: discord channel ${channelId}]`,
    text,
  ].join("\n");
}

function compareFilenames(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function readChannelOverlayText(overlaysDir: string, channelId: string): string | null {
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

function resolveOverlay(params: {
  api: any;
  event: any;
  ctx: any;
  hookName: "before_prompt_build" | "before_turn_developer_instructions";
}): { channelId: string; text: string } | null {
  const { channelId, source } = extractDiscordChannelIdFromHook(params.event, params.ctx);
  if (!channelId) return null;

  const cfg = params.api.config?.get?.() ?? {};
  const overlaysDir =
    cfg.overlaysDir || "/home/ec2-user/.openclaw/workspace-discord-general/context-overlays/discord";
  const channelDir = `${overlaysDir}/channel-${channelId}`;

  let text: string | null;
  try {
    text = readChannelOverlayText(overlaysDir, channelId);
  } catch {
    params.api.logger?.debug?.(
      `[channel-context-overlay] MISS hook=${params.hookName} channelId=${channelId} source=${source ?? "unknown"} path=${channelDir}`
    );
    return null;
  }

  if (!text) return null;

  params.api.logger?.info?.(
    `[channel-context-overlay] HIT hook=${params.hookName} channelId=${channelId} source=${source ?? "unknown"} chars=${text.length}`
  );

  return { channelId, text };
}

function isGatewayRuntime(): boolean {
  return (
    process.env.OPENCLAW_SERVICE_KIND === "gateway" ||
    process.env.OPENCLAW_SYSTEMD_UNIT === "openclaw-gateway.service" ||
    !!process.env.OPENCLAW_SERVICE_MARKER
  );
}

export default function register(api: any) {
  api.registerTool({
    name: "channel_context_overlay",
    label: "Channel Context Overlay",
    description: "Report current channel-context-overlay configuration and runtime gating",
    parameters: ChannelContextOverlayToolSchema,
    async execute() {
      const cfg = api.config?.get?.() ?? {};
      const overlaysDir =
        cfg.overlaysDir || "/home/ec2-user/.openclaw/workspace-discord-general/context-overlays/discord";
      const payload = { ok: true, overlaysDir, gatewayRuntime: isGatewayRuntime() };
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], details: payload };
    },
  });

  if (!isGatewayRuntime()) return;

  api.on("before_prompt_build", (event: any, ctx: any) => {
    const overlay = resolveOverlay({
      api,
      event,
      ctx,
      hookName: "before_prompt_build",
    });
    if (!overlay) return;

    return {
      appendSystemContext: formatOverlayDeveloperInstructions(overlay.channelId, overlay.text),
    };
  });

  api.on("before_turn_developer_instructions", (event: any, ctx: any) => {
    const overlay = resolveOverlay({
      api,
      event,
      ctx,
      hookName: "before_turn_developer_instructions",
    });
    if (!overlay) return;

    return {
      appendDeveloperInstructions: formatOverlayDeveloperInstructions(
        overlay.channelId,
        overlay.text
      ),
    };
  });

  api.logger?.info?.("[channel-context-overlay] loaded - before_turn_developer_instructions hook active");
}
