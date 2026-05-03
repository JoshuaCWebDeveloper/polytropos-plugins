import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginName = process.argv[2];

if (!pluginName) {
  console.error('usage: node scripts/build-js-plugin.mjs <pluginName>');
  process.exit(2);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const pluginRoot = path.join(repoRoot, 'plugins', pluginName);
const sourcePath = path.join(pluginRoot, 'index.js');
const distDir = path.join(pluginRoot, 'dist');
const targetPath = path.join(distDir, 'index.js');

try {
  await fs.access(sourcePath);
} catch {
  console.error(`missing JS entry artifact: ${path.relative(repoRoot, sourcePath)}`);
  process.exit(1);
}

await fs.rm(distDir, { recursive: true, force: true });
await fs.mkdir(distDir, { recursive: true });
await fs.copyFile(sourcePath, targetPath);

console.log(`staged JS plugin artifact: ${path.relative(repoRoot, targetPath)}`);
