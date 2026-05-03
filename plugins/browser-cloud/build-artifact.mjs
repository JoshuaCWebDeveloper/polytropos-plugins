import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.join(pluginRoot, "artifact-src", "runtime-dist");
const outputRoot = path.join(pluginRoot, "dist");

const jsLikeExtensions = new Set([".js", ".d.ts"]);
const tsSpecifierPattern =
  /((?:from\s+["'])|(?:import\s*\(\s*["'])|(?:export\s+\*\s+from\s+["']))([^"'()]*?)\.ts(["'])/g;

async function rewriteTsSpecifiers(targetPath) {
  const source = await fs.readFile(targetPath, "utf8");
  const rewritten = source.replace(tsSpecifierPattern, "$1$2.js$3");
  if (rewritten !== source) {
    await fs.writeFile(targetPath, rewritten);
  }
}

async function walkAndRewrite(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const targetPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkAndRewrite(targetPath);
      continue;
    }

    if (jsLikeExtensions.has(path.extname(entry.name))) {
      await rewriteTsSpecifiers(targetPath);
    }
  }
}

try {
  await fs.access(sourceRoot);
} catch {
  console.error(`missing artifact source runtime: ${sourceRoot}`);
  process.exit(1);
}

await fs.rm(outputRoot, { recursive: true, force: true });
await fs.cp(sourceRoot, outputRoot, { recursive: true });
await walkAndRewrite(outputRoot);

console.log(`staged browser-cloud runtime: ${path.relative(pluginRoot, outputRoot)}`);
