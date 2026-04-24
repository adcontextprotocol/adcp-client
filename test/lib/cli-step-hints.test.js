/**
 * CLI renderers for runner hints (adcp-client#879).
 *
 * The runner populates `StoryboardStepResult.hints[]` with
 * `context_value_rejected` hints (#870/#875). This test fixes the
 * formatting the CLI uses for the human console path so regressions
 * surface here instead of in downstream CI output.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { printStepHints, countHintsInResult } = require('../../bin/adcp-step-hints.js');

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

function captureLogs(fn, { columns } = {}) {
  // Force a deterministic wrap width regardless of host terminal — tests
  // run in TTY, non-TTY (CI piped to file), and CI matrix terminals with
  // wildly different widths. `COLUMNS` is the env-var hook
  // `resolveWidth()` falls back to when stdout isn't a TTY.
  const prevColumns = process.env.COLUMNS;
  if (columns !== undefined) process.env.COLUMNS = String(columns);
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    fn();
  } finally {
    console.log = original;
    if (columns !== undefined) {
      if (prevColumns === undefined) delete process.env.COLUMNS;
      else process.env.COLUMNS = prevColumns;
    }
  }
  return lines;
}

describe('printStepHints', () => {
  test('first line carries the hint marker at the configured indent', () => {
    const lines = captureLogs(() => printStepHints([sampleHint]), { columns: 9999 });
    assert.equal(lines.length, 1, 'wide terminal — no wrap');
    assert.match(lines[0], /^ {3}💡 Hint: /);
    assert.match(lines[0], /\$context\.first_signal_pricing_option_id/);
    assert.match(lines[0], /po_prism_cart_cpm/);
  });

  test('renders each hint as its own block', () => {
    const second = { ...sampleHint, message: 'second hint body' };
    const lines = captureLogs(() => printStepHints([sampleHint, second]), { columns: 9999 });
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
    const [line] = captureLogs(() => printStepHints([sampleHint]), { columns: 9999 });
    assert.ok(line.startsWith('   '), `expected 3-space indent, got ${JSON.stringify(line.slice(0, 6))}`);
  });
});

describe('printStepHints: word-wrapping', () => {
  test('wraps long messages to terminal width with continuation indent', () => {
    const lines = captureLogs(() => printStepHints([sampleHint]), { columns: 80 });
    assert.ok(lines.length > 1, `expected wrap on 80-col terminal, got ${lines.length} lines`);
    // First line carries the marker.
    assert.match(lines[0], /^ {3}💡 Hint: /);
    // Continuation lines align under the message text — 3-space indent +
    // 9-column "💡 Hint: " prefix width = 12 spaces of leading whitespace.
    for (let i = 1; i < lines.length; i++) {
      assert.ok(
        lines[i].startsWith('            '),
        `continuation line ${i} should start with 12 spaces; got: ${JSON.stringify(lines[i].slice(0, 14))}`
      );
      // Continuation lines should NOT carry the marker.
      assert.doesNotMatch(lines[i], /💡 Hint:/);
    }
  });

  test('every line stays at or below the configured terminal width', () => {
    const COLS = 80;
    const lines = captureLogs(() => printStepHints([sampleHint]), { columns: COLS });
    for (const line of lines) {
      // Account for the two-codepoint emoji rendering as one visible glyph
      // (UTF-16 length is 2, visible width is 1).
      const visibleWidth = line.replace('💡', ' ').length;
      assert.ok(
        visibleWidth <= COLS,
        `line exceeded width ${COLS}: visibleWidth=${visibleWidth} text=${JSON.stringify(line)}`
      );
    }
  });

  test('preserves backtick-fenced segments across wraps (does not break inside `code`)', () => {
    // The hint message uses `code` segments for identifiers — wrapping
    // should never split a `\`xxx\`` token across two lines because
    // readers parse the whole identifier as one unit.
    const lines = captureLogs(() => printStepHints([sampleHint]), { columns: 60 });
    const joined = lines.join('\n');
    // Count opening/closing backticks per line — every line should have
    // an even count (balanced) OR zero.
    for (const line of lines) {
      const ticks = (line.match(/`/g) ?? []).length;
      assert.ok(ticks % 2 === 0, `line has unbalanced backticks (${ticks}): ${JSON.stringify(line)}`);
    }
    // Sanity: the message is intact when continuation lines are joined.
    const stripped = lines
      .map(l => l.replace(/^ {3}💡 Hint: /, '').replace(/^ {12}/, ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    assert.match(stripped, /Rejected .* Seller's accepted values:/);
  });

  test('falls back to 100 columns when COLUMNS is unset and stdout is not a TTY', () => {
    // No COLUMNS override → resolveWidth() falls through to FALLBACK_WIDTH.
    delete process.env.COLUMNS;
    const lines = captureLogs(() => printStepHints([sampleHint]));
    // sampleHint is ~280 chars; 100-col fallback should produce 3+ lines.
    assert.ok(lines.length >= 2, `expected ≥2 lines on 100-col fallback, got ${lines.length}`);
  });
});

describe('printStepHints with custom indent', () => {
  test('empty indent renders hints at column zero', () => {
    const [line] = captureLogs(() => printStepHints([sampleHint], ''), { columns: 9999 });
    assert.match(line, /^💡 Hint: /);
  });

  test('custom indent is prepended to every line', () => {
    const second = { ...sampleHint, message: 'second' };
    const lines = captureLogs(() => printStepHints([sampleHint, second], '  › '), { columns: 9999 });
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^ {2}› 💡 Hint: /);
    assert.match(lines[1], /^ {2}› 💡 Hint: second/);
  });
});

describe('countHintsInResult', () => {
  test('returns 0 for results with no hints', () => {
    const result = {
      phases: [{ steps: [{ passed: true }] }],
    };
    assert.equal(countHintsInResult(result), 0);
  });

  test('sums hints across phases and steps', () => {
    const result = {
      phases: [
        { steps: [{ hints: [{ kind: 'context_value_rejected', message: 'a' }] }] },
        {
          steps: [
            { hints: [{ kind: 'context_value_rejected', message: 'b' }] },
            { hints: [{ kind: 'context_value_rejected', message: 'c' }] },
          ],
        },
      ],
    };
    assert.equal(countHintsInResult(result), 3);
  });

  test('handles undefined / null result safely', () => {
    assert.equal(countHintsInResult(undefined), 0);
    assert.equal(countHintsInResult(null), 0);
    assert.equal(countHintsInResult({}), 0);
  });
});
