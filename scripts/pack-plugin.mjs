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
  ['openclaw.plugin.json', path.join('dist', 'openclaw.plugin.json')],
];

function rewritePackagedManifest(rawManifest) {
  const manifest = JSON.parse(rawManifest);
  // Preserve the original entry path since it's already correct relative to dist/
  // manifest.entry = 'index.js';

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
  if (sourceName === 'openclaw.plugin.json') {
    const manifest = await fs.readFile(sourcePath, 'utf8');
    await fs.writeFile(targetPath, rewritePackagedManifest(manifest));
    continue;
  }

  await fs.cp(
    sourcePath,
    targetPath,
    { recursive: true },
  );
}

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
