import net from "node:net";

export function isLoopbackHost(hostname: string): boolean {
  const host = String(hostname ?? "").trim().toLowerCase();
  if (!host) return false;
  if (host === "localhost") return true;
  if (host === "127.0.0.1") return true;
  if (host === "::1") return true;
  // Normalize IPv6 bracket form if ever passed in.
  if (host === "[::1]") return true;
  return false;
}

export function isLoopbackAddress(address: string): boolean {
  const addr = String(address ?? "").trim();
  if (!addr) return false;
  if (addr === "::1" || addr === "[::1]" || addr === "127.0.0.1") return true;
  // Accept any 127.0.0.0/8.
  if (net.isIP(addr) === 4 && addr.startsWith("127.")) return true;
  return false;
}

