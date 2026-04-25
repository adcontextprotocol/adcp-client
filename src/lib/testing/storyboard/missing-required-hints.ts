/**
 * Missing-required-field hint detection.
 *
 * Parallel to `shape-drift-hints.ts` — pure function that reads the strict
 * AJV verdict already computed by `validateResponseSchema` (via
 * `ValidationResult.strict`) and emits one `MissingRequiredFieldHint` per
 * `required`-keyword violation.
 *
 * The runner (`runner.ts`) calls this after `runValidations` and merges the
 * result into `StoryboardStepResult.hints[]`. Fires unconditionally (same
 * gate as `ValidationResult.warning`) — hints are non-fatal and informational
 * even on passing steps (a strict-only violation does not flip `passed`).
 */
import type { MissingRequiredFieldHint, ValidationResult } from './types';

/**
 * Scan the strict AJV verdicts in `validations` and emit one hint per
 * required-field violation. Returns an empty array when no AJV schemas
 * are available or no required-field issues are present.
 *
 * `field_path` is taken directly from `SchemaValidationError.instance_path`,
 * which `ajvIssueToSchemaError` (via `formatIssue` in schema-validator.ts)
 * already encodes as `"${instancePath}/${missingProperty}"` — so the field
 * pointer is fully built before it reaches this detector.
 *
 * @param taskName - tool name (snake_case) the storyboard dispatched under
 * @param validations - result array from `runValidations` for this step
 */
export function detectMissingRequiredHints(
  taskName: string,
  validations: ValidationResult[]
): MissingRequiredFieldHint[] {
  const hints: MissingRequiredFieldHint[] = [];
  // De-duplicate across multiple ValidationResult entries (e.g. two
  // response_schema checks on the same step that share overlapping schemas).
  const seen = new Set<string>();

  for (const result of validations) {
    const strict = result.strict;
    if (!strict?.issues?.length) continue;

    for (const issue of strict.issues) {
      if (issue.keyword !== 'required') continue;

      // instance_path already contains the full pointer to the missing field
      // (formatIssue in schema-validator.ts: pointer = instancePath + "/" +
      // missingProperty). Use it directly — do not reconstruct from message.
      const fieldPath = issue.instance_path || '/';
      if (seen.has(fieldPath)) continue;
      seen.add(fieldPath);

      hints.push({
        kind: 'missing_required_field',
        tool: taskName,
        field_path: fieldPath,
        schema_ref: issue.schema_path || undefined,
        message: `${taskName} strict validation: ${issue.message}`,
      });
    }
  }

  return hints;
}
