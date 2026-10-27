import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

import {
  attributesSchema,
  canonical,
  Fault,
  requireValue,
  q,
  type Attributes,
  type Node,
  type Context,
  type ProcessSpec,
} from "@botlake/core";
import { getFlag } from "@botlake/extension-flags";
import { registrationSchema, type NativeRegistration } from "@botlake/native-session";
import { z } from "zod";

import { Catalog, agentConfigSchema, seatSchema, type AgentConfig } from "./catalog.ts";
import { NativeSessions } from "./native.ts";
import type { Provider, ProviderName, ProviderRun } from "./providers/contract.ts";
import { provider } from "./providers/index.ts";

const text = z.string().min(1);

export type AgentOptions = AgentConfig & { providers?: Provider[] };

export const startSchema = z.strictObject({
  seat: text,
  cwd: text,
  prompt: text,
  requestId: text.optional(),
  target: text.optional(),
  policy: z.enum(["stop-on-complete", "close-on-complete"]).default("stop-on-complete"),
  context: attributesSchema.default({}),
});

export type StartRun = z.input<typeof startSchema>;

const launchSchema = z.strictObject({
  owner: text,
  key: text,
  command: z.array(text).min(1),
  cwd: text,
  env: z.record(z.string(), z.string()),
  stdin: z.string(),
});

function fingerprint(value: unknown): string {
  return createHash("sha256")
    .update(canonical(z.json().parse(value)))
    .digest("hex");
}

export class Agents {
  private readonly authority = Symbol("agents");
  private readonly providers = new Map<ProviderName, Provider>();
  private readonly seats: Catalog;
  private readonly sessions: NativeSessions;
  private reconcileTask: Promise<void> | undefined;

  constructor(
    private readonly ctx: Context,
    options: AgentOptions = {},
  ) {
    const { providers, ...config } = options;
    const configuration = agentConfigSchema.parse(config);
    this.sessions = new NativeSessions(ctx, this.authority, configuration.unmanaged?.systemPrompt);

    for (const entry of providers ?? [provider("codex"), provider("pi"), provider("claude")]) {
      if (this.providers.has(entry.name))
        throw new Fault("collision", `Duplicate provider: ${entry.name}`);
      this.providers.set(entry.name, entry);
    }

    this.seats = new Catalog(
      [...this.providers.values()],
      configuration.aliases,
      (name) => getFlag(ctx, name)?.value,
    );
    ctx.graph.protect((changes, token) => {
      if (token === this.authority) return;

      for (const change of changes) {
        if (
          change.kind === "node" &&
          (change.before?.attributes["agent/run"] === true ||
            change.after?.attributes["agent/run"] === true)
        )
          throw new Fault("agent-guard", "Tracked runs require the Agents API");
        if (change.kind === "edge") {
          const edge = change.before ?? change.after;
          if (
            edge !== null &&
            ["serves", "continues"].includes(edge.relation) &&
            this.runs().some((run) => run.id === edge.from_id)
          )
            throw new Fault("agent-guard", "Execution authority requires the Agents API");
        }
      }
    });

    ctx.scheduler.register("agents/reconcile", async () => {
      await this.reconcile();
      ctx.scheduler.schedule("agents/reconcile", ctx.clock.now() + 1000, "agents/reconcile");
    });
  }

  private patch(id: string, attributes: Attributes, state?: "active" | "closed"): Node {
    return this.ctx.graph.atomic(
      () => this.ctx.graph.update(id, { attributes, ...(state === undefined ? {} : { state }) }),
      this.authority,
    );
  }

  runs(): Node[] {
    return this.ctx.graph.all({ where: q.eq(q.attr("agent/run"), true), lean: false });
  }

  private run(id: string): Node {
    const run = this.ctx.graph.show(id);
    if (run.attributes["agent/run"] !== true) throw new Fault("run", "Expected tracked run");

    return run;
  }

  private active(run: Node): boolean {
    return run.attributes["agent/settled"] !== true;
  }

  start(raw: StartRun): Node {
    return this.create(raw);
  }

