import fs from 'node:fs/promises';
import path from 'node:path';

const mode = process.argv[2]; // symlink|copy
const src = process.argv[3];  // candidate plugin root or manifest path
const name = process.argv[4]; // plugin name

if (!mode || !src || !name) {
  console.error('usage: node scripts/deploy-plugin.mjs <symlink|copy> <pluginRootOrManifestPath> <pluginName>');
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

async function resolvePluginRoot(candidatePath, pluginName) {
  const resolvedCandidate = path.resolve(candidatePath);
  const manifestCandidates = resolvedCandidate.endsWith('openclaw.plugin.json')
    ? [resolvedCandidate]
    : [
        path.join(resolvedCandidate, 'openclaw.plugin.json'),
        path.join(resolvedCandidate, 'dist', 'openclaw.plugin.json'),
      ];

  for (const manifestPath of manifestCandidates) {
    if (!(await pathExists(manifestPath))) {
      continue;
    }

    const manifestDir = path.dirname(manifestPath);
    const pluginRoot = path.basename(manifestDir) === 'dist'
      ? path.dirname(manifestDir)
      : manifestDir;
    const rawManifest = await fs.readFile(manifestPath, 'utf8');

    let manifest;
    try {
      manifest = JSON.parse(rawManifest);
    } catch (error) {
      console.error(`invalid manifest JSON for ${pluginName}: ${manifestPath}`);
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }

    if (manifest.id !== pluginName) {
      console.error(
        `manifest id mismatch for ${pluginName}: expected "${pluginName}", found "${manifest.id ?? '<missing>'}" in ${manifestPath}`,
      );
      process.exit(1);
    }

    if (typeof manifest.entry !== 'string' || manifest.entry.length === 0) {
      console.error(`manifest entry missing for ${pluginName}: ${manifestPath}`);
      process.exit(1);
    }

    const entryPath = path.resolve(path.dirname(manifestPath), manifest.entry);
    if (!(await pathExists(entryPath))) {
      console.error(
        `manifest entry does not exist for ${pluginName}: ${manifest.entry} (resolved to ${entryPath})`,
      );
      process.exit(1);
    }

    return pluginRoot;
  }

  console.error(
    `could not resolve plugin root for ${pluginName} from ${resolvedCandidate}; expected ${path.join(resolvedCandidate, 'openclaw.plugin.json')} or ${path.join(resolvedCandidate, 'dist', 'openclaw.plugin.json')}`,
  );
  process.exit(1);
}

const home = process.env.HOME || '/home/ec2-user';
const destRoot = path.join(home, '.openclaw', 'extensions');
const dest = path.join(destRoot, name);
const resolvedRoot = await resolvePluginRoot(src, name);

await fs.mkdir(destRoot, { recursive: true });

await fs.rm(dest, { recursive: true, force: true });

if (mode === 'symlink') {
  await fs.symlink(resolvedRoot, dest, 'dir');
  console.log(`symlinked ${dest} -> ${resolvedRoot}`);
} else if (mode === 'copy') {
  await fs.cp(resolvedRoot, dest, { recursive: true });
  console.log(`copied ${resolvedRoot} -> ${dest}`);
} else {
  console.error('mode must be symlink or copy');
  process.exit(2);
}
