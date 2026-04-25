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

// AJV formats the message for `required` keyword violations as:
//   must have required property '<name>'
// Capture group 1 is the field name.
const REQUIRED_MSG_RE = /required property ['"]([^'"]+)['"]/;

/**
 * Scan the strict AJV verdicts in `validations` and emit one hint per
 * required-field violation. Returns an empty array when no AJV schemas
 * are available or no required-field issues are present.
 *
 * @param taskName - tool name (snake_case) the storyboard dispatched under
 * @param validations - result array from `runValidations` for this step
 */
export function detectMissingRequiredHints(
  taskName: string,
  validations: ValidationResult[]
): MissingRequiredFieldHint[] {
  const hints: MissingRequiredFieldHint[] = [];

  for (const result of validations) {
    const strict = result.strict;
    if (!strict || strict.valid || !strict.issues) continue;

    for (const issue of strict.issues) {
      if (issue.keyword !== 'required') continue;

      const match = issue.message.match(REQUIRED_MSG_RE);
      const fieldName = match?.[1];
      if (!fieldName) continue;

      // Build RFC 6901 path: parent instance_path + "/" + field name.
      // instance_path is "" for root-level required violations (AJV points
      // at the parent object, not the missing child), so "" + "/" + name
      // collapses to "/name" which is the correct RFC 6901 form.
      const parentPath = issue.instance_path ?? '';
      const fieldPath = `${parentPath}/${fieldName}`;

      hints.push({
        kind: 'missing_required_field',
        tool: taskName,
        field_path: fieldPath,
        schema_ref: issue.schema_path || undefined,
        message:
          `${taskName} strict validation: missing required property '${fieldName}'` +
          (parentPath ? ` at ${parentPath}` : ''),
      });
    }
  }

  return hints;
}
