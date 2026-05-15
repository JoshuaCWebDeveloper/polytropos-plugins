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
        // Canonical contract: plugin root is dist/ (manifest directory).
        // We intentionally do NOT support root-level manifests for packaged plugins.
        path.join(resolvedCandidate, 'dist', 'openclaw.plugin.json'),
      ];

  for (const manifestPath of manifestCandidates) {
    if (!(await pathExists(manifestPath))) {
      continue;
    }

    const manifestDir = path.dirname(manifestPath);
    // Canonical rule: plugin root is the directory containing openclaw.plugin.json.
    // This is the directory OpenClaw should be pointed at (symlink/copy source).
    const pluginRoot = manifestDir;
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
const resolvedCandidate = path.resolve(src);

await fs.mkdir(destRoot, { recursive: true });

await fs.rm(dest, { recursive: true, force: true });

async function readPackageJson(rootDir) {
  const pkgPath = path.join(rootDir, 'package.json');
  try {
    const raw = await fs.readFile(pkgPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function hasRuntimeDeps(pkg) {
  if (!pkg || typeof pkg !== 'object') return false;
  const deps = pkg.dependencies && typeof pkg.dependencies === 'object' ? Object.keys(pkg.dependencies) : [];
  const optDeps = pkg.optionalDependencies && typeof pkg.optionalDependencies === 'object' ? Object.keys(pkg.optionalDependencies) : [];
  return deps.length + optDeps.length > 0;
}

async function materializeRuntimeDeps(pluginDir, pkg) {
  if (!(await hasRuntimeDeps(pkg))) return;

  // Deploy is meant to produce runnable extensions under ~/.openclaw/extensions/<name>.
  // For external plugins, that means runtime deps must exist relative to that plugin dir.
  // Install prod deps only, and never run install scripts.
  console.log(`[deploy] installing runtime deps for ${name}...`);
  const { spawn } = await import('node:child_process');
  await new Promise((resolve, reject) => {
    const child = spawn(
      'npm',
      ['install', '--omit=dev', '--no-save', '--silent', '--ignore-scripts'],
      { cwd: pluginDir, stdio: 'inherit' },
    );
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npm install failed (code ${code})`));
    });
  });
}

if (mode === 'symlink') {
  await fs.symlink(resolvedRoot, dest, 'dir');
  console.log(`symlinked ${dest} -> ${resolvedRoot}`);
  // In symlink mode, the source tree is the runtime tree, so we do not run installs here.
  // (If desired, callers should install deps in the source tree.)
} else if (mode === 'copy') {
  await fs.cp(resolvedRoot, dest, { recursive: true });
  console.log(`copied ${resolvedRoot} -> ${dest}`);

  // If we copied from a parent artifact root, also copy package.json into the deployed
  // plugin root so dependency materialization can occur.
  // Example source shape:
  //   dist/plugins/<id>/{ package.json, dist/openclaw.plugin.json, dist/index.js }
  // Example deployed plugin root shape:
  //   ~/.openclaw/extensions/<id>/{ openclaw.plugin.json, index.js, package.json }
  if (!resolvedCandidate.endsWith('openclaw.plugin.json') && !resolvedCandidate.endsWith(path.join('dist'))) {
    const candidatePkg = path.join(resolvedCandidate, 'package.json');
    if (await pathExists(candidatePkg)) {
      await fs.copyFile(candidatePkg, path.join(dest, 'package.json'));
    }
  }

  const pkg = await readPackageJson(dest);
  if (await hasRuntimeDeps(pkg)) {
    await materializeRuntimeDeps(dest, pkg);
  }
} else {
  console.error('mode must be symlink or copy');
  process.exit(2);
}
