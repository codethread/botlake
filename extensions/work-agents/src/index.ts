import { Fault, defineOp, jsonSchema, type Context, type Extension } from "@botlake/core";
import {
  agentsChanged,
  readAgentLiveness,
  resolveAssignmentRun,
  type AgentLiveness,
} from "@botlake/extension-agents";
import { callerActor, resolveIdentity } from "@botlake/extension-identity";
import { workAssignmentEstablished, workStore, type Assignment } from "@botlake/extension-work";
import { z } from "zod";

import { workAgentAttributes, workAgentBindingSchema } from "./node-model.ts";

export { workAgentAttributes, workAgentBindingSchema } from "./node-model.ts";

const text = z.compile(z.string().trim().min(1));
const optionsSchema = z.compile(z.strictObject({ checkIntervalMs: z.number().int().positive() }));
const wakeSchema = z.compile(
  z.strictObject({ binding: text, assignment: text, heartbeatAt: z.number().int() }),
);

export interface WorkAgentsOptions {
  /** Interval for rechecking uncertain native sessions; elapsed silence never proves exit. */
  checkIntervalMs: number;
}

/** Explicitly selected liveness for work assignments bound to native agent identities. */
export function workAgents(raw: WorkAgentsOptions): Extension {
  const options = optionsSchema.parse(raw);

  return {
    name: "work-agents",
    requires: ["work", "agents", "identity"],
    activate(ctx) {
      const service = createService(ctx, options);
      ctx.graph.protect((changes, token) => {
        if (token === service.authority) return;
        for (const change of changes)
          if (
            change.kind === "node" &&
            (change.before?.attributes[workAgentAttributes.binding] === true ||
              change.after?.attributes[workAgentAttributes.binding] === true)
          )
            throw new Fault(
              "work-agents-guard",
              "Assignment liveness bindings require Work Agents",
            );
      });
      ctx.scheduler.register("work-agents/check", (wake) => {
        service.checkWake(wake.payload);
      });
      ctx.on(workAssignmentEstablished, ({ task, assignment }) => {
        service.enroll(task, assignment);
      });
      ctx.on(agentsChanged, ({ id, liveness }) => {
        service.observe(id, liveness);
      });
      ctx.resource({ start: service.start, stop: service.stop });
      ctx.register(
        defineOp({
          name: "work-agent",
          input: z.compile(
            z.discriminatedUnion("command", [
              z.strictObject({
                command: z.literal("bind"),
                task: text,
                run: text,
                assignment: text,
              }),
              z.strictObject({
                command: z.literal("heartbeat"),
                task: text,
                run: text,
                assignment: text,
                byIdentity: text.optional(),
              }),
            ]),
          ),
          output: jsonSchema,
          primer:
            "AFK claims and assigned creation bind automatically when Agents resolves an exact managed invocation or one matching native session. Missing evidence leaves work assigned and unbound; same-owner reclaim retries enrollment. Explicit bind and heartbeat remain available. Settled managed custody or a native session-end observation releases only the same assignment token. Silence triggers rechecking, never release. HITL assignments never bind.",
          cli: {
            description: "Bind assigned work to verified agent liveness",
            commands: {
              bind: {
                description: "Bind a current assignment to a registered agent run",
                positionals: [
                  { name: "task", type: "string", required: true },
                  { name: "run", type: "string", required: true },
                ],
                flags: { assignment: { type: "string", required: true } },
              },
              heartbeat: {
                description: "Record a heartbeat from the matching bound native identity",
                positionals: [
                  { name: "task", type: "string", required: true },
                  { name: "run", type: "string", required: true },
                ],
                flags: {
                  assignment: { type: "string", required: true },
                  "by-identity": { key: "byIdentity", type: "string" },
                },
              },
            },
          },
          handler(input) {
            if (input.command === "bind") return service.bind(input);
            return service.heartbeat(input);
          },
        }),
      );
    },
  };
}

// -- Private helpers --