  private create(raw: StartRun, parent?: Node): Node {
    const input = startSchema.parse(raw);
    const cwd = realpathSync(input.cwd);
    const request = Object.fromEntries(
      Object.entries({ ...input, cwd }).filter(([, value]) => value !== undefined),
    );

    const hash = fingerprint({
      operation: parent === undefined ? "start" : "resume",
      parent: parent?.id ?? null,
      input: request,
    });

    return this.ctx.graph.atomic(() => {
      if (input.requestId !== undefined) {
        const existing = this.runs().find(
          (run) => run.attributes["agent/request-id"] === input.requestId,
        );
        if (existing !== undefined) {
          if (existing.attributes["agent/request-hash"] !== hash)
            throw new Fault("replay", "Request ID was used with different input");
          return existing;
        }
      }

      const seat =
        parent === undefined
          ? this.seats.resolve(input.seat, { cwd, workspace: this.ctx.workspace })
          : seatSchema.parse(parent.attributes["agent/settings"]);
      if (!this.providers.has(seat.provider))
        throw new Fault("provider", `Provider unavailable: ${seat.provider}`);

      if (input.target !== undefined) {
        if (this.ctx.graph.show(input.target).state !== "active")
          throw new Fault("assignment", "Assignment target must be active");
        if (
          this.runs().some(
            (run) =>
              this.active(run) &&
              this.ctx.graph.edge(run.id, input.target ?? "", "serves") !== null,
          )
        )
          throw new Fault("assignment", "Target already has an active writer");
      }

      const attrs: Attributes = {
        "agent/run": true,
        "agent/state": "ready",
        "agent/substatus": "pending",
        "agent/accepted": true,
        "agent/settled": false,
        "agent/attempt": 0,
        "agent/provider": seat.provider,
        "agent/seat": input.seat,
        "agent/cwd": cwd,
        "agent/prompt": input.prompt,
        "agent/policy": input.policy,
        "agent/context": input.context,
        ...(parent === undefined
          ? {}
          : {
              "agent/session-id": text.parse(parent.attributes["agent/session-id"]),
              "agent/identity": text.parse(parent.attributes["agent/identity"]),
            }),
        "agent/resumes": parent !== undefined,
        "agent/session-confirmed": false,
        "agent/integration": "unobserved",
        "agent/settings": z.json().parse(
          parent === undefined
            ? {
                ...seat,
                systemPrompt: [
                  seat.systemPrompt,
                  ...(input.target === undefined
                    ? []
                    : [
                        `You serve task ${input.target}. ${
                          input.policy === "close-on-complete"
                            ? "Close the task yourself only when its intended outcome is satisfied."
                            : "Stop after reporting results; completing the process does not close the task."
                        }`,
                      ]),
                ]
                  .filter((part) => part.length > 0)
                  .join("\n\n"),
              }
            : parent.attributes["agent/settings"],
        ),
      };

      if (input.requestId !== undefined) {
        attrs["agent/request-id"] = input.requestId;
        attrs["agent/request-hash"] = hash;
      }

      const run = this.ctx.graph.add({ title: `Agent ${input.seat}`, attributes: attrs });

      if (input.target !== undefined) this.ctx.graph.connect(run.id, input.target, "serves");

      return run;
    }, this.authority);
  }

  private providerRun(run: Node): ProviderRun {
    const seat = seatSchema.parse(run.attributes["agent/settings"]);

    return {
      provider: seat.provider,
      cwd: text.parse(run.attributes["agent/cwd"]),
      prompt: text.parse(run.attributes["agent/prompt"]),
      ...(run.attributes["agent/resumes"] === true
        ? { resumes: true, sessionId: text.parse(run.attributes["agent/session-id"]) }
        : { resumes: false }),
      model: seat.model,
      effort: seat.effort,
      extraArgs: seat.extraArgs,
      systemPrompt: seat.systemPrompt,
    };
  }

  private begin(run: Node): Node {
    return this.ctx.graph.atomic(() => {
      const current = this.run(run.id);
      if (current.attributes["agent/state"] !== "ready")
        throw new Fault("attempt", "Run is not ready");
      const target = this.ctx.graph.edges(run.id, "serves").find((edge) => edge.from_id === run.id);
      if (
        target !== undefined &&
        this.ctx.graph.all({ ready: true, where: q.eq("id", target.to_id) }).length === 0
      )
        return current;

      const invocation = crypto.randomUUID();
      const definition = this.providerRun(current);
      const plan = requireValue(
        this.providers.get(definition.provider),
        "Provider unavailable",
      ).prepare(definition);
      const trackingEnv: Record<string, string> = {
        BL_AGENT_SEAT: text.parse(current.attributes["agent/seat"]),
        ...(definition.model === undefined ? {} : { BL_MODEL: definition.model }),
        ...(definition.effort === undefined ? {} : { BL_EFFORT: definition.effort }),
        ...(definition.resumes
          ? { BL_ACTOR: text.parse(current.attributes["agent/identity"]) }
          : {}),
      };
      const spec: ProcessSpec = {
        owner: "agents",
        key: `${current.id}/${invocation}`,
        command: [
          "env",
          ...[
            "BL_ACTOR",
            "BL_AGENT_SEAT",
            "BL_MODEL",
            "BL_EFFORT",
            "BL_NATIVE_SESSION_ID",
            "BL_NATIVE_PROVIDER",
          ].flatMap((key) => (trackingEnv[key] === undefined ? ["-u", key] : [])),
          ...plan.command,
        ],
        cwd: definition.cwd,
        stdin: plan.stdin,
        env: {
          ...plan.env,
          ...trackingEnv,
          BL_WORKSPACE: this.ctx.workspace,
          BL_RUN_REFERENCE: `${current.id}:${invocation}`,
        },
      };

      return this.patch(current.id, {
        "agent/state": "running",
        "agent/invocation": invocation,
        "agent/attempt": z.number().parse(current.attributes["agent/attempt"]) + 1,
        "agent/launch": z.json().parse(spec),
      });
    }, this.authority);
  }

