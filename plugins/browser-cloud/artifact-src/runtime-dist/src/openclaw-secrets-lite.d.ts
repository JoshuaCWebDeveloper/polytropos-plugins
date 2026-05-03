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
export type SecretRef = {
    source: "exec";
    provider: string;
    id: string;
};
export declare function resolveExecSecretRef(params: {
    cfg: OpenClawConfigLike;
    ref: SecretRef;
    maxBytes?: number;
}): Promise<string>;
