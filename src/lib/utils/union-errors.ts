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
 * Uses Zod v3 internal `_def.options` to access union variants.
 * Returns null if the schema is not a union or has no variants.
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
