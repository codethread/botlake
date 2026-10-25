import { Worker } from "node:worker_threads";

import { z } from "zod";

import { Fault } from "../core/json.ts";
import { invocationSchema } from "./protocol.ts";

const socket = z.string().min(1).parse(Bun.argv[2]);
const millSocket = z.string().min(1).parse(Bun.argv[3]);
interface Member {
  worker: Worker;
  ready: Promise<void>;
  stopped: Promise<void>;
  bins: Record<string, string>;
  closing: boolean;
}
const members = new Map<string, Member>();
interface Connection {
  input: string;
  chunks: Uint8Array[];
  offset: number;
  ending: boolean;
  handled: boolean;
}
const streams = new Map<string, { member: Member; socket: Bun.Socket<Connection> }>();
function flush(client: Bun.Socket<Connection>): void {
  while (client.data.chunks.length > 0) {
    const chunk = client.data.chunks[0];
    if (chunk === undefined) break;
    const written = client.write(chunk.subarray(client.data.offset));
    if (written < 0) return;
    client.data.offset += written;
    if (client.data.offset < chunk.byteLength) return;
    client.data.chunks.shift();
    client.data.offset = 0;
  }
  if (client.data.ending) client.end();
}
function write(client: Bun.Socket<Connection>, frame: string, end = false): void {
  client.data.chunks.push(encoder.encode(frame));
  client.data.ending = end;
  flush(client);
}
const encoder = new TextEncoder();
const frameSchema = z.object({
  request_id: z.string().optional(),
  frame: z.string().optional(),
  end: z.boolean().optional(),
  ready: z.boolean().optional(),
  stopped: z.boolean().optional(),
  fatal: z.unknown().optional(),
  bins: z.record(z.string(), z.string()).optional(),
});
async function start(workspace: string): Promise<Member> {
  if (members.has(workspace)) throw new Fault("member", "Workspace is already running");
  const worker = new Worker(new URL("./worker.ts", import.meta.url), {
    workerData: { workspace, millSocket },
  });
  const ready = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  const member: Member = {
    worker,
    ready: ready.promise,
    stopped: stopped.promise,
    bins: {},
    closing: false,
  };
  members.set(workspace, member);
  const timeout = setTimeout(() => {
    ready.reject(new Error("Workspace startup timed out"));
  }, 15000);
  function failed(error: Error): void {
    ready.reject(error);
    for (const [id, stream] of streams)
      if (stream.member === member) {
        stream.socket.terminate();
        streams.delete(id);
      }
  }
  worker.on("message", (raw: unknown) => {
    const message = frameSchema.parse(raw);
    if (message.ready === true) {
      clearTimeout(timeout);
      member.bins = message.bins ?? {};
      ready.resolve();
    }
    if (message.stopped === true) stopped.resolve();
    if (message.fatal !== undefined) failed(new Error(JSON.stringify(message.fatal)));
    if (message.request_id !== undefined) {
      const stream = streams.get(message.request_id);
      if (message.frame !== undefined && stream !== undefined) write(stream.socket, message.frame);
      if (message.end === true) {
        if (stream !== undefined) {
          stream.socket.data.ending = true;
          flush(stream.socket);
        }
        streams.delete(message.request_id);
      }
    }
  });
  worker.on("error", failed);
  worker.on("exit", (code) => {
    clearTimeout(timeout);
    failed(new Error(`Worker exited: ${code}`));
    stopped.resolve();
    if (members.get(workspace) === member) members.delete(workspace);
    if (!member.closing) {
      setTimeout(() => {
        void start(workspace).catch((error: unknown) => {
          process.stderr.write(`Workspace restart failed: ${String(error)}\n`);
        });
      }, 100);
    }
  });
  try {
    await member.ready;
    return member;
  } catch (error) {
    member.closing = true;
    await worker.terminate();
    members.delete(workspace);
    throw error;
  }
}
async function stop(workspace: string): Promise<void> {
  const member = members.get(workspace);
  if (member === undefined) throw new Fault("member", "Workspace is not running");
  member.closing = true;
  member.worker.postMessage("stop");
  const timer = setTimeout(() => {
    void member.worker.terminate();
  }, 5000);
  try {
    await member.stopped;
  } finally {
    clearTimeout(timer);
    members.delete(workspace);
  }
}
const controlSchema = z.strictObject({
  action: z.enum(["start", "stop", "restart", "status"]),
  workspace: z.string().optional(),
});

const server = Bun.listen<Connection>({
  unix: socket,
  socket: {
    open(client) {
      client.data = { input: "", chunks: [], offset: 0, ending: false, handled: false };
      client.timeout(10);
    },
    data(client, bytes) {
      if (client.data.handled) return;
      client.data.input += bytes.toString();
      if (client.data.input.length > 4 * 1024 * 1024) {
        client.terminate();
        return;
      }
      const newline = client.data.input.indexOf("\n");
      if (newline < 0) return;
      client.data.handled = true;
      client.timeout(0);
      void handle(client, client.data.input.slice(0, newline)).catch((error: unknown) => {
        write(
          client,
          `${JSON.stringify({ ok: false, error: { type: "error", code: "host", message: String(error) } })}\n`,
          true,
        );
      });
    },
    drain: flush,
    error(client) {
      client.terminate();
    },
    close(client) {
      for (const [id, stream] of streams)
        if (stream.socket === client) {
          stream.member.worker.postMessage({ cancel: id });
          streams.delete(id);
        }
    },
  },
});
async function handle(client: Bun.Socket<Connection>, line: string): Promise<void> {
  const envelope = z
    .strictObject({ type: z.enum(["/control", "/invoke"]), body: z.unknown() })
    .parse(JSON.parse(line));
  if (envelope.type === "/control") {
    const control = controlSchema.parse(envelope.body);
    if (control.action === "status") {
      write(
        client,
        `${JSON.stringify({ ok: true, result: { pid: process.pid, memory: process.memoryUsage(), members: [...members.keys()] } })}\n`,
        true,
      );
      return;
    }
    const workspace = z.string().parse(control.workspace);
    if (control.action === "stop" || (control.action === "restart" && members.has(workspace)))
      await stop(workspace);
    if (control.action === "start" || control.action === "restart") await start(workspace);
    write(client, `${JSON.stringify({ ok: true, result: { ready: true } })}\n`, true);
    return;
  }
  const parsed = invocationSchema.parse(envelope.body);
  const member = members.get(parsed.workspace);
  if (member === undefined) throw new Fault("member", "Workspace is not running");
  await member.ready;
  if (streams.has(parsed.request_id)) throw new Fault("request", "Duplicate active request ID");
  streams.set(parsed.request_id, { member, socket: client });
  member.worker.postMessage(parsed);
}
process.on("SIGTERM", () => {
  void (async () => {
    for (const workspace of members.keys()) await stop(workspace);
    server.stop(true);
    process.exit(0);
  })();
});
