import { Fault } from "@botlake/core";
import { match } from "ts-pattern";
import { z } from "zod";

import { agentFlags } from "./flags.ts";
import { resolveSystemPrompt, systemPromptSchema, type SystemPrompt } from "./prompt.ts";
import { providerNameSchema, type Provider } from "./providers/contract.ts";

const text = z.string().trim().min(1);

const settings = {
  model: text.optional(),
  effort: text.optional(),
  extraArgs: z.array(z.string()).optional(),
};

export const seatSchema = z.strictObject({
  provider: providerNameSchema,
  ...settings,
  extraArgs: z.array(z.string()).default([]),
  systemPrompt: z.string().default(""),
});

const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    text,
    z.tuple([z.literal("and"), conditionSchema]).rest(conditionSchema),
    z.tuple([z.literal("or"), conditionSchema]).rest(conditionSchema),
    z.tuple([z.literal("not"), conditionSchema]),
  ]),
);

const schemas = configSchemas(systemPromptSchema);

export const agentConfigSchema = schemas.config;

export type Seat = Omit<z.input<typeof seatSchema>, "systemPrompt"> & {
  systemPrompt?: SystemPrompt;
};

type ResolvedSeat = Omit<z.output<typeof seatSchema>, "systemPrompt"> & {
  systemPrompt: SystemPrompt;
};

export type Condition = string | ["and" | "or", Condition, ...Condition[]] | ["not", Condition];

export type Alias = z.input<typeof schemas.alias>;

type Candidate = z.output<typeof schemas.candidate>;

export type AgentConfig = z.input<typeof agentConfigSchema>;

// A closed JSON payload needs the implicit index signature supplied by a type alias.
type Reason = {
  /** Seat whose resolution failed. */
  name: string;
  /** Category explaining why this seat or candidate is unavailable. */
  reason: "not-registered" | "cycle" | "disabled" | "condition" | "candidate";
  /** Provider flag responsible for a disabled seat. */
  flag?: string;
  /** Candidate condition that evaluated to false. */
  when?: Condition;
  /** Zero-based candidate index when resolving an alias. */
  candidate?: number;
  /** Parent seat selected by the unavailable candidate. */
  parent?: string;
  /** Nested failures explaining an unavailable parent. */
  causes?: Reason[];
};

type Resolution =
  | {
      available: true;
      doc: string | null;
      settings: ResolvedSeat;
      selectedParent?: string;
      selectedCandidate?: number;
    }
  | { available: false; doc: string | null; reasons: Reason[] };

export function agentConfigJsonSchema(): unknown {
  // JSON configuration supports text; callbacks belong to TypeScript configuration.
  return z.toJSONSchema(configSchemas(z.string()).config, { io: "input" });
}

export class Catalog {
  private readonly aliases = new Map<string, Candidate[]>();

  constructor(
    private readonly providers: Provider[],
    aliases: z.output<typeof agentConfigSchema>["aliases"],
    private readonly flag: (name: string) => boolean | undefined,
  ) {
    for (const [name, value] of Object.entries(aliases)) {
      if (providers.some((provider) => provider.name === name))
        throw new Fault("collision", `Duplicate alias: ${name}`);
      this.aliases.set(name, Array.isArray(value) ? value : [value]);
    }
  }

