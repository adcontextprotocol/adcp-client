/**
 * Tests that storyboard results preserve observation_data for the
 * collectObservations() pipeline in comply().
 *
 * collectObservations() reads step.observation_data from TestResult objects
 * produced by mapStoryboardResultsToTrackResult(). This test verifies the
 * mapping preserves response data so observations can fire.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { mapStoryboardResultsToTrackResult } = require('../../dist/lib/testing/compliance/storyboard-tracks.js');

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

function storyboardResult(overrides = {}) {
  return {
    storyboard_id: 'test-storyboard',
    storyboard_title: 'Test Storyboard',
    agent_url: 'https://example.com/mcp',
    overall_passed: true,
    phases: [],
    context: {},
    total_duration_ms: 100,
    passed_count: 1,
    failed_count: 0,
    skipped_count: 0,
    tested_at: '2026-01-01T00:00:00.000Z',

    ...overrides,
  };
}

const dummyProfile = { name: 'Test Agent', tools: ['get_products', 'create_media_buy'] };

describe('storyboard observation_data preservation', () => {
  test('response data becomes observation_data on mapped TestStepResult', () => {
    const responseData = { products_count: 3, channels: ['display', 'video'] };
    const result = storyboardResult({
      phases: [
        {
          phase_id: 'discovery',
          phase_title: 'Discovery',
          passed: true,
          steps: [
            stepResult({
              task: 'get_products',
              response: responseData,
            }),
          ],
          duration_ms: 100,
        },
      ],
    });

    const trackResult = mapStoryboardResultsToTrackResult('products', [result], dummyProfile);
    const steps = trackResult.scenarios[0].steps;
    assert.ok(steps.length > 0, 'should have steps');
    assert.deepEqual(steps[0].observation_data, responseData);
  });

  test('undefined response maps to undefined observation_data', () => {
    const result = storyboardResult({
      phases: [
        {
          phase_id: 'discovery',
          phase_title: 'Discovery',
          passed: true,
          steps: [stepResult({ response: undefined })],
          duration_ms: 100,
        },
      ],
    });

    const trackResult = mapStoryboardResultsToTrackResult('products', [result], dummyProfile);
    assert.equal(trackResult.scenarios[0].steps[0].observation_data, undefined);
  });

  test('media_buy response data with valid_actions is preserved', () => {
    const responseData = {
      valid_actions: ['pause', 'cancel'],
      history_entries: 2,
      history_valid: true,
      has_creative_deadline: true,
      sandbox: true,
    };
    const result = storyboardResult({
      phases: [
        {
          phase_id: 'lifecycle',
          phase_title: 'Lifecycle',
          passed: true,
          steps: [
            stepResult({
              task: 'get_media_buys',
              response: responseData,
            }),
          ],
          duration_ms: 200,
        },
      ],
    });

    const trackResult = mapStoryboardResultsToTrackResult('media_buy', [result], dummyProfile);
    const step = trackResult.scenarios[0].steps[0];
    assert.deepEqual(step.observation_data, responseData);
    assert.equal(step.task, 'get_media_buys');
  });

  test('create_media_buy response data is preserved for lifecycle observations', () => {
    const responseData = {
      confirmed_at: '2026-01-01T12:00:00Z',
      revision: 1,
      media_buy_id: 'mb-123',
    };
    const result = storyboardResult({
      phases: [
        {
          phase_id: 'purchase',
          phase_title: 'Purchase',
          passed: true,
          steps: [
            stepResult({
              task: 'create_media_buy',
              response: responseData,
            }),
          ],
          duration_ms: 150,
        },
      ],
    });

    const trackResult = mapStoryboardResultsToTrackResult('media_buy', [result], dummyProfile);
    const step = trackResult.scenarios[0].steps[0];
    assert.deepEqual(step.observation_data, responseData);
  });

  test('scenario name includes storyboard_id and phase_id', () => {
    const result = storyboardResult({
      storyboard_id: 'media_buy_seller',
      phases: [
        {
          phase_id: 'account_setup',
          phase_title: 'Account Setup',
          passed: true,
          steps: [stepResult()],
          duration_ms: 50,
        },
      ],
    });

    const trackResult = mapStoryboardResultsToTrackResult('media_buy', [result], dummyProfile);
    assert.equal(trackResult.scenarios[0].scenario, 'media_buy_seller/account_setup');
  });

  test('skipped steps set warnings and observation_data is undefined', () => {
    const result = storyboardResult({
      passed_count: 0,
      failed_count: 0,
      skipped_count: 1,
      phases: [
        {
          phase_id: 'flow',
          phase_title: 'Flow',
          passed: true,
          steps: [stepResult({ skipped: true, duration_ms: 0, response: undefined })],
          duration_ms: 0,
        },
      ],
    });

    const trackResult = mapStoryboardResultsToTrackResult('products', [result], dummyProfile);
    const step = trackResult.scenarios[0].steps[0];
    assert.equal(step.observation_data, undefined);
    assert.ok(step.warnings?.length > 0, 'skipped steps should have warnings');
  });

  test('validation details are concatenated into step details', () => {
    const result = storyboardResult({
      phases: [
        {
          phase_id: 'validation',
          phase_title: 'Validation',
          passed: true,
          steps: [
            stepResult({
              validations: [
                { description: 'Has products', passed: true },
                { description: 'Valid schema', passed: false, error: 'missing field' },
              ],
            }),
          ],
          duration_ms: 100,
        },
      ],
    });

    const trackResult = mapStoryboardResultsToTrackResult('products', [result], dummyProfile);
    const details = trackResult.scenarios[0].steps[0].details;
    assert.ok(details.includes('✓ Has products'));
    assert.ok(details.includes('✗ Valid schema: missing field'));
  });

  test('multiple storyboards for same track aggregate into scenarios', () => {
    const result1 = storyboardResult({
      storyboard_id: 'media_buy_seller',
      passed_count: 1,
      failed_count: 0,
      skipped_count: 0,
      total_duration_ms: 100,
      phases: [
        {
          phase_id: 'account_setup',
          phase_title: 'Account Setup',
          passed: true,
          steps: [stepResult({ task: 'sync_accounts' })],
          duration_ms: 100,
        },
      ],
    });
    const result2 = storyboardResult({
      storyboard_id: 'media_buy_state_machine',
      passed_count: 1,
      failed_count: 0,
      skipped_count: 0,
      total_duration_ms: 200,
      phases: [
        {
          phase_id: 'state_transitions',
          phase_title: 'State Transitions',
          passed: true,
          steps: [stepResult({ task: 'update_media_buy' })],
          duration_ms: 200,
        },
      ],
    });

    const trackResult = mapStoryboardResultsToTrackResult('media_buy', [result1, result2], dummyProfile);
    assert.equal(trackResult.scenarios.length, 2);
    assert.equal(trackResult.scenarios[0].scenario, 'media_buy_seller/account_setup');
    assert.equal(trackResult.scenarios[1].scenario, 'media_buy_state_machine/state_transitions');
    assert.equal(trackResult.duration_ms, 300);
    assert.equal(trackResult.status, 'pass');
  });
});
