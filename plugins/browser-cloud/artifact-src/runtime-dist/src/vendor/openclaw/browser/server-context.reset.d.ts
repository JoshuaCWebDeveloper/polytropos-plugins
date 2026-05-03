import type { ResolvedBrowserProfile } from "./config.ts";
import type { ProfileRuntimeState } from "./server-context.types.ts";
type ResetDeps = {
    profile: ResolvedBrowserProfile;
    getProfileState: () => ProfileRuntimeState;
    stopRunningBrowser: () => Promise<{
        stopped: boolean;
    }>;
    isHttpReachable: (timeoutMs?: number) => Promise<boolean>;
    resolveOpenClawUserDataDir: (profileName: string) => string;
};
type ResetOps = {
    resetProfile: () => Promise<{
        moved: boolean;
        from: string;
        to?: string;
    }>;
};
export declare function createProfileResetOps({ profile, getProfileState, stopRunningBrowser, isHttpReachable, resolveOpenClawUserDataDir, }: ResetDeps): ResetOps;
export {};
