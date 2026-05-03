function isGatewayRuntime(): boolean {
  return (
    process.env.OPENCLAW_SERVICE_KIND === "gateway" ||
    process.env.OPENCLAW_SYSTEMD_UNIT === "openclaw-gateway.service" ||
    !!process.env.OPENCLAW_SERVICE_MARKER
  );
}

export default function register(api: any) {
  if (!isGatewayRuntime()) return;
  api.on("before_prompt_build", (event: any) => {
    if (!event?.messages?.length) return;

    let fixed = 0;
    for (const msg of event.messages) {
      if (msg.role !== "assistant") continue;
      const content = msg.content;
      if (!Array.isArray(content)) continue;

      // Find last toolCall index
      let lastToolIdx = -1;
      for (let j = 0; j < content.length; j++) {
        if (content[j]?.type === "toolCall") lastToolIdx = j;
      }

      // Strip anything after last toolCall
      if (lastToolIdx >= 0 && lastToolIdx < content.length - 1) {
        const removed = content.splice(lastToolIdx + 1);
        fixed++;
        api.logger?.debug?.(
          `[transcript-hygiene] stripped ${removed.length} trailing block(s) after toolCall: ${removed.map((b: any) => b?.type).join(", ")}`
        );
      }
    }

    if (fixed > 0) {
      api.logger?.info?.(`[transcript-hygiene] sanitized ${fixed} assistant message(s) in-memory`);
    }
  });

  api.logger?.info?.("[transcript-hygiene] loaded — before_prompt_build hook active");
}
