import { z } from "zod";

import { Fault, type Json } from "../core/json.ts";

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
  selector?: string;
  value?: string;
  flags?: Record<string, Omit<Argument, "name">>;
  positionals?: Argument[];
  commands?: Record<string, Command>;
}
function parseValue(text: string, type: Argument["type"]): Json {
  switch (type) {
    case "string":
      return text;
    case "number":
      return z.number().parse(Number(text));
    case "boolean":
      if (text !== "true" && text !== "false")
        throw new Fault("argv", `Expected boolean, received ${text}`);
      return text === "true";
    case "json":
      return z.json().parse(JSON.parse(text));
  }
}
export async function parseArgs(command: Command, argv: string[]): Promise<Record<string, Json>> {
  const result: Record<string, Json> = {};
  const args = [...argv];
  if (command.commands !== undefined) {
    const name = args.shift();
    const child = name === undefined ? undefined : command.commands[name];
    if (child === undefined)
      throw new Fault("argv", `Expected subcommand: ${Object.keys(command.commands).join(", ")}`);
    return {
      [command.selector ?? "command"]: child.value ?? name ?? "",
      ...(await parseArgs(child, args)),
    };
  }
  let position = 0;
  let literal = false;
  async function value(text: string, type: Argument["type"]): Promise<Json> {
    if (text.startsWith("@")) return parseValue(await Bun.file(text.slice(1)).text(), type);
    return parseValue(text, type);
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
      if (spec.multiple === true) {
        const previous = result[spec.name];
        result[spec.name] = [...(Array.isArray(previous) ? previous : []), parsed];
      } else {
        result[spec.name] = parsed;
        position++;
      }
    }
  }
  for (const [name, spec] of Object.entries(command.flags ?? {}))
    if (spec.required === true && result[spec.key ?? name] === undefined)
      throw new Fault("argv", `Required flag: --${name}`);
  for (const spec of command.positionals ?? [])
    if (spec.required === true && result[spec.name] === undefined)
      throw new Fault("argv", `Required positional: ${spec.name}`);
  return result;
}
