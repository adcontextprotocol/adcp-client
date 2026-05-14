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
