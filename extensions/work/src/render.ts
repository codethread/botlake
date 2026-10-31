import { requireValue } from "@botlake/core";

import type { WorkTopology, WorkTopologyNode } from "./types.ts";

interface Branch {
  id: string;
  prefix: string;
  branch: "root" | "last" | "more";
}

/** Render containment or a dependency projection without changing its topology. */
export function renderWorkTopology(view: WorkTopology, columns: number | null): string {
  const heading =
    view.view === "tree"
      ? "Containment"
      : view.direction === "dependents"
        ? "Dependents"
        : "Prerequisites";
  const lines = [heading, ""];
  const nodes = new Map(view.nodes.map((node) => [node.id, node]));
  const context = new Set(view.context);
  const children = new Map<string, string[]>();
  for (const edge of view.edges) {
    const [parent, child] =
      view.direction === "dependents" ? [edge.to, edge.from] : [edge.from, edge.to];
    const siblings = children.get(parent) ?? [];
    siblings.push(child);
    children.set(parent, siblings);
  }
  // Node order is the read model's deterministic priority/title/identity ordering.
  const order = new Map(view.nodes.map((node, index) => [node.id, index]));
  for (const siblings of children.values())
    siblings.sort(
      (a, b) =>
        requireValue(order.get(a), `Missing topology node: ${a}`) -
        requireValue(order.get(b), `Missing topology node: ${b}`),
    );
  const idWidth = view.nodes.reduce((width, node) => Math.max(width, displayWidth(node.id)), 0);
  const idColumn = Math.max(24, (columns ?? 80) - idWidth - 2);
  const expanded = new Set<string>();

  const groups = rootGroups(view);
  const roots = groups.flatMap((ids, groupIndex) =>
    ids.map((id) => ({ id, component: groups.length > 1 ? groupIndex + 1 : null })),
  );
  let component: number | null = null;
  for (const root of roots) {
    if (lines.length > 2 && lines.at(-1) !== "") lines.push("");
    if (root.component !== null && root.component !== component) {
      lines.push(`Component ${root.component}`, "");
      component = root.component;
    }
    const stack: Branch[] = [{ id: root.id, prefix: "", branch: "root" }];
    while (stack.length > 0) {
      const entry = requireValue(stack.pop(), "Missing outline branch");
      const node = requireValue(nodes.get(entry.id), `Missing topology node: ${entry.id}`);
      const branch = entry.branch === "root" ? "" : entry.branch === "last" ? "└── " : "├── ";
      const stem =
        entry.prefix + (entry.branch === "root" ? "" : entry.branch === "last" ? "    " : "│   ");
      const isContext = context.has(node.id);
      const lean = !("kind" in node);
      const label = `${entry.prefix}${branch}${inline(node.title)}${lean ? ` [${node.state}${isContext ? ", context" : ""}]` : ""}`;
      lines.push(
        `${label}${" ".repeat(Math.max(2, idColumn - displayWidth(label)))}${inline(node.id)}`,
      );
      const descendants = children.get(node.id) ?? [];
      const detailStem = entry.branch === "root" && descendants.length > 0 ? "│" : stem;
      const details = `${detailStem}  `;
      if (expanded.has(node.id)) {
        lines.push(`${details}↳ shown above`);
        continue;
      }
      expanded.add(node.id);
      if (!lean) renderDetails(lines, node, details, detailStem, isContext, columns);
      if (!lean) {
        if (descendants.length > 0) lines.push(`${stem}│`);
        else if (stack.length > 0) lines.push(stem.trimEnd());
      }
      for (let index = descendants.length - 1; index >= 0; index--)
        stack.push({
          id: requireValue(descendants[index], "Missing outline descendant"),
          prefix: stem,
          branch: index === descendants.length - 1 ? "last" : "more",
        });
    }
  }
  if (view.nodes.length === 0) lines.push("No matching work.");
  if (view.omittedLinks > 0)
    lines.push(
      "",
      `${view.omittedLinks} link${view.omittedLinks === 1 ? "" : "s"} omitted by the state filter.`,
    );
  return lines.join("\n");
}

function rootGroups(view: WorkTopology): string[][] {
  if (view.view === "tree" || view.root !== null) return [view.roots];
  const membership = new Map(
    view.components.flatMap((ids, index) => ids.map((id) => [id, index] as const)),
  );
  const groups = view.components.map((): string[] => []);
  for (const root of view.roots) {
    const index = requireValue(membership.get(root), `Missing component for root: ${root}`);
    requireValue(groups[index], `Missing component: ${index}`).push(root);
  }
  return groups;
}

function renderDetails(
  lines: string[],
  node: WorkTopologyNode,
  details: string,
  stem: string,
  context: boolean,
  columns: number | null,
): void {
  if (!("kind" in node)) return;
  const metadata = [
    ...(node.priority === null ? [] : [node.priority]),
    ...(node.kind === "group" ? ["group"] : []),
    node.state,
    ...(node.state === "open" ? [node.ready ? "ready" : "waiting"] : []),
    ...(context ? ["context"] : []),
  ];
  lines.push(details + metadata.join(" · "));
  if ("description" in node && node.description !== undefined && node.description.length > 0) {
    lines.push(stem.trimEnd());
    appendProse(lines, node.description, details, columns);
  }
  if (
    "acceptanceCriteria" in node &&
    node.acceptanceCriteria !== undefined &&
    node.acceptanceCriteria.length > 0
  ) {
    lines.push(stem.trimEnd(), details + "Criteria");
    for (const criterion of node.acceptanceCriteria) {
      appendProse(lines, `[${criterion.state}] ${criterion.condition}`, `${details}  `, columns);
      if (criterion.resolution !== null)
        appendProse(lines, criterion.resolution.text, `${details}    `, columns);
    }
  }
}

function appendProse(lines: string[], value: string, prefix: string, columns: number | null): void {
  const width = Math.max(16, (columns ?? 80) - displayWidth(prefix));
  for (const paragraph of safeText(value).split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/u).filter((part) => part.length > 0)) {
      if (line.length > 0 && displayWidth(`${line} ${word}`) > width) {
        lines.push(prefix + line);
        line = "";
      }
      line += `${line.length > 0 ? " " : ""}${word}`;
    }
    lines.push(prefix + line);
  }
}

function inline(value: string): string {
  return safeText(value).replaceAll("\n", " ");
}

function safeText(value: string): string {
  // Stored prose must not inject terminal control sequences into the outline.
  return Bun.stripANSI(value)
    .replaceAll("\r\n", "\n")
    .replaceAll(/\p{Cc}/gu, (control) => (control === "\n" ? control : " "));
}

function displayWidth(value: string): number {
  return Bun.stringWidth(value);
}
