import { nodeIdWords } from "./id-words.ts";
import { requireValue } from "./json.ts";

export function nodeId(randomInt: (max: number) => number): string {
  const number = randomInt(1000).toString().padStart(3, "0");
  const first = requireValue(nodeIdWords[randomInt(nodeIdWords.length)], "Unknown ID word");
  const second = requireValue(nodeIdWords[randomInt(nodeIdWords.length)], "Unknown ID word");
  return `${number}-${first}-${second}`;
}
