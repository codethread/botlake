import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

import {
  attributesSchema,
  canonical,
  Fault,
  requireValue,
  defineOp,
  q,
  type Attributes,
  type Strand,
  type Context,
  type ProcessSpec,
  type Spool,
} from "@millstrand/core";
import { getFlag } from "@millstrand/spool-flags";
import { nativeStartup, reserveIdentity } from "@millstrand/spool-identity";
import { match } from "ts-pattern";
import { z } from "zod";

import { Catalog, harnessConfigSchema, seatSchema, type HarnessConfig } from "./catalog.ts";
import { provider, type Provider, type ProviderRun } from "./providers.ts";

const text = z.string().min(1);
export type HarnessOptions = HarnessConfig & { providers?: Provider[] };
const startSchema = z.strictObject({
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
  private readonly providers = new Map<string, Provider>();
  private readonly seats: Catalog;
  private readonly configuration: z.output<typeof harnessConfigSchema>;
  private reconcileTask: Promise<void> | undefined;
  constructor(
    private readonly ctx: Context,
    options: HarnessOptions = {},
  ) {
    this.configuration = harnessConfigSchema.parse({
      aliases: options.aliases,
      reviewers: options.reviewers,
    });
    for (const entry of options.providers ?? [
      provider("codex"),
      provider("pi"),
      provider("claude"),
      provider("cursor"),
    ]) {
      if (this.providers.has(entry.name))
        throw new Fault("collision", `Duplicate provider: ${entry.name}`);
      this.providers.set(entry.name, entry);
    }
    this.seats = new Catalog(
      [...this.providers.values()].map((entry) => entry.name),
      this.configuration.aliases,
      (name) => getFlag(ctx, name),
    );
    ctx.graph.protect((changes, token) => {
      if (token === this.authority) return;
      for (const change of changes) {
        if (
          change.kind === "strand" &&
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
  private patch(id: string, attributes: Attributes, state?: "active" | "closed"): Strand {
    return this.ctx.graph.atomic(
      () => this.ctx.graph.update(id, { attributes, ...(state === undefined ? {} : { state }) }),
      this.authority,
    );
  }
  runs(): Strand[] {
    return this.ctx.graph.all({ where: q.eq(q.attr("harness/run"), true), lean: false });
  }
  private run(id: string): Strand {
    const run = this.ctx.graph.show(id);
    if (run.attributes["harness/run"] !== true) throw new Fault("run", "Expected tracked run");
    return run;
  }
  private active(run: Strand): boolean {
    return run.attributes["harness/settled"] !== true;
  }
  start(raw: StartRun): Strand {
    return this.create(raw);
  }
  private create(raw: StartRun, parent?: Strand): Strand {
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
      const identity =
        parent === undefined
          ? reserveIdentity(this.ctx, {
              harness: seat.provider,
              model: seat.model,
              thinkingLevel: seat.effort,
            })
          : {
              identity: text.parse(parent.attributes["harness/identity"]),
              reservationId: text.parse(parent.attributes["harness/reservation-id"]),
            };
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
        "harness/session-id":
          parent === undefined
            ? crypto.randomUUID()
            : text.parse(parent.attributes["harness/session-id"]),
        "harness/resumes": parent !== undefined,
        "harness/session-confirmed": false,
        "harness/identity": identity.identity,
        "harness/reservation-id": identity.reservationId,
        "harness/settings": z.json().parse(
          parent === undefined
            ? {
                ...seat,
                systemPrompts: [
                  ...seat.systemPrompts,
                  ...(input.target === undefined
                    ? []
                    : [
                        `You serve task ${input.target}. ${input.policy === "close-on-complete" ? "Close the task yourself only when its intended outcome is satisfied." : "Stop after reporting results; completing the process does not close the task."}`,
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
  private providerRun(run: Strand): ProviderRun {
    const seat = seatSchema.parse(run.attributes["harness/settings"]);
    return {
      provider: seat.provider,
      cwd: text.parse(run.attributes["harness/cwd"]),
      prompt: text.parse(run.attributes["harness/prompt"]),
      sessionId: text.parse(run.attributes["harness/session-id"]),
      resumes: run.attributes["harness/resumes"] === true,
      model: seat.model,
      effort: seat.effort,
      fast: seat.fast,
      extraArgs: seat.extraArgs,
      systemPrompts: seat.systemPrompts,
    };
  }
  private begin(run: Strand): Strand {
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
        command: plan.command,
        cwd: definition.cwd,
        stdin: plan.stdin,
        env: {
          ...plan.env,
          MILLSTRAND_WORKSPACE: this.ctx.workspace,
          MILLSTRAND_RUN_REFERENCE: `${current.id}:${invocation}`,
          MILLSTRAND_RUN_ID: current.id,
          MILLSTRAND_INVOCATION: invocation,
          MILLSTRAND_IDENTITY: text.parse(current.attributes["harness/identity"]),
          MILLSTRAND_RESERVATION_ID: text.parse(current.attributes["harness/reservation-id"]),
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
        if (fact.cancellation !== undefined) {
          this.patch(
            run.id,
            {
              "harness/state": "stopped",
              "harness/substatus": "requested",
              "harness/settled": fact.cancellation.stop !== "uncertain",
              "harness/custody": z.json().parse(fact),
            },
            "closed",
          );
          continue;
        }
        if (fact.exit === undefined) {
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
        ).finish(definition, fact.exit.code, stdout, stderr);
        const identity = this.run(run.id).attributes["harness/identity"];
        const bound = this.ctx.graph
          .edges(run.id, "performed")
          .some(
            (edge) =>
              edge.to_id === run.id &&
              edge.attributes["invocation"] === invocation &&
              this.ctx.graph.show(edge.from_id).attributes["identity/id"] === identity,
          );
        const session = this.run(run.id).attributes["harness/session-id"];
        const bootstrap = !bound || (outcome.sessionId !== null && session !== outcome.sessionId);
        this.patch(
          run.id,
          {
            "harness/state": outcome.success && !bootstrap ? "stopped" : "failed",
            "harness/substatus": bootstrap
              ? "bootstrap"
              : outcome.success
                ? "completed"
                : "execution",
            "harness/settled": true,
            "harness/result": outcome.result,
            "harness/error": bootstrap
              ? "Native identity startup did not bind the observed session"
              : outcome.error,
            "harness/session-confirmed": !bootstrap && outcome.sessionId !== null,
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
  native(input: {
    provider: "codex" | "pi" | "claude" | "cursor";
    nativeSessionId: string;
    cwd: string;
    runId?: string | undefined;
    invocation?: string | undefined;
    parentIdentity?: string | undefined;
    model?: string | undefined;
    thinkingLevel?: string | undefined;
  }): unknown {
    const cwd = realpathSync(input.cwd);
    return this.ctx.graph.atomic(() => {
      if (input.runId === undefined) {
        const binding = nativeStartup(this.ctx, {
          harness: input.provider,
          nativeSessionId: input.nativeSessionId,
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel }),
          ...(input.parentIdentity === undefined ? {} : { parentIdentity: input.parentIdentity }),
        });
        let external = this.runs().find(
          (run) =>
            run.attributes["harness/external"] === true &&
            run.attributes["harness/identity"] === binding.identity,
        );
        external ??= this.ctx.graph.add({
          title: `External ${input.provider}`,
          attributes: {
            "harness/run": true,
            "harness/external": true,
            "harness/identity": binding.identity,
            "harness/provider": input.provider,
            "harness/cwd": cwd,
            "harness/session-id": input.nativeSessionId,
            "harness/state": "running",
            "harness/settled": false,
          },
        });
        nativeStartup(this.ctx, {
          harness: input.provider,
          nativeSessionId: input.nativeSessionId,
          identity: binding.identity,
          runId: external.id,
        });
        return { ...binding, runId: external.id, external: true };
      }
      const run = this.run(input.runId);
      if (
        run.attributes["harness/state"] !== "running" ||
        run.attributes["harness/invocation"] !== input.invocation ||
        run.attributes["harness/provider"] !== input.provider ||
        run.attributes["harness/cwd"] !== cwd ||
        run.attributes["harness/external"] === true
      )
        throw new Fault("native", "Stale or mismatched native run registration");
      if (
        run.attributes["harness/resumes"] === true &&
        run.attributes["harness/session-id"] !== input.nativeSessionId
      )
        throw new Fault("native", "Resumed native session mismatch");
      this.patch(run.id, { "harness/session-id": input.nativeSessionId });
      return nativeStartup(this.ctx, {
        harness: input.provider,
        nativeSessionId: input.nativeSessionId,
        identity: text.parse(run.attributes["harness/identity"]),
        reservationId: text.parse(run.attributes["harness/reservation-id"]),
        runId: run.id,
        invocation: input.invocation,
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel }),
      });
    }, this.authority);
  }
  async cancel(id: string): Promise<Strand> {
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
  retry(id: string): Strand {
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
      const identity = reserveIdentity(this.ctx, {
        harness: text.parse(run.attributes["harness/provider"]),
      });
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
          "harness/custody": null,
          "harness/session-id": crypto.randomUUID(),
          "harness/session-confirmed": false,
          "harness/resumes": false,
          "harness/identity": identity.identity,
          "harness/reservation-id": identity.reservationId,
        },
        "active",
      );
    }, this.authority);
  }
  resume(id: string, prompt: string, requestId?: string): Strand {
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
            this.active(run) &&
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
  async acknowledge(id: string): Promise<Strand> {
    const run = this.run(id);
    if (run.attributes["harness/external"] === true || run.attributes["harness/settled"] !== true)
      throw new Fault("custody", "Only settled managed runs may acknowledge custody");
    const spec = launchSchema.parse(run.attributes["harness/launch"]);
    const owned = await this.ctx.processes.listOwned(spec.owner);
    const fact = owned.find((entry) => entry.key === spec.key);
    if (fact !== undefined) await this.ctx.processes.acknowledge(fact.handle, spec.owner, spec.key);
    return this.patch(id, { "harness/acknowledged": true });
  }
  async review(input: {
    cwd: string;
    base?: string | undefined;
    reviewer?: string | undefined;
    labels?: string[] | undefined;
  }): Promise<unknown> {
    const cwd = realpathSync(input.cwd);
    async function git(args: string[]): Promise<string> {
      const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
      const [output, error, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (code !== 0) throw new Fault("review", error);
      return output;
    }
    const base = (
      await git(["rev-parse", "--verify", "--end-of-options", `${input.base ?? "HEAD"}^{commit}`])
    ).trim();
    const change = await git(["diff", "--no-ext-diff", base, "--"]);
    if (change.trim().length === 0) return { result: "skipped", reason: "empty-diff", runs: [] };
    const files = (await git(["diff", "--name-only", base, "--"])).trim().split("\n");
    const candidates = Object.entries(this.configuration.reviewers).filter(
      ([name, reviewer]) =>
        (input.reviewer === undefined || name === input.reviewer) &&
        (input.labels ?? []).every((label) => reviewer.labels?.includes(label) === true) &&
        (reviewer.paths === undefined ||
          files.some(
            (file) => reviewer.paths?.some((glob) => new Bun.Glob(glob).match(file)) === true,
          )),
    );
    if (input.reviewer !== undefined && this.configuration.reviewers[input.reviewer] === undefined)
      throw new Fault("review", `Unknown reviewer: ${input.reviewer}`);
    if (candidates.length === 0)
      return { result: "skipped", reason: "no-matching-reviewers", runs: [] };
    const selected = candidates.map(([name, reviewer]) => {
      const seat = reviewer.seats.find((candidate) => {
        const resolved = this.seats.availability(candidate);
        if (!resolved.available) return false;
        const configured = resolved.settings;
        const backend = requireValue(
          this.providers.get(configured.provider),
          "Reviewer provider unavailable",
        );
        const executable = backend.prepare({
          provider: configured.provider,
          cwd,
          prompt: reviewer.prompt,
          sessionId: "preflight",
          resumes: false,
          extraArgs: configured.extraArgs,
          systemPrompts: configured.systemPrompts,
          model: configured.model,
          effort: configured.effort,
          fast: configured.fast,
        }).command[0];
        return executable !== undefined && Bun.which(executable, { cwd }) !== null;
      });
      if (seat === undefined) throw new Fault("review", `No available seat for reviewer ${name}`);
      return { name, reviewer, seat };
    });
    const runs = this.ctx.graph.atomic(
      () =>
        selected.map(({ name, reviewer, seat }) =>
          this.start({
            seat,
            cwd,
            prompt: `${reviewer.prompt}\n\nReview only. Report actionable findings; do not change the files.\n\n${change}`,
            context: { reviewer: name, base, changeHash: fingerprint(change), files },
          }),
        ),
      this.authority,
    );
    await this.reconcile();
    return { result: "started", runs };
  }
  catalog(name?: string): unknown {
    if (name !== undefined) return this.seats.show(name);
    return {
      providers: [...this.providers.keys()],
      aliases: this.seats.list(),
      reviewers: this.configuration.reviewers,
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
export function harnesses(options: HarnessOptions = {}): Spool {
  return {
    name: "harnesses",
    requires: ["identity", "flags"],
    activate(ctx) {
      const service = new Harnesses(ctx, options);
      for (const state of ["ready", "running", "stopped", "failed"])
        ctx.registerQuery(`agent-run-${state}`, {
          where: q.and(q.eq(q.attr("harness/run"), true), q.eq(q.attr("harness/state"), state)),
          description: `Agent runs in ${state} state`,
        });
      ctx.resource({ start: () => service.startResource(), stop: () => service.stop() });
      const input = z.discriminatedUnion("command", [
        startSchema.extend({ command: z.literal("start") }),
        z.strictObject({ command: z.literal("list") }),
        z.strictObject({ command: z.literal("show"), id: text }),
        z.strictObject({ command: z.literal("catalog"), name: text.optional() }),
        z.strictObject({ command: z.literal("reconcile") }),
        z.strictObject({ command: z.literal("cancel"), id: text }),
        z.strictObject({ command: z.literal("retry"), id: text }),
        z.strictObject({
          command: z.literal("resume"),
          id: text,
          prompt: text,
          requestId: text.optional(),
        }),
        z.strictObject({ command: z.literal("acknowledge"), id: text }),
        z.strictObject({
          command: z.literal("review"),
          cwd: text,
          base: text.optional(),
          reviewer: text.optional(),
          labels: z.array(text).optional(),
        }),
        z.strictObject({
          command: z.literal("native"),
          provider: z.enum(["codex", "pi", "claude", "cursor"]),
          nativeSessionId: text,
          cwd: text,
          runId: text.optional(),
          invocation: text.optional(),
          parentIdentity: text.optional(),
          model: text.optional(),
          thinkingLevel: text.optional(),
        }),
      ]);
      ctx.register(
        defineOp({
          name: "agent",
          primer:
            "Inspect catalog for seat docs, effective models and availability; catalog NAME shows candidates and full settings. Flags control new seat selection: flag set harness/PROVIDER false disables a provider; alias conditions use generic workspace flags. Start a tracked run with a seat, working directory and prompt. Native startup binds its session. Accepted settings are frozen across flag changes, retry and resume. Inspect show or reconcile before continuing. Process completion does not complete tasks; external sessions carry no stop authority.",
          input,
          output: z.json(),
          cli: {
            description: "Tracked agent runs and native registration",
            examples: [
              "strand agent catalog",
              "strand agent catalog reviewer",
              "strand agent list",
              "strand agent show RUN_ID",
            ],
            commands: {
              list: { description: "Runs" },
              catalog: {
                description: "Seat docs and availability; name expands candidates and settings",
                positionals: [{ name: "name", type: "string" }],
              },
              reconcile: { description: "Reconcile custody" },
              show: {
                description: "Run",
                positionals: [{ name: "id", type: "string", required: true }],
              },
              cancel: {
                description: "Cancel owned process",
                positionals: [{ name: "id", type: "string", required: true }],
              },
              retry: {
                description: "Retry settled failure",
                positionals: [{ name: "id", type: "string", required: true }],
              },
              acknowledge: {
                description: "Release retained process evidence",
                positionals: [{ name: "id", type: "string", required: true }],
              },
              resume: {
                description: "Resume verified session",
                positionals: [
                  { name: "id", type: "string", required: true },
                  { name: "prompt", type: "string", required: true },
                ],
                flags: { "request-id": { key: "requestId", type: "string" } },
              },
              review: {
                description: "Review a frozen Git diff",
                flags: {
                  cwd: { type: "string", required: true },
                  base: { type: "string" },
                  reviewer: { type: "string" },
                  labels: { type: "string", multiple: true },
                },
              },
              native: {
                description: "Register actual native session",
                flags: {
                  provider: { type: "string", required: true },
                  "native-session-id": { key: "nativeSessionId", type: "string", required: true },
                  cwd: { type: "string", required: true },
                  "run-id": { key: "runId", type: "string" },
                  invocation: { type: "string" },
                  "parent-identity": { key: "parentIdentity", type: "string" },
                  model: { type: "string" },
                  "thinking-level": { key: "thinkingLevel", type: "string" },
                },
              },
              start: {
                description: "Create run",
                flags: {
                  seat: { type: "string", required: true },
                  cwd: { type: "string", required: true },
                  prompt: { type: "string", required: true },
                  target: { type: "string" },
                  "request-id": { key: "requestId", type: "string" },
                },
              },
            },
          },
          async handler(value) {
            const result = await match(value)
              .with({ command: "start" }, async (commandInput) => {
                const { command: _, ...request } = commandInput;
                const run = service.start(request);
                await service.reconcile();
                return ctx.graph.show(run.id);
              })
              .with({ command: "list" }, () => service.runs())
              .with({ command: "show" }, ({ id }) => ctx.graph.show(id))
              .with({ command: "catalog" }, ({ name }) => service.catalog(name))
              .with({ command: "reconcile" }, async () => {
                await service.reconcile();
                return service.runs();
              })
              .with({ command: "cancel" }, ({ id }) => service.cancel(id))
              .with({ command: "retry" }, async ({ id }) => {
                const run = service.retry(id);
                await service.reconcile();
                return run;
              })
              .with({ command: "resume" }, async ({ id, prompt, requestId }) => {
                const run = service.resume(id, prompt, requestId);
                await service.reconcile();
                return run;
              })
              .with({ command: "acknowledge" }, ({ id }) => service.acknowledge(id))
              .with({ command: "review" }, (request) => service.review(request))
              .with({ command: "native" }, (commandInput) => {
                const { command: _, ...request } = commandInput;
                return service.native(request);
              })
              .exhaustive();
            return z.json().parse(result);
          },
        }),
      );
    },
  };
}

export default harnesses();

export { harnessConfigSchema, harnessConfigJsonSchema } from "./catalog.ts";
export type { Seat, Alias, Condition, Reviewer, HarnessConfig } from "./catalog.ts";
export { provider } from "./providers.ts";
export type { Provider, ProviderRun, LaunchPlan, Outcome } from "./providers.ts";
