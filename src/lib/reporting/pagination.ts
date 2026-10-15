import type { ZodNumber, ZodOptional } from 'zod';
import { PaginationRequestSchema } from '../types/schemas.generated';

/**
 * The largest `pagination.max_results` AdCP allows (`core/pagination-request.json`), read from the generated
 * schema so a protocol change carries through. The reporting walkers ask for pages this large: a seller that
 * validates the schema answers 50 rows when `max_results` is omitted.
 */
export function reportingMaxPageSize(): number {
  const field = PaginationRequestSchema.shape.max_results as ZodOptional<ZodNumber>;
  const maximum = field.unwrap().maxValue;
  if (maximum === null || !Number.isSafeInteger(maximum) || maximum < 1) {
    throw new Error('The AdCP pagination-request schema does not define a maximum for max_results');
  }
  return maximum;
}
