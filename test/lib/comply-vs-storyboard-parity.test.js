/**
 * adcp-client#1708 — comply() ↔ runStoryboard() parity regression guard.
 *
 * Original framing: cross-evaluator divergence (AAO comply suite vs CLI
 * runner producing different scores on the same agent) was a load-bearing
 * higher-order bug. Investigation showed the divergence was version-driven
 * — the comply suite was on an older @adcp/sdk that hit two distinct bugs
 * now both fixed in 7.1.0:
 *
 *   - #1713 / PR #1714 — `no_secret_echo` invariant flagged the spec-legit
 *     `authorization` field on `additionalProperties: true` accounts items
 *     regardless of value. Now only fails on string values.
 *
 *   - #1709 / PR #1712 — Zod schema rejects on the response unwrapper were
 *     misattributed to whichever step-scope invariant fired next (canonically
 *     `context.no_secret_echo`). Now correctly attributed to a synthesized
 *     `response_schema` validation entry that prepends `step.validations[]`.
 *
 * This file is the durable regression guard for the AGGREGATION layer:
 * comply()'s `extractFailures` must preserve the per-storyboard
 * `(storyboard_id, step_id, validation.check)` attribution that
 * `runStoryboard()` produces. If a future change reorders the aggregation
 * (e.g. picks the last failed validation instead of the first), the
 * BidMachine misattribution shape silently returns.
 *
 * Three test cases:
 *
 *   1. Clean pass — synthesized StoryboardResult has no failures; extractFailures
 *      returns an empty array.
 *   2. #1713 regression — a step whose validations include only the
 *      `no_secret_echo` invariant entry (failed): extractFailures attributes
 *      to `assertion`. (Validates extractFailures hasn't been altered to drop
 *      assertion entries while we were narrowing the dragnet.)
 *   3. #1709 regression — a step whose validations include BOTH a synthesized
 *      `response_schema` (failed, prepended) AND an `assertion` entry:
 *      extractFailures picks `response_schema` first. This is the actual
 *      misattribution guard.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { extractFailures } = require('../../dist/lib/testing/compliance/comply.js');

// ────────────────────────────────────────────────────────────
// Fixture builders
// ────────────────────────────────────────────────────────────

function buildStoryboardDef(id, track = 'core') {
  return {
    id,
    version: '1.0.0',
    title: `${id} (parity fixture)`,
    category: 'test',
    track,
    summary: '',
    narrative: '',
    agent: { interaction_model: 'sync', capabilities: [] },
    caller: { role: 'buyer_agent' },
    phases: [
      {
        id: 'p1',
        title: 'Phase 1',
        steps: [{ id: 'step1', title: 'Trivial', task: 'sync_accounts', expected: 'Returns a clean response.' }],
      },
    ],
  };
}

function buildStoryboardResult(storyboardId, opts = {}) {
  const step = {
    storyboard_id: storyboardId,
    step_id: 'step1',
    phase_id: 'p1',
    title: 'Trivial',
    task: 'sync_accounts',
    passed: opts.stepPassed !== false,
    duration_ms: 5,
    validations: opts.validations ?? [],
    context: {},
    extraction: { path: 'none' },
    ...(opts.error && { error: opts.error }),
  };
  return {
    storyboard_id: storyboardId,
    storyboard_title: `${storyboardId} (parity fixture)`,
    agent_url: 'https://stub.example/mcp',
    overall_passed: opts.stepPassed !== false,
    phases: [
      { phase_id: 'p1', phase_title: 'Phase 1', passed: opts.stepPassed !== false, steps: [step], duration_ms: 5 },
    ],
    context: {},
    total_duration_ms: 5,
    passed_count: opts.stepPassed !== false ? 1 : 0,
    failed_count: opts.stepPassed !== false ? 0 : 1,
    skipped_count: 0,
    tested_at: '2026-05-12T00:00:00.000Z',
    notices: [],
  };
}

// ────────────────────────────────────────────────────────────
// Test 1: clean pass — no failures in, no failures out
// ────────────────────────────────────────────────────────────

describe('extractFailures parity guard (#1708): clean pass', () => {
  test('returns empty failures when no storyboard had a failed step', () => {
    const sb = buildStoryboardDef('parity_clean_pass');
    const result = buildStoryboardResult('parity_clean_pass', { stepPassed: true });
    const failures = extractFailures([result], [sb], 'parity_test_agent');
    assert.equal(failures.length, 0);
  });

  test('skipped steps do not surface as failures', () => {
    const sb = buildStoryboardDef('parity_skipped');
    const result = buildStoryboardResult('parity_skipped', { stepPassed: true });
    // Mark the step as skipped — extractFailures must filter this out.
    result.phases[0].steps[0].skipped = true;
    result.phases[0].steps[0].skip_reason = 'not_applicable';
    result.phases[0].steps[0].passed = true;
    const failures = extractFailures([result], [sb], 'parity_test_agent');
    assert.equal(failures.length, 0);
  });
});

// ────────────────────────────────────────────────────────────
// Test 2: assertion-only failure (the pre-1709 shape)
// ────────────────────────────────────────────────────────────

describe('extractFailures parity guard (#1708): assertion-only failure surface', () => {
  test('a failed assertion alone surfaces as validation.check === "assertion"', () => {
    const sb = buildStoryboardDef('parity_assertion_only');
    const result = buildStoryboardResult('parity_assertion_only', {
      stepPassed: false,
      validations: [
        {
          check: 'assertion',
          passed: false,
          description: 'context.no_secret_echo: Response omits caller-supplied secrets',
          error: 'step "step1" response contains suspect property name "authorization"',
        },
      ],
    });
    const failures = extractFailures([result], [sb], 'parity_test_agent');
    assert.equal(failures.length, 1);
    assert.equal(failures[0].storyboard_id, 'parity_assertion_only');
    assert.equal(failures[0].step_id, 'step1');
    assert.equal(failures[0].validation.check, 'assertion');
    assert.match(failures[0].validation.description, /context\.no_secret_echo/);
  });
});

// ────────────────────────────────────────────────────────────
// Test 3: the #1709 regression guard — schema reject + assertion in
// the same step, schema must be reported first
// ────────────────────────────────────────────────────────────

describe('extractFailures parity guard (#1708): schema-reject attribution preserved (#1709)', () => {
  test('response_schema failure surfaces FIRST when present alongside an assertion', () => {
    // This is the canonical BidMachine misattribution shape. Pre-#1712, the
    // Zod reject didn't even reach `step.validations[]` — only the next
    // invariant did. Post-#1712, the runner synthesizes a `response_schema`
    // entry and PREPENDS it. extractFailures uses `.find(v => !v.passed)`
    // which returns the FIRST failed validation. So the synthesized
    // response_schema entry MUST resolve before any invariant entry, OR the
    // aggregation layer silently reintroduces the misattribution.
    const sb = buildStoryboardDef('parity_schema_then_assertion');
    const result = buildStoryboardResult('parity_schema_then_assertion', {
      stepPassed: false,
      validations: [
        // Synthesized by runner at executeStep (#1712); prepended.
        {
          check: 'response_schema',
          passed: false,
          description: 'Response schema validation for sync_accounts',
          error: 'accounts[0]: Unrecognized key(s) in object',
          json_pointer: '/accounts/0',
          expected: 'response schema for sync_accounts',
          actual: [{ code: 'unrecognized_keys', path: ['accounts', '0'], message: 'Unrecognized keys' }],
          schema_id: '/schemas/3.0.11/account/sync-accounts-response.json',
        },
        // Invariant that ran before the short-circuit (or in legacy flows)
        // and was reordered to the wrong attribution.
        {
          check: 'assertion',
          passed: false,
          description: 'context.no_secret_echo: Response omits caller-supplied secrets',
          error: 'step "step1" response contains suspect property name "authorization"',
        },
      ],
    });
    const failures = extractFailures([result], [sb], 'parity_test_agent');
    assert.equal(failures.length, 1);
    assert.equal(
      failures[0].validation.check,
      'response_schema',
      'extractFailures must surface response_schema BEFORE the no_secret_echo assertion — ' +
        'otherwise the BidMachine misattribution shape (adcp-client#1709 / adcp#4419) silently returns.'
    );
    assert.match(failures[0].validation.description, /sync_accounts/);
    assert.equal(failures[0].validation.json_pointer, '/accounts/0');
    assert.equal(
      failures[0].validation.schema_id,
      '/schemas/3.0.11/account/sync-accounts-response.json',
      'schema_id must propagate through the aggregation layer for downstream consumers'
    );
  });

  test('skipped assertion markers downstream of a schema reject are excluded from extractFailures', () => {
    // After #1712, the runner emits `{ check: 'assertion', passed: true,
    // description: '<id>: skipped — response failed schema validation' }`
    // markers for each invariant it short-circuited. These MUST NOT surface
    // in `failures` (they have passed: true) — confirms extractFailures
    // filters on .passed correctly.
    const sb = buildStoryboardDef('parity_schema_with_skip_markers');
    const result = buildStoryboardResult('parity_schema_with_skip_markers', {
      stepPassed: false,
      validations: [
        {
          check: 'response_schema',
          passed: false,
          description: 'Response schema validation for sync_accounts',
          error: 'rejected',
        },
        {
          check: 'assertion',
          passed: true, // skip marker — must NOT crowd out the real failure
          description: 'context.no_secret_echo: skipped — response failed schema validation',
        },
        {
          check: 'assertion',
          passed: true, // another skip marker
          description: 'idempotency.conflict_no_payload_leak: skipped — response failed schema validation',
        },
      ],
    });
    const failures = extractFailures([result], [sb], 'parity_test_agent');
    assert.equal(failures.length, 1);
    assert.equal(failures[0].validation.check, 'response_schema');
  });
});

// ────────────────────────────────────────────────────────────
// Test 4: BidMachine-shaped clean pass (#1713 regression guard)
// ────────────────────────────────────────────────────────────

describe('extractFailures parity guard (#1708): no_secret_echo passes on structured authorization (#1713)', () => {
  test('a step where no_secret_echo passed produces no failure entry', () => {
    // BidMachine-shape happy path: sync_accounts response carries a
    // structured `authorization` field on accounts[]. Pre-#1714 this would
    // have failed `no_secret_echo` (name dragnet); post-#1714 the invariant
    // passes because the value is a structured object, not a credential
    // echo. The step result therefore has no failed validation, and
    // extractFailures returns an empty array.
    //
    // This locks the AGGREGATION-layer invariant: a step with ONLY
    // passing validations (passed assertions, passed schema checks) must
    // not surface in `failures`. Future refactors that aggregate by
    // step.passed=false but accidentally include passed-with-warning
    // entries would break this.
    const sb = buildStoryboardDef('parity_bidmachine_clean');
    const result = buildStoryboardResult('parity_bidmachine_clean', {
      stepPassed: true,
      validations: [
        {
          check: 'assertion',
          passed: true,
          description: 'context.no_secret_echo: Response omits caller-supplied secrets and credential-shaped fields',
        },
        {
          check: 'response_schema',
          passed: true,
          description: 'Response schema validation for sync_accounts',
          schema_id: '/schemas/3.0.11/account/sync-accounts-response.json',
        },
      ],
    });
    const failures = extractFailures([result], [sb], 'parity_test_agent');
    assert.equal(failures.length, 0, 'a step with only-passing validations must produce no failure entry');
  });
});

// ────────────────────────────────────────────────────────────
// Test 5: multi-storyboard aggregation parity
// ────────────────────────────────────────────────────────────

describe('extractFailures parity guard (#1708): multi-storyboard aggregation', () => {
  test('aggregates failures across N storyboards with stable per-storyboard attribution', () => {
    const sbA = buildStoryboardDef('parity_multi_a');
    const sbB = buildStoryboardDef('parity_multi_b');
    const sbC = buildStoryboardDef('parity_multi_c');

    const failedSchema = {
      check: 'response_schema',
      passed: false,
      description: 'Response schema validation for sync_accounts',
      error: 'rejected',
    };
    const failedAssertion = {
      check: 'assertion',
      passed: false,
      description: 'context.no_secret_echo: …',
      error: 'leaked',
    };

    const resultA = buildStoryboardResult('parity_multi_a', { stepPassed: false, validations: [failedSchema] });
    const resultB = buildStoryboardResult('parity_multi_b', { stepPassed: true }); // clean
    const resultC = buildStoryboardResult('parity_multi_c', { stepPassed: false, validations: [failedAssertion] });

    const failures = extractFailures([resultA, resultB, resultC], [sbA, sbB, sbC], 'parity_test_agent');
    assert.equal(failures.length, 2, 'failed storyboards A and C surface; clean B does not');

    const byId = new Map(failures.map(f => [f.storyboard_id, f]));
    assert.ok(byId.has('parity_multi_a'));
    assert.ok(byId.has('parity_multi_c'));
    assert.ok(!byId.has('parity_multi_b'));
    assert.equal(byId.get('parity_multi_a').validation.check, 'response_schema');
    assert.equal(byId.get('parity_multi_c').validation.check, 'assertion');
  });
});
