import type { PaseoAgent } from "@getpaseo/client";
import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { Text } from "react-native";

import { lookup } from "./shared/lookup.ts";

export default function contribute(client: PluginClientContext) {
  const lifetime = new AbortController();
  const pills = new Map<string, { key: string; pill: PluginButtonRegistration }>();
  function remove(id: string) {
    pills.get(id)?.pill.remove();
    pills.delete(id);
  }
  function clear() {
    for (const id of pills.keys()) remove(id);
  }
  function show(agent: PaseoAgent) {
    const { id, workspaceId, persistence } = agent;
    if (workspaceId === undefined || typeof agent.archivedAt === "string") {
      remove(id);
      return;
    }
    const key = JSON.stringify([
      workspaceId,
      agent.cwd,
      persistence?.provider,
      persistence?.sessionId,
    ]);
    if (pills.get(id)?.key === key) return;
    remove(id);
    const pill = client.addComposerPill({
      id: "identity",
      agentId: id,
      workspaceId,
      button: {
        title: "Refresh Botlake identity",
        label: "Botlake: checking",
        icon: "Fingerprint",
        behavior: { kind: "action", onPress: refresh },
      },
    });
    pills.set(id, { key, pill });
    let pending = false;
    async function refresh() {
      if (pending) return;
      pending = true;
      try {
        const result = await client.rpc(lookup, { agentId: id });
        if (result.status === "registered") {
          const { identity } = result;
          pill.update({
            title: "Botlake identity",
            label: identity,
            behavior: {
              kind: "popover",
              Content: ({ theme }) => (
                <Text selectable style={{ color: theme.colors.foreground, fontSize: 18 }}>
                  {identity}
                </Text>
              ),
            },
          });
        } else {
          pill.update({
            label:
              result.status === "no-session" ? "Botlake: no session" : "Botlake: not registered",
          });
        }
      } catch (error) {
        pill.update({ label: "Botlake: unavailable" });
        console.error("Botlake identity lookup failed", id, error);
      } finally {
        pending = false;
      }
    }
    void refresh();
  }
  async function observe() {
    const { subscription } = await client.paseo.agents.list({
      subscribe: {},
      signal: lifetime.signal,
    });
    subscription.subscribe({
      snapshot: ({ entries }) => {
        clear();
        for (const { agent } of entries) show(agent);
      },
      update: (message) => {
        if (message.type !== "agent_update") return;
        const update = message.payload;
        if (update.kind === "upsert") show(update.agent);
        else remove(update.agentId);
      },
    });
  }
  void observe().catch((error: unknown) => {
    if (!lifetime.signal.aborted) console.error("Paseo agent observation failed", error);
  });
  return () => {
    lifetime.abort();
    clear();
  };
}
