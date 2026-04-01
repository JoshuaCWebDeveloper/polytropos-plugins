import fs from 'node:fs/promises';
import path from 'node:path';

const mode = process.argv[2]; // symlink|copy
const src = process.argv[3];  // dist dir
const name = process.argv[4]; // plugin name

if (!mode || !src || !name) {
  console.error('usage: node scripts/deploy-plugin.mjs <symlink|copy> <distDir> <pluginName>');
  process.exit(2);
}

const home = process.env.HOME || '/home/ec2-user';
const destRoot = path.join(home, '.openclaw', 'extensions');
const dest = path.join(destRoot, name);

await fs.mkdir(destRoot, { recursive: true });

await fs.rm(dest, { recursive: true, force: true });

if (mode === 'symlink') {
  await fs.symlink(path.resolve(src), dest, 'dir');
  console.log(`symlinked ${dest} -> ${path.resolve(src)}`);
} else if (mode === 'copy') {
  await fs.cp(path.resolve(src), dest, { recursive: true });
  console.log(`copied ${path.resolve(src)} -> ${dest}`);
} else {
  console.error('mode must be symlink or copy');
  process.exit(2);
}
