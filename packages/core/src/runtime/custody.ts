import { z } from "zod";

import { jsonSchema, Fault } from "../core/json.ts";
import type { Processes, ProcessFact, ProcessSpec, Peers } from "./context.ts";

const exitSchema = z.compile(z.object({ code: z.number(), signal: z.string().nullable() }));

export const factSchema = z.compile(
  z.object({
    handle: z.string(),
    owner: z.string(),
    key: z.string(),
    phase: z.enum(["starting", "running", "terminal"]),
    output: z.object({ stdout_ref: z.string(), stderr_ref: z.string() }),
    exit: exitSchema.optional(),
    cancellation: z
      .object({
        reason: z.string(),
        stop: z.string(),
        observed_exit: exitSchema.nullable().optional(),
      })
      .optional(),
    launch_failure: z.object({ message: z.string() }).optional(),
  }),
);

const controlFrameSchema = z.compile(
  z.union([
    z.object({
      ok: z.boolean(),
      result: z.unknown().optional(),
      error: jsonSchema.optional(),
    }),
    z.object({ stream: z.literal(true) }),
  ]),
);
const factsSchema = z.compile(z.array(factSchema));
const peerSchema = z.compile(z.object({ path: z.string(), name: z.string() }));

interface ControlData {
  resolve(value: unknown): void;
  reject(error: Error): void;
  buffer: string;
  decoder: TextDecoder;
  output: Uint8Array;
  offset: number;
}

export function botlakeServices(
  socket: string,
  workspace: string,
): { processes: Processes; peers: Peers } {
  async function control(
    operation: string,
    payload: unknown,
    target = workspace,
  ): Promise<unknown> {
    const connection = await Bun.connect<ControlData>({
      unix: socket,
      socket: {
        data(client, bytes) {
          client.data.buffer += client.data.decoder.decode(bytes, { stream: true });
          const end = client.data.buffer.indexOf("\n");
          if (end < 0) return;
          try {
            const frame = controlFrameSchema.parse(JSON.parse(client.data.buffer.slice(0, end)));
            if ("stream" in frame) throw new Fault("peer", "Streaming peer calls are unsupported");
            if (frame.ok) client.data.resolve(frame.result);
            else
              client.data.reject(
                new Fault("botlake", "Botlake request failed", frame.error ?? null),
              );
          } catch (error) {
            client.data.reject(error instanceof Error ? error : new Error(String(error)));
          }
          client.end();
        },
        drain: flush,
        error(client, error) {
          client.data.reject(error);
        },
        close(client) {
          client.data.reject(new Fault("transport", "Botlake connection closed before response"));
        },
      },
      data: {
        resolve: () => {},
        reject: () => {},
        buffer: "",
        decoder: new TextDecoder(),
        output: new Uint8Array(),
        offset: 0,
      },
    });
    return new Promise((resolveResult, reject) => {
      connection.data.resolve = resolveResult;
      connection.data.reject = reject;
      connection.data.output = new TextEncoder().encode(
        `${JSON.stringify({ protocol_version: 1, request_id: crypto.randomUUID(), operation, workspace: target, cwd: workspace, payload })}\n`,
      );
      flush(connection);
    });
  }
  return {
    processes: {
      async launch(spec: ProcessSpec): Promise<ProcessFact> {
        return factSchema.parse(
          await control("process.launch", {
            owner: spec.owner,
            key: spec.key,
            launch_spec: {
              argv: spec.command,
              cwd: spec.cwd ?? workspace,
              env: spec.env ?? {},
              ...(spec.stdin === undefined ? {} : { stdin: spec.stdin }),
            },
          }),
        );
      },
      async get(handle): Promise<ProcessFact> {
        return factSchema.parse(await control("process.get", { handle }));
      },
      async listOwned(owner): Promise<ProcessFact[]> {
        return factsSchema.parse(await control("process.list-owned", { owner }));
      },
      async cancel(handle, owner, key): Promise<ProcessFact> {
        const fact = factSchema.parse(await control("process.get", { handle }));
        if (fact.key !== key) throw new Fault("custody", "Process key mismatch");
        return factSchema.parse(await control("process.cancel", { handle, owner }));
      },
      async acknowledge(handle, owner, key): Promise<void> {
        const fact = factSchema.parse(await control("process.get", { handle }));
        if (fact.key !== key) throw new Fault("custody", "Process key mismatch");
        await control("process.acknowledge", { handle, owner });
      },
    },
    peers: {
      async resolve(target) {
        return peerSchema.parse(await control("lake-resolve", {}, target));
      },
      async call(target, name, input) {
        return control("invoke", { name, input }, target);
      },
    },
  };
}

// -- Private helpers --

function flush(client: Bun.Socket<ControlData>): void {
  if (client.data.offset === client.data.output.byteLength) return;
  const written = client.write(client.data.output.subarray(client.data.offset));
  if (written > 0) client.data.offset += written;
}
