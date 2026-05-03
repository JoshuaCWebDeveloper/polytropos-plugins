export type LookupFn = (hostname: string) => Promise<string[]>;
export type SsrFPolicy = {
    /**
     * Minimal compatibility shim for the core gateway SSRF policy.
     * This plugin defaults to permissive behavior; callers may still pass a policy object.
     */
    allowPrivate?: boolean;
    pinnedHostnames?: Record<string, string>;
};
export declare class SsrFBlockedError extends Error {
    constructor(message: string);
}
export declare function isPrivateNetworkAllowedByPolicy(policy?: SsrFPolicy): boolean;
export declare function defaultLookup(hostname: string): Promise<string[]>;
export declare function resolvePinnedHostnameWithPolicy(hostname: string, opts?: {
    policy?: SsrFPolicy;
    lookupFn?: LookupFn;
}): Promise<string>;
