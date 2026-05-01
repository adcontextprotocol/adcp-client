/**
 * TrackStatus 'silent' rollup (issue #1139, paired with adcontextprotocol/adcp#2834).
 *
 * Track-level rollup demotes a passing track to `silent` when every
 * observation-bearing assertion record reports `observation_count: 0`
 * — the agent is wired but its lifecycle protections were not
 * exercised this run. Rollup precedence is enforced as:
 *
 *   skip  ← no executable steps OR all steps skipped
 *   fail  ← any step failed AND no steps passed
 *   partial ← any step failed AND some steps passed
 *   silent ← no failures AND every observation-bearing record had 0 observations
 *   pass  ← otherwise (real protection observed, or no observation-based assertions ran)
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { mapStoryboardResultsToTrackResult } = require('../../dist/lib/testing/compliance/storyboard-tracks.js');

/** Minimal StoryboardResult factory — only the fields the rollup reads. */
function sbResult({ passed = 1, failed = 0, skipped = 0, assertions = [] } = {}) {
  return {
    storyboard_id: 'fixture',
    storyboard_title: 'fixture',
    agent_url: 'https://example.test',
    overall_passed: failed === 0,
    phases: [],
    passed_count: passed,
    failed_count: failed,
    skipped_count: skipped,
    tested_at: new Date().toISOString(),
    total_duration_ms: 0,
    assertions,
  };
}

const PROFILE = { name: 'fixture', tools: [] };

describe('TrackStatus silent rollup', () => {
  it("emits 'silent' when every observation-bearing assertion record reports zero observations", () => {
    const result = mapStoryboardResultsToTrackResult(
      'governance',
      [
        sbResult({
          passed: 2,
          failed: 0,
          assertions: [
            {
              assertion_id: 'status.monotonic',
              passed: true,
              description: 'Resource statuses transition only along spec lifecycle edges',
              scope: 'storyboard',
              observation_count: 0,
            },
          ],
        }),
      ],
      PROFILE
    );
    assert.strictEqual(result.status, 'silent');
  });

  it("emits 'pass' when at least one observation-bearing record observed > 0", () => {
    const result = mapStoryboardResultsToTrackResult(
      'media_buy',
      [
        sbResult({
          passed: 3,
          assertions: [
            {
              assertion_id: 'status.monotonic',
              passed: true,
              description: 'Resource statuses transition only along spec lifecycle edges',
              scope: 'storyboard',
              observation_count: 4,
            },
          ],
        }),
      ],
      PROFILE
    );
    assert.strictEqual(result.status, 'pass');
  });

  it("emits 'pass' when no observation-based assertions ran (no records carry observation_count)", () => {
    const result = mapStoryboardResultsToTrackResult(
      'core',
      [
        sbResult({
          passed: 2,
          assertions: [
            {
              assertion_id: 'context.no_secret_echo',
              passed: true,
              description: 'fixture',
              scope: 'storyboard',
              // no observation_count — not observation-based
            },
          ],
        }),
      ],
      PROFILE
    );
    assert.strictEqual(result.status, 'pass');
  });

  it("a step failure suppresses 'silent' and rolls up to 'fail' / 'partial'", () => {
    const failResult = mapStoryboardResultsToTrackResult(
      'media_buy',
      [
        sbResult({
          passed: 0,
          failed: 1,
          assertions: [
            {
              assertion_id: 'status.monotonic',
              passed: true,
              description: '',
              scope: 'storyboard',
              observation_count: 0,
            },
          ],
        }),
      ],
      PROFILE
    );
    assert.strictEqual(failResult.status, 'fail');

    const partialResult = mapStoryboardResultsToTrackResult(
      'media_buy',
      [
        sbResult({
          passed: 1,
          failed: 1,
          assertions: [
            {
              assertion_id: 'status.monotonic',
              passed: true,
              description: '',
              scope: 'storyboard',
              observation_count: 0,
            },
          ],
        }),
      ],
      PROFILE
    );
    assert.strictEqual(partialResult.status, 'partial');
  });

  it("'skip' precedence is preserved — all-skipped tracks stay 'skip', not 'silent'", () => {
    const result = mapStoryboardResultsToTrackResult(
      'governance',
      [
        sbResult({
          passed: 0,
          failed: 0,
          skipped: 3,
          assertions: [
            {
              assertion_id: 'status.monotonic',
              passed: true,
              description: '',
              scope: 'storyboard',
              observation_count: 0,
            },
          ],
        }),
      ],
      PROFILE
    );
    assert.strictEqual(result.status, 'skip');
  });

  it("emits 'silent' when one storyboard observed and one did not — only when EVERY record is zero (here both are zero)", () => {
    const result = mapStoryboardResultsToTrackResult(
      'governance',
      [
        sbResult({
          passed: 1,
          assertions: [
            {
              assertion_id: 'status.monotonic',
              passed: true,
              description: '',
              scope: 'storyboard',
              observation_count: 0,
            },
          ],
        }),
        sbResult({
          passed: 1,
          assertions: [
            {
              assertion_id: 'status.monotonic',
              passed: true,
              description: '',
              scope: 'storyboard',
              observation_count: 0,
            },
          ],
        }),
      ],
      PROFILE
    );
    assert.strictEqual(result.status, 'silent');
  });

  it("emits 'pass' when one storyboard observed transitions and another did not — any non-zero lifts the track", () => {
    const result = mapStoryboardResultsToTrackResult(
      'governance',
      [
        sbResult({
          passed: 1,
          assertions: [
            {
              assertion_id: 'status.monotonic',
              passed: true,
              description: '',
              scope: 'storyboard',
              observation_count: 0,
            },
          ],
        }),
        sbResult({
          passed: 1,
          assertions: [
            {
              assertion_id: 'status.monotonic',
              passed: true,
              description: '',
              scope: 'storyboard',
              observation_count: 2,
            },
          ],
        }),
      ],
      PROFILE
    );
    assert.strictEqual(result.status, 'pass');
  });
});

