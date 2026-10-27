---
name: typescript
description: Use when authoring or reviewing TypeScript code.
---

# TypeScript

## Data modelling

- Use clear discriminated unions for domain models, with a focused doc string on every field of no more than 3–5 lines.
- Avoid optionals when a union models the domain better: an explicit variant beats `field?:` when the missing case has its own meaning.
- All IO lives at the application boundary, managed by dependency injection and services. Keep domain code pure.
- Prefer pure functions operating on data. Use classes only to extend `Error` (or an existing error class) or a third-party library class required by an integration.

```ts
// Prefer
type Lookup = { kind: "found"; user: User } | { kind: "missing"; id: string };
// Over
type Lookup = { user?: User };
```

- Prefer interfaces for object shapes. Use type aliases when their features are needed, such as unions, mapped types or conditional types.

## Functions

- Use function declarations for named module-level functions, not assignments to arrow functions.
- Inside a function body, named local helpers may be arrows to keep their lexical context nearby.
- A module-level arrow assignment is permitted when an existing callable type from a library or a complex generic supplies both parameter and return types.

A module-level declaration with a local arrow:

```ts
export function formatRange(min: number, max: number, unit: string): string {
  const formatValue = (value: number) => `${value} ${unit}`;
  return `${formatValue(min)}–${formatValue(max)}`;
}
```

A module-level arrow using an existing library callable type:

```ts
import type { WebSocketHandler } from "bun";

export const echo: WebSocketHandler<unknown>["message"] = (socket, message) => {
  socket.send(message);
};
```

## Module layout and locality

- Use named exports only.
- Follow Clean Code's journalistic style: public functions first, progressively lower-level details below. Use declaration hoisting to support this reading order.
- Order modules as imports, constants, interfaces/type aliases, public functions, a comment divider, then private functions.
- Prefer substantial, well-named functions and cohesive modules over many small helpers and files. Keep related steps inline when reading them together makes the operation clearer.
- Extract a helper when its name and interface hide meaningful detail, not merely to shorten its caller. Small duplication is acceptable; consider abstraction at the third occurrence (the rule of three).
- Keep code that must be understood together together. Split a file when the new module hides implementation behind a useful interface, not to meet a line-count target.
