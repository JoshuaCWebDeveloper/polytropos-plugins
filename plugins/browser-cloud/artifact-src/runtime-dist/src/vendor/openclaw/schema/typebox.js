import { Type } from "@sinclair/typebox";
export function stringEnum(values) {
    return Type.Union(values.map((v) => Type.Literal(v)));
}
export function optionalStringEnum(values) {
    return Type.Optional(stringEnum(values));
}
//# sourceMappingURL=typebox.js.map