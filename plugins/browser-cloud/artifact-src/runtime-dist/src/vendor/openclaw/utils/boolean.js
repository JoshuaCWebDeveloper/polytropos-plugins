export function parseBooleanValue(value, opts) {
    if (typeof value === "boolean")
        return value;
    if (typeof value === "number" && Number.isFinite(value)) {
        if (value === 1)
            return true;
        if (value === 0)
            return false;
    }
    if (typeof value === "string") {
        const v = value.trim().toLowerCase();
        const truthy = (opts?.truthy ?? ["true", "1", "yes"]).map((s) => s.toLowerCase());
        const falsy = (opts?.falsy ?? ["false", "0", "no"]).map((s) => s.toLowerCase());
        if (truthy.includes(v))
            return true;
        if (falsy.includes(v))
            return false;
    }
    return undefined;
}
//# sourceMappingURL=boolean.js.map