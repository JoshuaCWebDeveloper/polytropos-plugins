declare function uploadFilesToPage(opts: {
    cdpUrl: string;
    targetId: string;
    paths: string[];
    timeoutMs?: number;
}): Promise<void>;
export { uploadFilesToPage };
