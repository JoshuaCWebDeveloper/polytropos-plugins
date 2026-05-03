import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { resolvePreferredOpenClawTmpDir } from "./vendor/openclaw/infra/tmp-openclaw-dir.ts";

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

function extForContentType(contentType: string): string {
  const ct = contentType.toLowerCase();
  if (ct.includes("png")) return "png";
  if (ct.includes("jpeg") || ct.includes("jpg")) return "jpg";
  if (ct.includes("pdf")) return "pdf";
  if (ct.includes("text/plain")) return "txt";
  return "bin";
}

export async function ensureMediaDir(): Promise<string> {
  const dir = path.join(resolvePreferredOpenClawTmpDir(), "media", "browser");
  await ensureDir(dir);
  return dir;
}

export async function saveMediaBuffer(params: {
  buffer: Buffer;
  contentType: string;
  maxBytes: number;
}): Promise<{ path: string }> {
  if (params.buffer.byteLength > params.maxBytes) {
    throw new Error(
      `media exceeds maxBytes (${params.buffer.byteLength} > ${params.maxBytes})`,
    );
  }
  const dir = await ensureMediaDir();
  const id = crypto.randomUUID();
  const ext = extForContentType(params.contentType);
  const filePath = path.join(dir, `${id}.${ext}`);
  await fs.writeFile(filePath, params.buffer);
  return { path: filePath };
}

