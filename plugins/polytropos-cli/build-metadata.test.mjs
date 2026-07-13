import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(pluginRoot, "../..");

test("plugin build emits lightweight CLI metadata for wrapper claim discovery", async () => {
  const packagedMetadataPath = path.join(
    repoRoot,
    "dist/plugins/polytropos-cli/dist/cli-metadata.js",
  );
  const source = await fs.readFile(packagedMetadataPath, "utf8");

  assert.match(source, /parentPath:\s*\[\s*"hooks"\s*\]/);
  assert.match(source, /commands:\s*\[\s*"relay"\s*\]/);
  assert.doesNotMatch(source, /from\s+["']\.\/index\.js["']/);
});

test("wrapper-facing hooks relay claim is discoverable from the packaged plugin", async () => {
  const { loadPolytroposCliClaims, resolvePolytroposCliClaim } = await import(
    pathToFileURL(path.join(repoRoot, "node_modules/openclaw/polytropos.mjs")).href
  );
  const packagedPluginRoot = path.join(repoRoot, "dist/plugins/polytropos-cli");
  const claims = await loadPolytroposCliClaims({ roots: [packagedPluginRoot] });
  const claim = resolvePolytroposCliClaim(
    ["node", "polytropos.mjs", "hooks", "relay"],
    claims,
  );

  assert.deepEqual(claim && {
    pluginId: claim.pluginId,
    commandPath: claim.commandPath,
    parentPath: claim.parentPath,
    command: claim.command,
  }, {
    pluginId: "polytropos-cli",
    commandPath: ["hooks", "relay"],
    parentPath: ["hooks"],
    command: "relay",
  });
});
