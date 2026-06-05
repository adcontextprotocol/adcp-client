const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner');

const failedAdcpPayload = {
  products: [],
  proposals: [],
  errors: [
    {
      code: 'MULTI_FINALIZE_UNSUPPORTED',
      message:
        'Atomic multi-proposal finalize is not supported; sequence individual create_media_buy(proposal_id=...) calls instead.',
      field: 'refine',
      recovery: 'correctable',
    },
  ],
  adcp_version: '3.1',
  status: 'failed',
};

const topLevelAdcpError = {
  code: 'INVALID_REQUEST',
  message: 'Invalid multi-finalize request',
  field: 'refine',
  recovery: 'correctable',
};

function buildStoryboard() {
  return {
    id: 'failed_payload_expect_error',
    version: '1.0.0',
    title: 'Failed payload expect_error',
    category: 'test',
    summary: '',
    narrative: '',
    agent: { interaction_model: '*', capabilities: [] },
    caller: { role: 'buyer_agent' },
    phases: [
      {
        id: 'reject',
        title: 'reject',
        steps: [
          {
            id: 'multi_finalize',
            title: 'multi finalize unsupported',
            task: 'get_products',
            expect_error: true,
            contributes_to: 'multi_finalize_handled',
            sample_request: { buying_mode: 'brief', brief: 'finalize multiple proposals' },
            validations: [
              {
                check: 'error_code',
                allowed_values: ['MULTI_FINALIZE_UNSUPPORTED', 'INVALID_REQUEST'],
                description: 'seller rejects atomic multi-proposal finalize',
              },
            ],
          },
        ],
      },
      {
        id: 'gate',
        title: 'gate',
        steps: [
          {
            id: 'assert_multi_finalize_handled',
            title: 'assert multi finalize branch',
            task: 'assert_contribution',
            validations: [
              {
                check: 'any_of',
                allowed_values: ['multi_finalize_handled'],
                description: 'one multi-finalize handling path was credited',
              },
            ],
          },
        ],
      },
    ],
  };
}

describe('storyboard expect_error failed payload normalization (#2179)', () => {
  test('failed AdCP payloads without TaskResult.success pass expect_error and credit contributions', async () => {
    const client = {
      getAgentInfo: async () => ({ name: 'stub', tools: [{ name: 'get_products' }] }),
      getProducts: async () => ({ data: failedAdcpPayload }),
    };

    const result = await runStoryboard('https://stub.example/mcp', buildStoryboard(), {
      protocol: 'mcp',
      _client: client,
      _profile: { name: 'stub', tools: [{ name: 'get_products' }] },
    });

    const rejectStep = result.phases[0].steps[0];
    const gateStep = result.phases[1].steps[0];

    assert.equal(rejectStep.passed, true);
    assert.equal(rejectStep.validations[0].passed, true);
    assert.equal(gateStep.passed, true);
    assert.equal(gateStep.validations[0].passed, true);
    assert.equal(result.overall_passed, true);
  });

  test('top-level adcp_error without data supports expect_error error_code validation', async () => {
    const client = {
      getAgentInfo: async () => ({ name: 'stub', tools: [{ name: 'get_products' }] }),
      getProducts: async () => ({ adcp_error: topLevelAdcpError }),
    };

    const result = await runStoryboard('https://stub.example/mcp', buildStoryboard(), {
      protocol: 'mcp',
      _client: client,
      _profile: { name: 'stub', tools: [{ name: 'get_products' }] },
    });

    const rejectStep = result.phases[0].steps[0];
    const gateStep = result.phases[1].steps[0];

    assert.equal(rejectStep.passed, true);
    assert.equal(rejectStep.validations[0].passed, true);
    assert.deepEqual(rejectStep.response_record.payload, { adcp_error: topLevelAdcpError });
    assert.equal(gateStep.passed, true);
    assert.equal(result.overall_passed, true);
  });
});
