import { spawn } from "node:child_process";

export type ExecSecretProviderConfig = {
  source: "exec";
  command: string;
  args?: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  jsonOnly?: boolean;
  env?: Record<string, string>;
  passEnv?: string[];
  trustedDirs?: string[];
  allowInsecurePath?: boolean;
  allowSymlinkCommand?: boolean;
};

export type SecretsConfig = {
  providers?: Record<string, unknown>;
};

export type OpenClawConfigLike = {
  secrets?: SecretsConfig;
};

export type SecretRef = { source: "exec"; provider: string; id: string };

function readJsonPointer(obj: unknown, pointer: string): unknown {
  if (pointer === "" || pointer === "/") return obj;
  if (!pointer.startsWith("/")) {
    throw new Error(`Secret ref id must be a JSON pointer starting with '/': ${pointer}`);
  }
  const parts = pointer
    .split("/")
    .slice(1)
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur: any = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

export async function resolveExecSecretRef(params: {
  cfg: OpenClawConfigLike;
  ref: SecretRef;
  maxBytes?: number;
}): Promise<string> {
  const providerRaw = params.cfg?.secrets?.providers?.[params.ref.provider];
  if (!providerRaw || typeof providerRaw !== "object") {
    throw new Error(`Secret provider not configured: ${params.ref.provider}`);
  }
  const provider = providerRaw as Partial<ExecSecretProviderConfig>;
  if (provider.source !== "exec") {
    throw new Error(
      `Secret provider ${params.ref.provider} has source ${String(provider.source)} (expected exec)`,
    );
  }

  const command = String(provider.command ?? "").trim();
  if (!command) {
    throw new Error(`exec secret provider ${params.ref.provider} missing command`);
  }
  const args = Array.isArray(provider.args) ? provider.args.map(String) : [];

  const timeoutMs = Number.isFinite(provider.timeoutMs) ? Number(provider.timeoutMs) : 5000;
  const maxOutputBytes = Number.isFinite(provider.maxOutputBytes)
    ? Number(provider.maxOutputBytes)
    : 1024 * 1024;

  // Build env: explicit env map + passEnv allowlist.
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (provider.env && typeof provider.env === "object") {
    for (const [k, v] of Object.entries(provider.env)) {
      env[k] = String(v);
    }
  }
  if (Array.isArray(provider.passEnv) && provider.passEnv.length > 0) {
    // If passEnv is set, restrict to those + base PATH (avoid surprising failures).
    const restricted: Record<string, string> = {};
    for (const k of provider.passEnv) {
      if (k in env) restricted[k] = env[k];
    }
    if (env.PATH) restricted.PATH = env.PATH;
    // keep HOME so python can resolve user paths if needed
    if (env.HOME) restricted.HOME = env.HOME;
    // @ts-expect-error
    Object.assign(env, restricted);
  }

  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });

  const chunks: Buffer[] = [];
  const errChunks: Buffer[] = [];

  const timer = setTimeout(() => {
    child.kill("SIGKILL");
  }, timeoutMs);

  child.stdout.on("data", (d: Buffer) => {
    chunks.push(d);
    const size = chunks.reduce((n, b) => n + b.length, 0);
    if (size > maxOutputBytes) {
      child.kill("SIGKILL");
    }
  });

  child.stderr.on("data", (d: Buffer) => {
    errChunks.push(d);
  });

  const exitCode: number = await new Promise((resolve) => child.on("close", resolve));
  clearTimeout(timer);

  const stdout = Buffer.concat(chunks).toString("utf-8").trim();
  const stderr = Buffer.concat(errChunks).toString("utf-8").trim();

  if (exitCode !== 0) {
    throw new Error(`exec secret provider failed (code=${exitCode}): ${stderr || stdout}`);
  }

  const json = JSON.parse(stdout || "{}");
  const value = readJsonPointer(json, params.ref.id);
  const resolved = typeof value === "string" ? value : value == null ? "" : String(value);
  if (!resolved) {
    throw new Error(`Secret not found at ${params.ref.id} (provider=${params.ref.provider})`);
  }
  return resolved;
}
