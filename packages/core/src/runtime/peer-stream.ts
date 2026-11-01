import { createConnection } from "node:net";

import { z } from "zod";

import { Fault, jsonSchema } from "../core/json.ts";
import { eventFrameSchema, type EventFrame } from "./events.ts";

const errorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: jsonSchema.optional(),
});
const streamFrameSchema = z.union([
  eventFrameSchema,
  z.object({ stream: z.literal(true) }),
  z.object({ done: z.literal(true), success: z.literal(true) }),
  z.object({
    done: z.literal(true),
    success: z.literal(false),
    error: errorSchema,
  }),
  z.object({ ok: z.literal(false), error: errorSchema }),
]);

/** Read the existing daemon event stream; the caller owns reconnection and refetch. */
export async function* watchPeer(
  socket: string,
  caller: string,
  workspace: string,
  events: string[],
  signal: AbortSignal,
): AsyncGenerator<EventFrame> {
  signal.throwIfAborted();
  const connection = createConnection({ path: socket });
  const abort = (): void => {
    connection.destroy(
      signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)),
    );
  };
  signal.addEventListener("abort", abort, { once: true });
  connection.setEncoding("utf8");
  connection.once("connect", () => {
    connection.write(
      `${JSON.stringify({
        protocol_version: 1,
        request_id: crypto.randomUUID(),
        operation: "invoke",
        workspace,
        cwd: caller,
        payload: { name: "events", input: { command: "stream", events } },
      })}\n`,
    );
  });
  let buffer = "";
  const chunks: AsyncIterable<unknown> = connection;
  try {
    for await (const chunk of chunks) {
      buffer += z.string().parse(chunk);
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        signal.throwIfAborted();
        const line = buffer.slice(0, end);
        if (Buffer.byteLength(line) > 16 * 1024 * 1024)
          throw new Fault("transport", "Botlake event frame exceeds 16 MiB");
        const frame = streamFrameSchema.parse(JSON.parse(line));
        buffer = buffer.slice(end + 1);
        if ("stream" in frame) continue;
        if ("type" in frame) yield frame;
        else if ("error" in frame)
          throw new Fault(frame.error.code, frame.error.message, frame.error.details ?? null);
        else throw new Fault("peer", "Peer event stream ended; reconnect and refetch");
      }
      if (Buffer.byteLength(buffer) > 16 * 1024 * 1024)
        throw new Fault("transport", "Botlake event frame exceeds 16 MiB");
    }
    signal.throwIfAborted();
    throw new Fault("transport", "Peer event stream disconnected; reconnect and refetch");
  } finally {
    signal.removeEventListener("abort", abort);
    connection.destroy();
  }
}
