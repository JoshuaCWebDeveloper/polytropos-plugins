import fs from "node:fs/promises";
import path from "node:path";
import { isNotFoundPathError, isPathInside } from "./path-guards.ts";

export class SafeOpenError extends Error {
  code: "not-found" | "outside-workspace" | "invalid";
  constructor(code: SafeOpenError["code"], message: string) {
    super(message);
    this.name = "SafeOpenError";
    this.code = code;
  }
}

export async function openFileWithinRoot(opts: {
  rootDir: string;
  relativePath: string;
}): Promise<{ handle: fs.FileHandle; realPath: string }> {
  const rootDir = path.resolve(opts.rootDir);
  const rootReal = await fs.realpath(rootDir).catch(() => null);
  if (!rootReal) {
    throw new SafeOpenError("invalid", "root not found");
  }

  const rel = opts.relativePath.replace(/^\/+/, "");
  const abs = path.resolve(rootDir, rel);
  const real = await fs.realpath(abs).catch((err) => {
    if (isNotFoundPathError(err)) {
      throw new SafeOpenError("not-found", "file not found");
    }
    throw new SafeOpenError("invalid", "invalid path");
  });

  if (!isPathInside(rootReal, real)) {
    throw new SafeOpenError("outside-workspace", "outside root");
  }

  const st = await fs.lstat(real);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink > 1) {
    throw new SafeOpenError("invalid", "not a regular file");
  }

  const handle = await fs.open(real, "r");
  return { handle, realPath: real };
}

