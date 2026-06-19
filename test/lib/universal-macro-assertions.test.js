/**
 * Tests for the `expect_universal_macro_substituted` pseudo-task handler.
 *
 * The handler reads rendered HTML from a prior step's response body,
 * locates tracker URLs, and asserts that build-time macro tokens were
 * replaced with their real captured values from the storyboard context.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  executeUniversalMacroAssertionStep,
  UNIVERSAL_MACRO_ASSERTION_TASKS,
} = require('../../dist/lib/testing/storyboard/index.js');

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

/**
 * Build a step spec for `expect_universal_macro_substituted` using two
 * separate tracker URLs — one per macro.
 */
function makeStep(overrides = {}) {
  return {
    id: 'check_macro_substitution',
    title: 'Verify macro substitution in rendered preview',
    task: 'expect_universal_macro_substituted',
    source: 'prior_step',
    source_path: '/preview_html',
    // Two separate tracker templates — one macro per URL. The handler tests
    // each binding independently, so an array of templates is not needed:
    // `match_bindings` is called once per step with all bindings. To handle
    // two separate URLs, we test the {MEDIA_BUY_ID} macro with its URL here.
    macro_template: 'https://cdn.example/track?mb={MEDIA_BUY_ID}',
    macro_bindings: [
      { macro: '{MEDIA_BUY_ID}', context_key: 'media_buy_id' },
    ],
    ...overrides,
  };
}

/**
 * Build a prior step result carrying a response with a `preview_html` field.
 */
function makePriorResult(html) {
  return {
    step_id: 'render_creative',
    phase_id: 'phase_1',
    title: 'Render creative',
    task: 'render_creative',
    passed: true,
    duration_ms: 100,
    validations: [],
    context: {},
    response: { preview_html: html },
  };
}

function makeContext(overrides = {}) {
  return {
    media_buy_id: 'mb-abc-123',
    ...overrides,
  };
}

function makePriorResults(prior) {
  const map = new Map();
  if (prior) map.set(prior.step_id, prior);
  return map;
}

// ──────────────────────────────────────────────────────────────
// Task set
// ──────────────────────────────────────────────────────────────

describe('UNIVERSAL_MACRO_ASSERTION_TASKS', () => {
  it('contains expect_universal_macro_substituted', () => {
    assert.ok(UNIVERSAL_MACRO_ASSERTION_TASKS instanceof Set);
    assert.ok(UNIVERSAL_MACRO_ASSERTION_TASKS.has('expect_universal_macro_substituted'));
  });
});

// ──────────────────────────────────────────────────────────────
// Pass cases
// ──────────────────────────────────────────────────────────────

describe('executeUniversalMacroAssertionStep — pass cases', () => {
  it('passes when the macro is correctly substituted', async () => {
    const step = makeStep();
    // Use an img src URL so the parser can extract it. Each URL has exactly
    // one query param — raw & in multi-param query strings is intentionally
    // rejected by the HTML parser as a security measure.
    const prior = makePriorResult(
      `<html><body><img src="https://cdn.example/track?mb=mb-abc-123"></body></html>`
    );
    const context = makeContext();
    const priorStepResults = makePriorResults(prior);

    const result = await executeUniversalMacroAssertionStep(step, 'phase_1', context, {
      priorStepResults,
    });

    assert.strictEqual(result.passed, true);
    assert.ok(!result.skipped);
    assert.ok(result.validations.length > 0);
    assert.ok(result.validations.every(v => v.passed));
  });

  it('passes with multiple macro bindings across separate tracker URLs', async () => {
    // Test a step with two bindings, each resolved from a separate img element.
    const step = {
      ...makeStep(),
      // Override to test the {PACKAGE_ID} macro in a second tracker URL.
      macro_template: 'https://cdn.example/pkg?pkg={PACKAGE_ID}',
      macro_bindings: [{ macro: '{PACKAGE_ID}', context_key: 'package_id' }],
    };
    const prior = makePriorResult(
      `<html><body><img src="https://cdn.example/pkg?pkg=pkg-xyz-456"></body></html>`
    );
    const context = { package_id: 'pkg-xyz-456' };
    const priorStepResults = makePriorResults(prior);

    const result = await executeUniversalMacroAssertionStep(step, 'phase_1', context, {
      priorStepResults,
    });

    assert.strictEqual(result.passed, true);
    assert.ok(!result.skipped);
    assert.ok(result.validations.every(v => v.passed));
  });
});

