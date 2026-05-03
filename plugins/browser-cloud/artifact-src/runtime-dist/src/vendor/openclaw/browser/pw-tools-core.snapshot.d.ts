import type { SsrFPolicy } from "../infra/net/ssrf.ts";
import { type AriaSnapshotNode } from "./pw-aria-snapshot.ts";
import { type RoleSnapshotOptions, type RoleRefMap } from "./pw-role-snapshot.ts";
export declare function snapshotAriaViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    limit?: number;
}): Promise<{
    nodes: AriaSnapshotNode[];
}>;
export declare function snapshotAiViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    timeoutMs?: number;
    maxChars?: number;
}): Promise<{
    snapshot: string;
    truncated?: boolean;
    refs: RoleRefMap;
}>;
export declare function snapshotRoleViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    selector?: string;
    frameSelector?: string;
    refsMode?: "role" | "aria";
    options?: RoleSnapshotOptions;
}): Promise<{
    snapshot: string;
    refs: Record<string, {
        role: string;
        name?: string;
        nth?: number;
    }>;
    stats: {
        lines: number;
        chars: number;
        refs: number;
        interactive: number;
    };
}>;
export declare function navigateViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    url: string;
    timeoutMs?: number;
    ssrfPolicy?: SsrFPolicy;
}): Promise<{
    url: string;
}>;
export declare function resizeViewportViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    width: number;
    height: number;
}): Promise<void>;
export declare function closePageViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
}): Promise<void>;
export declare function pdfViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
}): Promise<{
    buffer: Buffer;
}>;
