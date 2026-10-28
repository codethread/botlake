import { z } from "zod";

const errorSchema = z.compile(z.instanceof(Error));

export async function rejected(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return errorSchema.parse(error);
  }
  throw new Error("Expected a rejected operation");
}
