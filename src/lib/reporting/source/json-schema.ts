import { z } from 'zod';

/** Render the stable transport-independent JSON Schema published by the SDK. */
export function toPublishedJsonSchema<T extends z.ZodType>(schema: T) {
  return z.toJSONSchema(schema);
}
