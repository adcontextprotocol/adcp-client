const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { partitionStoryboardsByRequiredTools } = require('../../dist/lib/testing/compliance/comply');

function storyboard(id, requiredTools) {
  return {
    id,
    version: '1.0.0',
    title: id,
    category: 'test',
    track: 'core',
    summary: '',
    narrative: '',
    agent: { interaction_model: '*', capabilities: [] },
    caller: { role: 'buyer_agent' },
    required_tools: requiredTools,
    phases: [],
  };
}

describe('compliance storyboard required-tool applicability', () => {
  test('keeps only tool-independent storyboards when no tools are discovered', () => {
    const result = partitionStoryboardsByRequiredTools(
      [storyboard('universal', []), storyboard('media_buy', ['get_products'])],
      []
    );

    assert.deepStrictEqual(
      result.runnable.map(item => item.id),
      ['universal']
    );
    assert.deepStrictEqual(
      result.missing.map(item => item.storyboard_id),
      ['media_buy']
    );
  });

  test('uses any-of semantics while keeping unrelated tool families out', () => {
    const siTools = ['si_get_offering', 'si_initiate_session', 'si_send_message', 'si_terminate_session'];
    const result = partitionStoryboardsByRequiredTools(
      [
        storyboard('universal', []),
        storyboard('si_baseline', ['si_initiate_session']),
        storyboard('si_partial_surface', ['si_initiate_session', 'si_optional_tool']),
        storyboard('media_buy', ['get_products']),
        storyboard('creative_transformers', ['list_transformers']),
      ],
      siTools
    );

    assert.deepStrictEqual(
      result.runnable.map(item => item.id),
      ['universal', 'si_baseline', 'si_partial_surface']
    );
    assert.deepStrictEqual(
      result.missing.map(item => item.storyboard_id),
      ['media_buy', 'creative_transformers']
    );
  });

  test('accepts a required-tools family from a union of multiple agents', () => {
    const salesTools = ['get_products'];
    const governanceTools = ['sync_governance'];
    const unionedAgentTools = [...new Set([...salesTools, ...governanceTools])];
    const result = partitionStoryboardsByRequiredTools(
      [
        storyboard('cross_agent_family', ['sync_governance', 'activate_signal']),
        storyboard('unmatched_family', ['build_creative', 'list_transformers']),
      ],
      unionedAgentTools
    );

    assert.deepStrictEqual(
      result.runnable.map(item => item.id),
      ['cross_agent_family']
    );
    assert.deepStrictEqual(result.missing, [
      {
        storyboard_id: 'unmatched_family',
        storyboard_title: 'unmatched_family',
        track: 'core',
        reason: 'missing required_tools: build_creative, list_transformers',
      },
    ]);
  });
});
