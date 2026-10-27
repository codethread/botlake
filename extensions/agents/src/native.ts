import { Fault, q, type Context, type Node } from "@botlake/core";
import { nativeStartup, observeIdentity, recordParticipation } from "@botlake/extension-identity";
import {
  providerSchema,
  type NativeBinding,
  type NativeRegistration,
  type ProviderName,
} from "@botlake/native-session";
import { z } from "zod";

import { resolveSystemPrompt, type SystemPrompt } from "./prompt.ts";

const text = z.string().min(1);

export class NativeSessions {
  constructor(
    private readonly ctx: Context,
    private readonly authority: symbol,
    private readonly unmanagedSystemPrompt: SystemPrompt | undefined,
  ) {}

  private runs(provider: ProviderName, sessionId: string): Node[] {
    return this.ctx.graph.all({
      where: q.and(
        q.eq(q.attr("agent/run"), true),
        q.eq(q.attr("agent/provider"), provider),
        q.eq(q.attr("agent/session-id"), sessionId),
      ),
      lean: false,
    });
  }

  private managed(input: NativeRegistration): Node {
    const run = this.ctx.graph.show(text.parse(input.runId));
    if (
      run.attributes["agent/run"] !== true ||
      run.attributes["agent/external"] === true ||
      run.attributes["agent/state"] !== "running" ||
      run.attributes["agent/invocation"] !== input.invocation ||
      run.attributes["agent/provider"] !== input.provider
    )
      throw new Fault("native", "Stale or mismatched native run registration");
    const expected = run.attributes["agent/session-id"];
    if (expected !== undefined && expected !== input.nativeSessionId)
      throw new Fault("native", "Native session differs from the linked run");
    if (
      run.attributes["agent/integration"] === "unobserved" &&
      run.attributes["agent/cwd"] !== input.cwd
    )
      throw new Fault("native", "Native startup cwd differs from its run");

    if (
      this.runs(input.provider, input.nativeSessionId).some(
        (other) =>
          other.id !== run.id &&
          other.attributes["agent/external"] !== true &&
          other.attributes["agent/settled"] !== true,
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
        const previous = referenced.attributes["agent/session-id"];

        // Native clear/fork can switch sessions while retaining the launching environment.
        // Only an already registered external session may bypass that inherited reference.
        const detached =
          typeof previous === "string" && previous !== input.nativeSessionId
            ? this.runs(input.provider, input.nativeSessionId).find(
                (entry) => entry.attributes["agent/external"] === true,
              )
            : undefined;
        run = detached ?? this.managed(input);
      } else {
        const matches = this.runs(input.provider, input.nativeSessionId);

        if (
          matches.some(
            (entry) =>
              entry.attributes["agent/external"] !== true &&
              entry.attributes["agent/settled"] !== true,
          )
        )
          throw new Fault(
            "native",
            "Managed session observations require the current run reference",
          );
        run =
          matches.find((entry) => entry.attributes["agent/external"] === true) ??
          this.ctx.graph.add({
            title: `Native ${input.provider}`,
            attributes: {
              "agent/run": true,
              "agent/external": true,
              "agent/provider": input.provider,
              "agent/session-id": input.nativeSessionId,
              "agent/cwd": input.cwd,
              "agent/state": "external",
            },
          });
      }

      const binding = observeIdentity(this.ctx, input);
      const session = this.ctx.graph.show(binding.nodeId);

      this.ctx.graph.update(run.id, {
        attributes: {
          "agent/identity": binding.identity,
          "agent/session-id": input.nativeSessionId,
          "agent/session-confirmed": true,
          "agent/integration": "native",
          "agent/observation": {
            event: input.event,
            at: this.ctx.clock.now(),
            activity: session.attributes["identity/activity"] ?? "unknown",
            agentSeat: session.attributes["identity/agent-seat"] ?? null,
            model: session.attributes["identity/model"] ?? null,
            thinkingLevel: session.attributes["identity/thinking-level"] ?? null,
            cwd: input.cwd,
            capabilities: session.attributes["identity/capabilities"] ?? [],
          },
        },
      });
      const external = run.attributes["agent/external"] === true;

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
        systemPrompt:
          external && (input.event === "session-start" || input.event === "metadata")
            ? resolveSystemPrompt(this.unmanagedSystemPrompt, {
                provider: input.provider,
                model: input.model ?? null,
                effort: input.thinkingLevel ?? null,
                seat: input.agentSeat ?? null,
                cwd: input.cwd,
                workspace: this.ctx.workspace,
              })
            : "",
      };
    }, this.authority);
  }

  // Output is useful session evidence when plugins are unavailable, never fabricated activity.
  fromOutput(run: Node, nativeSessionId: string): void {
    this.ctx.graph.atomic(() => {
      const input: NativeRegistration = {
        provider: providerSchema.parse(run.attributes["agent/provider"]),
        nativeSessionId,
        cwd: text.parse(run.attributes["agent/cwd"]),
        event: "metadata",
        runId: run.id,
        invocation: text.parse(run.attributes["agent/invocation"]),
      };
      const current = this.managed(input);
      if (current.attributes["agent/integration"] === "native") return;

      const binding = nativeStartup(this.ctx, input);
      this.ctx.graph.update(run.id, {
        attributes: {
          "agent/identity": binding.identity,
          "agent/session-id": nativeSessionId,
          "agent/session-confirmed": true,
          "agent/integration": "output",
        },
      });

      recordParticipation(this.ctx, binding.identity, run.id, input.invocation ?? "external");
    }, this.authority);
  }
}
