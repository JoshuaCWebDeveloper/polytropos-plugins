import path from "node:path";
export function isNotFoundPathError(err) {
    return (typeof err === "object" &&
        err !== null &&
        "code" in err &&
        err.code === "ENOENT");
}
export function isPathInside(root, candidate) {
    const rel = path.relative(root, candidate);
    return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}
//# sourceMappingURL=path-guards.js.map