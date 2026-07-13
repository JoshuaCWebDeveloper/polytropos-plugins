import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

const HOOKS_RELAY_CLI_METADATA: Parameters<OpenClawPluginApi["registerCli"]>[1] = {
  parentPath: ["hooks"],
  commands: ["relay"],
  descriptors: [
    {
      name: "relay",
      description: "Internal native harness hook relay",
      hasSubcommands: false,
    },
  ],
};

export function createPolytroposCliMetadataPlugin() {
  return {
    id: "polytropos-cli",
    name: "Polytropos CLI Metadata",
    description: "Claims Polytropos CLI command paths without loading the runtime plugin.",
    register(api: Pick<OpenClawPluginApi, "registerCli">) {
      api.registerCli(() => {}, HOOKS_RELAY_CLI_METADATA);
    },
  };
}

export default createPolytroposCliMetadataPlugin();
