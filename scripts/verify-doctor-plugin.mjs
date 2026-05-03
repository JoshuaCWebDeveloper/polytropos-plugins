#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const pluginId = process.argv[2];
if (!pluginId) {
  console.error('usage: node scripts/verify-doctor-plugin.mjs <pluginId>');
  process.exit(2);
}

let out = '';
try {
  out = execFileSync('openclaw', ['doctor', '--non-interactive'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (err) {
  // doctor uses exit 0 typically; but fail hard if it doesn't.
  console.error('openclaw doctor failed');
  console.error(err?.stderr?.toString?.() ?? String(err));
  process.exit(1);
}

const needle = `plugins.entries.${pluginId}`;
const lines = out.split(/\r?\n/);
const matches = [];
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes(needle)) matches.push(`${i + 1}:${lines[i]}`);
}

if (matches.length) {
  console.error(`doctor reported warnings/errors for ${pluginId}:`);
  for (const m of matches.slice(0, 50)) console.error(m);
  if (matches.length > 50) console.error(`...and ${matches.length - 50} more lines`);
  process.exit(1);
}

console.log(`doctor ok for plugin: ${pluginId}`);
