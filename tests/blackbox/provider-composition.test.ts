import { expect, test } from "bun:test";
import { join } from "node:path";

import { agentAttributes } from "@botlake/extension-agents";
import { z } from "zod";

import { system } from "./fixtures/system.ts";

const identifier = z.compile(z.object({ id: z.string() }));
const runSchema = z.compile(
  z.object({ id: z.string(), attributes: z.record(z.string(), z.json()) }),
);
const catalogSchema = z.compile(z.object({ providers: z.array(z.string()) }));

test("custom harness instances retain native identity, output binding, activity and resume across restart without Flags", async () => {
  const host = await system();
  try {
    const workspace = await host.workspace("custom-harness", [
      "@botlake/extension-batteries",
      "@botlake/extension-identity",
      "./providers.ts",
    ]);
    const child = join(workspace, "harness.ts");
    await Bun.write(
      child,
      `import { spawnSync } from "node:child_process";
const input = JSON.parse(await Bun.stdin.text());
if (Bun.argv[2] !== "--base-option") throw new Error("Missing base argv");
const session = input.sessionId ?? "custom-" + crypto.randomUUID();
if (input.prompt !== "output-only") {
  const [runId, invocation] = process.env.BL_RUN_REFERENCE.split(":");
  const observed = spawnSync(process.env.BL_BIN, ["--workspace", process.env.BL_WORKSPACE, "--input", JSON.stringify({
    command: "native", provider: "acme-harness", nativeSessionId: session, cwd: process.cwd(),
    runId, invocation, event: "session-start", capabilities: ["messages"],
    activity: [{kind: "message", role: "assistant", summary: "custom activity", truncated: false}],
  }), "agent"], {encoding: "utf8"});
  if (observed.status !== 0) throw new Error(observed.stderr);
}
console.log(JSON.stringify({session, answer: input.prompt, actor: process.env.BL_ACTOR ?? null}));
`,
    );
    await Bun.write(
      join(workspace, "providers.ts"),
      `import { agents, type Provider, type ProviderRun } from "@botlake/extension-agents";
import { z } from "zod";
const output = z.object({ session: z.string(), answer: z.string(), actor: z.string().nullable() });
class CustomHarness implements Provider {
  name = " acme-harness ";
  doc = "Custom harness with its own wire protocol.";
  #command = ["bun", ${JSON.stringify(child)}, "--base-option"];
  #preparations = 0;

  prepare(run: ProviderRun) {
    this.#preparations++;
    return {
      command: [...this.#command],
      stdin: JSON.stringify({prompt: run.prompt, sessionId: run.resumes ? run.sessionId : null}),
      env: {},
    };
  }

  finish(_run: ProviderRun, exitCode: number, stdout: string, stderr: string) {
    const value = output.parse(JSON.parse(stdout));
    return {
      success: exitCode === 0,
      result: JSON.stringify({...value, preparations: this.#preparations}),
      sessionId: value.session,
      error: exitCode === 0 ? null : stderr,
    };
  }
}
function myCustomHarness(): Provider {
  return new CustomHarness();
}
export default agents({providers: [myCustomHarness()], aliases: {worker: {provider: "acme-harness"}}});
`,
    );
    await host.botlake(["lake", "start", "--workspace", workspace]);
    expect(
      catalogSchema.parse(await host.bl(workspace, "agent", { command: "catalog" })).providers,
    ).toEqual(["acme-harness"]);
    expect(await host.bl(workspace, "help", {})).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "flag" })]),
    );

    async function settled(id: string) {
      expect(
        await host.bl(workspace, "await", {
          query: "agent-run-settled",
          params: { runId: id },
          minCount: 1,
          timeoutSecs: 10,
        }),
      ).toMatchObject({ reason: "satisfied" });
      const run = runSchema.parse(await host.bl(workspace, "agent", { command: "show", id }));
      expect(run.attributes[agentAttributes.substatus]).toBe("completed");
      expect(run.attributes[agentAttributes.provider]).toBe("acme-harness");
      expect(run.attributes[agentAttributes.sessionConfirmed]).toBe(true);
      return run;
    }
    const started = identifier.parse(
      await host.bl(workspace, "agent", {
        command: "start",
        seat: "worker",
        cwd: workspace,
        prompt: "native",
      }),
    );
    const first = await settled(started.id);
    expect(first.attributes[agentAttributes.integration]).toBe("native");
    const activity = z
      .object({
        stream: z.object({ provider: z.string(), sessionId: z.string() }),
        recent: z.array(z.object({ summary: z.string().nullable() })),
      })
      .parse(
        await host.bl(workspace, "agent", { command: "activity", operation: "peek", id: first.id }),
      );
    expect(activity.stream).toMatchObject({
      provider: "acme-harness",
      sessionId: first.attributes[agentAttributes.sessionId],
    });
    expect(activity.recent.some((event) => event.summary === "custom activity")).toBe(true);

    await host.botlake(["lake", "restart", "--workspace", workspace]);
    const resumed = identifier.parse(
      await host.bl(workspace, "agent", { command: "resume", id: first.id, prompt: "continued" }),
    );
    const continuation = await settled(resumed.id);
    expect(continuation.attributes[agentAttributes.identity]).toBe(
      first.attributes[agentAttributes.identity],
    );
    expect(continuation.attributes[agentAttributes.sessionId]).toBe(
      first.attributes[agentAttributes.sessionId],
    );
    const answer = z
      .object({ actor: z.string(), preparations: z.literal(1) })
      .parse(JSON.parse(z.string().parse(continuation.attributes[agentAttributes.result])));
    expect(answer.actor).toBe(z.string().parse(first.attributes[agentAttributes.identity]));

    const outputOnly = identifier.parse(
      await host.bl(workspace, "agent", {
        command: "start",
        seat: "worker",
        cwd: workspace,
        prompt: "output-only",
      }),
    );
    const outputRun = await settled(outputOnly.id);
    expect(outputRun.attributes[agentAttributes.integration]).toBe("output");
    expect(outputRun.attributes[agentAttributes.identity]).not.toBe(
      first.attributes[agentAttributes.identity],
    );

    const external = z.object({ runId: z.string(), external: z.boolean() }).parse(
      await host.bl(workspace, "agent", {
        command: "native",
        provider: "another-harness",
        nativeSessionId: first.attributes[agentAttributes.sessionId],
        cwd: workspace,
      }),
    );
    expect(external.external).toBe(true);
    const externalRun = runSchema.parse(
      await host.bl(workspace, "agent", { command: "show", id: external.runId }),
    );
    expect(externalRun.attributes[agentAttributes.provider]).toBe("another-harness");
    expect(externalRun.attributes[agentAttributes.identity]).not.toBe(
      first.attributes[agentAttributes.identity],
    );
  } finally {
    await host.close();
  }
}, 60000);

