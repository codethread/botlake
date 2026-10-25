import { resolve } from "node:path";
import { parentPort, workerData } from "node:worker_threads";

import { z } from "zod";

import { encode, Fault, requireValue } from "../core/json.ts";
import { loadWorkspace } from "./config.ts";
import { millServices } from "./custody.ts";
import { workerMessageSchema } from "./protocol.ts";
import { Runtime, isStream } from "./runtime.ts";

const data = z.object({ workspace: z.string(), millSocket: z.string() }).parse(workerData);
const port = requireValue(parentPort, "Workspace entry must run in a Worker");
const runtime = new Runtime({
  database: resolve(data.workspace, ".millstrand/world.db"),
  workspace: data.workspace,
  ...millServices(data.millSocket, data.workspace),
});
const controllers = new Map<string, AbortController>();
function errorFrame(error: unknown): unknown {
  return {
    type: "error",
    code: error instanceof Fault ? error.code : "runtime",
    message: error instanceof Error ? error.message : String(error),
    details: error instanceof Fault ? error.details : null,
  };
}
port.on("message", (raw: unknown) => {
  if (raw === "stop") {
    for (const controller of controllers.values())
      controller.abort(new Fault("cancelled", "Worker stopped"));
    void runtime.stop().then(() => {
      port.postMessage({ stopped: true });
      port.close();
    });
    return;
  }
  void (async () => {
    const message = workerMessageSchema.parse(raw);
    if ("cancel" in message) {
      controllers.get(message.cancel)?.abort(new Fault("cancelled", "Caller disconnected"));
      return;
    }
    const request = message;
    const controller = new AbortController();
    controllers.set(request.request_id, controller);
    function send(frame: unknown): void {
      port.postMessage({ request_id: request.request_id, frame: `${encode(frame)}\n` });
    }
    let streaming = false;
    try {
      let name = request.name;
      if (request.bin === true) {
        const op = runtime.bins.get(name);
        if (op === undefined) throw new Fault("bin", `Unknown bin: ${name}`);
        name = op;
      }
      const result = await runtime.invoke(name, request.argv ?? request.input ?? {}, {
        ...(request.argv === undefined ? {} : { argv: true }),
        ...(request.timeout_ms === undefined ? {} : { timeoutMs: request.timeout_ms }),
        requestId: request.request_id,
        signal: controller.signal,
      });
      if (isStream(result)) {
        streaming = true;
        send({ protocol_version: 1, request_id: request.request_id, stream: true });
        for await (const item of result)
          port.postMessage({ request_id: request.request_id, frame: `${encode(item)}\n` });
        send({
          protocol_version: 1,
          request_id: request.request_id,
          done: true,
          success: true,
          result: null,
        });
      } else send({ ok: true, result });
    } catch (error) {
      send(
        streaming
          ? {
              protocol_version: 1,
              request_id: request.request_id,
              done: true,
              success: false,
              error: errorFrame(error),
            }
          : { ok: false, error: errorFrame(error) },
      );
    } finally {
      controllers.delete(request.request_id);
      port.postMessage({ request_id: request.request_id, end: true });
    }
  })().catch((error: unknown) => {
    port.postMessage({ fatal: String(error) });
  });
});
try {
  const { spools } = await loadWorkspace(data.workspace);
  await runtime.start(spools);
  port.postMessage({ ready: true, bins: Object.fromEntries(runtime.bins) });
} catch (error) {
  port.postMessage({ fatal: errorFrame(error) });
  await runtime.stop();
  port.close();
}
