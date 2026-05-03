export declare function ensureDir(dir: string): Promise<void>;
export declare function ensureMediaDir(): Promise<string>;
export declare function saveMediaBuffer(params: {
    buffer: Buffer;
    contentType: string;
    maxBytes: number;
}): Promise<{
    path: string;
}>;
