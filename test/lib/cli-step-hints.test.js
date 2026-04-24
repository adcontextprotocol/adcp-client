/**
 * CLI renderers for runner hints (adcp-client#879).
 *
 * The runner populates `StoryboardStepResult.hints[]` with
 * `context_value_rejected` hints (#870/#875). This test fixes the
 * formatting the CLI uses for both the human console path and the JUnit
 * XML failure body so regressions in either renderer surface here
 * instead of in downstream CI dashboards.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { printStepHints, formatHintsForFailureBody } = require('../../bin/adcp-step-hints.js');

const sampleHint = {
  kind: 'context_value_rejected',
  message:
    'Rejected `packages[0].pricing_option_id: po_prism_abandoner_cpm` was extracted from ' +
    '`$context.first_signal_pricing_option_id` (set by step `search_by_spec` from ' +
    'response path `signals[0].pricing_options[0].pricing_option_id`). ' +
    "Seller's accepted values: [po_prism_cart_cpm].",
  context_key: 'first_signal_pricing_option_id',
  source_step_id: 'search_by_spec',
  source_kind: 'context_outputs',
  response_path: 'signals[0].pricing_options[0].pricing_option_id',
  rejected_value: 'po_prism_abandoner_cpm',
  request_field: 'packages[0].pricing_option_id',
  accepted_values: ['po_prism_cart_cpm'],
  error_code: 'INVALID_PRICING_MODEL',
};

function captureLogs(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

describe('printStepHints', () => {
  test('renders one line per hint prefixed with the Hint marker', () => {
    const lines = captureLogs(() => printStepHints([sampleHint]));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^ {3}💡 Hint: /);
    assert.match(lines[0], /\$context\.first_signal_pricing_option_id/);
    assert.match(lines[0], /po_prism_cart_cpm/);
  });

  test('renders multiple hints on separate lines', () => {
    const second = { ...sampleHint, message: 'second hint body' };
    const lines = captureLogs(() => printStepHints([sampleHint, second]));
    assert.equal(lines.length, 2);
    assert.match(lines[1], /second hint body/);
  });

  test('no-op when hints is undefined', () => {
    const lines = captureLogs(() => printStepHints(undefined));
    assert.equal(lines.length, 0);
  });

  test('no-op when hints is an empty array', () => {
    const lines = captureLogs(() => printStepHints([]));
    assert.equal(lines.length, 0);
  });

  test('no-op when hints is not an array', () => {
    const lines = captureLogs(() => printStepHints('not an array'));
    assert.equal(lines.length, 0);
  });

  test('aligns with the 3-space indent used for `Error:` and validations', () => {
    // The CLI prints `   Error: ...` and `   ✅ ...` at 3-space indent.
    // Hint lines use the same so they group visually.
    const [line] = captureLogs(() => printStepHints([sampleHint]));
    assert.ok(line.startsWith('   '), `expected 3-space indent, got ${JSON.stringify(line.slice(0, 6))}`);
  });
});

describe('formatHintsForFailureBody', () => {
  test('formats each hint as a prefixed line with its kind', () => {
    const lines = formatHintsForFailureBody([sampleHint]);
    assert.deepEqual(lines, [`Hint (context_value_rejected): ${sampleHint.message}`]);
  });

  test('returns empty array when hints is absent', () => {
    assert.deepEqual(formatHintsForFailureBody(undefined), []);
    assert.deepEqual(formatHintsForFailureBody(null), []);
    assert.deepEqual(formatHintsForFailureBody([]), []);
  });

  test('returns one entry per hint (order preserved)', () => {
    const second = { ...sampleHint, kind: 'context_value_rejected', message: 'B' };
    const third = { ...sampleHint, kind: 'context_value_rejected', message: 'C' };
    const lines = formatHintsForFailureBody([sampleHint, second, third]);
    assert.equal(lines.length, 3);
    assert.ok(lines[1].endsWith(': B'));
    assert.ok(lines[2].endsWith(': C'));
  });
});
