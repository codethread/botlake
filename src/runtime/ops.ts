import type { StandardSchemaV1, StandardJSONSchemaV1 } from "@standard-schema/spec";

import { encode, Fault } from "../core/json.ts";
import type { Command } from "./cli.ts";
import { isStream } from "./runtime.ts";
import type { Context } from "./runtime.ts";

export interface Invocation {
  signal: AbortSignal;
  requestId: string;
  deadline: number;
}
export interface Op {
  name: string;
  cli: Command;
  about?: string | undefined;
  primer?: string | undefined;
  dependencies: string[];
  stream: boolean;
  invoke(input: unknown, ctx: Context, request: Invocation): Promise<unknown>;
  jsonSchema?: (() => unknown) | undefined;
}
export async function validate<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
  phase: "input" | "output" = "input",
): Promise<StandardSchemaV1.InferOutput<S>> {
  const result = await schema["~standard"].validate(value);
  if (result.issues !== undefined)
    throw new Fault(
      "validation",
      `${phase} schema validation failed`,
      result.issues.map((issue) => ({
        message: issue.message,
        ...(issue.path === undefined
          ? {}
          : {
              path: issue.path.map((segment) => {
                const key = typeof segment === "object" ? segment.key : segment;
                return typeof key === "symbol" ? String(key) : key;
              }),
            }),
      })),
    );
  return result.value;
}
export function defineOp<I extends StandardSchemaV1, O extends StandardSchemaV1>(descriptor: {
  name: string;
  input: I;
  output: O;
  cli: Command;
  about?: string;
  primer?: string;
  dependencies?: string[];
  stream?: boolean;
  jsonSchema?: { input: StandardJSONSchemaV1; output: StandardJSONSchemaV1 };
  handler(
    input: StandardSchemaV1.InferOutput<I>,
    ctx: Context,
    request: Invocation,
  ):
    | StandardSchemaV1.InferInput<O>
    | AsyncIterable<StandardSchemaV1.InferInput<O>>
    | Promise<StandardSchemaV1.InferInput<O> | AsyncIterable<StandardSchemaV1.InferInput<O>>>;
}): Op {
  return {
    name: descriptor.name,
    cli: descriptor.cli,
    about: descriptor.about ?? descriptor.cli.description,
    primer: descriptor.primer,
    dependencies: descriptor.dependencies ?? [],
    stream: descriptor.stream ?? false,
    jsonSchema:
      descriptor.jsonSchema === undefined
        ? undefined
        : () => ({
            input: descriptor.jsonSchema?.input["~standard"].jsonSchema.input({
              target: "draft-2020-12",
            }),
            output: descriptor.jsonSchema?.output["~standard"].jsonSchema.output({
              target: "draft-2020-12",
            }),
          }),
    async invoke(input, ctx, request) {
      const parsed = await validate(descriptor.input, input);
      request.signal.throwIfAborted();
      const result = await descriptor.handler(parsed, ctx, request);
      if (descriptor.stream === true) {
        if (!isStream(result))
          throw new Fault("output", "Streaming op must return an AsyncIterable");
        const iterable = result;
        async function* stream(): AsyncGenerator {
          for await (const item of iterable) {
            request.signal.throwIfAborted();
            const output = await validate(descriptor.output, item, "output");
            encode(output);
            yield output;
          }
        }
        return stream();
      }
      const output = await validate(descriptor.output, result, "output");
      encode(output);
      return output;
    },
  };
}
