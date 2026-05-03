import os from "node:os";
import path from "node:path";
export function resolvePreferredOpenClawTmpDir() {
    const env = process.env.OPENCLAW_TMP_DIR || process.env.OPENCLAW_TEMP_DIR;
    if (typeof env === "string" && env.trim()) {
        return path.resolve(env.trim());
    }
    return path.join(os.tmpdir(), "openclaw");
}
//# sourceMappingURL=tmp-openclaw-dir.js.map