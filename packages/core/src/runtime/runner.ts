import { resolve } from "node:path";

import { z } from "zod";

import { encode, Fault, isFault } from "../core/json.ts";
import { botlakeServices } from "./custody.ts";
import { loadLakeConfig } from "./lake.ts";
import { invocationSchema } from "./protocol.ts";
import { Runtime, isStream } from "./runtime.ts";

const wireVersion = 1;
const launchSchema = z.compile(
  z.object({
    workspace: z.string(),
    generation: z.string().min(1),
    socket: z.string().min(1),
    botlakeSocket: z.string().min(1),
    env: z.record(z.string(), z.string()),
  }),
);
const controlSchema = z.compile(
  z.discriminatedUnion("kind", [
    z.strictObject({
      v: z.literal(wireVersion),
      kind: z.literal("activate"),
      generation: z.string(),
    }),
    z.strictObject({
      v: z.literal(wireVersion),
      kind: z.literal("drain"),
      generation: z.string(),
      reason: z.enum(["restart", "stop"]),
      finish_ms: z.number(),
    }),
  ]),
);

const launch = launchSchema.parse(JSON.parse(process.env["BOTLAKE_LAUNCH"] ?? ""));
const output = Bun.file(3).writer();
const lease = Bun.file(4);
const controllers = new Map<string, AbortController>();
let runtime: Runtime | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let phase: "prepare" | "prepared" | "ready" | "stopped" = "prepare";
function currentPhase(): typeof phase {
  return phase;
}

function send(message: unknown): void {
  void output.write(`${JSON.stringify(message)}\n`);
  void output.flush();
}

function failure(error: unknown): {
  type: "error";
  code: string;
  message: string;
  details: unknown;
} {
  return {
    type: "error",
    code: isFault(error) ? error.code : "runtime",
    message: error instanceof Error ? error.message : String(error),
    details: isFault(error)
      ? error.details
      : error instanceof AggregateError
        ? error.errors.map(failure)
        : null,
  };
}

async function stop(_reason: "restart" | "stop", finishMs: number): Promise<void> {
  if (phase === "stopped") return;
  void server?.stop(false);
  const deadline = performance.now() + finishMs;
  while (controllers.size > 0 && performance.now() < deadline) {
    await Bun.sleep(Math.min(10, deadline - performance.now()));
  }
  for (const controller of controllers.values()) {
    controller.abort(new Fault("drained", "Lake invocation was interrupted by drain"));
  }
  await server?.stop(true);
  await runtime?.stop();
  phase = "stopped";
  send({ v: wireVersion, kind: "stopped", generation: launch.generation });
  void output.end();
  await lease.exists();
  process.exit(0);
}

