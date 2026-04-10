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
 * ⚠️  Zod v3 internals: accesses `schema._def.options` which is not part
 * of the public API. Zod v4 restructured `_def` — this will need updating
 * on upgrade. A canary test in response-schema-validation.test.js ("can
 * access union variant options from Zod schema internals") will fail if
 * the internal structure changes. Degrades gracefully: returns null if
 * `_def.options` is absent, and callers fall back to the standard error.
 */
export function getBestUnionErrors(schema: ZodTypeAny, data: unknown): SchemaViolation[] | null {
  const options = (schema as any)._def?.options as ZodTypeAny[] | undefined;
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
