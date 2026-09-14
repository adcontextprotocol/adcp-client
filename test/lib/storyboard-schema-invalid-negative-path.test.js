const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { ProtocolClient, SingleAgentClient } = require('../../dist/lib/index.js');
const { runStoryboardStep } = require('../../dist/lib/testing/storyboard/runner.js');

function storyboard(negativePath) {
  return {
    id: 'schema_invalid_negative_path',
    version: '1.0.0',
    title: 'Schema-invalid negative path',
    category: 'test',
    summary: 'Grades seller validation responses for malformed requests.',
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

function mcpResponse(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

function options(error, inspectTaskOptions = () => {}) {
  const client = {
    async getProducts(_params, _inputHandler, taskOptions) {
      inspectTaskOptions(taskOptions);
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
  test('dispatches malformed requests and grades response-derived checks against the seller response', async () => {
    const originalCallTool = ProtocolClient.callTool;
    const agent = {
      id: 'test',
      name: 'Strict request client',
      agent_uri: 'https://stub.example/mcp',
      protocol: 'mcp',
    };
    const client = new SingleAgentClient(agent, {
      adcpVersion: '3.2.0-rc.3',
      validateFeatures: false,
      validation: { requests: 'strict', responses: 'off' },
    });
    client.getCapabilities = async () => ({
      version: 'v3',
      majorVersions: [3],
      supportedVersions: ['3.2.0-rc.3'],
      protocols: ['media_buy'],
      features: {},
      extensions: [],
      _synthetic: false,
    });
    client.ensureEndpointDiscovered = async () => agent;
    const dispatches = [];
    ProtocolClient.callTool = async (_agent, taskName, params) => {
      dispatches.push({ taskName, params });
      return mcpResponse({
        status: 'failed',
        errors: [
          {
            code: 'INVALID_REQUEST',
            message: 'buying_mode is invalid',
            recovery: 'correctable',
            field: 'buying_mode',
          },
        ],
        context: { correlation_id: 'schema-invalid-correlation' },
      });
    };

    try {
      const sb = storyboard('schema_invalid');
      sb.phases[0].steps[0].sample_request.context = {
        correlation_id: 'schema-invalid-correlation',
      };
      sb.phases[0].steps[0].validations.push(
        {
          check: 'field_present',
          path: 'errors[0].recovery',
          description: 'Seller returns a recovery classification',
        },
        {
          check: 'field_present',
          path: 'context',
          description: 'Seller echoes the request context',
        },
        {
          check: 'field_value',
          path: 'context.correlation_id',
          value: 'schema-invalid-correlation',
          description: 'Seller preserves the correlation id',
        }
      );
      const result = await runStoryboardStep('https://stub.example/mcp', sb, 'reject_invalid_request', {
        protocol: 'mcp',
        _client: client,
        _profile: { name: 'Strict request client', tools: ['get_products'], raw_capabilities: {} },
      });

      const malformedDispatch = dispatches.find(call => call.taskName === 'get_products');
      assert.ok(
        malformedDispatch,
        `schema-invalid request must reach the seller: ${JSON.stringify({ dispatches, result })}`
      );
      assert.equal(malformedDispatch.params.buying_mode, 'invalid-mode');
      assert.equal(result.passed, true, JSON.stringify(result.validations));
      assert.equal(result.response.synthetic, undefined);
      assert.equal(result.response.errors[0].message, 'buying_mode is invalid');
      assert.equal(result.validations.length, 4);
      assert.ok(
        result.validations.every(validation => validation.passed),
        JSON.stringify(result.validations)
      );
    } finally {
      ProtocolClient.callTool = originalCallTool;
    }
  });

  test('fails context checks when the seller does not echo schema-invalid request context', async () => {
    const sb = storyboard('schema_invalid');
    sb.phases[0].steps[0].sample_request.context = { correlation_id: 'expected-correlation' };
    sb.phases[0].steps[0].validations.push({
      check: 'field_value',
      path: 'context.correlation_id',
      value: 'expected-correlation',
      description: 'Seller preserves the correlation id',
    });
    const client = {
      async getProducts(_params, _inputHandler, taskOptions) {
        assert.equal(taskOptions.skipRequestValidation, true);
        return {
          success: false,
          data: {
            errors: [{ code: 'INVALID_REQUEST', message: 'invalid request' }],
            context: { correlation_id: 'wrong-correlation' },
          },
        };
      },
    };

    const result = await runStoryboardStep('https://stub.example/mcp', sb, 'reject_invalid_request', {
      protocol: 'mcp',
      _client: client,
      _profile: { name: 'Seller response stub', tools: ['get_products'], raw_capabilities: {} },
    });

    assert.equal(result.passed, false);
    assert.equal(result.response.synthetic, undefined);
    assert.equal(result.validations[0].passed, true);
    assert.equal(result.validations[1].passed, false);
    assert.equal(result.validations[1].actual, 'wrong-correlation');
  });

  test('uses schema_invalid as the backwards-compatible expect_error default', async () => {
    const sb = storyboard(undefined);
    const client = {
      async getProducts(_params, _inputHandler, taskOptions) {
        assert.equal(taskOptions.skipRequestValidation, true);
        return {
          success: false,
          data: { errors: [{ code: 'INVALID_REQUEST', message: 'invalid request' }] },
        };
      },
    };

    const result = await runStoryboardStep('https://stub.example/mcp', sb, 'reject_invalid_request', {
      protocol: 'mcp',
      _client: client,
      _profile: { name: 'Default negative-path stub', tools: ['get_products'], raw_capabilities: {} },
    });

    assert.equal(result.passed, true, JSON.stringify(result.validations));
    assert.equal(result.skipped, undefined);
  });

  test('does not grade seller validations when an injected client rejects locally', async () => {
    const result = await runStoryboardStep(
      'https://stub.example/mcp',
      storyboard('schema_invalid'),
      'reject_invalid_request',
      options('Validation failed for field buying_mode: must be equal to one of the allowed values')
    );

    assert.equal(result.passed, true);
    assert.equal(result.skipped, true);
    assert.equal(result.skip_reason, 'not_applicable');
    assert.match(result.skip.detail, /Seller was not reached/);
    assert.deepEqual(result.response, {
      errors: [
        {
          code: 'INVALID_REQUEST',
          message: 'Validation failed for field buying_mode: must be equal to one of the allowed values',
        },
      ],
      synthetic: true,
    });
    assert.deepEqual(result.validations, []);
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
      options('Schema validation failed: seller rejected the request', taskOptions => {
        assert.equal(taskOptions, undefined);
      })
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
