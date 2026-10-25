import { z } from "zod";

import { Fault } from "../core/json.ts";
import type { Processes, ProcessFact, ProcessSpec, Peers } from "./runtime.ts";

export const factSchema = z.object({
  handle: z.string(),
  owner: z.string(),
  key: z.string(),
  phase: z.enum(["starting", "running", "terminal"]),
  output: z.object({ stdout_ref: z.string(), stderr_ref: z.string() }),
  exit: z.object({ code: z.number(), signal: z.string().nullable() }).optional(),
  cancellation: z
    .object({
      reason: z.string(),
      stop: z.string(),
      observed_exit: z
        .object({ code: z.number(), signal: z.string().nullable() })
        .nullable()
        .optional(),
    })
    .optional(),
  launch_failure: z.object({ message: z.string() }).optional(),
});
export function millServices(
  socket: string,
  workspace: string,
): { processes: Processes; peers: Peers } {
  async function control(operation: string, payload: unknown): Promise<unknown> {
    const connection = await Bun.connect<{
      resolve(value: unknown): void;
      reject(error: Error): void;
      buffer: string;
    }>({
      unix: socket,
      socket: {
        data(client, bytes) {
          client.data.buffer += bytes.toString();
          const end = client.data.buffer.indexOf("\n");
          if (end < 0) return;
          try {
            const frame = z
              .object({
                ok: z.boolean(),
                result: z.unknown().optional(),
                error: z.json().optional(),
              })
              .parse(JSON.parse(client.data.buffer.slice(0, end)));
            if (frame.ok) client.data.resolve(frame.result);
            else client.data.reject(new Fault("mill", "Mill request failed", frame.error ?? null));
          } catch (error) {
            client.data.reject(error instanceof Error ? error : new Error(String(error)));
          }
          client.end();
        },
        error(client, error) {
          client.data.reject(error);
        },
        close(client) {
          client.data.reject(new Fault("transport", "Mill connection closed before response"));
        },
      },
      data: { resolve: () => {}, reject: () => {}, buffer: "" },
    });
    return new Promise((resolveResult, reject) => {
      connection.data = { resolve: resolveResult, reject, buffer: "" };
      connection.write(
        `${JSON.stringify({ protocol_version: 1, request_id: crypto.randomUUID(), operation, workspace, cwd: workspace, payload })}\n`,
      );
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
        return z.array(factSchema).parse(await control("process.list-owned", { owner }));
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
      async call(target, name, input) {
        return control("invoke", { workspace: target, name, input });
      },
    },
  };
}
