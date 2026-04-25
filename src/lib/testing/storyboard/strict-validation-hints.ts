/**
 * Structured hints derived from the strict (AJV) verdict attached to a
 * `response_schema` ValidationResult. Issue #935 moves the strict signal
 * from a prose-only `ValidationResult.warning` into per-issue structured
 * hints so renderers (CLI, Addie, JUnit) can build per-case fix plans.
 *
 * Two hint kinds are emitted:
 *   - `MissingRequiredFieldHint` — one per parent path with one or more
 *     missing required fields. AJV reports each missing field as its own
 *     issue with `keyword: "required"`; we group them under the parent
 *     instance_path so a seller filling out N required fields sees them
 *     in one round.
 *   - `FormatMismatchHint` — one per non-`required` strict issue
 *     (`format`, `pattern`, `enum`, `minLength`, ...). Each carries the
 *     pointer + keyword the renderer needs to write a verify recipe.
 *
 * The `ValidationResult.warning` prose stays populated for one minor for
 * back-compat with existing CLI / dashboard scrapers — see CHANGELOG.
 */

import type {
  FormatMismatchHint,
  MissingRequiredFieldHint,
  SchemaValidationError,
  StoryboardStepHint,
  ValidationResult,
} from './types';

/**
 * Per-validation cap on `format_mismatch` hints to keep `step.hints[]`
 * bounded on pathological responses (e.g. a list payload where every
 * `agent_url` field is malformed). When the cap trips, a sentinel
 * `format_mismatch` hint is appended so the surface self-documents the
 * truncation — operators see the elision rather than silently losing
 * context. The total `failed` count remains visible via
 * `StoryboardResult.strict_validation_summary`.
 */
const MAX_FORMAT_HINTS = 5;

/**
 * Emit structured hints for every strict-AJV finding on a step's
 * validations. Walks each `response_schema` validation that carried a
 * `strict` verdict, partitions issues into required-keyword vs other,
 * and returns the structured hints ready to drop into `step.hints[]`.
 */
export function detectStrictValidationHints(
  taskName: string,
  validations: readonly ValidationResult[]
): StoryboardStepHint[] {
  const hints: StoryboardStepHint[] = [];
  for (const v of validations) {
    if (v.check !== 'response_schema') continue;
    const strict = v.strict;
    if (!strict || strict.valid !== false) continue;
    const issues = strict.issues;
    if (!issues || issues.length === 0) continue;
    const required = issues.filter(i => i.keyword === 'required');
    const others = issues.filter(i => i.keyword !== 'required');

    for (const grouped of groupRequiredIssues(taskName, required, v.schema_url ?? undefined)) {
      hints.push(grouped);
    }
    const shown = others.slice(0, MAX_FORMAT_HINTS);
    const elided = others.length - shown.length;
    for (const issue of shown) {
      hints.push(formatHintFromIssue(taskName, issue, v.schema_url ?? undefined));
    }
    if (elided > 0) {
      // Sentinel hint surfaces the cap so consumers don't silently lose
      // signal. `keyword: 'truncated'` is a runner-internal pseudo-keyword
      // (no AJV equivalent); renderers branching on it can flag the
      // strict_validation_summary as the authoritative count.
      hints.push({
        kind: 'format_mismatch',
        tool: taskName,
        instance_path: '',
        schema_path: '',
        keyword: 'truncated',
        ...(v.schema_url ? { schema_url: v.schema_url } : {}),
        message: `${taskName} produced ${elided} additional strict issue${elided === 1 ? '' : 's'} not shown — see strict_validation_summary on the run result for the full count.`,
      });
    }
  }
  return hints;
}

function groupRequiredIssues(
  taskName: string,
  issues: SchemaValidationError[],
  schemaUrl: string | undefined
): MissingRequiredFieldHint[] {
  const grouped = new Map<string, { schema_path: string; fields: string[] }>();
  for (const issue of issues) {
    const at = issue.instance_path || '';
    const match = issue.message.match(/required property ['"]([^'"]+)['"]/);
    const field = match?.[1] ?? issue.message;
    const entry = grouped.get(at);
    if (entry) {
      entry.fields.push(field);
    } else {
      grouped.set(at, { schema_path: issue.schema_path, fields: [field] });
    }
  }
  const out: MissingRequiredFieldHint[] = [];
  for (const [at, { schema_path, fields }] of grouped) {
    out.push({
      kind: 'missing_required_field',
      tool: taskName,
      instance_path: at,
      schema_path,
      missing_fields: fields,
      ...(schemaUrl !== undefined ? { schema_url: schemaUrl } : {}),
      message: `${taskName} response missing required field${fields.length > 1 ? 's' : ''} at ${at || '/'}: ${fields.join(', ')}.`,
    });
  }
  return out;
}

function formatHintFromIssue(
  taskName: string,
  issue: SchemaValidationError,
  schemaUrl: string | undefined
): FormatMismatchHint {
  const at = issue.instance_path || '/';
  return {
    kind: 'format_mismatch',
    tool: taskName,
    instance_path: issue.instance_path,
    schema_path: issue.schema_path,
    keyword: issue.keyword,
    ...(schemaUrl !== undefined ? { schema_url: schemaUrl } : {}),
    message: `${taskName} response failed strict ${issue.keyword} at ${at}: ${issue.message}`,
  };
}
