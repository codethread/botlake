import { Fault } from "@millstrand/core";
import { match } from "ts-pattern";
import { z } from "zod";

const text = z.string().trim().min(1);
const providerName = z.enum(["codex", "pi", "claude", "cursor"]);
const settings = {
  model: text.optional(),
  effort: text.optional(),
  fast: z.boolean().optional(),
  extraArgs: z.array(z.string()).optional(),
  systemPrompts: z.array(text).optional(),
};
export const seatSchema = z.strictObject({
  provider: providerName,
  ...settings,
  extraArgs: z.array(z.string()).default([]),
  systemPrompts: z.array(text).default([]),
});
export type Seat = z.input<typeof seatSchema>;
type ResolvedSeat = z.output<typeof seatSchema>;

export type Condition = string | ["and" | "or", Condition, ...Condition[]] | ["not", Condition];
const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    text,
    z.tuple([z.literal("and"), conditionSchema]).rest(conditionSchema),
    z.tuple([z.literal("or"), conditionSchema]).rest(conditionSchema),
    z.tuple([z.literal("not"), conditionSchema]),
  ]),
);
const descriptor = {
  doc: text.optional(),
  when: conditionSchema.optional(),
  ...settings,
};
const aliasDescriptorSchema = z.strictObject({ parent: text, ...descriptor });
const candidateSchema = z.union([
  text,
  aliasDescriptorSchema,
  z.strictObject({ provider: providerName, ...descriptor }),
]);
const aliasSchema = z.union([candidateSchema, z.array(candidateSchema).min(1)]);
export type Alias = z.input<typeof aliasSchema>;
type Candidate = z.output<typeof candidateSchema>;

const reviewerSchema = z.strictObject({
  seats: z.array(text).min(1),
  prompt: text,
  labels: z.array(text).optional(),
  paths: z.array(text).optional(),
});
export type Reviewer = z.input<typeof reviewerSchema>;
export const harnessConfigSchema = z.strictObject({
  aliases: z.record(text, aliasSchema).default({}),
  reviewers: z.record(text, reviewerSchema).default({}),
});
export type HarnessConfig = z.input<typeof harnessConfigSchema>;
export function harnessConfigJsonSchema(): unknown {
  return z.toJSONSchema(harnessConfigSchema, { io: "input" });
}

type Reason = {
  name: string;
  reason: "not-registered" | "cycle" | "disabled" | "condition" | "candidate";
  flag?: string;
  when?: Condition;
  candidate?: number;
  parent?: string;
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
const providerDocs = {
  codex: "Codex CLI. Uses the provider's default model unless an alias selects one.",
  pi: "Pi CLI. Model names may include a provider prefix, such as openai-codex/.",
  claude: "Claude Code CLI. Uses the provider's default model unless an alias selects one.",
  cursor: "Cursor Agent CLI. Combines model, effort and fast into a model selector.",
};

export class Catalog {
  private readonly aliases = new Map<string, Candidate[]>();
  constructor(
    private readonly providers: Array<z.infer<typeof providerName>>,
    aliases: z.output<typeof harnessConfigSchema>["aliases"],
    private readonly flag: (name: string) => boolean | undefined,
  ) {
    for (const [name, value] of Object.entries(aliases)) {
      if (providers.some((provider) => provider === name))
        throw new Fault("collision", `Duplicate alias: ${name}`);
      this.aliases.set(name, Array.isArray(value) ? value : [value]);
    }
  }
  private condition(value: Condition): boolean {
    if (typeof value === "string") return this.flag(value) === true;
    const [operator, first, ...rest] = value;
    return match(operator)
      .with("and", () => [first, ...rest].every((part) => this.condition(part)))
      .with("or", () => [first, ...rest].some((part) => this.condition(part)))
      .with("not", () => !this.condition(first))
      .exhaustive();
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
        const candidate: z.output<typeof aliasDescriptorSchema> =
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
            ...(candidate.fast === undefined ? {} : { fast: candidate.fast }),
            extraArgs: candidate.extraArgs ?? resolved.settings.extraArgs,
            systemPrompts: [...resolved.settings.systemPrompts, ...(candidate.systemPrompts ?? [])],
          },
        };
      }
      return { available: false, doc: description, reasons };
    }
    const provider = this.providers.find((entry) => entry === name);
    if (provider === undefined)
      return { available: false, doc: null, reasons: [{ name, reason: "not-registered" }] };
    const flag = `harness/${provider}`;
    if (this.flag(flag) === false)
      return {
        available: false,
        doc: providerDocs[provider],
        reasons: [{ name, reason: "disabled", flag }],
      };
    return {
      available: true,
      doc: providerDocs[provider],
      settings: { provider, extraArgs: [], systemPrompts: [] },
    };
  }
  resolve(name: string): ResolvedSeat {
    const resolved = this.availability(name);
    if (!resolved.available) throw new Fault("seat", `Seat unavailable: ${name}`, resolved.reasons);
    return resolved.settings;
  }
  private summary(resolved: Resolution): unknown {
    if (!resolved.available) return resolved;
    const {
      settings: { extraArgs: _, systemPrompts: __, ...effective },
      ...selection
    } = resolved;
    return { ...selection, ...effective };
  }
  list(): Record<string, unknown> {
    return Object.fromEntries(
      [...this.providers, ...this.aliases.keys()].map((name) => [
        name,
        this.summary(this.availability(name)),
      ]),
    );
  }
  show(name: string): unknown {
    const resolved = this.availability(name);
    return {
      name,
      ...resolved,
      candidates: this.aliases.get(name) ?? [],
    };
  }
}
