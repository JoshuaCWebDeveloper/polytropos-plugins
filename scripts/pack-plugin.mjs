import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginName = process.argv[2];

if (!pluginName) {
  console.error('usage: node scripts/pack-plugin.mjs <pluginName>');
  process.exit(2);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const pluginRoot = path.join(repoRoot, 'plugins', pluginName);
const outputRoot = path.join(repoRoot, 'dist', 'plugins', pluginName);

const requiredEntries = [
  ['dist', 'dist'],
  ['package.json', 'package.json'],
];

function rewritePackagedManifestForRoot(rawManifest) {
  // Root deploy convention: OpenClaw points at `dist/plugins/<name>`, so the
  // manifest entry must include the `dist/` prefix (e.g. `dist/index.js`).
  const manifest = JSON.parse(rawManifest);
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function rewritePackagedManifestForDistDir(rawManifest) {
  // Alternate deploy convention: OpenClaw points at `dist/plugins/<name>/dist`,
  // so the manifest entry must be relative to that folder (e.g. `index.js`).
  const manifest = JSON.parse(rawManifest);
  if (typeof manifest.entry === 'string' && manifest.entry.startsWith('dist/')) {
    manifest.entry = manifest.entry.slice('dist/'.length);
  }

  return `${JSON.stringify(manifest, null, 2)}\n`;
}

for (const [sourceName] of requiredEntries) {
  const sourcePath = path.join(pluginRoot, sourceName);

  try {
    await fs.access(sourcePath);
  } catch {
    console.error(`missing required plugin artifact: ${path.relative(repoRoot, sourcePath)}`);
    process.exit(1);
  }
}

await fs.rm(outputRoot, { recursive: true, force: true });
await fs.mkdir(outputRoot, { recursive: true });

for (const [sourceName, targetName] of requiredEntries) {
  const sourcePath = path.join(pluginRoot, sourceName);
  const targetPath = path.join(outputRoot, targetName);

  await fs.cp(
    sourcePath,
    targetPath,
    { recursive: true },
  );
}

const sourceManifestPath = path.join(pluginRoot, 'openclaw.plugin.json');
const rawManifest = await fs.readFile(sourceManifestPath, 'utf8');
const rootManifest = rewritePackagedManifestForRoot(rawManifest);
const distDirManifest = rewritePackagedManifestForDistDir(rawManifest);

await fs.writeFile(path.join(outputRoot, 'openclaw.plugin.json'), rootManifest);
await fs.mkdir(path.join(outputRoot, 'dist'), { recursive: true });
await fs.writeFile(path.join(outputRoot, 'dist', 'openclaw.plugin.json'), distDirManifest);

const hooksPath = path.join(pluginRoot, 'hooks');

try {
  const hooksStats = await fs.stat(hooksPath);
  if (hooksStats.isDirectory()) {
    await fs.cp(hooksPath, path.join(outputRoot, 'hooks'), { recursive: true });
  }
} catch (error) {
  if (error && error.code !== 'ENOENT') {
    throw error;
  }
}

console.log(`packed ${pluginName} -> ${path.relative(repoRoot, outputRoot)}`);