// ──────────────────────────────────────────────────────────────
// Neutral skip — no preview surface
// ──────────────────────────────────────────────────────────────

describe('executeUniversalMacroAssertionStep — neutral skip', () => {
  it('skips with no_preview_surface when response has no HTML at source_path', async () => {
    const step = makeStep();
    // Prior step response doesn't have preview_html
    const prior = {
      step_id: 'render_creative',
      phase_id: 'phase_1',
      title: 'Render creative',
      task: 'render_creative',
      passed: true,
      duration_ms: 100,
      validations: [],
      context: {},
      response: { some_other_field: 'value' },
    };
    const context = makeContext();
    const priorStepResults = makePriorResults(prior);

    const result = await executeUniversalMacroAssertionStep(step, 'phase_1', context, {
      priorStepResults,
    });

    assert.strictEqual(result.passed, true, 'no_preview_surface must not fail');
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.skip_reason, 'no_preview_surface');
  });

  it('skips with no_preview_surface when prior step response is null', async () => {
    const step = makeStep();
    // Step result with no response field
    const prior = {
      step_id: 'render_creative',
      phase_id: 'phase_1',
      title: 'Render creative',
      task: 'render_creative',
      passed: true,
      duration_ms: 100,
      validations: [],
      context: {},
    };
    const context = makeContext();
    const priorStepResults = makePriorResults(prior);

    const result = await executeUniversalMacroAssertionStep(step, 'phase_1', context, {
      priorStepResults,
    });

    assert.strictEqual(result.passed, true, 'no_preview_surface must not fail');
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.skip_reason, 'no_preview_surface');
  });

  it('skips with no_preview_surface when preview HTML is an empty string', async () => {
    const step = makeStep();
    const prior = makePriorResult('');
    const context = makeContext();
    const priorStepResults = makePriorResults(prior);

    const result = await executeUniversalMacroAssertionStep(step, 'phase_1', context, {
      priorStepResults,
    });

    assert.strictEqual(result.passed, true, 'empty html must not fail');
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.skip_reason, 'no_preview_surface');
  });

  it('skips with no_preview_surface when no prior step result is found', async () => {
    const step = makeStep();
    const context = makeContext();
    // priorStepResults is empty — no prior step ran
    const result = await executeUniversalMacroAssertionStep(step, 'phase_1', context, {
      priorStepResults: new Map(),
    });

    assert.strictEqual(result.passed, true, 'missing prior must not fail');
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.skip_reason, 'no_preview_surface');
  });
});

// ──────────────────────────────────────────────────────────────
// Multi-param tracker URL (canonical real-world case)
// ──────────────────────────────────────────────────────────────