  availability(name: string, seen: Set<string> = new Set()): Resolution {
    const candidates = this.aliases.get(name);
    const doc = candidates?.find(
      (candidate) => typeof candidate !== "string" && candidate.doc !== undefined,
    );
    const description = typeof doc === "object" ? (doc.doc ?? null) : null;

    if (seen.has(name))
      return { available: false, doc: description, reasons: [{ name, reason: "cycle" }] };

    if (candidates !== undefined) {
      const reasons: Reason[] = [];
      for (const [index, raw] of candidates.entries()) {
        const candidate: z.output<typeof schemas.aliasDescriptor> =
          typeof raw === "string"
            ? { parent: raw }
            : "provider" in raw
              ? { ...raw, parent: raw.provider }
              : raw;
        const parent = candidate.parent;

        if (candidate.when !== undefined && !this.condition(candidate.when)) {
          reasons.push({
            name,
            candidate: index,
            parent,
            reason: "condition",
            when: candidate.when,
          });
          continue;
        }

        const resolved = this.availability(parent, new Set([...seen, name]));
        if (!resolved.available) {
          reasons.push({
            name,
            candidate: index,
            parent,
            reason: "candidate",
            causes: resolved.reasons,
          });
          continue;
        }

        return {
          available: true,
          doc: candidate.doc ?? resolved.doc,
          selectedCandidate: index,
          selectedParent: parent,
          settings: {
            ...resolved.settings,
            ...(candidate.model === undefined ? {} : { model: candidate.model }),
            ...(candidate.effort === undefined ? {} : { effort: candidate.effort }),
            extraArgs: candidate.extraArgs ?? resolved.settings.extraArgs,
            systemPrompt: candidate.systemPrompt ?? "",
          },
        };
      }
      return { available: false, doc: description, reasons };
    }

    const provider = this.providers.find((entry) => entry.name === name);
    if (provider === undefined)
      return { available: false, doc: null, reasons: [{ name, reason: "not-registered" }] };
    const definition = agentFlags[provider.name];
    const flag = definition.name;
    if (!(this.flag(flag) ?? definition.default))
      return {
        available: false,
        doc: provider.doc,
        reasons: [{ name, reason: "disabled", flag }],
      };

    return {
      available: true,
      doc: provider.doc,
      settings: { provider: provider.name, extraArgs: [], systemPrompt: "" },
    };
  }

  resolve(name: string, context: { cwd: string; workspace: string }): z.output<typeof seatSchema> {
    const resolved = this.availability(name);
    if (!resolved.available) throw new Fault("seat", `Seat unavailable: ${name}`, resolved.reasons);

    const selected = resolved.settings;
    return {
      ...selected,
      systemPrompt: resolveSystemPrompt(selected.systemPrompt, {
        ...context,
        provider: selected.provider,
        audience: "agent",
        model: selected.model ?? null,
        effort: selected.effort ?? null,
        seat: name,
      }),
    };
  }

  list(all = false): Record<string, unknown> {
    const entries = [...this.providers.map((entry) => entry.name), ...this.aliases.keys()].map(
      (name) => [name, this.availability(name)] as const,
    );
    return Object.fromEntries(
      entries
        .filter(([, resolved]) => all || resolved.available)
        .map(([name, resolved]) => [name, this.summary(resolved)]),
    );
  }

  show(name: string): unknown {
    const resolved = this.availability(name);

    const describe = (source: SystemPrompt | undefined) =>
      typeof source === "function" ? { dynamic: true } : source;

    return {
      name,
      ...resolved,
      ...(resolved.available
        ? {
            settings: {
              ...resolved.settings,
              systemPrompt: describe(resolved.settings.systemPrompt),
            },
          }
        : {}),
      candidates: (this.aliases.get(name) ?? []).map((candidate) =>
        typeof candidate === "string" || candidate.systemPrompt === undefined
          ? candidate
          : { ...candidate, systemPrompt: describe(candidate.systemPrompt) },
      ),
    };
  }

  // -- Private helpers --

  private condition(value: Condition): boolean {
    if (typeof value === "string") return this.flag(value) === true;

    const [operator, first, ...rest] = value;

    return match(operator)
      .with("and", () => [first, ...rest].every((part) => this.condition(part)))
      .with("or", () => [first, ...rest].some((part) => this.condition(part)))
      .with("not", () => !this.condition(first))
      .exhaustive();
  }

  private summary(resolved: Resolution): unknown {
    if (!resolved.available) return resolved;

    const {
      settings: { extraArgs: _, systemPrompt: __, ...effective },
      ...selection
    } = resolved;

    return { ...selection, ...effective };
  }
}

// -- Private helpers --

function configSchemas<P extends z.ZodType>(prompt: P) {
  const descriptor = {
    doc: text.optional(),
    when: conditionSchema.optional(),
    ...settings,
    systemPrompt: prompt.optional(),
  };
  const aliasDescriptor = z.strictObject({ parent: text, ...descriptor });
  const candidate = z.union([
    text,
    aliasDescriptor,
    z.strictObject({ provider: providerNameSchema, ...descriptor }),
  ]);
  const alias = z.union([candidate, z.array(candidate).min(1)]);
  return {
    aliasDescriptor,
    candidate,
    alias,
    config: z.strictObject({
      aliases: z.record(text, alias).default({}),
      unmanaged: z.strictObject({ systemPrompt: prompt.optional() }).optional(),
    }),
  };
}