describe('computeOverallStatus precedence with silent tracks', () => {
  const { computeOverallStatus } = require('../../dist/lib/testing/compliance/comply.js');

  it("returns 'partial' (not 'failing') when silent and failed tracks coexist", () => {
    const status = computeOverallStatus({
      tracks_passed: 0,
      tracks_failed: 1,
      tracks_skipped: 0,
      tracks_partial: 0,
      tracks_silent: 1,
      headline: '',
    });
    assert.strictEqual(status, 'partial');
  });

  it('returns partial when silent tracks accompany passes', () => {
    const status = computeOverallStatus({
      tracks_passed: 2,
      tracks_failed: 0,
      tracks_skipped: 0,
      tracks_partial: 0,
      tracks_silent: 1,
      headline: '',
    });
    assert.strictEqual(status, 'partial');
  });

  it('tolerates pre-6.2 summaries without tracks_silent (defaults to 0)', () => {
    const status = computeOverallStatus({
      tracks_passed: 3,
      tracks_failed: 0,
      tracks_skipped: 0,
      tracks_partial: 0,
      headline: '',
    });
    assert.strictEqual(status, 'passing');
  });
});

describe('status.monotonic onEnd emits run-level observation_count', () => {
  // Side-effect import to register the bundled assertions.
  require('../../dist/lib/testing/storyboard/default-invariants.js');
  const { getAssertion } = require('../../dist/lib/testing/storyboard/assertions.js');

  it('emits observation_count: 0 when the run observed no lifecycle resources', async () => {
    const spec = getAssertion('status.monotonic');
    assert.ok(spec.onEnd, 'status.monotonic must define onEnd to surface the silent signal');

    // Mimic what the runner threads through `assertionContexts.get(spec.id)`
    // when no onStep observation populated history.
    const ctx = { state: {}, storyboardContext: undefined };
    spec.onStart?.(ctx);

    const records = await spec.onEnd(ctx);
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].passed, true);
    assert.strictEqual(records[0].observation_count, 0);
  });

  it('emits observation_count > 0 when history accumulated entries during the run', async () => {
    const spec = getAssertion('status.monotonic');
    const ctx = { state: {}, storyboardContext: undefined };
    spec.onStart?.(ctx);
    // Reach into history directly — equivalent end-of-run state to having
    // observed two distinct resources.
    ctx.state.history.set('media_buy:abc', { stepId: 's1', status: 'active' });
    ctx.state.history.set('creative:xyz', { stepId: 's2', status: 'approved' });

    const records = await spec.onEnd(ctx);
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].passed, true);
    assert.strictEqual(records[0].observation_count, 2);
  });
});
