import { Fault, q, type Context, type Extension, type Node } from "@botlake/core";
import { identityAttributes, resolveIdentity } from "@botlake/extension-identity";
import { mailAttributes as a, mailPredicate, mailRelations as r } from "@botlake/extension-mail";

const authority = Symbol("mail-identity");

/** Explicit identity composition; mail remains usable with opaque unregistered names. */
export function mailIdentity(): Extension {
  return {
    name: "mail-identity",
    source: import.meta.url,
    requires: ["mail", "identity"],
    activate(ctx) {
      ctx.graph.protect((changes, token) => {
        if (token === authority) return;
        for (const change of changes)
          if (
            change.kind === "edge" &&
            [change.before?.relation, change.after?.relation].some(
              (relation) => relation === r.sentBy || relation === r.sentTo,
            )
          )
            throw new Fault("mail-identity", "Mail attribution edges require Mail Identity");
      });
      for (const [name, relation] of [
        ["mail-received-by-node", r.sentTo],
        ["mail-sent-by-node", r.sentBy],
      ] as const)
        ctx.registerQuery(name, {
          description: "Mail linked to a registered identity node",
          params: ["identityNode"],
          where: q.and(mailPredicate, q.edgeOut(relation, q.eq("id", q.param("identityNode")))),
        });
      ctx.subscribe((event) => {
        for (const change of event.changes) {
          if (change.kind !== "node" || change.after === null || change.before !== null) continue;
          const node = change.after;
          if (node.attributes[a.message] === true) link(ctx, node);
          const name = node.attributes[identityAttributes.id];
          if (typeof name === "string") {
            for (const mail of ctx.graph.all({
              where: q.and(
                mailPredicate,
                q.or(q.eq(q.attr(a.from), name), q.eq(q.attr(a.to), name)),
              ),
            }))
              link(ctx, mail);
          }
        }
      });
      ctx.resource({
        start() {
          for (const node of ctx.graph.all({ where: mailPredicate })) link(ctx, node);
        },
        stop() {},
      });
    },
  };
}

function link(ctx: Context, node: Node): void {
  ctx.graph.atomic(() => {
    for (const [key, relation] of [
      [a.from, r.sentBy],
      [a.to, r.sentTo],
    ] as const) {
      const name = node.attributes[key];
      if (typeof name !== "string") continue;
      const identity = resolveIdentity(ctx.graph, name);
      for (const edge of ctx.graph.edges(node.id, relation))
        if (edge.from_id === node.id && edge.to_id !== identity?.id)
          ctx.graph.disconnect(node.id, edge.to_id, relation);
      if (identity !== undefined && ctx.graph.edge(node.id, identity.id, relation) === null)
        ctx.graph.connect(node.id, identity.id, relation);
    }
  }, authority);
}

export default mailIdentity();
