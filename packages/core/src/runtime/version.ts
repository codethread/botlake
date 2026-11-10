import { z } from "zod";

import { Fault } from "../core/json.ts";

export const semanticVersionSchema = z.compile(
  z
    .string()
    .regex(
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u,
      "Expected a semantic version",
    ),
);

const packageMetadataSchema = z.compile(z.object({ version: semanticVersionSchema }));

export const coreVersion = packageMetadataSchema.parse(
  await Bun.file(new URL("../../package.json", import.meta.url)).json(),
).version;

export function requireCoreVersion(minimum: string | undefined): void {
  if (minimum === undefined || Bun.semver.order(coreVersion, minimum) >= 0) return;

  throw new Fault(
    "core-version",
    `Lake requires @botlake/core ${minimum} or newer, but the running supervisor loaded ${coreVersion}. Upgrade the supervisor's @botlake/core package, then restart it with \`botlake stop\` followed by \`botlake start\`.`,
    { required: minimum, running: coreVersion },
  );
}
