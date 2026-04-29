/**
 * Regression test: when agent capability discovery fails, the storyboard
 * runner MUST surface a HARD STORYBOARD FAILURE rather than silently
 * emitting `agentTools: []` and letting every step skip with
 * `missing_tool`.
 *
 * The latter mode produces "X/X clean" CI summaries with 100% skipped —
 * an invisible failure when transport / auth / network policy is
 * misconfigured. See the v6 training-agent migration spike: storyboards
 * reported "4/4 clean" with 20 skipped steps when the underlying MCP
 * connection setup quietly fell back to a 405-returning SSE GET.
 *
 * `runStoryboard` calls `buildDiscoveryFailedResult` when
 * `discoverAgentProfile`'s step result has `passed === false`. We test
 * the helper directly to pin its result shape — the runner conditional
 * is a 4-line gate that's verifiable by reading.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { buildDiscoveryFailedResult } = require('../../dist/lib/testing/storyboard/index.js');

const minimalStoryboard = {
  id: 'discovery_failure_test',
  version: '1.0.0',
  title: 'Discovery failure surfaces as hard storyboard failure',
  category: 'test',
  summary: '',
  narrative: '',
  agent: { interaction_model: 'sync', capabilities: [] },
  caller: { role: 'buyer_agent' },
  phases: [],
};

describe('buildDiscoveryFailedResult — hard-failure result shape', () => {
  test('produces overall_passed: false with one failed step (no skip masquerade)', () => {
    const discoveryStep = {
      step: 'Discover agent capabilities',
      task: 'getAgentInfo',
      passed: false,
      duration_ms: 87,
      error: 'SSE error: Non-200 status code (405)',
    };
    const result = buildDiscoveryFailedResult(['http://127.0.0.1:1/mcp'], minimalStoryboard, discoveryStep);

    // Headline: discovery failure is NOT a clean run.
    assert.equal(
      result.overall_passed,
      false,
      'discovery failure must NOT pass — silent "clean" reporting is exactly the bug being fixed'
    );
    assert.equal(result.failed_count, 1, 'exactly one synthetic failed step for the discovery error');
    assert.equal(result.passed_count, 0);
    assert.equal(result.skipped_count, 0, 'no skipped steps masquerading as clean');

    // Phase shape
    assert.equal(result.phases.length, 1);
    const phase = result.phases[0];
    assert.equal(phase.phase_id, 'discovery_failed');
    assert.equal(phase.passed, false);
    assert.equal(phase.steps.length, 1);

    // Step shape
    const step = phase.steps[0];
    assert.equal(step.step_id, 'discovery_failed');
    assert.equal(step.passed, false);
    assert.equal(step.skipped, false, 'step.skipped MUST be false — this is a failure, not a skip');
    assert.ok(step.error, 'step.error MUST carry a discovery diagnostic');
    assert.match(
      step.error,
      /[Dd]iscovery failure/,
      'error message must clearly identify discovery as the problem'
    );
    assert.match(
      step.error,
      /SSE error: Non-200 status code \(405\)/,
      'underlying transport error MUST be preserved verbatim — operator triage needs the cause'
    );

    // Top-level result threading
    assert.equal(result.storyboard_id, 'discovery_failure_test');
    assert.equal(result.agent_url, 'http://127.0.0.1:1/mcp');
    assert.equal(result.total_duration_ms, 87, 'discovery duration carries through');
  });

  test('falls back to a generic message when no error string is supplied', () => {
    const discoveryStep = {
      step: 'Discover agent capabilities',
      task: 'getAgentInfo',
      passed: false,
      duration_ms: 0,
      // no error field
    };
    const result = buildDiscoveryFailedResult(['http://127.0.0.1:1/mcp'], minimalStoryboard, discoveryStep);
    assert.equal(result.overall_passed, false);
    assert.equal(result.failed_count, 1);
    assert.match(result.phases[0].steps[0].error, /Discovery failed \(no agent tools advertised\)/);
  });
});
