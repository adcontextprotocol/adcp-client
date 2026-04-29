/**
 * Schema drift detection for storyboard YAML validations.
 *
 * Catches when field_present / field_value / field_value_or_absent paths in
 * storyboard YAML reference fields that don't exist in the corresponding
 * Zod response schemas, when context extractors reference tasks without
 * schemas, and when `field_value_or_absent` is asserted on a path the
 * response schema already marks required (the tolerance is meaningless —
 * the storyboard author should have used `field_value`).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { z } = require('zod');

const { listAllComplianceStoryboards } = require('../../dist/lib/testing/storyboard/index.js');
const { parsePath } = require('../../dist/lib/testing/storyboard/path.js');
const { TOOL_RESPONSE_SCHEMAS } = require('../../dist/lib/utils/response-schemas.js');
const { CONTEXT_EXTRACTORS } = require('../../dist/lib/testing/storyboard/context.js');
// `envelope_field_present` (and `envelope_field_value{,_or_absent}`)
// validations walk the v3 protocol envelope — `status`, `task_id`,
// `message`, `replayed`, `governance_context`, `timestamp`, `context_id`,
// `push_notification_config` — instead of per-tool response schemas.
// `errors` and `adcp_version` are NOT envelope fields (errors lives inside
// `payload` per the per-tool response schema; adcp_major_version is on the
// request, not on either response surface). Added per adcp#3429.
const { ProtocolEnvelopeSchema } = require('../../dist/lib/types/schemas.generated.js');

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

/**
 * Walk a Zod v4 schema along a parsed path and report whether the path is
 * *required* — i.e. the spec guarantees the field is present. A path that
 * traverses ANY `optional` / `nullable` / `default` wrapper is not required;
 * neither is a path through a `record` (any key) or a `union` branch that
 * omits the field.
 *
 * Conservative on unions: required only if ALL branches require it. On
 * intersections: required if EITHER side requires it — a value in
 * `z.intersection(L, R)` must satisfy both sides, so the union of their
 * requirements applies.
 *
 * Used to lint `field_value_or_absent` assertions: if the path the tolerant
 * matcher targets is already required by the schema, the tolerance is dead
 * code — the author should have used `field_value`.
 */