  async reconcile(): Promise<void> {
    if (this.reconcileTask !== undefined) return this.reconcileTask;

    this.reconcileTask = this.reconcileRuns().finally(() => {
      this.reconcileTask = undefined;
    });

    return this.reconcileTask;
  }

  private async reconcileRuns(): Promise<void> {
    const owned = await this.ctx.processes.listOwned("agents");
    for (let run of this.runs().filter(
      (row) => row.attributes["agent/external"] !== true && this.active(row),
    )) {
      try {
        if (run.attributes["agent/state"] === "ready") run = this.begin(run);
        if (
          run.attributes["agent/state"] !== "running" &&
          run.attributes["agent/launch"] === undefined
        )
          continue;

        const invocation = text.parse(run.attributes["agent/invocation"]);
        const spec = launchSchema.parse(run.attributes["agent/launch"]);
        let fact = owned.find((entry) => entry.owner === spec.owner && entry.key === spec.key);
        fact ??= await this.ctx.processes.launch(spec);
        const current = this.run(run.id);
        if (current.attributes["agent/invocation"] !== invocation) continue;

        if (current.attributes["agent/handle"] !== fact.handle)
          run = this.patch(run.id, { "agent/handle": fact.handle });
        if (fact.phase !== "terminal") continue;

        if (fact.launch_failure !== undefined) {
          this.patch(
            run.id,
            {
              "agent/state": "failed",
              "agent/substatus": "launch",
              "agent/settled": true,
              "agent/error": fact.launch_failure.message,
            },
            "closed",
          );
          continue;
        }

        if (fact.cancellation?.stop === "uncertain") {
          this.patch(
            run.id,
            {
              "agent/state": "stopped",
              "agent/substatus": "requested",
              "agent/settled": false,
              "agent/custody": z.json().parse(fact),
            },
            "closed",
          );
          continue;
        }

        if (fact.exit === undefined && fact.cancellation === undefined) {
          this.patch(
            run.id,
            {
              "agent/state": "failed",
              "agent/substatus": "reconciliation",
              "agent/settled": false,
              "agent/error": "Terminal custody has no observed exit",
            },
            "closed",
          );
          continue;
        }

        const [stdout, stderr] = await Promise.all([
          Bun.file(fact.output.stdout_ref).text(),
          Bun.file(fact.output.stderr_ref).text(),
        ]);
        const definition = this.providerRun(run);
        const outcome = requireValue(
          this.providers.get(definition.provider),
          "Provider unavailable",
        ).finish(definition, fact.exit?.code ?? 1, stdout, stderr);

        let integrationError: string | null = null;
        if (outcome.sessionId !== null) {
          try {
            this.sessions.fromOutput(this.run(run.id), outcome.sessionId);
          } catch (error) {
            integrationError = String(error);
          }
        }

        this.patch(
          run.id,
          {
            "agent/state":
              fact.cancellation !== undefined || (outcome.success && integrationError === null)
                ? "stopped"
                : "failed",
            "agent/substatus":
              fact.cancellation !== undefined
                ? "requested"
                : integrationError !== null
                  ? "native-session"
                  : outcome.success
                    ? "completed"
                    : "execution",
            ...(integrationError === null ? {} : { "agent/session-confirmed": false }),
            "agent/settled": true,
            "agent/result": outcome.result,
            "agent/error":
              integrationError ?? (fact.cancellation === undefined ? outcome.error : null),
            "agent/custody": z.json().parse(fact),
          },
          "closed",
        );
      } catch (error) {
        this.patch(
          run.id,
          {
            "agent/state": "failed",
            "agent/substatus": "reconciliation",
            "agent/error": String(error),
            "agent/settled": run.attributes["agent/launch"] === undefined,
          },
          "closed",
        );
      }
    }
  }

  native(raw: z.input<typeof registrationSchema>): unknown {
    const input: NativeRegistration = registrationSchema.parse(raw);

    return this.sessions.observe({ ...input, cwd: realpathSync(input.cwd) });
  }

