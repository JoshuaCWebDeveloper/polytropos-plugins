import fs from "node:fs";
import path from "node:path";

// Patch 1: add extra logging when OpenClaw classifies an error as context overflow.
const NEEDLE_OVERFLOW =
  "\tif (isContextOverflowError(raw)) return \"Context overflow: prompt too large for the model. Try again with less input or a larger-context model.\";";

const REPLACEMENT_OVERFLOW =
  "\tif (isContextOverflowError(raw)) {\n" +
  "\t\ttry {\n" +
  "\t\t\tconst info = parseApiErrorInfo(raw);\n" +
  "\t\t\tconsole.warn(\"[context-overflow-detect] classified as context overflow\", {\n" +
  "\t\t\t\tsessionKey: opts?.sessionKey,\n" +
  "\t\t\t\tstopReason: msg.stopReason,\n" +
  "\t\t\t\thttpCode: info?.httpCode,\n" +
  "\t\t\t\ttype: info?.type,\n" +
  "\t\t\t\trequestId: info?.requestId,\n" +
  "\t\t\t\terrorMessageHead: raw.slice(0, 300)\n" +
  "\t\t\t});\n" +
  "\t\t} catch (e) {\n" +
  "\t\t\tconsole.warn(\"[context-overflow-detect] logging failed\", e);\n" +
  "\t\t}\n" +
  "\t\treturn \"Context overflow: prompt too large for the model. Try again with less input or a larger-context model.\";\n" +
  "\t}";

// Patch 2: add logging for invalid_request_error rejections (this is where the Harbor
// incident produced "LLM request rejected: ..." and we previously had no instrumentation).
const NEEDLE_INVALID_REQUEST =
  "\tif (invalidRequest?.[1]) return `LLM request rejected: ${invalidRequest[1]}`;";

const REPLACEMENT_INVALID_REQUEST =
  "\tif (invalidRequest?.[1]) {\n" +
  "\t\ttry {\n" +
  "\t\t\tconst info = parseApiErrorInfo(raw);\n" +
  "\t\t\tconsole.warn(\"[context-overflow-detect] invalid_request_error\", {\n" +
  "\t\t\t\tsessionKey: opts?.sessionKey,\n" +
  "\t\t\t\tstopReason: msg.stopReason,\n" +
  "\t\t\t\thttpCode: info?.httpCode,\n" +
  "\t\t\t\ttype: info?.type,\n" +
  "\t\t\t\trequestId: info?.requestId,\n" +
  "\t\t\t\thasContextLengthExceeded: /context_length_exceeded/i.test(raw),\n" +
  "\t\t\t\terrorMessageHead: raw.slice(0, 300)\n" +
  "\t\t\t});\n" +
  "\t\t} catch (e) {\n" +
  "\t\t\tconsole.warn(\"[context-overflow-detect] invalid_request_error logging failed\", e);\n" +
  "\t\t}\n" +
  "\t\treturn `LLM request rejected: ${invalidRequest[1]}`;\n" +
  "\t}";

function listHelperBundles(distDir: string): string[] {
  try {
    return fs
      .readdirSync(distDir)
      .filter((f) => f.startsWith("pi-embedded-helpers-") && f.endsWith(".js"))
      .map((f) => path.join(distDir, f));
  } catch {
    return [];
  }
}

function resolveDistDirCandidates(mainPath: string): string[] {
  const candidates = new Set<string>();
  const mainDir = path.dirname(mainPath || "");
  if (mainDir) candidates.add(mainDir);

  // If we're running via a global bin wrapper (e.g. ~/.npm-global/bin/openclaw),
  // try the sibling lib/node_modules path.
  if (mainDir.includes(path.sep + "bin")) {
    candidates.add(path.resolve(mainDir, "..", "lib", "node_modules", "openclaw", "dist"));
  }

  // Known install location on this box.
  candidates.add("/home/ec2-user/.npm-global/lib/node_modules/openclaw/dist");

  return [...candidates];
}

function patchFile(filePath: string, { dryRun }: { dryRun: boolean }): {
  filePath: string;
  status: "already" | "patched" | "not-found" | "error";
  reason?: string;
} {
  try {
    const text = fs.readFileSync(filePath, "utf8");

    let next = text;
    let changed = false;
    let hadAnyNeedle = false;

    // Only apply each patch if its target needle is present and the replacement isn't already.
    if (next.includes(NEEDLE_OVERFLOW)) {
      hadAnyNeedle = true;
      next = next.replace(NEEDLE_OVERFLOW, REPLACEMENT_OVERFLOW);
      changed = true;
    }

    if (next.includes(NEEDLE_INVALID_REQUEST)) {
      hadAnyNeedle = true;
      next = next.replace(NEEDLE_INVALID_REQUEST, REPLACEMENT_INVALID_REQUEST);
      changed = true;
    }

    if (!changed) {
      // If neither needle exists, report not-found; otherwise already.
      return { filePath, status: hadAnyNeedle ? "already" : "not-found" };
    }

    if (!dryRun) fs.writeFileSync(filePath, next, "utf8");
    return { filePath, status: "patched" };
  } catch (e: any) {
    return { filePath, status: "error", reason: String(e?.message ?? e) };
  }
}

export default function (api: any) {
  // Only run inside the long-lived gateway process.
  // The OpenClaw CLI loads plugins too; avoid init logging on every `openclaw ...` command.
  const gw = process.argv.indexOf("gateway");
  if (gw === -1) return;
  const next = process.argv[gw + 1];
  // Only patch when running the gateway *daemon* ("openclaw ... gateway --port ...").
  // Skip CLI subcommands like openclaw gateway status/start/stop/restart/install/etc.
  if (next && !next.startsWith("-")) return;

  const cfg = api?.config;
  const pluginCfg = cfg?.plugins?.entries?.["context-overflow-logger"]?.config ?? {};
  const enabled = pluginCfg.enabled !== false;
  const dryRun = pluginCfg.dryRun === true;

  if (!enabled) {
    console.warn("[context-overflow-logger] disabled by config");
    return;
  }

  // Try multiple strategies to locate the OpenClaw install dist dir.
  // In some contexts (ESM/jiti), require.main can be undefined.
  const mainPath = (process.argv?.[1] ?? "") || (require.main?.filename ?? "");

  const candidates = resolveDistDirCandidates(mainPath);
  let distDir = candidates[0] ?? "";
  let helpers: string[] = [];
  for (const c of candidates) {
    const found = listHelperBundles(c);
    if (found.length) {
      distDir = c;
      helpers = found;
      break;
    }
  }

  console.warn("[context-overflow-logger] init", {
    mainPath,
    distDir,
    tried: candidates,
    helperBundles: helpers.length,
    dryRun,
  });

  if (!distDir || helpers.length === 0) {
    console.warn("[context-overflow-logger] Could not locate dist helper bundles; no patch applied", {
      mainPath,
      tried: candidates,
    });
    return;
  }

  const results = helpers.map((f) => patchFile(f, { dryRun }));

  const summary = results.reduce(
    (acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  console.warn("[context-overflow-logger] patch results", { summary, results });
}
