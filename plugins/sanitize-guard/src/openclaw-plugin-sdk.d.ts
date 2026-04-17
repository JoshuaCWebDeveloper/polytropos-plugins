declare module "openclaw/plugin-sdk" {
  export type OpenClawPluginApi = any;
  export type HookHandler = (event: any) => Promise<void> | void;
  export function registerPluginHooksFromDir(api: any, dir: string): void;
  export function isAgentBootstrapEvent(event: any): boolean;
  export function resolveHookConfig(cfg: any, hookKey: string): any;
}
