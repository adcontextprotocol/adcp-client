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

  test('falls back to first hint message when step.error is absent (#883 gate)', () => {
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
    assert.match(
      xml,
      new RegExp(
        `<failure message="${hint.message
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&apos;')}"`
      )
    );
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
  test('escapes < > & " \' in messages', () => {
    const xml = formatStoryboardResultsAsJUnit([
      buildResult({
        stepOverrides: {
          error: `<script>alert("x&y")</script>`,
          hints: [{ ...hint, message: `it's <broken>` }],
        },
      }),
    ]);
    assert.doesNotMatch(xml, /<script>/);
    assert.match(xml, /&lt;script&gt;/);
    assert.match(xml, /&quot;/);
    assert.match(xml, /&apos;/);
    assert.match(xml, /&amp;/);
  });
});
