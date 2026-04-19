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
