/**
 * Regression tests for adcp-client#1736 / adcp#3025.
 *
 * Two false positives were surfacing from the evaluator:
 *
 *   1. `confirmed_at` advisory firing on `create_media_buy` responses
 *      with no backing storyboard rule. The advisory was hard-coded in
 *      `comply.ts` and emitted "Agent does not return confirmed_at …"
 *      whenever the field was absent (or appeared absent due to a
 *      response-wrapping mismatch), even though `confirmed_at` is optional
 *      in the response schema. Any advisory the evaluator emits must
 *      trace to a storyboard rule or schema constraint — there is no
 *      such rule for `confirmed_at`, so the advisory must not fire.
 *
 *   2. The previously-paired hard-coded `revision` advisory on
 *      `create_media_buy` was removed for the same reason. The schema's
 *      `minimum: 1` constraint on `revision` is enforced by the
 *      response_schema validator with a structured constraint-violation
 *      output (keyword=`minimum`, JSON Pointer=`/revision`) so the
 *      hard-coded advisory was redundant and unbacked.
 *
 * These tests verify that for `create_media_buy` responses, no advisory
 * fires regardless of whether `confirmed_at` / `revision` are present,
 * absent, null, or zero.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { collectObservations } = require('../../dist/lib/testing/compliance/index.js');

const dummyProfile = {
  name: 'Test Agent',
  tools: ['create_media_buy', 'get_media_buys'],
};

function testResultWithCreateMediaBuy(observationData) {
  return {
    agent_url: 'https://example.com/mcp',
    scenario: 'media_buy',
    overall_passed: true,
    summary: '',
    total_duration_ms: 100,
    tested_at: '2026-01-01T00:00:00.000Z',
    steps: [
      {
        step: 'Create media buy',
        task: 'create_media_buy',
        passed: true,
        duration_ms: 100,
        observation_data: observationData,
      },
    ],
  };
}

describe('collectObservations — create_media_buy advisories (#1736)', () => {
  test('does not emit confirmed_at advisory when confirmed_at is absent', () => {
    const result = testResultWithCreateMediaBuy({ revision: 1 });
    const observations = collectObservations('media_buy', [result], dummyProfile);
    const confirmedAt = observations.filter(o => o.message.includes('confirmed_at'));
    assert.equal(
      confirmedAt.length,
      0,
      `Expected zero confirmed_at advisories, got ${confirmedAt.length}: ${JSON.stringify(confirmedAt)}`
    );
  });

  test('does not emit confirmed_at advisory when confirmed_at is null', () => {
    const result = testResultWithCreateMediaBuy({ confirmed_at: null, revision: 1 });
    const observations = collectObservations('media_buy', [result], dummyProfile);
    const confirmedAt = observations.filter(o => o.message.includes('confirmed_at'));
    assert.equal(confirmedAt.length, 0, 'confirmed_at must never fire — no backing rule');
  });

  test('does not emit confirmed_at advisory when confirmed_at is present', () => {
    const result = testResultWithCreateMediaBuy({
      confirmed_at: '2026-01-01T00:00:00Z',
      revision: 1,
    });
    const observations = collectObservations('media_buy', [result], dummyProfile);
    const confirmedAt = observations.filter(o => o.message.includes('confirmed_at'));
    assert.equal(confirmedAt.length, 0);
  });

  test('does not emit revision advisory when revision is absent', () => {
    const result = testResultWithCreateMediaBuy({ confirmed_at: '2026-01-01T00:00:00Z' });
    const observations = collectObservations('media_buy', [result], dummyProfile);
    const revisionAdvisories = observations.filter(o => o.message.includes('revision in create_media_buy'));
    assert.equal(revisionAdvisories.length, 0, 'revision advisory was unbacked and must not fire');
  });

  test('does not emit revision advisory when revision is zero', () => {
    // `revision: 0` is a real constraint violation (schema has `minimum: 1`)
    // but it must be reported by the response_schema validator with a
    // constraint-violation classification, not by this advisory channel.
    const result = testResultWithCreateMediaBuy({
      confirmed_at: '2026-01-01T00:00:00Z',
      revision: 0,
    });
    const observations = collectObservations('media_buy', [result], dummyProfile);
    const revisionAdvisories = observations.filter(o => o.message.includes('revision in create_media_buy'));
    assert.equal(revisionAdvisories.length, 0);
  });

  test('every emitted advisory has a non-empty message (proxy for traceable source)', () => {
    // Smoke check: any advisory the evaluator does emit must at minimum
    // carry a populated message. A truly source-attributed advisory would
    // also carry storyboard/step coordinates — that's the next iteration —
    // but at present this test fences off the regression where an advisory
    // appears with neither a rule nor a meaningful description.
    const result = testResultWithCreateMediaBuy({
      confirmed_at: '2026-01-01T00:00:00Z',
      revision: 1,
    });
    const observations = collectObservations('media_buy', [result], dummyProfile);
    for (const o of observations) {
      assert.ok(typeof o.message === 'string' && o.message.length > 0, 'advisory missing message');
      assert.ok(o.category, 'advisory missing category');
      assert.ok(o.severity, 'advisory missing severity');
    }
  });
});

describe('collectObservations — valid_actions advisory (#5319)', () => {
  function mediaBuyResultWithGetMediaBuysObservations(observations) {
    return {
      agent_url: 'https://example.com/mcp',
      scenario: 'media_buy_seller/pending_creatives_to_start',
      overall_passed: true,
      summary: '',
      total_duration_ms: 100,
      tested_at: '2026-01-01T00:00:00.000Z',
      steps: observations.map((observation_data, index) => ({
        step: `Get media buys ${index + 1}`,
        task: 'get_media_buys',
        passed: true,
        duration_ms: 100,
        observation_data,
      })),
    };
  }

  test('does not emit missing-valid-actions when a later get_media_buys observation has valid_actions', () => {
    const result = mediaBuyResultWithGetMediaBuysObservations([
      { valid_actions: undefined },
      { valid_actions: ['cancel', 'update_budget'], sandbox: true },
    ]);

    const observations = collectObservations('media_buy', [result], dummyProfile);
    const missingValidActions = observations.filter(o => o.source?.code === 'missing-valid-actions');

    assert.equal(
      missingValidActions.length,
      0,
      `Expected no missing-valid-actions advisory when any get_media_buys observation includes valid_actions, got ${JSON.stringify(missingValidActions)}`
    );
  });

  test('still emits missing-valid-actions when no get_media_buys observation has valid_actions', () => {
    const result = mediaBuyResultWithGetMediaBuysObservations([{ sandbox: true }, { valid_actions: null }]);

    const observations = collectObservations('media_buy', [result], dummyProfile);
    const missingValidActions = observations.filter(o => o.source?.code === 'missing-valid-actions');

    assert.equal(missingValidActions.length, 1);
    assert.equal(missingValidActions[0].source.storyboard_id, 'media_buy_seller/pending_creatives_to_start');
    assert.equal(missingValidActions[0].source.step_id, 'Get media buys 1');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// #1746 — Every advisory carries traceable source coordinates.
//
// Builds on the original #1736 fix: it's not enough that the message is
// populated and the category/severity are set; every observation must
// trace back to either a storyboard step (with grep-able storyboard_id +
// step_id), a storyboard rollup (storyboard_id only), the agent's
// discovered profile, or a network probe. This test fixture covers each
// emission site in `collectObservations` and asserts the `source` field
// is structurally valid.
//
// If a future contributor adds a `observations.push({...})` without a
// `source`, this test fails the build before the regression ships.
// ────────────────────────────────────────────────────────────────────────────

const VALID_KINDS = new Set(['storyboard_step', 'storyboard', 'profile', 'probe']);

function assertValidSource(source, label) {
  assert.ok(source, `${label}: missing source`);
  assert.ok(VALID_KINDS.has(source.kind), `${label}: invalid source.kind="${source.kind}"`);
  assert.ok(typeof source.code === 'string' && source.code.length > 0, `${label}: missing source.code`);
  if (source.kind === 'storyboard_step') {
    assert.ok(source.storyboard_id, `${label}: storyboard_step missing storyboard_id`);
    assert.ok(source.step_id, `${label}: storyboard_step missing step_id`);
  }
  if (source.kind === 'storyboard') {
    assert.ok(source.storyboard_id, `${label}: storyboard missing storyboard_id`);
  }
}

describe('AdvisoryObservation.source — every emission populates provenance (#1746)', () => {
  test('profile-track observations have kind=profile', () => {
    // No tools, no version → triggers both profile observations
    const observations = collectObservations('core', [], { name: 'Bare Agent', tools: ['x'] /* fewer than 3 */ });
    assert.ok(observations.length > 0, 'expected at least one core-track observation');
    for (const o of observations) {
      assertValidSource(o.source, `core-track: ${o.message}`);
      assert.equal(o.source.kind, 'profile', `core-track: expected kind=profile, got ${o.source.kind}`);
    }
  });

  test('product-step observations carry storyboard_id + step_id', () => {
    const result = {
      agent_url: 'https://example.com/mcp',
      scenario: 'product_discovery',
      overall_passed: true,
      summary: '',
      total_duration_ms: 100,
      tested_at: '2026-01-01T00:00:00.000Z',
      steps: [
        {
          step: 'Get products',
          task: 'get_products',
          passed: true,
          duration_ms: 100,
          observation_data: { products_count: 0 },
        },
      ],
    };
    const observations = collectObservations('products', [result], dummyProfile);
    const zeroProducts = observations.find(o => o.source?.code === 'zero-products');
    assert.ok(zeroProducts, 'expected zero-products advisory');
    assertValidSource(zeroProducts.source, 'zero-products');
    assert.equal(zeroProducts.source.storyboard_id, 'product_discovery');
    assert.equal(zeroProducts.source.step_id, 'Get products');
  });

  test('slow-response advisory carries storyboard_id + step_id', () => {
    const result = {
      agent_url: 'https://example.com/mcp',
      scenario: 'slow_test',
      overall_passed: true,
      summary: '',
      total_duration_ms: 12000,
      tested_at: '2026-01-01T00:00:00.000Z',
      steps: [
        {
          step: 'Glacial step',
          task: 'get_products',
          passed: true,
          duration_ms: 12000,
        },
      ],
    };
    const observations = collectObservations('products', [result], dummyProfile);
    const slow = observations.find(o => o.source?.code === 'slow-response');
    assert.ok(slow, 'expected slow-response advisory');
    assert.equal(slow.source.kind, 'storyboard_step');
    assert.equal(slow.source.storyboard_id, 'slow_test');
    assert.equal(slow.source.step_id, 'Glacial step');
  });

  test('every advisory across every track has a structurally valid source', () => {
    // Exercise enough surface to hit a representative cross-section of
    // emission sites. Any new site that ships without a `source` will
    // fail the structural check below.
    const richResults = [
      {
        agent_url: 'https://example.com/mcp',
        scenario: 'media_buy',
        overall_passed: true,
        summary: '',
        total_duration_ms: 100,
        tested_at: '2026-01-01T00:00:00.000Z',
        steps: [
          {
            step: 'Get media buys',
            task: 'get_media_buys',
            passed: true,
            duration_ms: 100,
            observation_data: {
              valid_actions: undefined,
              has_creative_deadline: false,
              history_entries: 2,
              history_valid: false,
              sandbox: undefined,
            },
          },
          {
            step: 'Cancel media buy',
            task: 'update_media_buy',
            passed: true,
            duration_ms: 50,
            observation_data: { status: 'canceled' },
          },
        ],
      },
      {
        agent_url: 'https://example.com/mcp',
        scenario: 'media_buy_lifecycle',
        overall_passed: false,
        summary: '',
        total_duration_ms: 100,
        tested_at: '2026-01-01T00:00:00.000Z',
        steps: [
          { step: 'Pause media buy', task: 'update_media_buy', passed: false, duration_ms: 30, error: 'not supported' },
        ],
      },
    ];

    const observations = collectObservations('media_buy', richResults, dummyProfile);
    assert.ok(observations.length >= 5, `expected several media_buy observations, got ${observations.length}`);
    for (const o of observations) {
      assertValidSource(o.source, `media_buy: ${o.message}`);
    }
  });
});
