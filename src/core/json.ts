import { z } from "zod";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Attributes = Record<string, Json>;
export const attributesSchema = z.record(z.string().min(1), z.json());
export function encode(value: unknown): string {
  return JSON.stringify(z.json().parse(value));
}
export function decode(text: string): Json {
  return z.json().parse(JSON.parse(text));
}
export function object(text: string): Attributes {
  return attributesSchema.parse(JSON.parse(text));
}
export function merge(base: Attributes, patch: Attributes): Attributes {
  const result = new Map(Object.entries(base));
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) result.delete(key);
    else if (typeof value === "object" && !Array.isArray(value)) {
      const previous = result.get(key);
      result.set(
        key,
        merge(
          typeof previous === "object" && previous !== null && !Array.isArray(previous)
            ? previous
            : {},
          value,
        ),
      );
    } else result.set(key, value);
  }
  return Object.fromEntries(result);
}
export class Fault extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: Json = null,
  ) {
    super(message);
    this.name = "Fault";
  }
}
export function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Fault("not-found", message);
  return value;
}

export function canonical(value: Json): string {
  function sorted(item: Json): Json {
    if (Array.isArray(item)) return item.map((entry) => sorted(entry));
    if (item !== null && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item)
          .toSorted(([left], [right]) => (left === right ? 0 : left < right ? -1 : 1))
          .map(([key, entry]) => [key, sorted(entry)]),
      );
    return item;
  }
  return encode(sorted(value));
}