async function activate(info: Awaited<ReturnType<typeof loadLakeConfig>>): Promise<void> {
  const activeRuntime = new Runtime({
    database: resolve(launch.workspace, ".botlake/world.db"),
    workspace: launch.workspace,
    env: launch.env,
    ...botlakeServices(launch.botlakeSocket, launch.workspace),
  });
  runtime = activeRuntime;
  await activeRuntime.start(info.config.extensions);
  // @ts-expect-error Bun's Unix types omit idleTimeout: oven-sh/bun#46138.
  server = Bun.serve({
    unix: launch.socket,
    // Invocation deadlines own lifetime; quiet streams and handlers must stay connected.
    idleTimeout: 0,
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/invoke")
        return Response.json(failure(new Fault("request", "Unknown lake endpoint")), {
          status: 404,
        });
      try {
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > 4 * 1024 * 1024)
          throw new Fault("request-too-large", "Invocation request exceeds 4 MiB");
        const invocation = invocationSchema.parse(JSON.parse(raw));
        if (
          invocation.workspace !== launch.workspace ||
          invocation.generation !== launch.generation
        )
          throw new Fault("generation", "Invocation generation does not match the live lake");
        const invocationId = invocation.invocation_id ?? invocation.request_id;
        const abort = new AbortController();
        controllers.set(invocationId, abort);
        let streaming = false;
        let textOutput = false;
        async function* invoke(): AsyncGenerator {
          try {
            const result = await activeRuntime.invoke(
              invocation.name,
              invocation.argv ?? ("input" in invocation ? invocation.input : {}),
              {
                ...(invocation.argv === undefined ? {} : { argv: true }),
                ...(invocation.timeout_ms === undefined
                  ? {}
                  : { timeoutMs: invocation.timeout_ms }),
                requestId: invocation.request_id,
                ...(invocation.identity === undefined ? {} : { identity: invocation.identity }),
                env: invocation.env,
                ...(invocation.payloads === undefined ? {} : { payloads: invocation.payloads }),
                ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
                ...(invocation.worktree_root === undefined
                  ? {}
                  : { worktreeRoot: invocation.worktree_root }),
                ...(invocation.git_common_dir === undefined
                  ? {}
                  : { gitCommonDir: invocation.git_common_dir }),
                terminal: {
                  isTTY: invocation.is_tty ?? false,
                  columns: invocation.tty_col ?? null,
                },
                outputFormat: invocation.output_format ?? "auto",
                onText: () => {
                  if (streaming) throw new Fault("output", "Text output cannot be streamed");
                  textOutput = true;
                },
                signal: abort.signal,
              },
            );
            if (isStream(result)) {
              if (textOutput) throw new Fault("output", "Text output cannot be streamed");
              streaming = true;
              yield { kind: "stream", invocation_id: invocationId };
              for await (const item of result)
                yield { kind: "item", invocation_id: invocationId, value: item };
              yield { kind: "end", invocation_id: invocationId };
            } else {
              yield {
                kind: "result",
                invocation_id: invocationId,
                value: result,
                ...(textOutput ? { content_type: "text/plain" } : {}),
              };
            }
          } catch (error) {
            yield { kind: "error", invocation_id: invocationId, error: failure(error) };
          } finally {
            controllers.delete(invocationId);
          }
        }
        const frames = invoke();
        const stream = new ReadableStream({
          async pull(controller) {
            const next = await frames.next();
            if (next.done === true) {
              controller.close();
              return;
            }
            const line = `${encode(next.value)}\n`;
            if (new TextEncoder().encode(line).byteLength > 16 * 1024 * 1024)
              throw new Fault("response-too-large", "Invocation response frame exceeds 16 MiB");
            controller.enqueue(line);
          },
          async cancel() {
            abort.abort(new Fault("cancelled", "Caller disconnected"));
            await frames.return(null);
          },
        });
        return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
      } catch (error) {
        return Response.json(failure(error), { status: 400 });
      }
    },
  });
  phase = "ready";
  send({ v: wireVersion, kind: "ready", generation: launch.generation, info: info.info });
}

async function handleControl(
  control: z.infer<typeof controlSchema>,
  info: Awaited<ReturnType<typeof loadLakeConfig>>,
): Promise<void> {
  if (control.kind === "activate") {
    if (currentPhase() !== "prepared") throw new Error("activate is only valid after prepared");
    await activate(info);
    return;
  }
  if (currentPhase() !== "ready") throw new Error("drain is only valid after ready");
  await stop(control.reason, control.finish_ms);
}

try {
  const info = await loadLakeConfig(launch.workspace);
  phase = "prepared";
  send({
    v: wireVersion,
    kind: "prepared",
    generation: launch.generation,
    wire_version: wireVersion,
    name: info.config.name,
    core_version: info.info.coreVersion,
  });

  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffered += decoder.decode(chunk, { stream: true });
    if (buffered.length > 1024 * 1024) throw new Error("Control line exceeds 1 MiB");
    let newline: number;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      const control = controlSchema.parse(JSON.parse(line));
      if (control.generation !== launch.generation) throw new Error("Control generation mismatch");
      await handleControl(control, info);
    }
  }
  await stop("stop", 5_000);
} catch (error) {
  send({
    v: wireVersion,
    kind: "failed",
    generation: launch.generation,
    phase:
      currentPhase() === "ready" ? "drain" : currentPhase() === "prepared" ? "activate" : "prepare",
    error: failure(error),
  });
  await server?.stop(true);
  await runtime?.stop().catch(() => {});
  void output.end();
  process.exit(1);
}
