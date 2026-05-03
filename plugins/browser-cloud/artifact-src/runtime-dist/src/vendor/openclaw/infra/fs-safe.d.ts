import fs from "node:fs/promises";
export declare class SafeOpenError extends Error {
    code: "not-found" | "outside-workspace" | "invalid";
    constructor(code: SafeOpenError["code"], message: string);
}
export declare function openFileWithinRoot(opts: {
    rootDir: string;
    relativePath: string;
}): Promise<{
    handle: fs.FileHandle;
    realPath: string;
}>;
