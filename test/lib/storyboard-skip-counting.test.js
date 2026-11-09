/**
 * Tests that storyboard runner correctly counts steps skipped due to
 * requires_tool as skipped (not passed).
 *
 * Regression test for #440: tool discovery mismatch investigation.
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert');

const { mapStoryboardResultsToTrackResult } = require('../../dist/lib/testing/compliance/storyboard-tracks.js');

// Helper to build a minimal StoryboardStepResult
function stepResult(overrides = {}) {
  return {
    step_id: 'step-1',
    phase_id: 'phase-1',
    title: 'Test step',
    task: 'get_products',
    passed: true,
    duration_ms: 100,
    validations: [],
    context: {},
    ...overrides,
  };
}

// Helper to build a minimal StoryboardResult
function storyboardResult(overrides = {}) {
  return {
    storyboard_id: 'test-storyboard',
    storyboard_title: 'Test Storyboard',
    agent_url: 'https://example.com/mcp',
    overall_passed: true,
    phases: [],
    context: {},
    total_duration_ms: 100,
    passed_count: 0,
    failed_count: 0,
    skipped_count: 0,
    tested_at: '2026-01-01T00:00:00.000Z',

    ...overrides,
  };
}

const dummyProfile = { name: 'Test Agent', tools: [] };

describe('storyboard skip counting', () => {
  describe('mapStoryboardResultsToTrackResult', () => {
    test('track with all-skipped storyboard reports skip status', () => {
      const result = storyboardResult({
        passed_count: 0,
        failed_count: 0,
        skipped_count: 3,
        phases: [
          {
            phase_id: 'setup',
            phase_title: 'Setup',
            passed: true,
            steps: [
              stepResult({ skipped: true, duration_ms: 0 }),
              stepResult({ step_id: 'step-2', skipped: true, duration_ms: 0 }),
              stepResult({ step_id: 'step-3', skipped: true, duration_ms: 0 }),
            ],
            duration_ms: 0,
          },
        ],
      });

      const trackResult = mapStoryboardResultsToTrackResult('core', [result], dummyProfile);
      assert.strictEqual(trackResult.status, 'skip', 'track with all-skipped steps should have skip status');
    });

    test('track with mixed passed and skipped reports pass status', () => {
      const result = storyboardResult({
        passed_count: 2,
        failed_count: 0,
        skipped_count: 1,
        phases: [
          {
            phase_id: 'flow',
            phase_title: 'Flow',
            passed: true,
            steps: [
              stepResult({ duration_ms: 50 }),
              stepResult({ step_id: 'step-2', duration_ms: 50 }),
              stepResult({ step_id: 'step-3', skipped: true, duration_ms: 0 }),
            ],
            duration_ms: 100,
          },
        ],
      });

      const trackResult = mapStoryboardResultsToTrackResult('products', [result], dummyProfile);
      assert.strictEqual(trackResult.status, 'pass', 'track with some passed steps should have pass status');
    });

    test('fixture_unavailable is neutral in a mixed track (#3596)', () => {
      const result = storyboardResult({
        passed_count: 1,
        failed_count: 0,
        skipped_count: 1,
        phases: [
          {
            phase_id: 'flow',
            phase_title: 'Flow',
            passed: true,
            steps: [
              stepResult({ duration_ms: 50 }),
              stepResult({
                step_id: 'creative',
                skipped: true,
                skip_reason: 'fixture_unavailable',
                skip: {
                  reason: 'fixture_unavailable',
                  detail:
                    'creative_asset_fixture_unavailable: slot "video", asset type "video", constraint: fixture missing',
                },
                duration_ms: 0,
              }),
            ],
            duration_ms: 50,
          },
        ],
      });

      const trackResult = mapStoryboardResultsToTrackResult('creative', [result], dummyProfile);
      assert.strictEqual(trackResult.status, 'pass');
    });

    test('fixture_unavailable in a later multi-pass result is neutral (#3596)', () => {
      const passingPhase = {
        phase_id: 'flow',
        phase_title: 'Flow',
        passed: true,
        steps: [stepResult({ duration_ms: 50 })],
        duration_ms: 50,
      };
      const fixturePhase = {
        phase_id: 'flow',
        phase_title: 'Flow',
        passed: true,
        steps: [
          stepResult({
            step_id: 'creative',
            skipped: true,
            skip_reason: 'fixture_unavailable',
            skip: {
              reason: 'fixture_unavailable',
              detail:
                'creative_asset_fixture_unavailable: slot "video", asset type "video", constraint: fixture missing',
            },
            duration_ms: 0,
          }),
        ],
        duration_ms: 0,
      };
      const result = storyboardResult({
        passed_count: 1,
        failed_count: 0,
        skipped_count: 1,
        phases: [passingPhase],
        passes: [
          {
            pass_index: 1,
            dispatch_offset: 0,
            overall_passed: true,
            phases: [passingPhase],
            passed_count: 1,
            failed_count: 0,
            skipped_count: 0,
            duration_ms: 50,
          },
          {
            pass_index: 2,
            dispatch_offset: 1,
            overall_passed: true,
            phases: [fixturePhase],
            passed_count: 0,
            failed_count: 0,
            skipped_count: 1,
            duration_ms: 0,
          },
        ],
      });

      const trackResult = mapStoryboardResultsToTrackResult('creative', [result], dummyProfile);
      assert.strictEqual(trackResult.status, 'pass');
    });

    describe('runner-owned fixture gaps are neutral (#3596)', () => {
      const NEUTRAL_SKIPS = [
        {
          name: 'fixture_unavailable',
          skip_reason: 'fixture_unavailable',
          skip: {
            reason: 'fixture_unavailable',
            detail: 'creative_asset_fixture_unavailable: slot "alt_text", no exact runner mapping',
          },
        },
        {
          name: 'fixture_unsatisfied',
          skip_reason: 'fixture_unsatisfied',
          skip: { reason: 'fixture_unsatisfied', detail: 'fixture resolution ladder exhausted' },
        },
        {
          name: 'fixture_seed_unsupported',
          skip_reason: 'fixture_seed_unsupported',
          skip: { reason: 'not_applicable', detail: 'seller does not implement the seed_* scenario' },
        },
      ];

      const phaseOf = steps => [{ phase_id: 'flow', phase_title: 'Flow', passed: true, steps, duration_ms: 50 }];

      for (const neutral of NEUTRAL_SKIPS) {
        test(`${neutral.name} next to a passed step grades pass`, () => {
          const result = storyboardResult({
            passed_count: 1,
            skipped_count: 1,
            phases: phaseOf([
              stepResult(),
              stepResult({
                step_id: 'gap',
                skipped: true,
                skip_reason: neutral.skip_reason,
                skip: neutral.skip,
                duration_ms: 0,
              }),
            ]),
          });
          const trackResult = mapStoryboardResultsToTrackResult('media_buy', [result], dummyProfile);
          assert.strictEqual(trackResult.status, 'pass');
        });
      }

      test('fixture_unavailable beside a passing sibling storyboard grades pass', () => {
        const gap = storyboardResult({
          storyboard_id: 'gap',
          passed_count: 1,
          skipped_count: 1,
          phases: phaseOf([
            stepResult(),
            stepResult({
              step_id: 'gap',
              skipped: true,
              skip_reason: 'fixture_unavailable',
              skip: { reason: 'fixture_unavailable', detail: 'creative_asset_fixture_unavailable: x' },
              duration_ms: 0,
            }),
          ]),
        });
        const plain = storyboardResult({ storyboard_id: 'plain', passed_count: 1, phases: phaseOf([stepResult()]) });
        assert.strictEqual(mapStoryboardResultsToTrackResult('media_buy', [gap, plain], dummyProfile).status, 'pass');
      });

      test('an all-skipped track whose only skips are fixture_unavailable grades skip', () => {
        const result = storyboardResult({
          skipped_count: 1,
          phases: phaseOf([
            stepResult({
              skipped: true,
              skip_reason: 'fixture_unavailable',
              skip: { reason: 'fixture_unavailable', detail: 'creative_asset_fixture_unavailable: x' },
              duration_ms: 0,
            }),
          ]),
        });
        assert.strictEqual(mapStoryboardResultsToTrackResult('media_buy', [result], dummyProfile).status, 'skip');
      });

      test('fixture_unavailable next to a genuine failed step still grades partial', () => {
        const result = storyboardResult({
          overall_passed: false,
          passed_count: 1,
          failed_count: 1,
          skipped_count: 1,
          phases: phaseOf([
            stepResult(),
            stepResult({ step_id: 'bad', passed: false, error: 'boom' }),
            stepResult({
              step_id: 'gap',
              skipped: true,
              skip_reason: 'fixture_unavailable',
              skip: { reason: 'fixture_unavailable', detail: 'creative_asset_fixture_unavailable: x' },
              duration_ms: 0,
            }),
          ]),
        });
        assert.strictEqual(mapStoryboardResultsToTrackResult('media_buy', [result], dummyProfile).status, 'partial');
      });

      test('fixture_unavailable next to a failed step with nothing passed grades fail', () => {
        const result = storyboardResult({
          overall_passed: false,
          failed_count: 1,
          skipped_count: 1,
          phases: phaseOf([
            stepResult({ passed: false, error: 'boom' }),
            stepResult({
              step_id: 'gap',
              skipped: true,
              skip_reason: 'fixture_unavailable',
              skip: { reason: 'fixture_unavailable', detail: 'creative_asset_fixture_unavailable: x' },
              duration_ms: 0,
            }),
          ]),
        });
        assert.strictEqual(mapStoryboardResultsToTrackResult('media_buy', [result], dummyProfile).status, 'fail');
      });

      for (const reason of ['prerequisite_failed', 'missing_tool']) {
        test(`agent-caused ${reason} gap in a non-passing storyboard stays partial`, () => {
          const result = storyboardResult({
            overall_passed: false,
            passed_count: 1,
            skipped_count: 1,
            phases: phaseOf([
              stepResult(),
              stepResult({
                step_id: 'required',
                skipped: true,
                skip_reason: reason,
                skip: { reason, detail: 'required step could not run' },
                duration_ms: 0,
              }),
            ]),
          });
          assert.strictEqual(mapStoryboardResultsToTrackResult('media_buy', [result], dummyProfile).status, 'partial');
        });
      }

      test('unverified signing coverage stays partial next to a passing sibling storyboard', () => {
        const probe = storyboardResult({
          storyboard_id: 'signing',
          skipped_count: 1,
          phases: phaseOf([
            stepResult({
              task: 'request_signing_probe',
              skipped: true,
              skip_reason: 'signing_transport_unavailable',
              skip: { reason: 'not_applicable', detail: 'signing_transport_unavailable' },
              duration_ms: 0,
            }),
          ]),
        });
        const plain = storyboardResult({ storyboard_id: 'plain', passed_count: 1, phases: phaseOf([stepResult()]) });
        assert.strictEqual(
          mapStoryboardResultsToTrackResult('security_transport', [probe, plain], dummyProfile).status,
          'partial'
        );
        assert.strictEqual(
          mapStoryboardResultsToTrackResult('security_transport', [probe], dummyProfile).status,
          'partial'
        );
      });
    });

    test('track with no storyboards reports skip status', () => {
      const trackResult = mapStoryboardResultsToTrackResult('signals', [], dummyProfile);
      assert.strictEqual(trackResult.status, 'skip');
    });

    test('track with failed steps reports fail or partial status', () => {
      const result = storyboardResult({
        passed_count: 0,
        failed_count: 2,
        skipped_count: 0,
        phases: [
          {
            phase_id: 'flow',
            phase_title: 'Flow',
            passed: false,
            steps: [
              stepResult({ passed: false, error: 'Connection refused' }),
              stepResult({ step_id: 'step-2', passed: false, error: 'Timeout' }),
            ],
            duration_ms: 100,
          },
        ],
      });

      const trackResult = mapStoryboardResultsToTrackResult('core', [result], dummyProfile);
      assert.strictEqual(trackResult.status, 'fail', 'track with all-failed steps should have fail status');
    });

    test('missing_test_controller skip_reason surfaces controller detail', () => {
      const result = storyboardResult({
        passed_count: 2,
        failed_count: 0,
        skipped_count: 1,
        phases: [
          {
            phase_id: 'flow',
            phase_title: 'Flow',
            passed: true,
            steps: [
              stepResult({ duration_ms: 50 }),
              stepResult({ step_id: 'step-2', duration_ms: 50 }),
              stepResult({
                step_id: 'step-3',
                skipped: true,
                skip_reason: 'missing_test_controller',
                skip: {
                  reason: 'missing_test_controller',
                  detail: 'Deterministic-testing phase requires comply_test_controller; agent tools: [get_products].',
                },
                duration_ms: 0,
              }),
            ],
            duration_ms: 100,
          },
        ],
      });

      const trackResult = mapStoryboardResultsToTrackResult('core', [result], dummyProfile);
      const skippedStep = trackResult.scenarios[0].steps[2];
      assert.ok(skippedStep.warnings, 'skipped step should have warnings');
      assert.ok(
        skippedStep.warnings[0].includes('comply_test_controller'),
        'warning should mention test controller harness'
      );
    });

    test('track with mixed pass and fail reports partial status', () => {
      const result = storyboardResult({
        passed_count: 1,
        failed_count: 1,
        skipped_count: 0,
        phases: [
          {
            phase_id: 'flow',
            phase_title: 'Flow',
            passed: false,
            steps: [stepResult({ duration_ms: 50 }), stepResult({ step_id: 'step-2', passed: false, error: 'Failed' })],
            duration_ms: 100,
          },
        ],
      });

      const trackResult = mapStoryboardResultsToTrackResult('core', [result], dummyProfile);
      assert.strictEqual(trackResult.status, 'partial');
    });
  });
});
