const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { ProtocolClient } = require('../../dist/lib/index.js');
const { createTestClient } = require('../../dist/lib/testing/client.js');
const { runStoryboardStep } = require('../../dist/lib/testing/storyboard/runner.js');

function storyboard(negativePath) {
  return {
    id: 'schema_invalid_negative_path',
    version: '1.0.0',
    title: 'Schema-invalid negative path',
    category: 'test',
    summary: 'Grades SDK-local request validation as INVALID_REQUEST.',
    narrative: '',
    agent: { interaction_model: 'sync', capabilities: [] },
    caller: { role: 'buyer_agent' },
    phases: [
      {
        id: 'negative',
        title: 'Negative path',
        steps: [
          {
            id: 'reject_invalid_request',
            title: 'Reject an invalid request',
            task: 'get_products',
            expect_error: true,
            negative_path: negativePath,
            sample_request: { buying_mode: 'invalid-mode' },
            validations: [
              {
                check: 'error_code',
                allowed_values: ['INVALID_REQUEST'],
                description: 'The invalid request is rejected canonically',
              },
            ],
          },
        ],
      },
    ],
  };
}

function options(error) {
  const client = {
    async getProducts() {
      return { success: false, error };
    },
  };
  return {
    protocol: 'mcp',
    _client: client,
    _profile: { name: 'Local validation stub', tools: ['get_products'], raw_capabilities: {} },
  };
}

describe('storyboard schema-invalid negative paths', () => {
  test('grades the real SDK pre-dispatch request validator without contacting the seller', async () => {
    const originalCallTool = ProtocolClient.callTool;
    let dispatches = 0;
    ProtocolClient.callTool = async () => {
      dispatches += 1;
      throw new Error('seller transport must not be called');
    };

    try {
      const result = await runStoryboardStep(
        'https://stub.example/mcp',
        storyboard('schema_invalid'),
        'reject_invalid_request',
        {
          protocol: 'mcp',
          _client: createTestClient('https://stub.example/mcp'),
          _profile: { name: 'Strict request client', tools: ['get_products'], raw_capabilities: {} },
        }
      );

      assert.equal(dispatches, 0, 'request validation must reject before protocol dispatch');
      assert.equal(result.passed, true, JSON.stringify(result.validations));
      assert.equal(result.response.synthetic, true);
      assert.equal(result.response.errors[0].code, 'INVALID_REQUEST');
      assert.match(result.response.errors[0].message, /Request validation failed for get_products/);
    } finally {
      ProtocolClient.callTool = originalCallTool;
    }
  });

  test('normalizes a field-level SDK-local request rejection to synthetic INVALID_REQUEST', async () => {
    const result = await runStoryboardStep(
      'https://stub.example/mcp',
      storyboard('schema_invalid'),
      'reject_invalid_request',
      options('Validation failed for field buying_mode: must be equal to one of the allowed values')
    );

    assert.equal(result.passed, true, JSON.stringify(result.validations));
    assert.deepEqual(result.response, {
      errors: [
        {
          code: 'INVALID_REQUEST',
          message: 'Validation failed for field buying_mode: must be equal to one of the allowed values',
        },
      ],
      synthetic: true,
    });
    assert.equal(result.validations[0].passed, true);
    assert.equal(result.validations[0].actual, undefined);
  });

  test('does not normalize a post-transport response-schema rejection', async () => {
    const result = await runStoryboardStep(
      'https://stub.example/mcp',
      storyboard('schema_invalid'),
      'reject_invalid_request',
      options('Schema validation failed: seller returned an invalid response')
    );

    assert.equal(result.passed, false);
    assert.equal(result.validations[0].passed, false);
    assert.deepEqual(result.response, { error: 'Schema validation failed: seller returned an invalid response' });
  });

  test('does not normalize schema-valid seller rejection paths', async () => {
    const result = await runStoryboardStep(
      'https://stub.example/mcp',
      storyboard('payload_well_formed'),
      'reject_invalid_request',
      options('Schema validation failed: seller rejected the request')
    );

    assert.equal(result.passed, false);
    assert.equal(result.validations[0].passed, false);
    assert.deepEqual(result.response, { error: 'Schema validation failed: seller rejected the request' });
  });

  test('does not relabel transport failures as INVALID_REQUEST', async () => {
    const result = await runStoryboardStep(
      'https://stub.example/mcp',
      storyboard('schema_invalid'),
      'reject_invalid_request',
      options('ECONNRESET while connecting to seller')
    );

    assert.equal(result.passed, false);
    assert.equal(result.validations[0].passed, false);
    assert.deepEqual(result.response, { error: 'ECONNRESET while connecting to seller' });
  });
});
