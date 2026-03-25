/**
 * Shared utilities for schema processing during code generation.
 */

/**
 * Recursively remove minItems constraints from arrays to allow empty arrays.
 *
 * DESIGN DECISION: The AdCP JSON Schema specifies minItems: 1 for fields like
 * publisher_domains, which is technically correct per spec. However, real-world
 * agents often return empty arrays (e.g., when not authorized for any publishers).
 * We prioritize interoperability over strict spec compliance here.
 *
 * This is necessary because:
 * - json-schema-to-typescript converts minItems: 1 to [T, ...T[]] tuple syntax
 * - ts-to-zod converts these to z.tuple([]).rest() which requires at least one element
 *
 * By removing minItems, we generate string[] and z.array() instead, which accept
 * empty arrays. maxItems is preserved so Zod can emit .max(N) for runtime validation.
 */
export function removeMinItemsConstraints(schema: any): any {
  return removeArrayConstraints(schema, ['minItems']);
}

/**
 * Recursively remove both minItems and maxItems constraints from arrays.
 *
 * Used by TypeScript type generation where maxItems combined with oneOf causes
 * json-schema-to-typescript to enumerate every possible tuple length+variant
 * permutation, producing thousands of index signatures. TypeScript has no native
 * bounded-length array concept, so maxItems adds no type safety.
 *
 * Zod generation should use removeMinItemsConstraints instead to preserve
 * .max(N) runtime validation.
 */
export function removeArrayLengthConstraints(schema: any): any {
  return removeArrayConstraints(schema, ['minItems', 'maxItems']);
}

function removeArrayConstraints(schema: any, keys: string[]): any {
  if (!schema || typeof schema !== 'object') {
    return schema;
  }

  if (Array.isArray(schema)) {
    return schema.map(item => removeArrayConstraints(item, keys));
  }

  const result: any = {};
  for (const [key, value] of Object.entries(schema)) {
    if (keys.includes(key)) {
      continue;
    }
    result[key] = removeArrayConstraints(value, keys);
  }
  return result;
}
