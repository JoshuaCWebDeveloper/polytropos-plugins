import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const requireFromHere = createRequire(import.meta.url);

function findPackageRoot(startDir: string, name: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    const pkgPath = path.join(dir, "package.json");
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { name?: string };
      if (pkg.name === name) return dir;
    } catch {
      // ignore and keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function getRuntimeResolutionPaths(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = new Set<string>([
    here,
    path.join(here, ".."),
    process.cwd(),
    "/home/ec2-user/.npm-global/lib/node_modules/openclaw/node_modules",
    "/home/ec2-user/.npm-global/lib/node_modules/openclaw/node_modules/@discordjs/voice/node_modules",
  ]);

  const envRoot = process.env["OPENCLAW_ROOT"]?.trim();
  if (envRoot) {
    candidates.add(path.join(path.resolve(envRoot), "node_modules"));
  }

  const argv1 = process.argv[1];
  if (argv1) {
    const openclawRoot = findPackageRoot(path.dirname(argv1), "openclaw");
    if (openclawRoot) {
      candidates.add(path.join(openclawRoot, "node_modules"));
      candidates.add(path.join(openclawRoot, "node_modules", "@discordjs", "voice", "node_modules"));
    }
  }

  return [...candidates];
}

export function requireRuntimeModule<T = unknown>(specifier: string): T {
  const paths = getRuntimeResolutionPaths();
  try {
    const resolved = requireFromHere.resolve(specifier, { paths });
    return requireFromHere(resolved) as T;
  } catch (error) {
    throw new Error(
      `Missing runtime dependency "${specifier}". Searched: ${paths.join(", ")}. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function tryRequireRuntimeModule<T = unknown>(specifier: string): T | null {
  try {
    return requireRuntimeModule<T>(specifier);
  } catch {
    return null;
  }
}
