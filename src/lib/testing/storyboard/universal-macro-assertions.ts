/**
 * Universal macro substitution assertion pseudo-task.
 *
 * Verifies that a seller substituted build-time identifier macros
 * (e.g. `{MEDIA_BUY_ID}`, `{PACKAGE_ID}`) with their real captured
 * values in a creative's rendered tracking URL.
 *
 * The task name `expect_universal_macro_substituted` is dispatched by
 * runner.ts before the normal MCP/A2A transport path. Like the webhook-
 * assertion tasks, it reads already-captured state rather than calling
 * the agent.
 *
 * Design: self-contained HTML inspection. The handler resolves rendered
 * HTML from `source_path` inside the prior step's parsed response body
 * and runs the `SubstitutionObserver` tracker-URL analysis against it.
 * If no non-empty HTML string is found at that path, the step grades as
 * a neutral skip (`no_preview_surface`, `passed: true`) — the seller
 * has not exposed a preview surface for this creative type, which is an
 * explicit spec-defined opt-out, not a conformance failure.
 *
 * Spec: adcontextprotocol/adcp media-buy-identifier-substitution-check.
 */

import { SubstitutionObserver } from '../../substitution/observer/SubstitutionObserver';
import type { CatalogBinding } from '../../substitution/types';
import type {
  RunnerExtractionRecord,
  RunnerRequestRecord,
  StoryboardContext,
  StoryboardStep,
  StoryboardStepResult,
  ValidationResult,
} from './types';

export const UNIVERSAL_MACRO_ASSERTION_TASKS: Set<string> = new Set([
  'expect_universal_macro_substituted',
]);

/**
 * Minimal run-state shape consumed by the handler — a strict subset of
 * the runner's `ExecutionState`. Only `priorStepResults` is needed
 * because the handler reads the prior step's parsed response body from it.
 */
interface MacroAssertionRunState {
  priorStepResults: Map<string, StoryboardStepResult>;
}

const POINTER_FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Resolve an RFC 6901 JSON Pointer against a parsed response object.
 * Returns `undefined` when any segment is absent or when the root is not
 * an object. An empty pointer (`''` or `'/'`) returns the root object.
 *
 * Only segments that appear in storyboard-authored `source_path` values
 * need to work: string-keyed object traversal and RFC 6901 escape
 * decoding (`~1` → `/`, `~0` → `~`). Array indexes are decoded as
 * decimal numbers for completeness, but the primary use-case is object
 * paths like `/creative_manifest/preview_html`.
 *
 * Guards against prototype pollution: rejects segments in `POINTER_FORBIDDEN_KEYS`
 * and only descends into own properties.
 */
