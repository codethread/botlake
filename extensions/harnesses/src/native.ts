import { Fault, q, type Context, type Node } from "@botlake/core";
import { nativeStartup, observeIdentity, recordParticipation } from "@botlake/extension-identity";
import {
  providerSchema,
  type NativeBinding,
  type NativeRegistration,
  type ProviderName,
} from "@botlake/native-session";
import { z } from "zod";

const text = z.string().min(1);

export class NativeSessions {
  constructor(
    private readonly ctx: Context,
    private readonly authority: symbol,
  ) {}

  private runs(provider: ProviderName, sessionId: string): Node[] {
    return this.ctx.graph.all({
      where: q.and(
        q.eq(q.attr("harness/run"), true),
        q.eq(q.attr("harness/provider"), provider),
        q.eq(q.attr("harness/session-id"), sessionId),
      ),
      lean: false,
    });
  }

  private managed(input: NativeRegistration): Node {
    const run = this.ctx.graph.show(text.parse(input.runId));
    if (
      run.attributes["harness/run"] !== true ||
      run.attributes["harness/external"] === true ||
      run.attributes["harness/state"] !== "running" ||
      run.attributes["harness/invocation"] !== input.invocation ||
      run.attributes["harness/provider"] !== input.provider
    )
      throw new Fault("native", "Stale or mismatched native run registration");
    const expected = run.attributes["harness/session-id"];
    if (expected !== undefined && expected !== input.nativeSessionId)
      throw new Fault("native", "Native session differs from the linked run");
    if (
      run.attributes["harness/integration"] === "unobserved" &&
      run.attributes["harness/cwd"] !== input.cwd
    )
      throw new Fault("native", "Native startup cwd differs from its run");

    if (
      this.runs(input.provider, input.nativeSessionId).some(
        (other) =>
          other.id !== run.id &&
          other.attributes["harness/external"] !== true &&
          other.attributes["harness/settled"] !== true,
      )
    )
      throw new Fault("native", "Native session already has an active managed writer");
    return run;
  }

  observe(input: NativeRegistration): NativeBinding {
    return this.ctx.graph.atomic(() => {
      let run: Node;
      if (input.runId !== undefined) {
        const referenced = this.ctx.graph.show(input.runId);
        const previous = referenced.attributes["harness/session-id"];

        // Native clear/fork can switch sessions while retaining the launching environment.
        // Only an already registered external session may bypass that inherited reference.
        const detached =
          typeof previous === "string" && previous !== input.nativeSessionId
            ? this.runs(input.provider, input.nativeSessionId).find(
                (entry) => entry.attributes["harness/external"] === true,
              )
            : undefined;
        run = detached ?? this.managed(input);
      } else {
        const matches = this.runs(input.provider, input.nativeSessionId);

        if (
          matches.some(
            (entry) =>
              entry.attributes["harness/external"] !== true &&
              entry.attributes["harness/settled"] !== true,
          )
        )
          throw new Fault(
            "native",
            "Managed session observations require the current run reference",
          );
        run =
          matches.find((entry) => entry.attributes["harness/external"] === true) ??
          this.ctx.graph.add({
            title: `Native ${input.provider}`,
            attributes: {
              "harness/run": true,
              "harness/external": true,
              "harness/provider": input.provider,
              "harness/session-id": input.nativeSessionId,
              "harness/cwd": input.cwd,
              "harness/state": "external",
            },
          });
      }

      const binding = observeIdentity(this.ctx, input);
      const session = this.ctx.graph.show(binding.nodeId);

      this.ctx.graph.update(run.id, {
        attributes: {
          "harness/identity": binding.identity,
          "harness/session-id": input.nativeSessionId,
          "harness/session-confirmed": true,
          "harness/integration": "native",
          "harness/observation": {
            event: input.event,
            at: this.ctx.clock.now(),
            activity: session.attributes["identity/activity"] ?? "unknown",
            model: session.attributes["identity/model"] ?? null,
            thinkingLevel: session.attributes["identity/thinking-level"] ?? null,
            cwd: input.cwd,
            capabilities: session.attributes["identity/capabilities"] ?? [],
          },
        },
      });
      const external = run.attributes["harness/external"] === true;

      recordParticipation(
        this.ctx,
        binding.identity,
        run.id,
        external ? "external" : text.parse(input.invocation),
      );
      return {
        identity: binding.identity,
        nodeId: binding.nodeId,
        instruction: binding.instruction,
        runId: run.id,
        external,
      };
    }, this.authority);
  }

  // Output is useful session evidence when plugins are unavailable, never fabricated activity.
  fromOutput(run: Node, nativeSessionId: string): void {
    this.ctx.graph.atomic(() => {
      const input: NativeRegistration = {
        provider: providerSchema.parse(run.attributes["harness/provider"]),
        nativeSessionId,
        cwd: text.parse(run.attributes["harness/cwd"]),
        event: "metadata",
        runId: run.id,
        invocation: text.parse(run.attributes["harness/invocation"]),
      };
      const current = this.managed(input);
      if (current.attributes["harness/integration"] === "native") return;

      const binding = nativeStartup(this.ctx, input);
      this.ctx.graph.update(run.id, {
        attributes: {
          "harness/identity": binding.identity,
          "harness/session-id": nativeSessionId,
          "harness/session-confirmed": true,
          "harness/integration": "output",
        },
      });

      recordParticipation(this.ctx, binding.identity, run.id, input.invocation ?? "external");
    }, this.authority);
  }
}
