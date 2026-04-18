/**
 * Schema drift detection for storyboard YAML validations.
 *
 * Catches when field_present / field_value paths in storyboard YAML
 * reference fields that don't exist in the corresponding Zod response
 * schemas, and when context extractors reference tasks without schemas.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { listAllComplianceStoryboards } = require('../../dist/lib/testing/storyboard/index.js');
const { parsePath } = require('../../dist/lib/testing/storyboard/path.js');
const { TOOL_RESPONSE_SCHEMAS } = require('../../dist/lib/utils/response-schemas.js');
const { CONTEXT_EXTRACTORS } = require('../../dist/lib/testing/storyboard/context.js');

// Runner-internal tasks with no agent-facing schema.
const HARNESS_TASKS = new Set([
  'comply_test_controller',
  'protected_resource_metadata',
  'oauth_auth_server_metadata',
  'assert_contribution',
]);

// `$test_kit.*` substitution placeholders — resolved at run time, not tasks themselves.
const isSubstitutionTask = task => typeof task === 'string' && task.startsWith('$');

// ────────────────────────────────────────────────────────────
// Zod v4 schema walker
// ────────────────────────────────────────────────────────────

/**
 * Walk a Zod v4 schema along a parsed path and return whether the path is reachable.
 *
 * Relies on Zod v4 internals (schema._zod.def.type). If Zod upgrades change
 * these internals, the walker will need updating.
 */
function isPathReachable(schema, segments) {
  if (segments.length === 0) return true;

  const type = schema?._zod?.def?.type;
  if (!type) return false;

  const [head, ...rest] = segments;

  // Unwrap wrappers transparently
  if (type === 'optional' || type === 'nullable' || type === 'catch') {
    return isPathReachable(schema.unwrap(), segments);
  }

  // Default: unwrap inner type
  if (type === 'default') {
    return isPathReachable(schema._zod.def.innerType, segments);
  }

  // Pipe/transform: check the input schema
  if (type === 'pipe') {
    return isPathReachable(schema._zod.def.in, segments);
  }

  // Union: pass if ANY branch has the path
  if (type === 'union') {
    const options = schema.options || [];
    return options.some(opt => isPathReachable(opt, segments));
  }

  // Intersection: pass if EITHER side has the path
  if (type === 'intersection') {
    const { left, right } = schema._zod.def;
    return isPathReachable(left, segments) || isPathReachable(right, segments);
  }

  // Array index: unwrap to element type
  if (typeof head === 'number') {
    if (type === 'array' && schema.element) {
      return isPathReachable(schema.element, rest);
    }
    return false;
  }

  // Object: look up key in shape
  if (type === 'object' && schema.shape) {
    const field = schema.shape[head];
    if (!field) return false;
    return isPathReachable(field, rest);
  }

  // Record: any string key is valid
  if (type === 'record') {
    const valueSchema = schema._zod?.def?.valueType || schema.element;
    if (valueSchema) return isPathReachable(valueSchema, rest);
    return rest.length === 0;
  }

  // Leaf types (string, number, boolean, enum, literal, etc.)
  // If we still have segments left, the path doesn't exist
  return false;
}

// ────────────────────────────────────────────────────────────
// Collect validation paths from all storyboards
// ────────────────────────────────────────────────────────────

// Storyboards that validate test harness wrapper fields (e.g. TaskResult.success
// from comply_test_controller), not protocol response schemas. Add a storyboard
// here only if its validations target runtime metadata rather than tool response data.
const HARNESS_STORYBOARDS = new Set(['deterministic_testing']);

// Protocol envelope fields validated at runtime but not always declared
// in individual tool response schemas. Skip these in schema drift checks.
// `replayed` lands on the shared mutating-response envelope (AdCP spec) —
// it's set by the seller's idempotency layer, not the inner response type.
const ENVELOPE_PATHS = new Set(['context', 'context.correlation_id', 'ext', 'replayed']);

// Upstream scenarios whose validations reference fields not yet in the SDK's
// generated Zod schemas. Track upstream issues before adding to this list.
const KNOWN_SCHEMA_DRIFT_STORYBOARDS = new Set(['media_buy_seller/inventory_list_targeting']);

