import { Type } from "@sinclair/typebox";

export function stringEnum<const T extends readonly string[]>(values: T) {
  return Type.Union(values.map((v) => Type.Literal(v)));
}

export function optionalStringEnum<const T extends readonly string[]>(values: T) {
  return Type.Optional(stringEnum(values));
}

