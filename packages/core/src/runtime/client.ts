import { createConnection } from "node:net";

import { z } from "zod";

import { jsonSchema, Fault, type Json } from "../core/json.ts";

const frameSchema = z.compile(
  z.union([
    z.object({ ok: z.literal(true), result: jsonSchema }),
    z.object({
      ok: z.literal(false),
      error: z.object({ code: z.string(), message: z.string(), details: jsonSchema.optional() }),
    }),
    z.object({ stream: z.literal(true) }),
  ]),
);

export function botlakeCall(
  socket: string,
  request: { operation: string; workspace: string; cwd: string; payload: Json },
  signal: AbortSignal,
): Promise<Json> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const connection = createConnection({ path: socket });
    let buffer = "";
    const abort = (): void => {
      reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
      connection.destroy();
    };
    signal.addEventListener("abort", abort, { once: true });
    connection.setEncoding("utf8");
    connection.on("connect", () => {
      connection.write(
        `${JSON.stringify({ protocol_version: 1, request_id: crypto.randomUUID(), ...request })}\n`,
      );
    });
    connection.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) {
        reject(new Fault("transport", "Botlake response exceeds 16 MiB"));
        connection.destroy();
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const frame = frameSchema.parse(JSON.parse(buffer.slice(0, newline)));
        if ("stream" in frame)
          throw new Fault("eval", "api.call supports single-result operations, not streams");
        if (!frame.ok)
          throw new Fault(frame.error.code, frame.error.message, frame.error.details ?? null);
        resolve(frame.result);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
      connection.destroy();
    });
    connection.on("error", reject);
    connection.on("close", () => {
      signal.removeEventListener("abort", abort);
      reject(
        new Fault("transport", "Botlake connection closed before response; request not replayed"),
      );
    });
  });
}