test("provider flags and alias conditions require explicit Flags composition while ungated providers do not", async () => {
  const host = await system();
  try {
    const workspace = await host.workspace("composition", [
      "@botlake/extension-identity",
      "./agents.ts",
    ]);
    const module = join(workspace, "agents.ts");
    await Bun.write(
      module,
      'import agents from "@botlake/extension-agents"; export default agents;',
    );
    await host.botlake(["lake", "start", "--workspace", workspace]);
    expect(
      catalogSchema.parse(await host.bl(workspace, "agent", { command: "catalog" })).providers,
    ).toEqual(["codex", "pi", "claude"]);
    await host.botlake(["lake", "stop", "--workspace", workspace]);

    await Bun.write(
      join(workspace, "flags.ts"),
      `import { flags, configureFlags } from "@botlake/extension-flags";
export const harnessFlags = flags({custom: {name: "harness/custom", description: "Allow this harness", default: true}});
export default configureFlags([]);
`,
    );
    await Bun.write(
      module,
      `import {agents, builtinProviders} from "@botlake/extension-agents";
import {harnessFlags} from "./flags.ts";
export default agents({providers: [builtinProviders.claude({flag: harnessFlags.custom}), builtinProviders.pi()]});`,
    );
    expect(await host.botlake(["lake", "start", "--workspace", workspace], false)).toContain(
      "agents requires explicitly selected flags",
    );

    await Bun.write(
      module,
      `import {agents} from "@botlake/extension-agents";
export default agents({aliases: {conditional: [{parent: "pi", when: ["not", ["or", "offline", "maintenance"]]}]}});`,
    );
    expect(await host.botlake(["lake", "start", "--workspace", workspace], false)).toContain(
      "agents requires explicitly selected flags",
    );

    await Bun.write(
      module,
      `import {agents, builtinProviders} from "@botlake/extension-agents";
import {harnessFlags} from "./flags.ts";
export default agents({providers: [{...builtinProviders.claude({flag: harnessFlags.custom}), name: "gated-harness"}, builtinProviders.pi()], aliases: {worker: [{parent: "gated-harness", when: ["not", "offline"]}, "pi"]}});`,
    );
    await Bun.write(
      join(workspace, ".botlake/lake.ts"),
      `import {createLake} from "@botlake/core";
import identity from "@botlake/extension-identity";
import flags from "../flags.ts";
import agents from "../agents.ts";
export const lake = createLake({name: "composition", extensions: [agents, identity, flags]});`,
    );
    await host.botlake(["lake", "start", "--workspace", workspace]);
    expect(
      catalogSchema.parse(await host.bl(workspace, "agent", { command: "catalog" })).providers,
    ).toEqual(["pi"]);
    expect(
      await host.bl(workspace, "agent", { command: "catalog", name: "gated-harness" }),
    ).toMatchObject({
      available: false,
      reasons: [{ name: "gated-harness", reason: "disabled", flag: "harness/custom" }],
    });
    expect(await host.bl(workspace, "agent", { command: "catalog", name: "worker" })).toMatchObject(
      { settings: { provider: "pi" } },
    );
    await host.bl(workspace, "flag", {
      command: "set",
      name: "harness/custom",
      value: true,
      description: "Allow this harness",
    });
    expect(
      catalogSchema.parse(await host.bl(workspace, "agent", { command: "catalog" })).providers,
    ).toEqual(["gated-harness", "pi"]);
    expect(await host.bl(workspace, "agent", { command: "catalog", name: "worker" })).toMatchObject(
      { settings: { provider: "gated-harness" } },
    );
    await host.bl(workspace, "flag", { command: "unset", name: "harness/custom" });
    expect(
      catalogSchema.parse(await host.bl(workspace, "agent", { command: "catalog" })).providers,
    ).toEqual(["pi"]);

    await host.botlake(["lake", "stop", "--workspace", workspace]);
    await Bun.write(
      module,
      `import {agents, builtinProviders} from "@botlake/extension-agents";
export default agents({providers: [builtinProviders.pi(), builtinProviders.pi()]});`,
    );
    expect(await host.botlake(["lake", "start", "--workspace", workspace], false)).toContain(
      "Duplicate provider: pi",
    );
    await Bun.write(
      module,
      `import {agents, builtinProviders} from "@botlake/extension-agents";
export default agents({providers: [{...builtinProviders.pi(), name: " "}]});`,
    );
    expect(await host.botlake(["lake", "start", "--workspace", workspace], false)).toContain(
      "Too small",
    );
    await Bun.write(
      module,
      `import {agents, builtinProviders} from "@botlake/extension-agents";
export default agents({providers: [builtinProviders.claude({command: []})]});`,
    );
    expect(await host.botlake(["lake", "start", "--workspace", workspace], false)).toContain(
      "expected string, received undefined",
    );
    await Bun.write(
      module,
      `import {agents, builtinProviders} from "@botlake/extension-agents";
export default agents({providers: [builtinProviders.pi({bin: "piw", command: ["pi"]})]});`,
    );
    expect(await host.botlake(["lake", "start", "--workspace", workspace], false)).toContain(
      "bin and command are mutually exclusive",
    );
    await Bun.write(
      module,
      `import {agents, builtinProviders} from "@botlake/extension-agents";
export default agents({providers: [builtinProviders.pi({bin: ""})]});`,
    );
    expect(await host.botlake(["lake", "start", "--workspace", workspace], false)).toContain(
      "Too small",
    );
  } finally {
    await host.close();
  }
}, 60000);
