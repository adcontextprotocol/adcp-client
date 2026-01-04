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
 * empty arrays.
 *
 * Note: maxItems constraints are preserved (only minItems is removed).
 */
export function removeMinItemsConstraints(schema: any): any {
  if (!schema || typeof schema !== 'object') {
    return schema;
  }

  if (Array.isArray(schema)) {
    return schema.map(item => removeMinItemsConstraints(item));
  }

  const result: any = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'minItems') {
      // Skip minItems to allow empty arrays
      continue;
    }
    result[key] = removeMinItemsConstraints(value);
  }
  return result;
}
