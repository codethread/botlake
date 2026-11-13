import { z } from "zod";

export const lakeWireVersion = 1;

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
