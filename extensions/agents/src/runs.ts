// oxlint-disable import/max-dependencies -- Run orchestration composes custody, native sessions and its shared node model.
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

import {
  jsonSchema,
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
import {
  registrationSchema,
  agentMetadata,
  sessionAudience,
  type NativeRegistration,
} from "@botlake/native-session";
import { z } from "zod";

import { RunActivity, type ActivityRead } from "./activity.ts";
import { Catalog, agentConfigSchema, seatSchema, type AgentConfig } from "./catalog.ts";
import { initialLifecycleAttributes, runLifecycle, transitionRun } from "./lifecycle.ts";
import { NativeSessions } from "./native.ts";
import { agentAttributes, agentRelations, agentLaunchSchema } from "./node-model.ts";
import type { Provider, ProviderName, ProviderRun } from "./providers/contract.ts";
import { provider } from "./providers/index.ts";

const text = z.compile(z.string().min(1));
const policy = z.compile(z.enum(["stop-on-complete", "close-on-complete"]));
const number = z.compile(z.number());

export const startSchema = z.compile(
  z.strictObject({
    seat: text,
    cwd: text,
    prompt: text,
    requestId: text.optional(),
    target: text.optional(),
    policy: policy.default("stop-on-complete"),
    context: attributesSchema.default({}),
  }),
);

export type AgentOptions = AgentConfig & { providers?: Provider[] };

export type StartRun = z.input<typeof startSchema>;

export class Agents {
  private readonly activity: RunActivity;
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
    this.activity = new RunActivity(ctx, this.authority, configuration.activity.retentionMs);
    this.sessions = new NativeSessions(
      ctx,
      this.authority,
      this.activity,
      configuration.unmanaged?.systemPrompt,
    );

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
          (change.before?.attributes[agentAttributes.run] === true ||
            change.after?.attributes[agentAttributes.run] === true)
        )
          throw new Fault("agent-guard", "Tracked runs require the Agents API");
        if (change.kind === "edge") {
          const edge = change.before ?? change.after;
          if (
            edge !== null &&
            (edge.relation === agentRelations.serves ||
              edge.relation === agentRelations.continues) &&
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

  runs(): Node[] {
    return this.ctx.graph.all({ where: q.eq(q.attr(agentAttributes.run), true), lean: false });
  }

  start(raw: StartRun): Node {
    return this.create(raw);
  }

  async reconcile(): Promise<void> {
    if (this.reconcileTask !== undefined) return this.reconcileTask;

    this.reconcileTask = this.reconcileRuns().finally(() => {
      this.reconcileTask = undefined;
    });

    return this.reconcileTask;
  }

  native(raw: z.input<typeof registrationSchema>): unknown {
    const input: NativeRegistration = registrationSchema.parse(raw);

    return this.sessions.observe({
      ...input,
      ...agentMetadata(input, this.ctx.env.bl),
      audience: sessionAudience(input, this.ctx.env.bl),
      cwd: realpathSync(input.cwd),
    });
  }

  readActivity(input: ActivityRead) {
    return this.activity.read(input);
  }

  async cancel(id: string): Promise<Node> {
    const run = this.run(id);
    if (run.attributes[agentAttributes.external] === true)
      throw new Fault("custody", "External sessions grant no stop authority");
    if (runLifecycle(run).matches("pending")) return this.advance(id, { type: "ABANDON" });
    const spec = agentLaunchSchema.parse(run.attributes[agentAttributes.launch]);

    await this.ctx.processes.cancel(
      text.parse(run.attributes[agentAttributes.handle]),
      spec.owner,
      spec.key,
    );
    await this.reconcile();
    const fact = await this.ctx.processes.get(text.parse(run.attributes[agentAttributes.handle]));
    if (fact.phase !== "terminal")
      throw new Fault("custody", "Cancellation has no terminal evidence");

    return this.run(id);
  }

  retry(id: string): Node {
    return this.ctx.graph.atomic(() => {
      const run = this.run(id);
      if (
        run.attributes[agentAttributes.external] === true ||
        !runLifecycle(run).can({ type: "RETRY" }) ||
        run.attributes[agentAttributes.requestId] !== undefined ||
        this.ctx.graph.edges(id, agentRelations.serves).some((edge) => edge.from_id === id)
      )
        throw new Fault(
          "retry",
          "Retry requires a settled unassigned failure without request binding",
        );

      return this.advance(
        id,
        { type: "RETRY" },
        {
          [agentAttributes.error]: null,
          [agentAttributes.result]: null,
          [agentAttributes.invocation]: null,
          [agentAttributes.handle]: null,
          [agentAttributes.launch]: null,
          [agentAttributes.custody]: null,
          [agentAttributes.sessionId]: null,
          [agentAttributes.sessionConfirmed]: false,
          [agentAttributes.resumes]: false,
          [agentAttributes.identity]: null,
          [agentAttributes.integration]: "unobserved",
          [agentAttributes.observation]: null,
          [agentAttributes.activity]: null,
          [agentAttributes.acknowledged]: false,
        },
      );
    }, this.authority);
  }

  resume(id: string, prompt: string, requestId?: string): Node {
    return this.ctx.graph.atomic(() => {
      const parent = this.run(id);
      if (
        parent.attributes[agentAttributes.external] === true ||
        !runLifecycle(parent).hasTag("settled") ||
        parent.attributes[agentAttributes.sessionConfirmed] !== true
      )
        throw new Fault(
          "resume",
          "Resume requires a settled managed run with verified native session",
        );

      const existing = this.ctx.graph
        .edges(id, agentRelations.continues)
        .find((edge) => edge.to_id === id);
      if (existing !== undefined) {
        const child = this.run(existing.from_id);
        if (
          requestId !== undefined &&
          child.attributes[agentAttributes.requestId] === requestId &&
          child.attributes[agentAttributes.prompt] === prompt
        )
          return child;

        throw new Fault("resume", "Run already has an accepted continuation");
      }
      if (
        this.runs().some(
          (run) =>
            this.active(run) &&
            run.attributes[agentAttributes.provider] ===
              parent.attributes[agentAttributes.provider] &&
            run.attributes[agentAttributes.sessionId] ===
              parent.attributes[agentAttributes.sessionId],
        )
      )
        throw new Fault("resume", "Native session already has an active writer");

      const target = this.ctx.graph
        .edges(id, agentRelations.serves)
        .find((edge) => edge.from_id === id)?.to_id;
      const child = this.create(
        {
          seat: text.parse(parent.attributes[agentAttributes.seat]),
          cwd: text.parse(parent.attributes[agentAttributes.cwd]),
          prompt,
          ...(requestId === undefined ? {} : { requestId }),
          ...(target === undefined ? {} : { target }),
          policy: policy.parse(parent.attributes[agentAttributes.policy]),
          context: attributesSchema.parse(parent.attributes[agentAttributes.context]),
        },
        parent,
      );
      this.ctx.graph.connect(child.id, id, agentRelations.continues);

      return child;
    }, this.authority);
  }

  async acknowledge(id: string): Promise<Node> {
    const run = this.run(id);
    if (run.attributes[agentAttributes.external] === true)
      throw new Fault("custody", "Only settled managed runs may acknowledge custody");
    const lifecycle = runLifecycle(run);
    if (!lifecycle.hasTag("settled"))
      throw new Fault("custody", "Only settled managed runs may acknowledge custody");

    if (!lifecycle.hasTag("unlaunched")) {
      const spec = agentLaunchSchema.parse(run.attributes[agentAttributes.launch]);
      const owned = await this.ctx.processes.listOwned(spec.owner);
      const fact = owned.find((entry) => entry.key === spec.key);
      if (fact !== undefined)
        await this.ctx.processes.acknowledge(fact.handle, spec.owner, spec.key);
    }

    return this.patch(id, { [agentAttributes.acknowledged]: true });
  }

  catalog(name?: string, all = false): unknown {
    if (name !== undefined) return this.seats.show(name);

    const aliases = this.seats.list(all);
    return {
      providers: [...this.providers.keys()].filter((entry) => Object.hasOwn(aliases, entry)),
      aliases,
    };
  }

  async startResource(): Promise<void> {
    this.activity.start();
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

  // -- Private helpers --

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
          (run) => run.attributes[agentAttributes.requestId] === input.requestId,
        );
        if (existing !== undefined) {
          if (existing.attributes[agentAttributes.requestHash] !== hash)
            throw new Fault("replay", "Request ID was used with different input");
          return existing;
        }
      }

      const seat =
        parent === undefined
          ? this.seats.resolve(input.seat, { cwd, workspace: this.ctx.workspace })
          : seatSchema.parse(parent.attributes[agentAttributes.settings]);
      if (!this.providers.has(seat.provider))
        throw new Fault("provider", `Provider unavailable: ${seat.provider}`);

      if (input.target !== undefined) {
        if (this.ctx.graph.show(input.target).state !== "active")
          throw new Fault("assignment", "Assignment target must be active");
        if (
          this.runs().some(
            (run) =>
              this.active(run) &&
              this.ctx.graph.edge(run.id, input.target ?? "", agentRelations.serves) !== null,
          )
        )
          throw new Fault("assignment", "Target already has an active writer");
      }

      const attrs: Attributes = {
        [agentAttributes.run]: true,
        ...initialLifecycleAttributes(),
        [agentAttributes.accepted]: true,
        [agentAttributes.attempt]: 0,
        [agentAttributes.provider]: seat.provider,
        [agentAttributes.audience]: "agent",
        [agentAttributes.seat]: input.seat,
        [agentAttributes.cwd]: cwd,
        [agentAttributes.prompt]: input.prompt,
        [agentAttributes.policy]: input.policy,
        [agentAttributes.context]: input.context,
        ...(parent === undefined
          ? {}
          : {
              [agentAttributes.sessionId]: text.parse(parent.attributes[agentAttributes.sessionId]),
              [agentAttributes.identity]: text.parse(parent.attributes[agentAttributes.identity]),
            }),
        [agentAttributes.resumes]: parent !== undefined,
        [agentAttributes.sessionConfirmed]: false,
        [agentAttributes.integration]: "unobserved",
        [agentAttributes.settings]: jsonSchema.parse(
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
            : parent.attributes[agentAttributes.settings],
        ),
      };

      if (input.requestId !== undefined) {
        attrs[agentAttributes.requestId] = input.requestId;
        attrs[agentAttributes.requestHash] = hash;
      }

      const run = this.ctx.graph.add({ title: `Agent ${input.seat}`, attributes: attrs });

      if (input.target !== undefined)
        this.ctx.graph.connect(run.id, input.target, agentRelations.serves);

      return run;
    }, this.authority);
  }

  private async reconcileRuns(): Promise<void> {
    const owned = await this.ctx.processes.listOwned("agents");
    for (let run of this.runs().filter((row) => this.active(row))) {
      try {
        if (runLifecycle(run).matches("pending")) run = this.begin(run);
        if (!runLifecycle(run).hasTag("launched")) continue;

        const invocation = text.parse(run.attributes[agentAttributes.invocation]);
        const spec = agentLaunchSchema.parse(run.attributes[agentAttributes.launch]);
        let fact = owned.find((entry) => entry.owner === spec.owner && entry.key === spec.key);
        fact ??= await this.ctx.processes.launch(spec);
        const current = this.run(run.id);
        if (current.attributes[agentAttributes.invocation] !== invocation) continue;

        if (current.attributes[agentAttributes.handle] !== fact.handle)
          run = this.patch(run.id, { [agentAttributes.handle]: fact.handle });
        if (fact.phase !== "terminal") continue;

        if (fact.launch_failure !== undefined) {
          this.advance(
            run.id,
            { type: "LAUNCH_FAILED" },
            {
              [agentAttributes.error]: fact.launch_failure.message,
            },
          );
          continue;
        }

        if (fact.cancellation?.stop === "uncertain") {
          this.advance(
            run.id,
            { type: "STOP_UNCERTAIN" },
            {
              [agentAttributes.custody]: jsonSchema.parse(fact),
            },
          );
          continue;
        }

        if (fact.exit === undefined && fact.cancellation === undefined) {
          this.advance(
            run.id,
            { type: "RECONCILIATION_FAILED" },
            {
              [agentAttributes.error]: "Terminal custody has no observed exit",
            },
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

        this.advance(
          run.id,
          {
            type:
              fact.cancellation !== undefined
                ? "CANCELLED"
                : integrationError !== null
                  ? "SESSION_FAILED"
                  : outcome.success
                    ? "COMPLETED"
                    : "EXECUTION_FAILED",
          },
          {
            ...(integrationError === null ? {} : { [agentAttributes.sessionConfirmed]: false }),
            [agentAttributes.result]: outcome.result,
            [agentAttributes.error]:
              integrationError ?? (fact.cancellation === undefined ? outcome.error : null),
            [agentAttributes.custody]: jsonSchema.parse(fact),
          },
        );
      } catch (error) {
        this.advance(
          run.id,
          { type: "RECONCILIATION_FAILED" },
          {
            [agentAttributes.error]: String(error),
          },
        );
      }
    }
  }

  private active(run: Node): boolean {
    return (
      run.attributes[agentAttributes.external] !== true && !runLifecycle(run).hasTag("settled")
    );
  }

  private begin(run: Node): Node {
    return this.ctx.graph.atomic(() => {
      const current = this.run(run.id);
      if (!runLifecycle(current).can({ type: "LAUNCH" }))
        throw new Fault("attempt", "Run is not ready");
      const target = this.ctx.graph
        .edges(run.id, agentRelations.serves)
        .find((edge) => edge.from_id === run.id);
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
        BL_AGENT_SEAT: text.parse(current.attributes[agentAttributes.seat]),
        ...(definition.model === undefined ? {} : { BL_MODEL: definition.model }),
        ...(definition.effort === undefined ? {} : { BL_EFFORT: definition.effort }),
        ...(definition.resumes
          ? { BL_ACTOR: text.parse(current.attributes[agentAttributes.identity]) }
          : {}),
      };
      const spec: ProcessSpec = {
        owner: "agents",
        key: `${current.id}/${invocation}`,
        command: [
          "env",
          ...[
            "BL_AUDIENCE",
            "BL_ACTOR",
            "BL_AGENT_SEAT",
            "BL_MODEL",
            "BL_EFFORT",
            "BL_NATIVE_SESSION_ID",
            "BL_NATIVE_PROVIDER",
            "PI_SUBAGENT",
            "PI_SUBAGENT_CHILD",
          ].flatMap((key) => (trackingEnv[key] === undefined ? ["-u", key] : [])),
          ...plan.command,
        ],
        cwd: definition.cwd,
        stdin: plan.stdin,
        env: {
          ...Object.fromEntries(Object.entries(plan.env).filter(([key]) => key !== "BL_AUDIENCE")),
          ...trackingEnv,
          BL_WORKSPACE: this.ctx.workspace,
          BL_RUN_REFERENCE: `${current.id}:${invocation}`,
        },
      };

      const launched = this.advance(
        current.id,
        { type: "LAUNCH" },
        {
          [agentAttributes.invocation]: invocation,
          [agentAttributes.attempt]: number.parse(current.attributes[agentAttributes.attempt]) + 1,
          [agentAttributes.launch]: jsonSchema.parse(spec),
        },
      );
      this.activity.create(launched, invocation);
      return this.run(current.id);
    }, this.authority);
  }

  private advance(
    id: string,
    event: Parameters<typeof transitionRun>[1],
    attributes: Attributes = {},
  ): Node {
    return this.ctx.graph.atomic(() => {
      const update = transitionRun(this.run(id), event);
      const run = this.ctx.graph.update(id, {
        ...update,
        attributes: { ...attributes, ...update.attributes },
      });
      if (runLifecycle(run).hasTag("settled")) this.activity.settle(run);
      return run;
    }, this.authority);
  }

  private patch(id: string, attributes: Attributes): Node {
    return this.ctx.graph.atomic(() => this.ctx.graph.update(id, { attributes }), this.authority);
  }

  private run(id: string): Node {
    const run = this.ctx.graph.show(id);
    if (run.attributes[agentAttributes.run] !== true)
      throw new Fault("run", "Expected tracked run");

    return run;
  }

  private providerRun(run: Node): ProviderRun {
    const seat = seatSchema.parse(run.attributes[agentAttributes.settings]);

    return {
      provider: seat.provider,
      cwd: text.parse(run.attributes[agentAttributes.cwd]),
      prompt: text.parse(run.attributes[agentAttributes.prompt]),
      ...(run.attributes[agentAttributes.resumes] === true
        ? { resumes: true, sessionId: text.parse(run.attributes[agentAttributes.sessionId]) }
        : { resumes: false }),
      model: seat.model,
      effort: seat.effort,
      extraArgs: seat.extraArgs,
      systemPrompt: seat.systemPrompt,
    };
  }
}

// -- Private helpers --

function fingerprint(value: unknown): string {
  return createHash("sha256")
    .update(canonical(jsonSchema.parse(value)))
    .digest("hex");
}
