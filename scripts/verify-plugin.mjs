import fs from 'node:fs/promises';
import path from 'node:path';

const pluginName = process.argv[2];

if (!pluginName) {
  console.error('usage: node scripts/verify-plugin.mjs <pluginName>');
  process.exit(2);
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const artifactRoot = path.resolve('dist', 'plugins', pluginName);
const manifestPath = path.join(artifactRoot, 'dist', 'openclaw.plugin.json');

if (!(await pathExists(artifactRoot))) {
  fail(`missing plugin artifact root: ${artifactRoot}`);
}

if (!(await pathExists(manifestPath))) {
  fail(`missing packaged manifest: ${manifestPath}`);
}

let manifest;
try {
  manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
} catch (error) {
  fail(
    `invalid packaged manifest JSON: ${manifestPath}\n${error instanceof Error ? error.message : String(error)}`,
  );
}

if (manifest.id !== pluginName) {
  fail(`manifest id mismatch: expected "${pluginName}", found "${manifest.id ?? '<missing>'}"`);
}

if (typeof manifest.entry !== 'string' || manifest.entry.length === 0) {
  fail(`manifest entry missing: ${manifestPath}`);
}

const entryPath = path.resolve(path.dirname(manifestPath), manifest.entry);

if (!(await pathExists(entryPath))) {
  fail(`manifest entry does not exist: ${manifest.entry} (resolved to ${entryPath})`);
}

const packageJsonPath = path.join(artifactRoot, 'package.json');
if (!(await pathExists(packageJsonPath))) {
  fail(`missing packaged package.json: ${packageJsonPath}`);
}

console.log(`verified plugin artifact: ${pluginName}`);
console.log(`root: ${artifactRoot}`);
console.log(`manifest: ${manifestPath}`);
console.log(`entry: ${entryPath}`);
