/**
 * Snapshot-style tests for `formatStoryboardResultsAsJUnit` to pin the
 * behaviour added in issue #879: context_value_rejected hints must appear
 * in the JUnit <failure> body and, when step.error is absent, in the
 * message= attribute.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { formatStoryboardResultsAsJUnit } = require('../../dist/lib/testing/storyboard/junit.js');

function makeResult({ error, hints, validations } = {}) {
  return {
    storyboard_id: 'test_sb',
    storyboard_title: 'Test Storyboard',
    agent_url: 'https://example.com/mcp',
    tested_at: '2026-01-01T00:00:00.000Z',
    passed: false,
    passed_count: 0,
    failed_count: 1,
    skipped_count: 0,
    total_duration_ms: 100,
    phases: [
      {
        phase_id: 'phase_1',
        phase_title: 'Phase 1',
        passed: false,
        duration_ms: 100,
        steps: [
          {
            step_id: 'step_1',
            title: 'Buy media',
            task: 'create_media_buy',
            passed: false,
            skipped: false,
            duration_ms: 100,
            error: error ?? null,
            hints: hints ?? [],
            validations: validations ?? [],
          },
        ],
      },
    ],
  };
}

test('hint message appears in JUnit <failure> CDATA body', () => {
  const hint = {
    kind: 'context_value_rejected',
    message:
      'Rejected `packages[0].pricing_option_id: po_prism_abandoner_cpm` was extracted from `$context.pricing_option_id` (set by step `search_step`). Accepted: [po_prism_cart_cpm].',
    context_key: 'pricing_option_id',
    source_step_id: 'search_step',
    source_kind: 'convention',
    rejected_value: 'po_prism_abandoner_cpm',
    accepted_values: ['po_prism_cart_cpm'],
  };

  const xml = formatStoryboardResultsAsJUnit([
    makeResult({ error: 'Pricing option not found: po_prism_abandoner_cpm', hints: [hint] }),
  ]);

  assert.match(xml, /<failure[^>]+>/, 'should have a <failure> element');
  assert.match(xml, /Hint: Rejected `packages\[0\]\.pricing_option_id/, 'hint message should appear in failure body');
  assert.match(xml, /Pricing option not found: po_prism_abandoner_cpm/, 'step error should appear in failure body');
});

test('hint message ordering: step.error then hints then validations', () => {
  const hint = {
    kind: 'context_value_rejected',
    message: 'Hint text.',
    context_key: 'k',
    source_step_id: 's',
    source_kind: 'convention',
    rejected_value: 'v',
    accepted_values: [],
  };
  const validationFailure = { passed: false, description: 'field_present: foo', error: 'missing field' };

  const xml = formatStoryboardResultsAsJUnit([
    makeResult({ error: 'Top error', hints: [hint], validations: [validationFailure] }),
  ]);

  const errorPos = xml.indexOf('Top error');
  const hintPos = xml.indexOf('Hint text.');
  const validationPos = xml.indexOf('field_present: foo');
  assert.ok(errorPos < hintPos, 'error should come before hint');
  assert.ok(hintPos < validationPos, 'hint should come before validation failure');
});

test('when step.error is absent, first hint message used as failure message= attribute', () => {
  const hint = {
    kind: 'context_value_rejected',
    message: 'Context hint only.',
    context_key: 'k',
    source_step_id: 's',
    source_kind: 'convention',
    rejected_value: 'v',
    accepted_values: [],
  };

  const xml = formatStoryboardResultsAsJUnit([makeResult({ error: null, hints: [hint] })]);

  assert.match(xml, /message="Context hint only\."/, 'hint message should be the failure message= attribute');
});

test('step without hints falls through to validation failed', () => {
  const xml = formatStoryboardResultsAsJUnit([makeResult({ error: null, hints: [], validations: [] })]);

  assert.match(xml, /message="validation failed"/, 'default message should be "validation failed"');
  assert.doesNotMatch(xml, /Hint:/, 'should not mention Hint: when no hints present');
});

test('multiple hints all appear in failure body', () => {
  const hints = [
    {
      kind: 'context_value_rejected',
      message: 'Hint A.',
      context_key: 'a',
      source_step_id: 's1',
      source_kind: 'convention',
      rejected_value: 'x',
      accepted_values: [],
    },
    {
      kind: 'context_value_rejected',
      message: 'Hint B.',
      context_key: 'b',
      source_step_id: 's2',
      source_kind: 'convention',
      rejected_value: 'y',
      accepted_values: [],
    },
  ];

  const xml = formatStoryboardResultsAsJUnit([makeResult({ hints })]);

  assert.match(xml, /Hint A\./, 'first hint should appear');
  assert.match(xml, /Hint B\./, 'second hint should appear');
});
