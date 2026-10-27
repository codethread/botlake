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

import { Catalog, harnessConfigSchema, seatSchema, type HarnessConfig } from "./catalog.ts";
import { NativeSessions } from "./native.ts";
import type { Provider, ProviderName, ProviderRun } from "./providers/contract.ts";
import { provider } from "./providers/index.ts";

const text = z.string().min(1);

export type HarnessOptions = HarnessConfig & { providers?: Provider[] };

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

export class Harnesses {
  private readonly authority = Symbol("harnesses");
  private readonly providers = new Map<ProviderName, Provider>();
  private readonly seats: Catalog;
  private readonly sessions: NativeSessions;
  private reconcileTask: Promise<void> | undefined;

  constructor(
    private readonly ctx: Context,
    options: HarnessOptions = {},
  ) {
    this.sessions = new NativeSessions(ctx, this.authority);
    const { providers, ...config } = options;
    const configuration = harnessConfigSchema.parse(config);

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
          (change.before?.attributes["harness/run"] === true ||
            change.after?.attributes["harness/run"] === true)
        )
          throw new Fault("harness-guard", "Tracked runs require the Harnesses API");
        if (change.kind === "edge") {
          const edge = change.before ?? change.after;
          if (
            edge !== null &&
            ["serves", "continues"].includes(edge.relation) &&
            this.runs().some((run) => run.id === edge.from_id)
          )
            throw new Fault("harness-guard", "Execution authority requires the Harnesses API");
        }
      }
    });

    ctx.scheduler.register("harnesses/reconcile", async () => {
      await this.reconcile();
      ctx.scheduler.schedule("harnesses/reconcile", ctx.clock.now() + 1000, "harnesses/reconcile");
    });
  }

  private patch(id: string, attributes: Attributes, state?: "active" | "closed"): Node {
    return this.ctx.graph.atomic(
      () => this.ctx.graph.update(id, { attributes, ...(state === undefined ? {} : { state }) }),
      this.authority,
    );
  }

  runs(): Node[] {
    return this.ctx.graph.all({ where: q.eq(q.attr("harness/run"), true), lean: false });
  }

  private run(id: string): Node {
    const run = this.ctx.graph.show(id);
    if (run.attributes["harness/run"] !== true) throw new Fault("run", "Expected tracked run");
    return run;
  }

  private active(run: Node): boolean {
    return run.attributes["harness/settled"] !== true;
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
          (run) => run.attributes["harness/request-id"] === input.requestId,
        );
        if (existing !== undefined) {
          if (existing.attributes["harness/request-hash"] !== hash)
            throw new Fault("replay", "Request ID was used with different input");
          return existing;
        }
      }

      const seat =
        parent === undefined
          ? this.seats.resolve(input.seat)
          : seatSchema.parse(parent.attributes["harness/settings"]);
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
        "harness/run": true,
        "harness/state": "ready",
        "harness/substatus": "pending",
        "harness/accepted": true,
        "harness/settled": false,
        "harness/attempt": 0,
        "harness/provider": seat.provider,
        "harness/seat": input.seat,
        "harness/cwd": cwd,
        "harness/prompt": input.prompt,
        "harness/policy": input.policy,
        "harness/context": input.context,
        ...(parent === undefined
          ? {}
          : {
              "harness/session-id": text.parse(parent.attributes["harness/session-id"]),
              "harness/identity": text.parse(parent.attributes["harness/identity"]),
            }),
        "harness/resumes": parent !== undefined,
        "harness/session-confirmed": false,
        "harness/integration": "unobserved",
        "harness/settings": z.json().parse(
          parent === undefined
            ? {
                ...seat,
                systemPrompts: [
                  ...seat.systemPrompts,
                  ...(input.target === undefined
                    ? []
                    : [
                        `You serve task ${input.target}. ${
                          input.policy === "close-on-complete"
                            ? "Close the task yourself only when its intended outcome is satisfied."
                            : "Stop after reporting results; completing the process does not close the task."
                        }`,
                      ]),
                ],
              }
            : parent.attributes["harness/settings"],
        ),
      };

      if (input.requestId !== undefined) {
        attrs["harness/request-id"] = input.requestId;
        attrs["harness/request-hash"] = hash;
      }

      const run = this.ctx.graph.add({ title: `Agent ${input.seat}`, attributes: attrs });
      if (input.target !== undefined) this.ctx.graph.connect(run.id, input.target, "serves");
      return run;
    }, this.authority);
  }

  private providerRun(run: Node): ProviderRun {
    const seat = seatSchema.parse(run.attributes["harness/settings"]);
    return {
      provider: seat.provider,
      cwd: text.parse(run.attributes["harness/cwd"]),
      prompt: text.parse(run.attributes["harness/prompt"]),
      ...(run.attributes["harness/resumes"] === true
        ? { resumes: true, sessionId: text.parse(run.attributes["harness/session-id"]) }
        : { resumes: false }),
      model: seat.model,
      effort: seat.effort,
      extraArgs: seat.extraArgs,
      systemPrompts: seat.systemPrompts,
    };
  }

  private begin(run: Node): Node {
    return this.ctx.graph.atomic(() => {
      const current = this.run(run.id);
      if (current.attributes["harness/state"] !== "ready")
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
      const spec: ProcessSpec = {
        owner: "harnesses",
        key: `${current.id}/${invocation}`,
        command: [
          "env",
          "-u",
          "BOTLAKE_IDENTITY",
          "-u",
          "BOTLAKE_NATIVE_SESSION_ID",
          "-u",
          "BOTLAKE_NATIVE_PROVIDER",
          ...plan.command,
        ],
        cwd: definition.cwd,
        stdin: plan.stdin,
        env: {
          ...plan.env,
          BOTLAKE_WORKSPACE: this.ctx.workspace,
          BOTLAKE_RUN_REFERENCE: `${current.id}:${invocation}`,
        },
      };
      return this.patch(current.id, {
        "harness/state": "running",
        "harness/invocation": invocation,
        "harness/attempt": z.number().parse(current.attributes["harness/attempt"]) + 1,
        "harness/launch": z.json().parse(spec),
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
    const owned = await this.ctx.processes.listOwned("harnesses");
    for (let run of this.runs().filter(
      (row) => row.attributes["harness/external"] !== true && this.active(row),
    )) {
      try {
        if (run.attributes["harness/state"] === "ready") run = this.begin(run);
        if (
          run.attributes["harness/state"] !== "running" &&
          run.attributes["harness/launch"] === undefined
        )
          continue;
        const invocation = text.parse(run.attributes["harness/invocation"]);
        const spec = launchSchema.parse(run.attributes["harness/launch"]);
        let fact = owned.find((entry) => entry.owner === spec.owner && entry.key === spec.key);
        fact ??= await this.ctx.processes.launch(spec);
        const current = this.run(run.id);
        if (current.attributes["harness/invocation"] !== invocation) continue;

        if (current.attributes["harness/handle"] !== fact.handle)
          run = this.patch(run.id, { "harness/handle": fact.handle });
        if (fact.phase !== "terminal") continue;

        if (fact.launch_failure !== undefined) {
          this.patch(
            run.id,
            {
              "harness/state": "failed",
              "harness/substatus": "launch",
              "harness/settled": true,
              "harness/error": fact.launch_failure.message,
            },
            "closed",
          );
          continue;
        }

        if (fact.cancellation?.stop === "uncertain") {
          this.patch(
            run.id,
            {
              "harness/state": "stopped",
              "harness/substatus": "requested",
              "harness/settled": false,
              "harness/custody": z.json().parse(fact),
            },
            "closed",
          );
          continue;
        }

        if (fact.exit === undefined && fact.cancellation === undefined) {
          this.patch(
            run.id,
            {
              "harness/state": "failed",
              "harness/substatus": "reconciliation",
              "harness/settled": false,
              "harness/error": "Terminal custody has no observed exit",
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
            "harness/state":
              fact.cancellation !== undefined || (outcome.success && integrationError === null)
                ? "stopped"
                : "failed",
            "harness/substatus":
              fact.cancellation !== undefined
                ? "requested"
                : integrationError !== null
                  ? "native-session"
                  : outcome.success
                    ? "completed"
                    : "execution",
            ...(integrationError === null ? {} : { "harness/session-confirmed": false }),
            "harness/settled": true,
            "harness/result": outcome.result,
            "harness/error":
              integrationError ?? (fact.cancellation === undefined ? outcome.error : null),
            "harness/custody": z.json().parse(fact),
          },
          "closed",
        );
      } catch (error) {
        this.patch(
          run.id,
          {
            "harness/state": "failed",
            "harness/substatus": "reconciliation",
            "harness/error": String(error),
            "harness/settled": run.attributes["harness/launch"] === undefined,
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
    if (run.attributes["harness/external"] === true)
      throw new Fault("custody", "External sessions grant no stop authority");
    if (run.attributes["harness/state"] === "ready")
      return this.patch(
        id,
        { "harness/state": "stopped", "harness/substatus": "abandoned", "harness/settled": true },
        "closed",
      );
    const spec = launchSchema.parse(run.attributes["harness/launch"]);

    await this.ctx.processes.cancel(
      text.parse(run.attributes["harness/handle"]),
      spec.owner,
      spec.key,
    );
    await this.reconcile();
    const fact = await this.ctx.processes.get(text.parse(run.attributes["harness/handle"]));
    if (fact.phase !== "terminal")
      throw new Fault("custody", "Cancellation has no terminal evidence");
    return this.run(id);
  }

  retry(id: string): Node {
    return this.ctx.graph.atomic(() => {
      const run = this.run(id);
      if (
        run.attributes["harness/state"] !== "failed" ||
        run.attributes["harness/settled"] !== true ||
        run.attributes["harness/external"] === true ||
        run.attributes["harness/request-id"] !== undefined ||
        this.ctx.graph.edges(id, "serves").some((edge) => edge.from_id === id)
      )
        throw new Fault(
          "retry",
          "Retry requires a settled unassigned failure without request binding",
        );

      return this.patch(
        id,
        {
          "harness/state": "ready",
          "harness/substatus": "pending",
          "harness/settled": false,
          "harness/error": null,
          "harness/result": null,
          "harness/invocation": null,
          "harness/handle": null,
          "harness/launch": null,
          "harness/custody": null,
          "harness/session-id": null,
          "harness/session-confirmed": false,
          "harness/resumes": false,
          "harness/identity": null,
          "harness/integration": "unobserved",
          "harness/observation": null,
        },
        "active",
      );
    }, this.authority);
  }

  resume(id: string, prompt: string, requestId?: string): Node {
    return this.ctx.graph.atomic(() => {
      const parent = this.run(id);
      if (
        parent.attributes["harness/settled"] !== true ||
        parent.attributes["harness/session-confirmed"] !== true ||
        parent.attributes["harness/external"] === true
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
          child.attributes["harness/request-id"] === requestId &&
          child.attributes["harness/prompt"] === prompt
        )
          return child;
        throw new Fault("resume", "Run already has an accepted continuation");
      }
      if (
        this.runs().some(
          (run) =>
            run.attributes["harness/external"] !== true &&
            this.active(run) &&
            run.attributes["harness/provider"] === parent.attributes["harness/provider"] &&
            run.attributes["harness/session-id"] === parent.attributes["harness/session-id"],
        )
      )
        throw new Fault("resume", "Native session already has an active writer");

      const target = this.ctx.graph.edges(id, "serves").find((edge) => edge.from_id === id)?.to_id;
      const child = this.create(
        {
          seat: text.parse(parent.attributes["harness/seat"]),
          cwd: text.parse(parent.attributes["harness/cwd"]),
          prompt,
          ...(requestId === undefined ? {} : { requestId }),
          ...(target === undefined ? {} : { target }),
          policy: z
            .enum(["stop-on-complete", "close-on-complete"])
            .parse(parent.attributes["harness/policy"]),
          context: attributesSchema.parse(parent.attributes["harness/context"]),
        },
        parent,
      );
      this.ctx.graph.connect(child.id, id, "continues");
      return child;
    }, this.authority);
  }

  async acknowledge(id: string): Promise<Node> {
    const run = this.run(id);
    if (run.attributes["harness/external"] === true || run.attributes["harness/settled"] !== true)
      throw new Fault("custody", "Only settled managed runs may acknowledge custody");
    const spec = launchSchema.parse(run.attributes["harness/launch"]);
    const owned = await this.ctx.processes.listOwned(spec.owner);
    const fact = owned.find((entry) => entry.key === spec.key);
    if (fact !== undefined) await this.ctx.processes.acknowledge(fact.handle, spec.owner, spec.key);
    return this.patch(id, { "harness/acknowledged": true });
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
    const pending = this.ctx.scheduler.pending().find((wake) => wake.key === "harnesses/reconcile");
    if (pending === undefined)
      this.ctx.scheduler.schedule(
        "harnesses/reconcile",
        this.ctx.clock.now() + 1000,
        "harnesses/reconcile",
      );
  }

  async stop(): Promise<void> {
    await this.reconcileTask;
  }
}
