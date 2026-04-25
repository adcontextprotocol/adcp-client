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
  // `columns: null` explicitly clears COLUMNS for the duration of the
  // test; `undefined` (default) leaves it as-is.
  const prevColumns = process.env.COLUMNS;
  const overrideColumns = arguments.length > 1 && Object.prototype.hasOwnProperty.call(arguments[1], 'columns');
  if (overrideColumns) {
    if (columns === null) delete process.env.COLUMNS;
    else process.env.COLUMNS = String(columns);
  }
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    fn();
  } finally {
    console.log = original;
    if (overrideColumns) {
      if (prevColumns === undefined) delete process.env.COLUMNS;
      else process.env.COLUMNS = prevColumns;
    }
  }
  return lines;
}

describe('printStepHints', () => {
  test('first line carries the hint marker at the configured indent', () => {
    const lines = captureLogs(() => printStepHints([sampleHint]), { columns: 9999 });
    // Issue #935: every hint renders prose line + per-kind structured
    // detail lines (key / from step / accepted values for
    // `context_value_rejected`). The first line carries the hint marker;
    // subsequent lines are continuation indent.
    assert.ok(lines.length >= 1, 'at least the prose line is emitted');
    assert.match(lines[0], /^ {3}💡 Hint: /);
    assert.match(lines[0], /\$context\.first_signal_pricing_option_id/);
    // Accepted values appear on a structured detail line, not the prose
    // line — but they must still be reachable for an operator scrolling
    // the terminal output.
    assert.ok(
      lines.some(l => /po_prism_cart_cpm/.test(l)),
      'accepted values rendered on prose or detail line'
    );
  });

  test('renders each hint as its own block (prose + per-kind detail lines)', () => {
    const second = { ...sampleHint, message: 'second hint body' };
    const lines = captureLogs(() => printStepHints([sampleHint, second]), { columns: 9999 });
    // Two hints × (1 prose + N detail lines). The exact line count is
    // governed by `structuredDetailLines(kind)`; the contract under test
    // is "each hint is visually demarcated", which we assert by finding
    // two `💡 Hint:` markers.
    const markerLines = lines.filter(l => /💡 Hint:/.test(l));
    assert.equal(markerLines.length, 2, `expected two hint blocks, saw ${markerLines.length}`);
    assert.ok(
      lines.some(l => /second hint body/.test(l)),
      'second hint body appears on its prose line'
    );
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

  test('keeps short backtick fences intact when they fit on one line', () => {
    // Width-invariant takes precedence over fence integrity. When a
    // fenced run fits on the current line, the wrapper glues it; when
    // it would push past bodyWidth, it gets split rather than blowing
    // past the column. The integrity guarantee is therefore "fences
    // that fit aren't split" — not "fences are never split."
    const lines = captureLogs(() => printStepHints([sampleHint]), { columns: 100 });
    // At 100 cols, body width = 100 - 3 - 9 = 88. The longest fenced
    // run in sampleHint is 47 chars (`signals[0].pricing_options[0]…`).
    // Every fence fits → every line has balanced ticks.
    for (const line of lines) {
      const ticks = (line.match(/`/g) ?? []).length;
      assert.ok(ticks % 2 === 0, `line has unbalanced backticks (${ticks}): ${JSON.stringify(line)}`);
    }
    // Sanity: the message round-trips when continuation lines are joined.
    const stripped = lines
      .map(l => l.replace(/^ {3}💡 Hint: /, '').replace(/^ {12}/, ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    assert.match(stripped, /Rejected .* Seller's accepted values:/);
  });

  test('total backtick count is preserved across all lines (no ticks added or dropped)', () => {
    // Even when a fence splits across a wrap (because it would otherwise
    // overflow the body width), the wrapper must not add or drop any
    // backticks — readers reconstruct the message by joining lines and
    // tick parity must survive the round trip.
    const lines = captureLogs(() => printStepHints([sampleHint]), { columns: 60 });
    const totalIn = (sampleHint.message.match(/`/g) ?? []).length;
    const totalOut = lines.reduce((n, l) => n + (l.match(/`/g) ?? []).length, 0);
    assert.equal(totalOut, totalIn, 'tick count survives wrapping');
  });

  test('falls back to 100 columns when COLUMNS is unset and stdout is not a TTY', () => {
    // `columns: null` forces COLUMNS unset for the duration of the call —
    // and restores it afterward, so this test doesn't leak state into
    // sibling tests. resolveWidth() falls through to FALLBACK_WIDTH=100.
    const lines = captureLogs(() => printStepHints([sampleHint]), { columns: null });
    // sampleHint is ~280 chars; 100-col fallback should produce 3+ lines.
    assert.ok(lines.length >= 2, `expected ≥2 lines on 100-col fallback, got ${lines.length}`);
  });

  test('stray unmatched backtick does not produce a runaway line', () => {
    // Regression for code-reviewer finding on #925: an odd-tick message
    // would put the wrapper into "openTick forever" glue mode and emit
    // one line wider than bodyWidth. Up-front parity check disables
    // fence-aware glue when ticks are unbalanced.
    const stray = {
      message: 'foo `bar baz qux corge grault garply waldo fred plugh xyzzy thud',
    };
    const lines = captureLogs(() => printStepHints([stray]), { columns: 60 });
    for (const line of lines) {
      const visible = line.replace('💡', ' ').length;
      assert.ok(visible <= 60, `line exceeded width 60 with stray tick: ${JSON.stringify(line)}`);
    }
  });

  test('hard-breaks a single token longer than the body width', () => {
    // Regression for dx-expert finding on #925: a single 280-char URL
    // with no internal whitespace would otherwise overflow. The wrap()
    // function chops it at body-width boundaries.
    const long = {
      message: 'See ' + 'x'.repeat(200) + ' for details',
    };
    const lines = captureLogs(() => printStepHints([long]), { columns: 60 });
    // bodyWidth = 60 - 3 (indent) - 9 (label) = 48
    for (const line of lines) {
      const visible = line.replace('💡', ' ').length;
      assert.ok(visible <= 60, `line exceeded width 60 with oversize token: ${JSON.stringify(line)}`);
    }
    // The 200-x run should have produced multiple chunks; assert at
    // least three lines of pure-x (sanity check the chop happened).
    const xRuns = lines.filter(l => /^\s+x{20,}$/.test(l) || /^\s+xxxxxxxxxxxxxxxxxxxx/.test(l));
    assert.ok(xRuns.length >= 3, `expected oversize token to chop into 3+ chunks; got ${xRuns.length}`);
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
    // The prose lines for the two hints both start with the custom indent
    // + label; structured-detail continuation lines start with the custom
    // indent + label-width whitespace (so they align under the message).
    const markerLines = lines.filter(l => /💡 Hint:/.test(l));
    assert.equal(markerLines.length, 2);
    assert.match(markerLines[0], /^ {2}› 💡 Hint: /);
    assert.match(markerLines[1], /^ {2}› 💡 Hint: second/);
    // Every continuation line keeps the same custom-indent prefix so the
    // visual block stays aligned.
    for (const line of lines) {
      assert.ok(line.startsWith('  › '), `line should start with the custom indent: ${JSON.stringify(line)}`);
    }
  });
});

describe('printStepHints: structured detail lines per `kind` (issue #935)', () => {
  test('shape_drift: tool / observed / expected / at fields rendered', () => {
    const lines = captureLogs(
      () =>
        printStepHints([
          {
            kind: 'shape_drift',
            tool: 'list_creatives',
            observed_variant: 'bare_array',
            expected_variant: '{ creatives: [...] }',
            instance_path: '',
            message: 'list_creatives returned a bare array at the top level.',
          },
        ]),
      { columns: 9999 }
    );
    assert.ok(
      lines.some(l => /tool: list_creatives/.test(l)),
      'tool line rendered'
    );
    assert.ok(
      lines.some(l => /observed: bare_array/.test(l)),
      'observed line rendered'
    );
    assert.ok(
      lines.some(l => /expected: \{ creatives: \[\.\.\.\] \}/.test(l)),
      'expected line rendered'
    );
    // instance_path "" → the `at:` line is suppressed.
    assert.ok(!lines.some(l => /^\s+at:/.test(l)), 'no `at:` line for root-level drift');
  });

  test('missing_required_field: tool / at / missing fields rendered', () => {
    const lines = captureLogs(
      () =>
        printStepHints([
          {
            kind: 'missing_required_field',
            tool: 'create_media_buy',
            instance_path: '/packages/0',
            schema_path: '#/properties/packages/items/required',
            missing_fields: ['creative_id', 'package_id'],
            message: 'create_media_buy response missing required fields at /packages/0: creative_id, package_id.',
          },
        ]),
      { columns: 9999 }
    );
    assert.ok(
      lines.some(l => /tool: create_media_buy/.test(l)),
      'tool line rendered'
    );
    assert.ok(
      lines.some(l => /at: \/packages\/0/.test(l)),
      'instance_path rendered'
    );
    assert.ok(
      lines.some(l => /missing: creative_id, package_id/.test(l)),
      'missing-field list rendered'
    );
  });

  test('format_mismatch: tool / at / keyword fields rendered', () => {
    const lines = captureLogs(
      () =>
        printStepHints([
          {
            kind: 'format_mismatch',
            tool: 'list_creative_formats',
            instance_path: '/formats/0/format_id/agent_url',
            schema_path: '#/properties/formats/items/properties/format_id/properties/agent_url/format',
            keyword: 'format',
            message: 'list_creative_formats response failed strict format at /formats/0/format_id/agent_url',
          },
        ]),
      { columns: 9999 }
    );
    assert.ok(lines.some(l => /tool: list_creative_formats/.test(l)));
    assert.ok(lines.some(l => /at: \/formats\/0\/format_id\/agent_url/.test(l)));
    assert.ok(lines.some(l => /keyword: format/.test(l)));
  });

  test('monotonic_violation: transition / from step / legal next states rendered', () => {
    const lines = captureLogs(
      () =>
        printStepHints([
          {
            kind: 'monotonic_violation',
            resource_type: 'media_buy',
            resource_id: 'mb_123',
            from_status: 'active',
            to_status: 'pending_creatives',
            from_step_id: 'create',
            legal_next_states: ['paused', 'completed', 'canceled'],
            enum_url: 'https://adcontextprotocol.org/schemas/3.0.0/enums/media-buy-status.json',
            message: 'media_buy mb_123: active → pending_creatives is not in the lifecycle graph...',
          },
        ]),
      { columns: 9999 }
    );
    assert.ok(
      lines.some(l => /media_buy mb_123: active → pending_creatives/.test(l)),
      'transition rendered on its own line'
    );
    assert.ok(
      lines.some(l => /from step: create/.test(l)),
      'anchor step rendered'
    );
    assert.ok(
      lines.some(l => /legal next states: paused, completed, canceled/.test(l)),
      'legal targets rendered'
    );
  });

  test('monotonic_violation with empty legal_next_states → terminal-state label', () => {
    const lines = captureLogs(
      () =>
        printStepHints([
          {
            kind: 'monotonic_violation',
            resource_type: 'media_buy',
            resource_id: 'mb_done',
            from_status: 'completed',
            to_status: 'active',
            from_step_id: 'finalize',
            legal_next_states: [],
            enum_url: 'https://adcontextprotocol.org/schemas/3.0.0/enums/media-buy-status.json',
            message: 'media_buy mb_done: completed → active (terminal state)',
          },
        ]),
      { columns: 9999 }
    );
    assert.ok(
      lines.some(l => /legal next states: \(none — terminal state\)/.test(l)),
      'terminal state explicitly labeled'
    );
  });

  test('unknown hint kind → prose-only fallback (no structured detail lines)', () => {
    // Forward-compatibility: a renderer that doesn't know a future
    // `kind` literal still surfaces the prose line, just without the
    // structured detail it can't interpret.
    const lines = captureLogs(
      () =>
        printStepHints([{ kind: 'auth_misconfiguration', message: 'agent advertised bearer but rejected our bearer' }]),
      { columns: 9999 }
    );
    assert.equal(lines.length, 1, 'unknown kind renders just the prose line');
    assert.match(lines[0], /agent advertised bearer/);
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