function createService(ctx: Context, options: WorkAgentsOptions) {
  const authority = Symbol("work-agents");
  const store = workStore(ctx);

  function bindings(): ReturnType<typeof binding>[] {
    return ctx.graph
      .all({ lean: false })
      .filter((node) => node.attributes[workAgentAttributes.binding] === true)
      .map((node) => binding(node));
  }

  function binding(node: ReturnType<Context["graph"]["show"]>) {
    return {
      node,
      value: workAgentBindingSchema.parse(
        JSON.parse(text.parse(node.attributes[workAgentAttributes.value])),
      ),
    };
  }

  function run(id: string) {
    return readAgentLiveness(ctx, id);
  }

  function boundRun(id: string) {
    const evidence = run(id);
    const identity = evidence.identity;
    if (identity === null || resolveIdentity(ctx.graph, identity) === undefined)
      throw new Fault("work-agent", "Binding requires a registered native identity");
    if (evidence.audience !== "agent")
      throw new Fault("work-agent", "Automatic assignment release requires an agent-audience run");
    if (evidence.kind === "external") {
      if (!evidence.native)
        throw new Fault("work-agent", "Binding requires a native session observation");
      if (evidence.observation?.activity === "ended")
        throw new Fault("work-agent", "Binding requires a native session that has not ended");
      return { identity, invocation: null };
    }
    if (evidence.settled || evidence.invocation === null)
      throw new Fault("work-agent", "Binding requires an unsettled managed invocation");
    return { identity, invocation: evidence.invocation };
  }

  function schedule(entry: ReturnType<typeof binding>): void {
    const { node, value } = entry;
    if (value.status !== "active") return;
    if (value.invocation !== null) {
      ctx.scheduler.cancel(`work-agents/${node.id}`);
      return;
    }
    ctx.scheduler.schedule(
      `work-agents/${node.id}`,
      ctx.clock.now() + options.checkIntervalMs,
      "work-agents/check",
      { binding: node.id, assignment: value.assignment, heartbeatAt: value.heartbeatAt },
    );
  }

  function active(entry: ReturnType<typeof binding>): boolean {
    const { value } = entry;
    if (value.status !== "active") return false;
    const task = store.get(value.task);
    return (
      task.kind === "task" &&
      task.audience === "AFK" &&
      run(value.run).audience === "agent" &&
      task.assignment?.id === value.assignment &&
      task.assignment.assignee === value.identity
    );
  }

  function release(entry: ReturnType<typeof binding>, reason: string): boolean {
    if (!active(entry)) {
      ctx.graph.update(entry.node.id, {
        attributes: {
          [workAgentAttributes.value]: JSON.stringify({ ...entry.value, status: "superseded" }),
        },
      });
      ctx.scheduler.cancel(`work-agents/${entry.node.id}`);
      return false;
    }
    const released = store.release(entry.value.task, entry.value.assignment, reason, "work-agents");
    ctx.graph.update(entry.node.id, {
      attributes: {
        [workAgentAttributes.value]: JSON.stringify({
          ...entry.value,
          status: released ? "released" : "superseded",
        }),
      },
    });
    ctx.scheduler.cancel(`work-agents/${entry.node.id}`);
    return released;
  }

  function bind(input: { task: string; run: string; assignment: string }) {
    return ctx.graph.atomic(() => bindCurrent(input), authority);
  }

  function enroll(task: string, assignment: Assignment): void {
    const item = store.get(task);
    if (item.kind === "task" && item.audience === "HITL") return;
    const resolved = resolveAssignmentRun(ctx, assignment.assignee);
    if (resolved === null) return;
    ctx.graph.atomic(
      () => bindCurrent({ task, assignment: assignment.id, run: resolved.run }),
      authority,
    );
  }

  function bindCurrent(input: { task: string; run: string; assignment: string }) {
    const task = store.get(input.task);
    const agent = boundRun(input.run);
    if (
      task.kind !== "task" ||
      task.audience !== "AFK" ||
      task.assignment?.id !== input.assignment ||
      task.assignment.assignee !== agent.identity
    )
      throw new Fault(
        "work-agent",
        "Only an AFK assignment matching the agent run identity and current token can bind",
      );
    const existing = bindings().find((entry) => active(entry) && entry.value.task === input.task);
    if (existing !== undefined) {
      if (
        existing.value.assignment === input.assignment &&
        existing.value.run === input.run &&
        existing.value.invocation === agent.invocation
      )
        return acknowledgement(existing);
      throw new Fault("work-agent", "Current assignment is already bound");
    }
    const heartbeatAt = ctx.clock.now();
    const node = ctx.graph.add({
      title: `Work agent ${input.task}`,
      state: "closed",
      attributes: {
        [workAgentAttributes.binding]: true,
        [workAgentAttributes.value]: JSON.stringify({
          task: input.task,
          assignment: input.assignment,
          run: input.run,
          invocation: agent.invocation,
          identity: agent.identity,
          heartbeatAt,
          status: "active",
        }),
      },
    });
    const entry = binding(node);
    check(entry, run(entry.value.run));
    schedule(binding(ctx.graph.show(entry.node.id)));
    return acknowledgement(entry);
  }

  function heartbeat(input: {
    task: string;
    run: string;
    assignment: string;
    byIdentity?: string | undefined;
  }) {
    const actor = input.byIdentity ?? callerActor(ctx);
    return ctx.graph.atomic(() => {
      const entry = bindings().find(
        (candidate) =>
          candidate.value.status === "active" &&
          candidate.value.task === input.task &&
          candidate.value.run === input.run &&
          candidate.value.assignment === input.assignment,
      );
      if (entry === undefined) throw new Fault("work-agent", "Unknown active assignment binding");
      if (actor !== entry.value.identity)
        throw new Fault("work-agent", "Heartbeat attribution must match the bound native identity");
      const agent = boundRun(entry.value.run);
      if (agent.identity !== entry.value.identity || agent.invocation !== entry.value.invocation)
        throw new Fault("work-agent", "Heartbeat belongs to a stale run invocation");
      if (!active(entry)) throw new Fault("work-agent", "Assignment is no longer current");
      const heartbeatAt = ctx.clock.now();
      const refreshed = {
        node: ctx.graph.update(entry.node.id, {
          attributes: {
            [workAgentAttributes.value]: JSON.stringify({ ...entry.value, heartbeatAt }),
          },
        }),
        value: { ...entry.value, heartbeatAt },
      };
      schedule(refreshed);
      return acknowledgement(refreshed);
    }, authority);
  }

  function currentInvocation(entry: ReturnType<typeof binding>, current: AgentLiveness): boolean {
    return entry.value.invocation === null
      ? current.kind === "external" && current.native && current.identity === entry.value.identity
      : current.kind === "managed" &&
          current.invocation === entry.value.invocation &&
          current.identity === entry.value.identity;
  }

  function observe(runId: string, liveness: AgentLiveness | null): void {
    if (liveness === null) return;
    // Preserve managed settlement evidence, but reread resumable native session activity.
    const current = liveness.kind === "managed" && liveness.settled ? liveness : run(runId);
    for (const entry of bindings().filter((candidate) => candidate.value.run === runId)) {
      if (entry.value.status !== "active") continue;
      ctx.graph.atomic(() => {
        check(entry, current);
      }, authority);
    }
  }

  function refreshFromNativeObservation(
    entry: ReturnType<typeof binding>,
    current: AgentLiveness,
  ): void {
    const observed = current.observation;
    if (
      !current.native ||
      !currentInvocation(entry, current) ||
      observed === null ||
      observed.at <= entry.value.heartbeatAt
    )
      return;
    const heartbeatAt = observed.at;
    ctx.graph.atomic(() => {
      const currentBinding = binding(ctx.graph.show(entry.node.id));
      if (
        !active(currentBinding) ||
        !currentInvocation(currentBinding, current) ||
        currentBinding.value.heartbeatAt >= heartbeatAt
      )
        return;
      const refreshed = {
        node: ctx.graph.update(entry.node.id, {
          attributes: {
            [workAgentAttributes.value]: JSON.stringify({ ...currentBinding.value, heartbeatAt }),
          },
        }),
        value: { ...currentBinding.value, heartbeatAt },
      };
      schedule(refreshed);
    }, authority);
  }

  function check(entry: ReturnType<typeof binding>, current: AgentLiveness): void {
    if (!active(entry)) {
      release(entry, "assignment no longer current");
      return;
    }
    // Only the latest run proves supersession; a delayed V1 event must not release V2.
    if (entry.value.invocation !== null) {
      const latest = run(entry.value.run);
      if (latest.kind === "managed" && latest.invocation !== entry.value.invocation) {
        release(entry, "managed agent invocation superseded");
        return;
      }
    }
    if (!currentInvocation(entry, current)) return;
    if (current.kind === "managed" && current.settled) release(entry, "managed agent run settled");
    else if (current.kind === "external" && current.observation?.activity === "ended")
      release(entry, "native agent session ended");
    else refreshFromNativeObservation(entry, current);
  }

  function checkWake(raw: unknown): void {
    const wake = wakeSchema.parse(raw);
    ctx.graph.atomic(() => {
      const entry = binding(ctx.graph.show(wake.binding));
      if (
        entry.value.status !== "active" ||
        entry.value.assignment !== wake.assignment ||
        entry.value.heartbeatAt !== wake.heartbeatAt
      )
        return;
      check(entry, run(entry.value.run));
      schedule(binding(ctx.graph.show(entry.node.id)));
    }, authority);
  }

  function start(): void {
    for (const entry of bindings()) {
      if (entry.value.status !== "active") continue;
      const current = run(entry.value.run);
      ctx.graph.atomic(() => {
        check(entry, current);
        schedule(binding(ctx.graph.show(entry.node.id)));
      }, authority);
    }
  }

  function stop(): void {}

  function acknowledgement(entry: ReturnType<typeof binding>) {
    return {
      task: entry.value.task,
      run: entry.value.run,
      assignment: entry.value.assignment,
      identity: entry.value.identity,
      heartbeatAt: entry.value.heartbeatAt,
    };
  }

  return { authority, bind, enroll, heartbeat, observe, checkWake, start, stop };
}
