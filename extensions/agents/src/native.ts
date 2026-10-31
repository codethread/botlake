import { Fault, q, type Context, type Node } from "@botlake/core";
import {
  identityAttributes,
  nativeStartup,
  observeIdentity,
  recordParticipation,
} from "@botlake/extension-identity";
import {
  providerSchema,
  type Audience,
  type NativeBinding,
  type NativeRegistration,
  type ProviderName,
} from "@botlake/native-session";
import { z } from "zod";

import type { RunActivity } from "./activity.ts";
import { runLifecycle } from "./lifecycle.ts";
import { agentAttributes } from "./node-model.ts";
import { resolveSystemPrompt, type SystemPrompt } from "./prompt.ts";

const text = z.compile(z.string().min(1));

export class NativeSessions {
  constructor(
    private readonly ctx: Context,
    private readonly authority: symbol,
    private readonly activity: RunActivity,
    private readonly unmanagedSystemPrompt: SystemPrompt | undefined,
  ) {}

  observe(input: NativeRegistration & { audience: Audience }): NativeBinding {
    return this.ctx.graph.atomic(() => {
      let run: Node;
      if (input.runId !== undefined) {
        const referenced = this.ctx.graph.show(input.runId);
        const previous = referenced.attributes[agentAttributes.sessionId];

        // Native clear/fork can switch sessions while retaining the launching environment.
        // Only an already registered external session may bypass that inherited reference.
        const detached =
          typeof previous === "string" && previous !== input.nativeSessionId
            ? this.runs(input.provider, input.nativeSessionId).find(
                (entry) => entry.attributes[agentAttributes.external] === true,
              )
            : undefined;
        run = detached ?? this.managed(input);
      } else {
        const matches = this.runs(input.provider, input.nativeSessionId);

        if (
          matches.some(
            (entry) =>
              entry.attributes[agentAttributes.external] !== true &&
              !runLifecycle(entry).hasTag("settled"),
          )
        )
          throw new Fault(
            "native",
            "Managed session observations require the current run reference",
          );
        run =
          matches.find((entry) => entry.attributes[agentAttributes.external] === true) ??
          this.ctx.graph.add({
            title: `Native ${input.provider}`,
            attributes: {
              [agentAttributes.run]: true,
              [agentAttributes.external]: true,
              [agentAttributes.provider]: input.provider,
              [agentAttributes.sessionId]: input.nativeSessionId,
              [agentAttributes.cwd]: input.cwd,
              [agentAttributes.state]: "external",
            },
          });
      }

      const binding = observeIdentity(this.ctx, input);
      const session = this.ctx.graph.show(binding.nodeId);

      this.ctx.graph.update(run.id, {
        attributes: {
          [agentAttributes.identity]: binding.identity,
          [agentAttributes.audience]: input.audience,
          [agentAttributes.sessionId]: input.nativeSessionId,
          [agentAttributes.sessionConfirmed]: true,
          [agentAttributes.integration]: "native",
          [agentAttributes.observation]: {
            event: input.event,
            audience: input.audience,
            at: this.ctx.clock.now(),
            activity: session.attributes[identityAttributes.activity] ?? "unknown",
            agentSeat: session.attributes[identityAttributes.agentSeat] ?? null,
            model: session.attributes[identityAttributes.model] ?? null,
            thinkingLevel: session.attributes[identityAttributes.thinkingLevel] ?? null,
            cwd: input.cwd,
            capabilities: session.attributes[identityAttributes.capabilities] ?? [],
          },
        },
      });
      const external = run.attributes[agentAttributes.external] === true;

      recordParticipation(
        this.ctx,
        binding.identity,
        run.id,
        external ? "external" : text.parse(input.invocation),
      );
      this.activity.observe(this.ctx.graph.show(run.id), input, binding);
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
                audience: input.audience,
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
        provider: providerSchema.parse(run.attributes[agentAttributes.provider]),
        nativeSessionId,
        cwd: text.parse(run.attributes[agentAttributes.cwd]),
        event: "metadata",
        runId: run.id,
        invocation: text.parse(run.attributes[agentAttributes.invocation]),
      };
      const current = this.managed(input);
      if (current.attributes[agentAttributes.integration] === "native") return;

      const binding = nativeStartup(this.ctx, input);
      this.ctx.graph.update(run.id, {
        attributes: {
          [agentAttributes.identity]: binding.identity,
          [agentAttributes.sessionId]: nativeSessionId,
          [agentAttributes.sessionConfirmed]: true,
          [agentAttributes.integration]: "output",
        },
      });

      recordParticipation(this.ctx, binding.identity, run.id, input.invocation ?? "external");
      this.activity.observe(this.ctx.graph.show(run.id), input, binding);
    }, this.authority);
  }

  // -- Private helpers --

  private managed(input: NativeRegistration): Node {
    const run = this.ctx.graph.show(text.parse(input.runId));
    if (
      run.attributes[agentAttributes.run] !== true ||
      run.attributes[agentAttributes.external] === true ||
      !runLifecycle(run).hasTag("launched") ||
      run.attributes[agentAttributes.invocation] !== input.invocation ||
      run.attributes[agentAttributes.provider] !== input.provider
    )
      throw new Fault("native", "Stale or mismatched native run registration");
    const expected = run.attributes[agentAttributes.sessionId];
    if (expected !== undefined && expected !== input.nativeSessionId)
      throw new Fault("native", "Native session differs from the linked run");
    if (
      run.attributes[agentAttributes.integration] === "unobserved" &&
      run.attributes[agentAttributes.cwd] !== input.cwd
    )
      throw new Fault("native", "Native startup cwd differs from its run");

    if (
      this.runs(input.provider, input.nativeSessionId).some(
        (other) =>
          other.id !== run.id &&
          other.attributes[agentAttributes.external] !== true &&
          !runLifecycle(other).hasTag("settled"),
      )
    )
      throw new Fault("native", "Native session already has an active managed writer");
    return run;
  }

  private runs(provider: ProviderName, sessionId: string): Node[] {
    return this.ctx.graph.all({
      where: q.and(
        q.eq(q.attr(agentAttributes.run), true),
        q.eq(q.attr(agentAttributes.provider), provider),
        q.eq(q.attr(agentAttributes.sessionId), sessionId),
      ),
      lean: false,
    });
  }
}
