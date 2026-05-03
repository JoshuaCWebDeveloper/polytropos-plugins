import fs from "node:fs";
import path from "node:path";

// Least-invasive patch: extend isContextOverflowError() detection to match
//  - provider code: context_length_exceeded
//  - provider phrasing: "exceeds the context window" / "context window of this model"
//
// This makes OpenClaw's existing overflow recovery (auto-compaction + toolResult truncation + retry)
// reliably trigger for Codex/OpenAI-style errors.

const NEEDLE = "lower.includes(\"context length exceeded\")";
const INJECT =
  "lower.includes(\"context_length_exceeded\") || " +
  "lower.includes(\"exceeds the context window\") || " +
  "lower.includes(\"context window of this model\")";

function listDistJsFiles(distDir: string): string[] {
  try {
    return fs
      .readdirSync(distDir)
      .filter((f) => f.endsWith(".js"))
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

function patchFile(
  filePath: string,
  { dryRun }: { dryRun: boolean },
): { filePath: string; status: "already" | "patched" | "not-found" | "error"; reason?: string } {
  try {
    const text = fs.readFileSync(filePath, "utf8");

    // Skip quickly if this file doesn't contain the needle at all.
    if (!text.includes(NEEDLE)) return { filePath, status: "not-found" };

    // If it already contains all of our injected markers, treat as already.
    // (This is intentionally simple string matching; duplication is harmless.)
    const hasAll =
      text.includes("context_length_exceeded") &&
      text.toLowerCase().includes("exceeds the context window") &&
      text.toLowerCase().includes("context window of this model");
    if (hasAll) return { filePath, status: "already" };

    // Replace one occurrence of NEEDLE with compound detection.
    const next = text.replace(NEEDLE, `${NEEDLE} || ${INJECT}`);

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
  const pluginCfg = cfg?.plugins?.entries?.["context-overflow-detection-fix"]?.config ?? {};
  const enabled = pluginCfg.enabled !== false;
  const dryRun = pluginCfg.dryRun === true;

  if (!enabled) {
    console.warn("[context-overflow-detection-fix] disabled by config");
    return;
  }

  const mainPath = (process.argv?.[1] ?? "") || (require.main?.filename ?? "");
  const candidates = resolveDistDirCandidates(mainPath);

  let distDir = "";
  let files: string[] = [];
  for (const c of candidates) {
    const found = listDistJsFiles(c);
    if (found.length) {
      distDir = c;
      files = found;
      break;
    }
  }

  console.warn("[context-overflow-detection-fix] init", {
    mainPath,
    distDir,
    tried: candidates,
    jsFiles: files.length,
    dryRun,
  });

  if (!distDir || files.length === 0) {
    console.warn("[context-overflow-detection-fix] Could not locate dist JS files; no patch applied", {
      mainPath,
      tried: candidates,
    });
    return;
  }

  const results = files.map((f) => patchFile(f, { dryRun })).filter((r) => r.status !== "not-found");
  const summary = results.reduce(
    (acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  console.warn("[context-overflow-detection-fix] patch results", { summary, results });
}
