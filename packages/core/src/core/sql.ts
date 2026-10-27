// Syntax-highlighting tag only: interpolates text, never binds or escapes SQL values.
export function sql(parts: TemplateStringsArray, ...values: unknown[]): string {
  return parts.reduce(
    (text, part, index) => text + (index === 0 ? "" : String(values[index - 1])) + part,
    "",
  );
}
