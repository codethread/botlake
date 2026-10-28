import { z } from "zod";

import { jsonSchema, Fault, type Json } from "../core/json.ts";

const numberSchema = z.compile(z.number());

const argumentShape = {
  key: z.string().min(1).exactOptional(),
  type: z.enum(["string", "number", "boolean", "json"]),
  required: z.boolean().exactOptional(),
  multiple: z.boolean().exactOptional(),
  description: z.string().exactOptional(),
};

const commandDefinition: z.ZodType<Command> = z.lazy(() =>
  z.strictObject({
    description: z.string(),
    examples: z.array(z.string().min(1)).exactOptional(),
    selector: z.string().min(1).exactOptional(),
    value: z.string().min(1).exactOptional(),
    flags: z.record(z.string().min(1), z.strictObject(argumentShape)).exactOptional(),
    positionals: z
      .array(z.strictObject({ name: z.string().min(1), ...argumentShape }))
      .exactOptional(),
    commands: z.record(z.string().min(1), commandDefinition).exactOptional(),
  }),
);
// Initialize the recursive definition before eager compilation resolves its lazy getter.
const commandSchema = z.compile(commandDefinition);

export interface Argument {
  name: string;
  key?: string;
  type: "string" | "number" | "boolean" | "json";
  required?: boolean;
  multiple?: boolean;
  description?: string;
}

export interface Command {
  description: string;
  examples?: string[];
  selector?: string;
  value?: string;
  flags?: Record<string, Omit<Argument, "name">>;
  positionals?: Argument[];
  commands?: Record<string, Command>;
}

export function validateCommand(input: Command): Command {
  const command = commandSchema.parse(input);
  function visit(node: Command, selectors: string[]): void {
    if (node.commands !== undefined) {
      if (Object.keys(node.commands).length === 0)
        throw new Fault("cli", "A command group must have subcommands");
      if (node.flags !== undefined || node.positionals !== undefined)
        throw new Fault("cli", "Flags and positionals belong on leaf commands");
      const selector = node.selector ?? "command";
      if (selectors.includes(selector))
        throw new Fault("cli", `Repeated command selector: ${selector}`);
      for (const child of Object.values(node.commands)) visit(child, [...selectors, selector]);
    } else {
      if (node.selector !== undefined) throw new Fault("cli", "A selector requires subcommands");
      const positionals = node.positionals ?? [];
      for (const [index, positional] of positionals.entries()) {
        if (positional.multiple === true && index !== positionals.length - 1)
          throw new Fault("cli", "Only the last positional can accept multiple values");
      }
      const keys = [
        ...positionals.map((positional) => positional.key ?? positional.name),
        ...Object.entries(node.flags ?? {}).map(([name, flag]) => flag.key ?? name),
      ];
      for (const key of keys)
        if (selectors.includes(key))
          throw new Fault("cli", `Argument conflicts with command selector: ${key}`);
    }
  }

  visit(command, []);
  return command;
}

export async function parseArgs(
  rootCommand: Command,
  rawArgs: string[],
  payloads: Record<string, string> = {},
): Promise<Record<string, Json>> {
  const used = new Set<string>();

  function reference(text: string): string | undefined {
    if (text === ":stdin") return "stdin";
    if (text.startsWith(":payload/")) return text.slice(9);
    return undefined;
  }
  function resolvePayload(text: string): string {
    const slot = reference(text);
    if (slot === undefined) return text;
    const payload = Object.hasOwn(payloads, slot) ? payloads[slot] : undefined;
    if (payload === undefined) throw new Fault("payload", `Missing payload: ${slot}`);
    used.add(slot);
    return payload;
  }

  function expand(value: Json): Json {
    if (typeof value === "string") return resolvePayload(value);
    if (Array.isArray(value)) return value.map((entry) => expand(entry));
    if (value !== null && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, expand(entry)]));
    return value;
  }
  async function node(command: Command, argv: string[]): Promise<Record<string, Json>> {
    const result: Record<string, Json> = {};
    const args = [...argv];
    if (command.commands !== undefined) {
      const name = args.shift();
      const child = name === undefined ? undefined : command.commands[name];
      if (child === undefined)
        throw new Fault("argv", `Expected subcommand: ${Object.keys(command.commands).join(", ")}`);

      return {
        [command.selector ?? "command"]: child.value ?? name ?? "",
        ...(await node(child, args)),
      };
    }
    let position = 0;
    let literal = false;
    async function value(text: string, type: Argument["type"]): Promise<Json> {
      if (text.startsWith("@")) text = await Bun.file(text.slice(1)).text();
      if (reference(text) !== undefined) return parseValue(resolvePayload(text), type);
      return expand(parseValue(text, type));
    }

    while (args.length > 0) {
      const arg = args.shift();
      if (arg === undefined) break;
      if (arg === "--" && !literal) {
        literal = true;
        continue;
      }

      if (!literal && arg.startsWith("--")) {
        const split = arg.indexOf("=");
        const name = arg.slice(2, split < 0 ? undefined : split);
        const spec = command.flags?.[name];
        if (spec === undefined) throw new Fault("argv", `Unknown flag: --${name}`);
        const raw =
          split < 0 ? (spec.type === "boolean" ? "true" : args.shift()) : arg.slice(split + 1);
        if (raw === undefined) throw new Fault("argv", `Missing value for --${name}`);
        const parsed = await value(raw, spec.type);
        const key = spec.key ?? name;
        if (spec.multiple === true) {
          const previous = result[key];
          result[key] = [...(Array.isArray(previous) ? previous : []), parsed];
        } else {
          if (result[key] !== undefined) throw new Fault("argv", `Repeated flag: --${name}`);
          result[key] = parsed;
        }
      } else {
        const spec = command.positionals?.[position];
        if (spec === undefined) throw new Fault("argv", `Unexpected positional: ${arg}`);
        const parsed = await value(arg, spec.type);
        const key = spec.key ?? spec.name;
        if (spec.multiple === true) {
          const previous = result[key];
          result[key] = [...(Array.isArray(previous) ? previous : []), parsed];
        } else {
          if (result[key] !== undefined) throw new Fault("argv", `Repeated argument: ${key}`);
          result[key] = parsed;
          position++;
        }
      }
    }

    for (const [name, spec] of Object.entries(command.flags ?? {}))
      if (spec.required === true && result[spec.key ?? name] === undefined)
        throw new Fault("argv", `Required flag: --${name}`);
    for (const spec of command.positionals ?? [])
      if (spec.required === true && result[spec.key ?? spec.name] === undefined)
        throw new Fault("argv", `Required positional: ${spec.name}`);

    return result;
  }

  const result = await node(rootCommand, rawArgs);
  for (const slot of Object.keys(payloads))
    if (!used.has(slot)) throw new Fault("payload", `Unused payload: ${slot}`);

  return result;
}

// -- Private helpers --

function parseValue(text: string, type: Argument["type"]): Json {
  switch (type) {
    case "string":
      return text;
    case "number":
      if (text.trim().length === 0) throw new Fault("argv", "Expected a number");
      return numberSchema.parse(Number(text));
    case "boolean":
      if (text !== "true" && text !== "false")
        throw new Fault("argv", `Expected boolean, received ${text}`);
      return text === "true";
    case "json":
      return jsonSchema.parse(JSON.parse(text));
  }
}
