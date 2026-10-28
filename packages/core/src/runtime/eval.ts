import { writeFileSync } from "node:fs";

import { z } from "zod";

import { jsonSchema, Fault, isFault, type Json } from "../core/json.ts";
import { q } from "../core/query.ts";
import { botlakeCall } from "./client.ts";
import { environmentSchema } from "./protocol.ts";

const evalOptionsSchema = z.compile(
  z.strictObject({
    socket: z.string().min(1),
    workspace: z.string().min(1),
    cwd: z.string().min(1),
    source: z.string(),
    filename: z.string(),
    deadline: z.number(),
  }),
);
const memberSchema = z.compile(z.object({ path: z.string() }));
const operationNameSchema = z.compile(z.string().min(1));

interface EvalAPI {
  call(name: string, input: Json): Promise<Json>;
}

try {
  const result = await run();
  writeFileSync(3, `${JSON.stringify({ ok: true, result })}\n`);
  process.exit(0);
} catch (error) {
  writeFileSync(
    3,
    `${JSON.stringify({
      ok: false,
      error: {
        type: "error",
        code: isFault(error) ? error.code : "eval",
        message: error instanceof Error ? error.message : String(error),
        details: isFault(error) ? error.details : null,
      },
    })}\n`,
  );
  process.exit(1);
}

// -- Private helpers --

async function run(): Promise<Json> {
  const options = evalOptionsSchema.parse(await Bun.stdin.json());
  const env = environmentSchema.parse(process.env);
  const remaining = (): number => {
    const ms = options.deadline - Date.now();
    if (ms <= 0) throw new Fault("deadline", "Eval deadline exceeded");
    return ms;
  };
  const signal = AbortSignal.timeout(remaining());
  const call = (operation: string, workspace: string, payload: Json): Promise<Json> =>
    botlakeCall(options.socket, { operation, workspace, cwd: options.cwd, payload }, signal);
  const member = memberSchema.parse(await call("lake-resolve", options.workspace, {}));
  const api: EvalAPI = {
    call(name, input) {
      return call("invoke", member.path, {
        name: operationNameSchema.parse(name),
        input: jsonSchema.parse(input),
        cwd: options.cwd,
        env,
        is_tty: false,
        tty_col: null,
        timeout_ms: remaining(),
      });
    },
  };
  // Trusted caller code, deliberately not a sandbox. Validate only its returned value.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/no-implied-eval
  const evaluate = new Function(
    "api",
    "q",
    `"use strict"; return (async () => {\n${options.source}\n})();\n//# sourceURL=${encodeURI(options.filename)}`,
  ) as (api: EvalAPI, query: typeof q) => Promise<unknown>;
  const result = await evaluate(api, q);
  if (result === undefined) throw new Fault("eval", "Eval must return a JSON value; use return");
  return jsonSchema.parse(result);
}