function collectFieldValidations(storyboards) {
  const entries = [];
  for (const sb of storyboards) {
    if (HARNESS_STORYBOARDS.has(sb.id)) continue;
    if (KNOWN_SCHEMA_DRIFT_STORYBOARDS.has(sb.id)) continue;
    for (const phase of sb.phases) {
      for (const step of phase.steps) {
        if (!step.validations) continue;
        if (step.expect_error) continue; // error steps validate extracted error data, not response schemas
        for (const v of step.validations) {
          if ((v.check === 'field_present' || v.check === 'field_value') && v.path) {
            if (ENVELOPE_PATHS.has(v.path)) continue; // protocol-level, not per-schema
            entries.push({
              storyboard: sb.id,
              step: step.id,
              task: step.task,
              check: v.check,
              path: v.path,
            });
          }
        }
      }
    }
  }
  return entries;
}

// ────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────

describe('storyboard schema drift', () => {
  const storyboards = listAllComplianceStoryboards();
  const fieldValidations = collectFieldValidations(storyboards);

  it('compliance cache storyboards load without errors', () => {
    assert.ok(storyboards.length > 0, 'Expected at least one storyboard in the compliance cache');
  });

  it('found field validations to check', () => {
    assert.ok(fieldValidations.length > 0, 'Expected at least one field_present or field_value validation');
  });

  describe('field_present paths are reachable in response schemas', () => {
    const presentValidations = fieldValidations.filter(v => v.check === 'field_present');

    for (const entry of presentValidations) {
      const schema = TOOL_RESPONSE_SCHEMAS[entry.task];
      if (!schema) continue; // skip tasks without registered schemas

      it(`${entry.storyboard}/${entry.step}: ${entry.path} exists in ${entry.task} schema`, () => {
        const segments = parsePath(entry.path);
        const reachable = isPathReachable(schema, segments);
        assert.ok(
          reachable,
          `Path "${entry.path}" is not reachable in ${entry.task} response schema. ` +
            `Segments: ${JSON.stringify(segments)}`
        );
      });
    }
  });

  describe('field_value paths are reachable in response schemas', () => {
    const valueValidations = fieldValidations.filter(v => v.check === 'field_value');

    for (const entry of valueValidations) {
      const schema = TOOL_RESPONSE_SCHEMAS[entry.task];
      if (!schema) continue;

      it(`${entry.storyboard}/${entry.step}: ${entry.path} exists in ${entry.task} schema`, () => {
        const segments = parsePath(entry.path);
        const reachable = isPathReachable(schema, segments);
        assert.ok(
          reachable,
          `Path "${entry.path}" is not reachable in ${entry.task} response schema. ` +
            `Segments: ${JSON.stringify(segments)}`
        );
      });
    }
  });

  describe('context extractor tasks have registered response schemas', () => {
    const extractorTasks = Object.keys(CONTEXT_EXTRACTORS);

    for (const task of extractorTasks) {
      it(`${task} has a registered response schema`, () => {
        assert.ok(
          TOOL_RESPONSE_SCHEMAS[task],
          `Context extractor exists for "${task}" but no response schema is registered in TOOL_RESPONSE_SCHEMAS`
        );
      });
    }
  });

  describe('every storyboard task with field validations has a response schema', () => {
    // Synthetic runner tasks for raw HTTP probes and flag-accumulator steps
    // don't correspond to AdCP tools, so they don't have response schemas.
    const SYNTHETIC_TASKS = new Set([
      'protected_resource_metadata',
      'oauth_auth_server_metadata',
      'assert_contribution',
    ]);
    const tasksWithValidations = [...new Set(fieldValidations.map(v => v.task))].filter(t => !SYNTHETIC_TASKS.has(t));

    for (const task of tasksWithValidations) {
      if (HARNESS_TASKS.has(task) || isSubstitutionTask(task)) continue;
      it(`${task} has a registered response schema`, () => {
        assert.ok(
          TOOL_RESPONSE_SCHEMAS[task],
          `Storyboard field validations reference task "${task}" but no response schema is registered`
        );
      });
    }
  });
});
