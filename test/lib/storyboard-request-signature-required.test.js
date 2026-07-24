const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner');

function buildClient(errorCode = 'request_signature_required') {
  return {
    executeTask: async task => {
      assert.equal(task, 'create_media_buy');
      return {
        adcp_error: {
          code: errorCode,
          message: errorCode === 'request_signature_required' ? 'Request signature required' : 'Invalid request',
        },
      };
    },
  };
}

function buildProfile(requiredFor = ['create_media_buy']) {
  return {
    name: 'stub',
    tools: [{ name: 'create_media_buy' }],
    raw_capabilities: {
      request_signing: {
        supported: true,
        required_for: requiredFor,
      },
    },
  };
}

function buildStoryboard(requires) {
  return {
    id: 'unsigned_functional_media_buy',
    version: '1.0.0',
    title: 'Unsigned functional media buy',
    category: 'test',
    summary: '',
    narrative: '',
    ...(requires && { requires }),
    agent: { interaction_model: '*', capabilities: [] },
    caller: { role: 'buyer_agent' },
    phases: [
      {
        id: 'create',
        title: 'Create media buy',
        steps: [
          {
            id: 'create_buy',
            title: 'Create media buy',
            task: 'create_media_buy',
            stateful: true,
            sample_request: {
              account: { brand: { domain: 'example.com' }, operator: 'agency.example' },
              brand: { domain: 'example.com' },
              start_time: '2026-08-01T00:00:00Z',
              end_time: '2026-08-08T00:00:00Z',
              packages: [
                {
                  buyer_ref: 'pkg-1',
                  product_id: 'prod-1',
                  pricing_option_id: 'cpm-1',
                  budget: 1000,
                },
              ],
            },
            validations: [
              {
                check: 'field_present',
                path: 'media_buy_id',
                description: 'A successful response includes a media buy id',
              },
            ],
          },
        ],
      },
    ],
  };
}

async function runCase({ errorCode, requiredFor, requires } = {}) {
  const profile = buildProfile(requiredFor);
  const result = await runStoryboard('https://stub.example/mcp', buildStoryboard(requires), {
    protocol: 'mcp',
    allow_http: true,
    agentTools: ['create_media_buy'],
    _client: buildClient(errorCode),
    _profile: profile,
  });
  return result.phases[0].steps[0];
}

describe('unsigned functional request-signing guard (adcp-client#2373)', () => {
  test('grades a capability-declared signature-required rejection not_applicable', async () => {
    const result = await runCase();

    assert.equal(result.skipped, true);
    assert.equal(result.skip_reason, 'not_applicable');
    assert.equal(result.skip.reason, 'not_applicable');
    assert.match(result.skip.detail, /request_signing\.required_for/);
    assert.match(result.skip.detail, /create_media_buy/);
    assert.deepEqual(result.validations, [], 'authored validations must not run for the expected rejection');
  });

  test('does not skip a different error code', async () => {
    const result = await runCase({ errorCode: 'INVALID_REQUEST' });

    assert.notEqual(result.skipped, true);
    assert.equal(result.passed, false);
  });

  test('does not skip when the task is absent from request_signing.required_for', async () => {
    const result = await runCase({ requiredFor: ['update_media_buy'] });

    assert.notEqual(result.skipped, true);
    assert.equal(result.passed, false);
  });

  test('does not skip a storyboard that requires a request signer', async () => {
    const result = await runCase({ requires: ['request_signer'] });

    assert.notEqual(result.skipped, true);
    assert.equal(result.passed, false);
  });
});