function resolvePointer(root: unknown, pointer: string): unknown {
  if (typeof root !== 'object' || root === null) return undefined;
  if (pointer === '' || pointer === '/') return root;

  // Strip leading slash, then split and decode each segment.
  const segments = pointer.replace(/^\//, '').split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  let node: unknown = root;
  for (const seg of segments) {
    if (typeof node !== 'object' || node === null) return undefined;
    if (POINTER_FORBIDDEN_KEYS.has(seg)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(node, seg)) return undefined;
    node = (node as Record<string, unknown>)[seg];
  }
  return node;
}

/**
 * Resolves the prior step result that this assertion step should inspect.
 *
 * When `step.triggered_by` names an earlier step, looks it up directly in
 * `priorStepResults` — this matches the webhook-assertion convention and
 * is robust when step execution order differs from insertion order.
 * Falls back to the last inserted entry (Map preserves insertion order)
 * when no `triggered_by` is declared.
 * Returns `undefined` when the map is empty or the named step is not found.
 */
function getPriorResult(
  step: StoryboardStep,
  priorStepResults: Map<string, StoryboardStepResult>
): StoryboardStepResult | undefined {
  if (step.triggered_by) {
    return priorStepResults.get(step.triggered_by);
  }
  let last: StoryboardStepResult | undefined;
  for (const v of priorStepResults.values()) last = v;
  return last;
}

/**
 * Build a neutral skip result for `no_preview_surface`.
 */
function noPreviewSurfaceResult(
  step: StoryboardStep,
  phaseId: string,
  context: StoryboardContext,
  start: number,
  detail: string
): StoryboardStepResult {
  const request: RunnerRequestRecord = {
    transport: 'http',
    operation: step.task,
    payload: null,
  };
  const extraction: RunnerExtractionRecord = { path: 'none', note: 'universal-macro-assertion step' };
  return {
    step_id: step.id,
    phase_id: phaseId,
    title: step.title,
    task: step.task,
    passed: true,
    skipped: true,
    skip_reason: 'no_preview_surface',
    skip: { reason: 'not_applicable', detail },
    duration_ms: Date.now() - start,
    validations: [],
    context,
    error: detail,
    request,
    extraction,
  };
}

/**
 * Execute the `expect_universal_macro_substituted` pseudo-task.
 *
 * Steps:
 *  1. Locate the prior step's response and extract rendered HTML via
 *     `source_path` (RFC 6901 JSON Pointer). If missing → neutral skip.
 *  2. Validate all `macro_bindings` context keys are present. If any is
 *     missing → fail with a clear reason.
 *  3. Run `SubstitutionObserver.parse_html` + `match_bindings` to find
 *     aligned macro positions in the rendered tracker URLs.
 *  4. For each binding: assert `observed_value === expected`. Emit one
 *     `ValidationResult` per binding.
 *  5. Return overall `StoryboardStepResult` (pass when all bindings pass).
 */
export async function executeUniversalMacroAssertionStep(
  step: StoryboardStep,
  phaseId: string,
  context: StoryboardContext,
  state: MacroAssertionRunState
): Promise<StoryboardStepResult> {
  const start = Date.now();

  const request: RunnerRequestRecord = {
    transport: 'http',
    operation: step.task,
    payload: null,
  };
  const extraction: RunnerExtractionRecord = { path: 'none', note: 'universal-macro-assertion step' };

  // ── Locate prior step HTML ─────────────────────────────────

  const sourcePath = step.source_path ?? '';
  const priorResult = getPriorResult(step, state.priorStepResults);
  const priorResponse = priorResult?.response;
  const rawHtml = sourcePath ? resolvePointer(priorResponse, sourcePath) : priorResponse;

  if (typeof rawHtml !== 'string' || rawHtml.length === 0) {
    return noPreviewSurfaceResult(
      step,
      phaseId,
      context,
      start,
      `No non-empty HTML string found at source_path "${sourcePath}" in the prior step's response.`
    );
  }

  // ── Validate context keys and build bindings ───────────────

  const macroBindings = step.macro_bindings ?? [];
  const macroTemplate = step.macro_template ?? '';

  const validations: ValidationResult[] = [];

  if (macroBindings.length === 0) {
    validations.push({
      check: step.task,
      passed: false,
      description: 'Macro substitution configuration check',
      error:
        'Step "expect_universal_macro_substituted" has an empty or missing "macro_bindings" list. ' +
        'Declare at least one { macro, context_key } entry for the assertion to have effect.',
      json_pointer: null,
      expected: 'non-empty macro_bindings array',
      actual: null,
    });
    return {
      step_id: step.id,
      phase_id: phaseId,
      title: step.title,
      task: step.task,
      passed: false,
      duration_ms: Date.now() - start,
      validations,
      context,
      request,
      extraction,
    };
  }

  const catalogBindings: CatalogBinding[] = [];

  for (const { macro, context_key } of macroBindings) {
    const expectedValue = context[context_key];
    if (typeof expectedValue !== 'string' || expectedValue.length === 0) {
      validations.push({
        check: step.task,
        passed: false,
        description: `Macro ${macro} substitution check`,
        error:
          `Context key "${context_key}" for macro ${macro} is missing or not a non-empty string. ` +
          'Ensure the prior capture step ran successfully.',
        json_pointer: null,
        expected: `non-empty string at context["${context_key}"]`,
        actual: expectedValue ?? null,
      });
      continue;
    }
    // expected_encoded is required by resolveBinding for custom bindings.
    // For business identifier values (alphanumeric + hyphens) the raw value
    // and its query-string encoding are identical — no percent-encoding applies.
    catalogBindings.push({ macro, raw_value: expectedValue, expected_encoded: expectedValue });
  }

  // If any context key was missing, fail immediately without running observation.
  const hasContextErrors = validations.some(v => !v.passed);
  if (hasContextErrors) {
    return {
      step_id: step.id,
      phase_id: phaseId,
      title: step.title,
      task: step.task,
      passed: false,
      duration_ms: Date.now() - start,
      validations,
      context,
      request,
      extraction,
    };
  }

  // ── Run SubstitutionObserver ───────────────────────────────

  const observer = new SubstitutionObserver();
  const records = observer.parse_html(rawHtml);
  const matches = observer.match_bindings(records, macroTemplate, catalogBindings);

  // Build a lookup from macro token → match for O(1) access.
  const matchByMacro = new Map(matches.map(m => [m.binding.macro, m]));

  for (const { macro, context_key } of macroBindings) {
    const expected = context[context_key] as string;
    const match = matchByMacro.get(macro);

    if (!match) {
      validations.push({
        check: step.task,
        passed: false,
        description: `Macro ${macro} substitution check`,
        error:
          `Macro ${macro} was not found at any aligned position in the rendered tracker URLs. ` +
          `The seller may have omitted the macro from the submitted creative's tracker template, ` +
          `or the template URL "${macroTemplate}" does not appear in the rendered HTML.`,
        json_pointer: null,
        expected,
        actual: null,
      });
      continue;
    }

    const observed = match.observed_value;
    if (observed === expected) {
      validations.push({
        check: step.task,
        passed: true,
        description: `Macro ${macro} was substituted correctly (context key: ${context_key}).`,
        json_pointer: null,
        expected,
        actual: observed,
      });
    } else {
      validations.push({
        check: step.task,
        passed: false,
        description: `Macro ${macro} substitution check`,
        error:
          `Macro ${macro} was not substituted with the expected value. ` +
          `Expected "${expected}" but observed "${observed}". ` +
          `The seller must substitute ${macro} with the real captured ${context_key} value.`,
        json_pointer: null,
        expected,
        actual: observed,
      });
    }
  }

  const passed = validations.length > 0 && validations.every(v => v.passed);

  return {
    step_id: step.id,
    phase_id: phaseId,
    title: step.title,
    task: step.task,
    passed,
    duration_ms: Date.now() - start,
    validations,
    context,
    request,
    extraction,
  };
}
