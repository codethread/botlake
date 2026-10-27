import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import type { Provider, ProviderName } from "./contract.ts";
import { pi } from "./pi.ts";

const strategies: Record<ProviderName, Provider> = { codex, pi, claude };

export function provider(name: ProviderName): Provider {
  return { ...strategies[name] };
}