describe('executeUniversalMacroAssertionStep — multi-param tracker URL', () => {
  it('passes when both macros are correctly substituted in a single multi-param URL', async () => {
    // Both {MEDIA_BUY_ID} and {PACKAGE_ID} appear in one URL.
    // The HTML attribute must use &amp; — the only valid encoding in HTML.
    const step = {
      id: 'check_macro_substitution',
      title: 'Verify macro substitution in rendered preview',
      task: 'expect_universal_macro_substituted',
      source: 'prior_step',
      source_path: '/preview_html',
      macro_template: 'https://t.example/i?mb={MEDIA_BUY_ID}&pkg={PACKAGE_ID}',
      macro_bindings: [
        { macro: '{MEDIA_BUY_ID}', context_key: 'media_buy_id' },
        { macro: '{PACKAGE_ID}', context_key: 'package_id' },
      ],
    };
    const prior = makePriorResult(
      `<img src="https://t.example/i?mb=mb_123&amp;pkg=pkg_456">`
    );
    const context = { media_buy_id: 'mb_123', package_id: 'pkg_456' };
    const priorStepResults = makePriorResults(prior);

    const result = await executeUniversalMacroAssertionStep(step, 'phase_1', context, {
      priorStepResults,
    });

    assert.strictEqual(result.passed, true);
    assert.ok(!result.skipped);
    assert.strictEqual(result.validations.length, 2);
    assert.ok(result.validations.every(v => v.passed));
  });

  it('fails only the {PACKAGE_ID} validation when pkg= has the wrong value in a multi-param URL', async () => {
    const step = {
      id: 'check_macro_substitution',
      title: 'Verify macro substitution in rendered preview',
      task: 'expect_universal_macro_substituted',
      source: 'prior_step',
      source_path: '/preview_html',
      macro_template: 'https://t.example/i?mb={MEDIA_BUY_ID}&pkg={PACKAGE_ID}',
      macro_bindings: [
        { macro: '{MEDIA_BUY_ID}', context_key: 'media_buy_id' },
        { macro: '{PACKAGE_ID}', context_key: 'package_id' },
      ],
    };
    // mb= is correct but pkg= has the wrong value.
    const prior = makePriorResult(
      `<img src="https://t.example/i?mb=mb_123&amp;pkg=WRONG">`
    );
    const context = { media_buy_id: 'mb_123', package_id: 'pkg_456' };
    const priorStepResults = makePriorResults(prior);

    const result = await executeUniversalMacroAssertionStep(step, 'phase_1', context, {
      priorStepResults,
    });

    assert.strictEqual(result.passed, false);
    assert.ok(!result.skipped);
    assert.strictEqual(result.validations.length, 2);

    const mediaBuyValidation = result.validations.find(v => v.description && v.description.includes('{MEDIA_BUY_ID}'));
    const packageValidation = result.validations.find(v => v.description && v.description.includes('{PACKAGE_ID}'));

    assert.ok(mediaBuyValidation, '{MEDIA_BUY_ID} validation should be present');
    assert.ok(packageValidation, '{PACKAGE_ID} validation should be present');
    assert.strictEqual(mediaBuyValidation.passed, true, '{MEDIA_BUY_ID} should pass');
    assert.strictEqual(packageValidation.passed, false, '{PACKAGE_ID} should fail');
  });
});

// ──────────────────────────────────────────────────────────────
// Fail cases
// ──────────────────────────────────────────────────────────────

describe('executeUniversalMacroAssertionStep — fail cases', () => {
  it('fails when a macro token is left verbatim (not substituted)', async () => {
    const step = makeStep();
    // The seller left {MEDIA_BUY_ID} percent-encoded instead of substituting it.
    // The alignment will find the URL but observed_value !== expected.
    const prior = makePriorResult(
      `<html><body><img src="https://cdn.example/track?mb=%7BMEDIA_BUY_ID%7D"></body></html>`
    );
    const context = makeContext();
    const priorStepResults = makePriorResults(prior);

    const result = await executeUniversalMacroAssertionStep(step, 'phase_1', context, {
      priorStepResults,
    });

    assert.strictEqual(result.passed, false);
    assert.ok(result.validations.some(v => !v.passed));
  });

  it('fails when the macro slot is entirely absent from the rendered URL', async () => {
    const step = makeStep();
    // The rendered URL has no mb= parameter at all — the seller dropped it.
    const prior = makePriorResult(
      `<html><body><img src="https://cdn.example/track?other=value"></body></html>`
    );
    const context = makeContext();
    const priorStepResults = makePriorResults(prior);

    const result = await executeUniversalMacroAssertionStep(step, 'phase_1', context, {
      priorStepResults,
    });

    assert.strictEqual(result.passed, false);
    assert.ok(result.validations.some(v => !v.passed));
  });

  it('fails when the substituted value is wrong (different id)', async () => {
    const step = makeStep();
    // Seller substituted a different media_buy_id than the one in context.
    const prior = makePriorResult(
      `<html><body><img src="https://cdn.example/track?mb=WRONG-ID"></body></html>`
    );
    const context = makeContext();
    const priorStepResults = makePriorResults(prior);

    const result = await executeUniversalMacroAssertionStep(step, 'phase_1', context, {
      priorStepResults,
    });

    assert.strictEqual(result.passed, false);
    assert.ok(result.validations.some(v => !v.passed));
  });

  it('fails when a context key is missing (context not yet captured)', async () => {
    const step = makeStep();
    const prior = makePriorResult(
      `<html><body><img src="https://cdn.example/track?mb=mb-abc-123"></body></html>`
    );
    // media_buy_id is missing from context — prior capture step failed/skipped
    const context = {};
    const priorStepResults = makePriorResults(prior);

    const result = await executeUniversalMacroAssertionStep(step, 'phase_1', context, {
      priorStepResults,
    });

    assert.strictEqual(result.passed, false);
    assert.ok(result.validations.some(v => !v.passed));
  });
});
