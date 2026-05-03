const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function sha256(text) {
  return crypto.createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

function resolveHome(p) {
  if (!p) return p;
  if (p.startsWith("~" + path.sep) || p === "~") {
    const home = process.env.HOME || "/home/ec2-user";
    return path.join(home, p.slice(1));
  }
  return p;
}

function ensureDirForFile(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function safeStat(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function rotateIfNeeded(filePath, rotationCfg, api) {
  const maxBytes = Number(rotationCfg && rotationCfg.maxBytes) || 0;
  const maxFiles = Math.max(1, Number(rotationCfg && rotationCfg.maxFiles) || 10);
  if (!maxBytes) return;

  const st = safeStat(filePath);
  if (!st || !st.isFile()) return;
  if (st.size < maxBytes) return;

  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rotated = path.join(dir, `${base}.${ts}`);

  try {
    fs.renameSync(filePath, rotated);
  } catch (err) {
    // If rename fails, don't break logging.
    api?.logger?.warn?.(`[system-prompt-logger] log rotate rename failed: ${String(err)}`);
    return;
  }

  // Cleanup: keep newest maxFiles rotated logs.
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(base + "."))
      .map((f) => ({ f, p: path.join(dir, f), st: safeStat(path.join(dir, f)) }))
      .filter((x) => x.st && x.st.isFile())
      .sort((a, b) => (b.st.mtimeMs || 0) - (a.st.mtimeMs || 0));

    for (const x of files.slice(maxFiles)) {
      try {
        fs.unlinkSync(x.p);
      } catch {}
    }
  } catch (err) {
    api?.logger?.warn?.(`[system-prompt-logger] log rotate cleanup failed: ${String(err)}`);
  }
}

// ---- Dist patching (modeled after context-overflow-logger) ----
// Goal: ensure cacheTrace.wrapStreamFn records the final system prompt near provider request.
const NEEDLE_STREAM_CONTEXT_V1 =
  "\t\t\trecordStage(\"stream:context\", {\n" +
  "\t\t\t\tmodel: {\n" +
  "\t\t\t\t\tid: model?.id,\n" +
  "\t\t\t\t\tprovider: model?.provider,\n" +
  "\t\t\t\t\tapi: model?.api\n" +
  "\t\t\t\t},\n" +
  "\t\t\t\tmessages: context.messages ?? []\n" +
  "\t\t\t});";

const NEEDLE_STREAM_CONTEXT_V2 =
  "\t\t\trecordStage(\"stream:context\", {\n" +
  "\t\t\t\tmodel: {\n" +
  "\t\t\t\t\tid: model?.id,\n" +
  "\t\t\t\t\tprovider: model?.provider,\n" +
  "\t\t\t\t\tapi: model?.api\n" +
  "\t\t\t\t},\n" +
  "\t\t\t\tsystem: context.system,\n" +
  "\t\t\t\tmessages: context.messages ?? [],\n" +
  "\t\t\t\toptions: options ?? {}\n" +
  "\t\t\t});";

const REPLACEMENT_STREAM_CONTEXT_V2 =
  "\t\t\trecordStage(\"stream:context\", {\n" +
  "\t\t\t\tmodel: {\n" +
  "\t\t\t\t\tid: model?.id,\n" +
  "\t\t\t\t\tprovider: model?.provider,\n" +
  "\t\t\t\t\tapi: model?.api\n" +
  "\t\t\t\t},\n" +
  "\t\t\t\t// Capture the final system prompt as close to provider request as possible.\n" +
  "\t\t\t\t// Different providers expose this under different keys.\n" +
  "\t\t\t\tsystem: context.systemPrompt ?? context.system ?? context.instructions ?? context.system,\n" +
  "\t\t\t\tsystemPrompt: context.systemPrompt,\n" +
  "\t\t\t\tinstructions: context.instructions,\n" +
  "\t\t\t\tmessages: context.messages ?? [],\n" +
  "\t\t\t\toptions: options ?? {}\n" +
  "\t\t\t});";

function patchFile(filePath, { dryRun }) {
  try {
    const text = fs.readFileSync(filePath, "utf8");

    // Idempotency: if already patched, no-op.
    if (text.includes("system: context.systemPrompt")) {
      return { filePath, status: "already" };
    }

    // Prefer patching the newer shape (system + options).
    if (text.includes(NEEDLE_STREAM_CONTEXT_V2)) {
      const next = text.replace(NEEDLE_STREAM_CONTEXT_V2, REPLACEMENT_STREAM_CONTEXT_V2);
      if (!dryRun) fs.writeFileSync(filePath, next, "utf8");
      return { filePath, status: "patched" };
    }

    // Fallback to older shape (messages only) if present.
    if (text.includes(NEEDLE_STREAM_CONTEXT_V1)) {
      // For V1 we can only safely add `system` fields if we also add options; skip.
      // (We keep V1 unpatched rather than risking breaking older bundles.)
      return { filePath, status: "not-found" };
    }

    return { filePath, status: "not-found" };
  } catch (err) {
    return { filePath, status: "error", reason: String(err && err.message ? err.message : err) };
  }
}

function patchOpenClawDist(api) {
  // Only run inside the long-lived gateway process.
  const gw = process.argv.indexOf("gateway");
  if (gw === -1) return;

  const distDir = "/home/ec2-user/.npm-global/lib/node_modules/openclaw/dist";

  // After OpenClaw upgrades, bundle names change. Prefer broad matching of the known
  // cache-trace implementation bundles (pi-embedded-*.js and plugin-sdk/*).
  let candidates = [];
  try {
    const files = fs.readdirSync(distDir);
    candidates = files
      .filter((f) => (f.startsWith("pi-embedded-") || f.startsWith("plugin-sdk/")) && f.endsWith(".js"))
      .map((f) => path.join(distDir, f));
  } catch {
    candidates = [];
  }

  // Fallback to a small known set (older versions).
  if (!candidates.length) {
    candidates = [
      "discord-CcCLMjHw.js",
      "reply-Bm8VrLQh.js",
      "model-selection-46xMp11W.js",
      "model-selection-CU2b7bN6.js",
      "auth-profiles-DRjqKE3G.js",
      "auth-profiles-DDVivXkv.js",
      "plugin-sdk/thread-bindings-SYAnWHuW.js",
    ].map((f) => path.join(distDir, f));
  }

  const results = candidates.map((fp) => patchFile(fp, { dryRun: false }));

  const patched = results.filter((r) => r.status === "patched").length;
  const already = results.filter((r) => r.status === "already").length;
  const notFound = results.filter((r) => r.status === "not-found").length;
  const errors = results.filter((r) => r.status === "error");

  if (api.logger && api.logger.info) {
    api.logger.info(
      `[system-prompt-logger] dist patch summary: patched=${patched} already=${already} notFound=${notFound} errors=${errors.length}`
    );
  }
  if (errors.length && api.logger && api.logger.warn) {
    for (const e of errors.slice(0, 5)) {
      api.logger.warn(`[system-prompt-logger] dist patch error: ${e.filePath}: ${e.reason}`);
    }
  }
}

module.exports = function register(api) {
  // Ensure the cacheTrace stream-context capture exists (survives upgrades).
  try {
    patchOpenClawDist(api);
  } catch (e) {
    api?.logger?.warn?.(`[system-prompt-logger] dist patch threw: ${String(e)}`);
  }

  // Hook-based system prompt logging to a dedicated file.
  api.on("llm_input", (event, ctx) => {
    const cfg = (api.config && api.config.get && api.config.get()) || {};
    if (cfg.enabled === false) return;

    const defaultPath = path.join(
      process.env.OPENCLAW_STATE_DIR || path.join(process.env.HOME || "/home/ec2-user", ".openclaw"),
      "logs",
      "request-system-prompts.log"
    );

    const filePath = resolveHome((cfg.filePath || "").trim()) || defaultPath;

    const systemPrompt = event && typeof event.systemPrompt === "string" ? event.systemPrompt : "";

    const record = {
      ts: new Date().toISOString(),
      hook: "llm_input",
      runId: event && event.runId,
      sessionId: event && event.sessionId,
      sessionKey: ctx && ctx.sessionKey,
      agentId: ctx && ctx.agentId,
      provider: event && event.provider,
      model: event && event.model,
      systemPromptChars: systemPrompt.length,
      systemPromptSha256: sha256(systemPrompt),
      systemPrompt,
    };

    if (cfg.includePrompt) {
      const prompt = event && typeof event.prompt === "string" ? event.prompt : "";
      record.promptChars = prompt.length;
      record.promptSha256 = sha256(prompt);
      record.prompt = prompt;
    }

    try {
      ensureDirForFile(filePath);
      // Rotate before write to keep file bounded.
      rotateIfNeeded(filePath, cfg.rotation || { maxBytes: 10485760, maxFiles: 10 }, api);
      fs.appendFileSync(filePath, JSON.stringify(record) + "\n", "utf8");
    } catch (err) {
      if (api.logger && api.logger.warn)
        api.logger.warn(`[system-prompt-logger] failed to write ${filePath}: ${String(err)}`);
    }

    if (api.logger && api.logger.debug) {
      api.logger.debug(
        `[system-prompt-logger] llm_input runId=${record.runId} sessionId=${record.sessionId} provider=${record.provider} model=${record.model} systemPromptSha256=${record.systemPromptSha256} systemPromptChars=${record.systemPromptChars}`
      );
    }
  });

  api.logger && api.logger.info && api.logger.info("[system-prompt-logger] loaded — llm_input hook active");
};
