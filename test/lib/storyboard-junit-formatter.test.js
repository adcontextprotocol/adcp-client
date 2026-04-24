/**
 * Unit tests for `formatStoryboardResultsAsJUnit`.
 *
 * The JUnit formatter used to live inline in `bin/adcp.js` — untestable
 * without spawning the CLI. Extracted to `src/lib/testing/storyboard/
 * junit.ts` (issue #879 follow-up) so the XML output is exercised as a
 * pure function.
 *
 * Coverage focuses on the runner-hint integration added by #879 / #875
 * and the `message=` attribute fallback to `hints[0].message` when
 * `step.error` is absent.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { formatStoryboardResultsAsJUnit } = require('../../dist/lib/testing/storyboard/junit.js');

function buildResult({ stepOverrides = {}, storyboardOverrides = {} } = {}) {
  return {
    storyboard_id: 'test_sb',
    storyboard_title: 'Test Storyboard',
    agent_url: 'https://example.com/mcp',
    overall_passed: false,
    passed_count: 0,
    failed_count: 1,
    skipped_count: 0,
    total_duration_ms: 123,
    tested_at: '2026-04-24T00:00:00.000Z',
    phases: [
      {
        phase_id: 'p1',
        phase_title: 'Phase 1',
        passed: false,
        duration_ms: 123,
        steps: [
          {
            step_id: 's1',
            phase_id: 'p1',
            title: 'Buy media',
            task: 'create_media_buy',
            passed: false,
            skipped: false,
            duration_ms: 123,
            validations: [],
            context: {},
            extraction: { path: 'none' },
            ...stepOverrides,
          },
        ],
      },
    ],
    ...storyboardOverrides,
  };
}

const hint = {
  kind: 'context_value_rejected',
  message: 'Rejected `pricing_option_id: po_a` was extracted from `$context.x` (set by step `search`).',
  context_key: 'x',
  source_step_id: 'search',
  source_kind: 'convention',
  rejected_value: 'po_a',
  accepted_values: ['po_b'],
};

describe('formatStoryboardResultsAsJUnit: basic shape', () => {
  test('emits testsuites/testsuite/testcase hierarchy', () => {
    const xml = formatStoryboardResultsAsJUnit([buildResult()]);
    assert.match(xml, /<testsuites /);
    assert.match(xml, /<testsuite name="Test Storyboard"/);
    assert.match(xml, /<testcase classname="test_sb"/);
    assert.match(xml, /name="Phase 1 › Buy media"/);
  });

  test('empty results produces a valid empty testsuites element', () => {
    // Degenerate path the runner hits when every storyboard is filtered
    // out by capability resolution. Must still be valid XML.
    const xml = formatStoryboardResultsAsJUnit([]);
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.match(
      xml,
      /<testsuites name="adcp-storyboards" tests="0" failures="0" skipped="0" time="0\.000">\s*<\/testsuites>/
    );
  });

  test('aggregates totals across multiple storyboards + multi-phase steps', () => {
    // Two storyboards, one with two phases (two steps total), the other
    // with one phase / one step. Catches off-by-one bugs in the
    // totalTests / totalFailures / totalDuration reducers and the
    // per-storyboard suiteTests reducer.
    const sbA = buildResult({
      storyboardOverrides: {
        storyboard_id: 'sb_a',
        storyboard_title: 'SB A',
        failed_count: 1,
        passed_count: 1,
        total_duration_ms: 50,
        phases: [
          {
            phase_id: 'p1',
            phase_title: 'Phase 1',
            passed: false,
            duration_ms: 20,
            steps: [
              {
                step_id: 's1',
                phase_id: 'p1',
                title: 'Step A1',
                task: 't',
                passed: false,
                skipped: false,
                duration_ms: 20,
                validations: [],
                context: {},
                extraction: { path: 'none' },
                error: 'oops',
              },
            ],
          },
          {
            phase_id: 'p2',
            phase_title: 'Phase 2',
            passed: true,
            duration_ms: 30,
            steps: [
              {
                step_id: 's2',
                phase_id: 'p2',
                title: 'Step A2',
                task: 't',
                passed: true,
                skipped: false,
                duration_ms: 30,
                validations: [],
                context: {},
                extraction: { path: 'none' },
              },
            ],
          },
        ],
      },
    });
    const sbB = buildResult({
      stepOverrides: { passed: true },
      storyboardOverrides: {
        storyboard_id: 'sb_b',
        storyboard_title: 'SB B',
        failed_count: 0,
        passed_count: 1,
        total_duration_ms: 10,
      },
    });
    sbB.phases[0].steps[0].duration_ms = 10;

    const xml = formatStoryboardResultsAsJUnit([sbA, sbB]);
    // 3 tests total (sbA has 2 steps, sbB has 1), 1 failure, 0 skipped, 0.060s.
    assert.match(xml, /<testsuites name="adcp-storyboards" tests="3" failures="1" skipped="0" time="0\.060"/);
    // Per-suite tests counts.
    assert.match(xml, /<testsuite name="SB A" tests="2"/);
    assert.match(xml, /<testsuite name="SB B" tests="1"/);
  });

  test('reports passed steps as bare self-closing testcases', () => {
    const xml = formatStoryboardResultsAsJUnit([
      buildResult({ stepOverrides: { passed: true }, storyboardOverrides: { failed_count: 0, passed_count: 1 } }),
    ]);
    assert.match(xml, /name="Phase 1 › Buy media" time="[\d.]+"\/>/);
    assert.doesNotMatch(xml, /<failure/);
  });

  test('emits <skipped> for skipped steps', () => {
    const xml = formatStoryboardResultsAsJUnit([
      buildResult({
        stepOverrides: { passed: true, skipped: true, skip_reason: 'not_applicable' },
        storyboardOverrides: { failed_count: 0, skipped_count: 1 },
      }),
    ]);
    assert.match(xml, /<skipped message="not_applicable"\/>/);
  });
});

describe('formatStoryboardResultsAsJUnit: hint integration (#879)', () => {
  test('appends hint lines to the <failure> body after validation detail', () => {
    const xml = formatStoryboardResultsAsJUnit([
      buildResult({
        stepOverrides: {
          error: 'Pricing option not found',
          hints: [hint],
          validations: [{ check: 'error_code', passed: false, description: 'INVALID_PRICING_MODEL', error: 'got X' }],
        },
      }),
    ]);
    // Order in the body: step.error, failing validations, hints.
    const errorPos = xml.indexOf('Pricing option not found');
    const validationPos = xml.indexOf('INVALID_PRICING_MODEL: got X');
    const hintPos = xml.indexOf('Hint (context_value_rejected)');
    assert.ok(errorPos > 0 && validationPos > 0 && hintPos > 0, 'all three present');
    assert.ok(errorPos < validationPos, 'step.error first');
    assert.ok(validationPos < hintPos, 'validations before hints');
  });

  test('uses step.error as the message= attribute when present', () => {
    const xml = formatStoryboardResultsAsJUnit([
      buildResult({ stepOverrides: { error: 'task-level error', hints: [hint] } }),
    ]);
    assert.match(xml, /<failure message="task-level error"/);
  });

  test('falls back to first hint message when step.error is undefined (#883 gate)', () => {
    // When the #883-widened hint gate fires on a validation-only failure
    // (task-level success + validation fail), step.error is empty but
    // hints carry the diagnosis. CI dashboards that only read the
    // `message=` attribute still surface the hint.
    const xml = formatStoryboardResultsAsJUnit([
      buildResult({
        stepOverrides: {
          error: undefined,
          hints: [hint],
          validations: [
            { check: 'field_value', passed: false, description: 'status is activated', error: 'got rejected' },
          ],
        },
      }),
    ]);
    // Assert on a distinctive substring of the hint that survives XML
    // escaping — avoids the brittle escape-pipeline reconstruction the
    // reviewer flagged. The opening `<failure message=` plus the escaped
    // backticks in the hint (&quot;) is enough to pin attribute placement.
    assert.match(xml, /<failure message="Rejected `pricing_option_id: po_a` was extracted from `\$context\.x`/);
  });

  test('falls back to first hint message when step.error is empty string', () => {
    // Runner paths that set `error: ''` (not undefined) — the `||`
    // operator at junit.ts:82 must treat them the same as undefined.
    // The '.filter(Boolean)' in the body composition also correctly
    // strips the empty string.
    const xml = formatStoryboardResultsAsJUnit([
      buildResult({
        stepOverrides: {
          error: '',
          hints: [hint],
        },
      }),
    ]);
    assert.match(xml, /<failure message="Rejected/);
    // Empty-string error should not introduce a blank line in the body.
    assert.doesNotMatch(xml, /<failure[^>]*>\nHint /);
  });

  test('falls back to "validation failed" when neither error nor hints present', () => {
    const xml = formatStoryboardResultsAsJUnit([
      buildResult({
        stepOverrides: {
          validations: [{ check: 'field_value', passed: false, description: 'oops', error: 'got wrong' }],
        },
      }),
    ]);
    assert.match(xml, /<failure message="validation failed"/);
  });

  test('no hint entries in the body when hints is absent', () => {
    const xml = formatStoryboardResultsAsJUnit([buildResult({ stepOverrides: { error: 'plain' } })]);
    assert.doesNotMatch(xml, /Hint \(/);
  });
});

describe('formatStoryboardResultsAsJUnit: XML escaping', () => {
  test('escapes < > & " in the failure body', () => {
    const xml = formatStoryboardResultsAsJUnit([
      buildResult({
        stepOverrides: {
          error: `<script>alert("x&y")</script>`,
        },
      }),
    ]);
    // Raw <script> must never appear — that'd be an XML-injection vector.
    assert.doesNotMatch(xml, /<script>/);
    assert.match(xml, /&lt;script&gt;/);
    assert.match(xml, /&quot;/);
    assert.match(xml, /&amp;/);
  });

  test("escapes apostrophe in message= attribute (no injection via ')", () => {
    // Scope the apostrophe assertion to the attribute where it matters —
    // attribute-delimiter injection via unescaped `'` would break CI
    // parsers that wrap with single-quoted attributes.
    const xml = formatStoryboardResultsAsJUnit([
      buildResult({
        stepOverrides: {
          error: "it's broken",
        },
      }),
    ]);
    assert.match(xml, /<failure message="it&apos;s broken"/);
    assert.doesNotMatch(xml, /<failure message="it's /);
  });
});
