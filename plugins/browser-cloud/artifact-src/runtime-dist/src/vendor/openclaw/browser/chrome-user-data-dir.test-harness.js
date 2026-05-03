import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll } from "vitest";
export function installChromeUserDataDirHooks(chromeUserDataDir) {
    beforeAll(async () => {
        chromeUserDataDir.dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-chrome-user-data-"));
    });
    afterAll(async () => {
        await fs.rm(chromeUserDataDir.dir, { recursive: true, force: true });
    });
}
//# sourceMappingURL=chrome-user-data-dir.test-harness.js.map