import { z } from "zod";

export async function rejected(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return z.instanceof(Error).parse(error);
  }
  throw new Error("Expected a rejected operation");
}
