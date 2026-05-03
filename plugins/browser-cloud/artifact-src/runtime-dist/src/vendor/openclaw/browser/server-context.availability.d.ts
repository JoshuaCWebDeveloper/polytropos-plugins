import type { ResolvedBrowserProfile } from "./config.ts";
import type { BrowserServerState, ContextOptions, ProfileRuntimeState } from "./server-context.types.ts";
type AvailabilityDeps = {
    opts: ContextOptions;
    profile: ResolvedBrowserProfile;
    state: () => BrowserServerState;
    getProfileState: () => ProfileRuntimeState;
    setProfileRunning: (running: ProfileRuntimeState["running"]) => void;
};
type AvailabilityOps = {
    isHttpReachable: (timeoutMs?: number) => Promise<boolean>;
    isReachable: (timeoutMs?: number) => Promise<boolean>;
    ensureBrowserAvailable: () => Promise<void>;
    stopRunningBrowser: () => Promise<{
        stopped: boolean;
    }>;
};
export declare function createProfileAvailability({ opts, profile, state, getProfileState, setProfileRunning, }: AvailabilityDeps): AvailabilityOps;
export {};
