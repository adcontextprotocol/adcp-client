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
  test('keeps media-buy and unrelated specialism storyboards out of an SI-only run', () => {
    const siTools = ['si_get_offering', 'si_initiate_session', 'si_send_message', 'si_terminate_session'];
    const result = partitionStoryboardsByRequiredTools(
      [
        storyboard('si_baseline', ['si_initiate_session']),
        storyboard('media_buy', ['get_products']),
        storyboard('creative_transformers', ['list_transformers']),
      ],
      siTools
    );

    assert.deepStrictEqual(
      result.runnable.map(item => item.id),
      ['si_baseline']
    );
    assert.deepStrictEqual(
      result.missing.map(item => item.storyboard_id),
      ['media_buy', 'creative_transformers']
    );
  });
});
