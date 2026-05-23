import type { ZodIssue, ZodTypeAny } from 'zod';

export interface SchemaViolation {
  path: string;
  message: string;
  code: ZodIssue['code'];
}

/**
 * When a Zod union schema fails, the top-level error is the unhelpful
 * "(root): Invalid input". This function tries each variant individually
 * and returns the closest match's specific field errors.
 *
 * AdCP 3.1.0-beta.3 reshaped several response unions from bare
 * `z.union([...])` to `z.object({...envelope...}).passthrough().and(z.union([...]))`
 * — the envelope status / context fields became required outer-shape
 * members intersected with the variant union. We therefore unwrap one
 * level of `ZodIntersection` when present, looking for the union on
 * either side, before disambiguating variants.
 *
 * ⚠️  Zod v3 internals: accesses `schema._def.options` / `_def.left` /
 * `_def.right` which are not part of the public API. Zod v4 restructured
 * `_def` — this will need updating on upgrade. A canary test in
 * response-schema-validation.test.js will fail if the internal structure
 * changes. Degrades gracefully: returns null when no union options can
 * be located, and callers fall back to the standard error.
 */
export function getBestUnionErrors(schema: ZodTypeAny, data: unknown): SchemaViolation[] | null {
  const options = resolveUnionOptions(schema);
  if (!options || options.length === 0) return null;

  let best: SchemaViolation[] | null = null;
  let fewest = Infinity;

  for (const variant of options) {
    const result = variant.safeParse(data);
    if (result.success) return [];
    const violations = result.error.issues.map(i => ({
      path: i.path.length > 0 ? i.path.join('.') : '(root)',
      message: i.message,
      code: i.code,
    }));
    if (violations.length < fewest) {
      fewest = violations.length;
      best = violations;
    }
  }

  return best;
}

/**
 * Locate the union arm of a Zod schema. Handles three shapes:
 *   - bare `z.union([...])`           → `_def.options`
 *   - `z.object({...}).and(z.union)`  → `_def.right._def.options` (post-3.1.0-beta.3 reshape)
 *   - `z.union.and(z.object({...}))`  → `_def.left._def.options` (defensive — current schemas put the union on the right)
 */
function resolveUnionOptions(schema: ZodTypeAny): ZodTypeAny[] | null {
  const def = (schema as any)._def;
  if (!def) return null;
  if (Array.isArray(def.options)) return def.options as ZodTypeAny[];

  const right = def.right ? (def.right as any)._def?.options : undefined;
  if (Array.isArray(right)) return right as ZodTypeAny[];

  const left = def.left ? (def.left as any)._def?.options : undefined;
  if (Array.isArray(left)) return left as ZodTypeAny[];

  return null;
}
