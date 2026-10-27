import stringify from "fast-json-stable-stringify";
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

// A worker and its installed extensions can resolve separate copies of this package.

const faultBrand = Symbol.for("@botlake/core/Fault");

export class Fault extends Error {
  readonly [faultBrand] = true;
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: Json = null,
  ) {
    super(message);
    this.name = "Fault";
  }
}

export function isFault(value: unknown): value is Fault {
  return value instanceof Error && faultBrand in value && value[faultBrand] === true;
}

export function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Fault("not-found", message);
  return value;
}

export function canonical(value: Json): string {
  return stringify(z.json().parse(value));
}
