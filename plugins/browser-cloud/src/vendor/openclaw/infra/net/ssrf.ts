import dns from "node:dns/promises";
import net from "node:net";

export type LookupFn = (hostname: string) => Promise<string[]>;

export type SsrFPolicy = {
  /**
   * Minimal compatibility shim for the core gateway SSRF policy.
   * This plugin defaults to permissive behavior; callers may still pass a policy object.
   */
  allowPrivate?: boolean;
  pinnedHostnames?: Record<string, string>;
};

export class SsrFBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrFBlockedError";
  }
}

export function isPrivateNetworkAllowedByPolicy(policy?: SsrFPolicy): boolean {
  // Default permissive policy for the plugin unless explicitly disabled.
  if (!policy) return true;
  if (policy.allowPrivate === undefined) return true;
  return Boolean(policy.allowPrivate);
}

function resolvePinnedHostname(hostname: string, policy?: SsrFPolicy): string {
  const pinned = policy?.pinnedHostnames?.[hostname];
  return typeof pinned === "string" && pinned.trim() ? pinned.trim() : hostname;
}

function isPrivateIp(ip: string): boolean {
  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split(".").map((n) => Number.parseInt(n ?? "", 10));
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    return false;
  }
  if (net.isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local
    if (lower.startsWith("fe80:")) return true; // link-local
    return false;
  }
  return false;
}

export async function defaultLookup(hostname: string): Promise<string[]> {
  const res = await dns.lookup(hostname, { all: true });
  return res.map((r) => r.address);
}

export async function resolvePinnedHostnameWithPolicy(
  hostname: string,
  opts?: { policy?: SsrFPolicy; lookupFn?: LookupFn },
): Promise<string> {
  const resolvedHost = resolvePinnedHostname(hostname, opts?.policy);
  if (isPrivateNetworkAllowedByPolicy(opts?.policy)) {
    return resolvedHost;
  }
  const lookup = opts?.lookupFn ?? defaultLookup;
  const ips = await lookup(resolvedHost);
  if (ips.some((ip) => isPrivateIp(ip))) {
    throw new SsrFBlockedError(`SSRF blocked by policy for host: ${resolvedHost}`);
  }
  return resolvedHost;
}