  async cancel(id: string): Promise<Node> {
    const run = this.run(id);
    if (run.attributes["agent/external"] === true)
      throw new Fault("custody", "External sessions grant no stop authority");
    if (run.attributes["agent/state"] === "ready")
      return this.patch(
        id,
        { "agent/state": "stopped", "agent/substatus": "abandoned", "agent/settled": true },
        "closed",
      );
    const spec = launchSchema.parse(run.attributes["agent/launch"]);

    await this.ctx.processes.cancel(
      text.parse(run.attributes["agent/handle"]),
      spec.owner,
      spec.key,
    );
    await this.reconcile();
    const fact = await this.ctx.processes.get(text.parse(run.attributes["agent/handle"]));
    if (fact.phase !== "terminal")
      throw new Fault("custody", "Cancellation has no terminal evidence");

    return this.run(id);
  }

  retry(id: string): Node {
    return this.ctx.graph.atomic(() => {
      const run = this.run(id);
      if (
        run.attributes["agent/state"] !== "failed" ||
        run.attributes["agent/settled"] !== true ||
        run.attributes["agent/external"] === true ||
        run.attributes["agent/request-id"] !== undefined ||
        this.ctx.graph.edges(id, "serves").some((edge) => edge.from_id === id)
      )
        throw new Fault(
          "retry",
          "Retry requires a settled unassigned failure without request binding",
        );

      return this.patch(
        id,
        {
          "agent/state": "ready",
          "agent/substatus": "pending",
          "agent/settled": false,
          "agent/error": null,
          "agent/result": null,
          "agent/invocation": null,
          "agent/handle": null,
          "agent/launch": null,
          "agent/custody": null,
          "agent/session-id": null,
          "agent/session-confirmed": false,
          "agent/resumes": false,
          "agent/identity": null,
          "agent/integration": "unobserved",
          "agent/observation": null,
        },
        "active",
      );
    }, this.authority);
  }

  resume(id: string, prompt: string, requestId?: string): Node {
    return this.ctx.graph.atomic(() => {
      const parent = this.run(id);
      if (
        parent.attributes["agent/settled"] !== true ||
        parent.attributes["agent/session-confirmed"] !== true ||
        parent.attributes["agent/external"] === true
      )
        throw new Fault(
          "resume",
          "Resume requires a settled managed run with verified native session",
        );

      const existing = this.ctx.graph.edges(id, "continues").find((edge) => edge.to_id === id);
      if (existing !== undefined) {
        const child = this.run(existing.from_id);
        if (
          requestId !== undefined &&
          child.attributes["agent/request-id"] === requestId &&
          child.attributes["agent/prompt"] === prompt
        )
          return child;

        throw new Fault("resume", "Run already has an accepted continuation");
      }
      if (
        this.runs().some(
          (run) =>
            run.attributes["agent/external"] !== true &&
            this.active(run) &&
            run.attributes["agent/provider"] === parent.attributes["agent/provider"] &&
            run.attributes["agent/session-id"] === parent.attributes["agent/session-id"],
        )
      )
        throw new Fault("resume", "Native session already has an active writer");

      const target = this.ctx.graph.edges(id, "serves").find((edge) => edge.from_id === id)?.to_id;
      const child = this.create(
        {
          seat: text.parse(parent.attributes["agent/seat"]),
          cwd: text.parse(parent.attributes["agent/cwd"]),
          prompt,
          ...(requestId === undefined ? {} : { requestId }),
          ...(target === undefined ? {} : { target }),
          policy: z
            .enum(["stop-on-complete", "close-on-complete"])
            .parse(parent.attributes["agent/policy"]),
          context: attributesSchema.parse(parent.attributes["agent/context"]),
        },
        parent,
      );
      this.ctx.graph.connect(child.id, id, "continues");

      return child;
    }, this.authority);
  }

  async acknowledge(id: string): Promise<Node> {
    const run = this.run(id);
    if (run.attributes["agent/external"] === true || run.attributes["agent/settled"] !== true)
      throw new Fault("custody", "Only settled managed runs may acknowledge custody");

    const spec = launchSchema.parse(run.attributes["agent/launch"]);
    const owned = await this.ctx.processes.listOwned(spec.owner);
    const fact = owned.find((entry) => entry.key === spec.key);
    if (fact !== undefined) await this.ctx.processes.acknowledge(fact.handle, spec.owner, spec.key);

    return this.patch(id, { "agent/acknowledged": true });
  }

  catalog(name?: string): unknown {
    if (name !== undefined) return this.seats.show(name);

    return {
      providers: [...this.providers.keys()],
      aliases: this.seats.list(),
    };
  }

  async startResource(): Promise<void> {
    await this.reconcile();
    const pending = this.ctx.scheduler.pending().find((wake) => wake.key === "agents/reconcile");
    if (pending === undefined)
      this.ctx.scheduler.schedule(
        "agents/reconcile",
        this.ctx.clock.now() + 1000,
        "agents/reconcile",
      );
  }

  async stop(): Promise<void> {
    await this.reconcileTask;
  }
}