function isPathRequired(schema, segments) {
  const type = schema?._zod?.def?.type;
  if (!type) return false;

  // Any tolerance wrapper means "not required at this level."
  if (type === 'optional' || type === 'nullable' || type === 'default' || type === 'catch') {
    return false;
  }

  if (type === 'pipe') {
    return isPathRequired(schema._zod.def.in, segments);
  }

  if (type === 'union') {
    const options = schema.options || [];
    return options.length > 0 && options.every(opt => isPathRequired(opt, segments));
  }

  if (type === 'intersection') {
    const { left, right } = schema._zod.def;
    return isPathRequired(left, segments) || isPathRequired(right, segments);
  }

  if (segments.length === 0) {
    // Reached the end of the path on a non-tolerance schema — required.
    return true;
  }

  const [head, ...rest] = segments;

  if (typeof head === 'number') {
    if (type === 'array' && schema.element) return isPathRequired(schema.element, rest);
    return false;
  }

  if (type === 'object' && schema.shape) {
    const field = schema.shape[head];
    if (!field) return false;
    return isPathRequired(field, rest);
  }

  // Records don't guarantee any specific key.
  if (type === 'record') return false;

  // Leaf with segments remaining — path doesn't exist.
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

// Entire storyboards whose validations reference schema shapes that diverge
// from the generated Zod schemas AND that blanket-skipping is defensible
// for. Prefer field-path entries in UPSTREAM_SCHEMA_DRIFT / VERIFIER_UNREACHABLE
// over adding here — this set hides ALL checks in the storyboard, not just
// the drifting ones.
const KNOWN_SCHEMA_DRIFT_STORYBOARDS = new Set();

function collectFieldValidations(storyboards) {
  const entries = [];
  for (const sb of storyboards) {
    if (HARNESS_STORYBOARDS.has(sb.id)) continue;
    if (KNOWN_SCHEMA_DRIFT_STORYBOARDS.has(sb.id)) continue;
    for (const phase of sb.phases) {
      for (const step of phase.steps) {
        if (!step.validations) continue;
        if (step.expect_error) continue; // error steps validate extracted error data, not response schemas
        // Steps that declare `is_error` as a validation are also asserting
        // an error-response shape (e.g. `error.code`, `error.recovery`) even
        // if `expect_error` isn't set at the step level. Their paths target
        // the error envelope, not the task's success response schema, so
        // schema drift checks don't apply.
        const isErrorStep = step.validations.some(v => v.check === 'is_error');
        if (isErrorStep) continue;
        for (const v of step.validations) {
          if (
            (v.check === 'field_present' ||
              v.check === 'field_absent' ||
              v.check === 'envelope_field_present' ||
              v.check === 'envelope_field_absent' ||
              v.check === 'field_value' ||
              v.check === 'envelope_field_value' ||
              v.check === 'field_value_or_absent' ||
              v.check === 'envelope_field_value_or_absent') &&
            v.path
          ) {
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
    assert.ok(
      fieldValidations.length > 0,
      'Expected at least one field_present, field_value, or field_value_or_absent validation'
    );
  });

  // Drift entries cleared by upstream fixes that haven't shipped in the
  // published tarball yet. `npm run sync-schemas` pulls the most recent
  // release, so a fix merged to adcp `main` post-release stays in this
  // allowlist until the next tarball cut.
  const KNOWN_FORWARD_DRIFT = new Set([]);

  // Paths that are structurally valid in the spec schema but that
  // `isPathReachable` can't resolve after the Zod codegen — the codegen
  // emits a shape our traversal doesn't recognize (typically an intersected
  // `oneOf` where the discriminated union gets wrapped in a way we don't
  // unwrap). These are verifier-side limitations, not spec drift; removing
  // an entry requires extending `isPathReachable` to handle the shape.
  const VERIFIER_UNREACHABLE = new Set([
    // `status` is on the v3 envelope (`protocol-envelope.json`), not the
    // inner `get-adcp-capabilities-response.json`. The drift detector
    // walks only the inner response schema today; teaching it to chain
    // through the envelope wrapper requires schema-loader work tracked
    // separately. The storyboard step (3.0.1+
    // universal/v3-envelope-integrity.yaml) asserts the canonical v3
    // envelope contract — the schema constraint lives on the envelope's
    // `not: { anyOf: [...] }`, which the runner enforces at wire time.
    // Filed upstream as adcp#3429 (storyboard authoring: response_schema_ref
    // vs envelope-level field assertions).
    'v3_envelope_integrity/no_legacy_status_fields:status',
  ]);

  // Paths that reference spec schema fields the upstream schema doesn't
  // actually define. Each entry MUST cite an open upstream issue — if the
  // citation closes without the field landing, the entry is stale and
  // should be removed or re-evaluated.
  const UPSTREAM_SCHEMA_DRIFT = new Set([
    // adcontextprotocol/adcp#2488 — PackageStatus lacks `targeting_overlay`,
    // so get_media_buys can't echo the property_list / collection_list the
    // seller persisted. Storyboard media_buy_seller/inventory_list_targeting
    // asserts both read paths post-create and post-update (4 entries total).
    'media_buy_seller/inventory_list_targeting/get_after_create:media_buys[0].packages[0].targeting_overlay.property_list.list_id',
    'media_buy_seller/inventory_list_targeting/get_after_create:media_buys[0].packages[0].targeting_overlay.collection_list.list_id',
    'media_buy_seller/inventory_list_targeting/get_after_update:media_buys[0].packages[0].targeting_overlay.property_list.list_id',
    'media_buy_seller/inventory_list_targeting/get_after_update:media_buys[0].packages[0].targeting_overlay.collection_list.list_id',
  ]);

  function skipReason(key) {
    if (KNOWN_FORWARD_DRIFT.has(key)) return 'known forward-drift pending schema regen';
    if (UPSTREAM_SCHEMA_DRIFT.has(key)) return 'upstream schema drift — see adcp#2488';
    if (VERIFIER_UNREACHABLE.has(key)) return 'verifier-side path-reachability limitation';
    return false;
  }

  describe('field_present paths are reachable in response schemas', () => {
    const presentValidations = fieldValidations.filter(v => v.check === 'field_present');

    for (const entry of presentValidations) {
      const schema = TOOL_RESPONSE_SCHEMAS[entry.task];
      if (!schema) continue; // skip tasks without registered schemas

      const key = `${entry.storyboard}/${entry.step}:${entry.path}`;
      const skip = skipReason(key);
      it(`${entry.storyboard}/${entry.step}: ${entry.path} exists in ${entry.task} schema`, { skip }, () => {
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

  describe('field_absent / envelope_field_absent are collected but skip reachability', () => {
    // Absence checks have no schema target by design — a `field_absent` assertion
    // validates that a path does NOT exist, so there is no schema field to walk.
    // We still collect them in collectFieldValidations (above) so a future sweep
    // can cross-reference storyboard intent, but we do not assert reachability.
    const absentValidations = fieldValidations.filter(
      v => v.check === 'field_absent' || v.check === 'envelope_field_absent'
    );
    it('absence-check validations are collected without reachability assertions', () => {
      // Structural smoke-test: if any are present, they must have a path.
      for (const entry of absentValidations) {
        assert.ok(entry.path, `${entry.storyboard}/${entry.step}: field_absent entry missing path`);
      }
    });
  });

  describe('envelope-scoped validations resolve in the v3 envelope schema', () => {
    // adcp#3429: storyboards assert envelope-level fields (`status`,
    // `task_id`, `message`, `replayed`, `governance_context`, `timestamp`,
    // `context_id`, `push_notification_config`) using the envelope-scoped
    // checks so the drift detector knows to walk `protocol-envelope.json`
    // rather than the per-tool response schema. `errors` and `adcp_version`
    // are NOT envelope fields — keep them on the un-prefixed checks.
    // `envelope_field_absent` is excluded here — absence checks have no schema
    // target (see the `field_absent / envelope_field_absent` block above).
    const envelopeValidations = fieldValidations.filter(
      v =>
        v.check === 'envelope_field_present' ||
        v.check === 'envelope_field_value' ||
        v.check === 'envelope_field_value_or_absent'
    );

    for (const entry of envelopeValidations) {
      const key = `${entry.storyboard}/${entry.step}:${entry.path}`;
      const skip = skipReason(key);
      it(
        `${entry.storyboard}/${entry.step}: ${entry.check} ${entry.path} exists in v3 protocol envelope`,
        { skip },
        () => {
          const segments = parsePath(entry.path);
          const reachable = isPathReachable(ProtocolEnvelopeSchema, segments);
          assert.ok(
            reachable,
            `Path "${entry.path}" is not reachable in protocol-envelope.json. ` +
              `Segments: ${JSON.stringify(segments)}`
          );
        }
      );
    }
  });

  describe('field_value paths are reachable in response schemas', () => {
    const valueValidations = fieldValidations.filter(v => v.check === 'field_value');

    for (const entry of valueValidations) {
      const schema = TOOL_RESPONSE_SCHEMAS[entry.task];
      if (!schema) continue;

      const key = `${entry.storyboard}/${entry.step}:${entry.path}`;
      const skip = skipReason(key);
      it(`${entry.storyboard}/${entry.step}: ${entry.path} exists in ${entry.task} schema`, { skip }, () => {
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

  describe('field_value_or_absent paths are reachable in response schemas', () => {
    const tolerantValidations = fieldValidations.filter(v => v.check === 'field_value_or_absent');

    for (const entry of tolerantValidations) {
      const schema = TOOL_RESPONSE_SCHEMAS[entry.task];
      if (!schema) continue;

      const key = `${entry.storyboard}/${entry.step}:${entry.path}`;
      const skip = skipReason(key);
      it(`${entry.storyboard}/${entry.step}: ${entry.path} exists in ${entry.task} schema`, { skip }, () => {
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

  // Lint: `field_value_or_absent` is meaningful only when the schema does NOT
  // already guarantee the field is present. If a storyboard uses the tolerant
  // matcher on a required field, the tolerance is dead code — the spec already
  // rules out the "absent" branch. Redirect authors to `field_value` there.
  // Envelope-tolerant paths (declared in `ENVELOPE_PATHS` above) are skipped
  // because they target protocol-level fields not modeled on individual tool
  // response schemas.
  describe('field_value_or_absent is not redundantly applied to schema-required fields', () => {
    const tolerantValidations = fieldValidations.filter(v => v.check === 'field_value_or_absent');

    for (const entry of tolerantValidations) {
      const schema = TOOL_RESPONSE_SCHEMAS[entry.task];
      if (!schema) continue;

      it(`${entry.storyboard}/${entry.step}: ${entry.path} is not schema-required (use \`field_value\` if it is)`, () => {
        const segments = parsePath(entry.path);
        const required = isPathRequired(schema, segments);
        assert.ok(
          !required,
          `Path "${entry.path}" is required in ${entry.task} response schema — ` +
            `the tolerance in \`field_value_or_absent\` is meaningless. Use \`field_value\` instead.`
        );
      });
    }
  });

  describe('isPathRequired helper', () => {
    it('returns true for a top-level required string field', () => {
      const schema = z.object({ status: z.string() });
      assert.equal(isPathRequired(schema, ['status']), true);
    });

    it('returns false for a top-level optional field', () => {
      const schema = z.object({ replayed: z.boolean().optional() });
      assert.equal(isPathRequired(schema, ['replayed']), false);
    });

    it('returns false for a nullable field (null is a legal value, not presence)', () => {
      const schema = z.object({ note: z.string().nullable() });
      assert.equal(isPathRequired(schema, ['note']), false);
    });

    it('returns false for a defaulted field (default implies absence is tolerated)', () => {
      const schema = z.object({ currency: z.string().default('USD') });
      assert.equal(isPathRequired(schema, ['currency']), false);
    });

    it('returns true through a nested required object', () => {
      const schema = z.object({ envelope: z.object({ status: z.string() }) });
      assert.equal(isPathRequired(schema, ['envelope', 'status']), true);
    });

    it('returns false when the intermediate wrapper is optional', () => {
      const schema = z.object({ envelope: z.object({ status: z.string() }).optional() });
      assert.equal(isPathRequired(schema, ['envelope', 'status']), false);
    });

    it('returns false for a missing field', () => {
      const schema = z.object({ status: z.string() });
      assert.equal(isPathRequired(schema, ['nope']), false);
    });

    it('returns true through an array element when the element schema requires the key', () => {
      const schema = z.object({ accounts: z.array(z.object({ id: z.string() })) });
      assert.equal(isPathRequired(schema, ['accounts', 0, 'id']), true);
    });

    it('returns false for record key access (no specific key is guaranteed)', () => {
      const schema = z.object({ props: z.record(z.string(), z.string()) });
      assert.equal(isPathRequired(schema, ['props', 'whatever']), false);
    });

    it('union: required only if EVERY branch requires it', () => {
      const both = z.union([z.object({ id: z.string() }), z.object({ id: z.string(), extra: z.number() })]);
      assert.equal(isPathRequired(both, ['id']), true);

      const onlyOne = z.union([z.object({ id: z.string() }), z.object({ other: z.string() })]);
      assert.equal(isPathRequired(onlyOne, ['id']), false);
    });
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
