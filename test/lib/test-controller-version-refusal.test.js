const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detectController } = require('../../dist/lib/testing/test-controller');
const { ProtocolFeatureUnsupportedError } = require('../../dist/lib/errors');

const profile = { tools: ['comply_test_controller'] };

test('controller detection propagates an unsupported AdCP pin with its version diagnostic', async () => {
  const refusal = new ProtocolFeatureUnsupportedError(['adcp_version'], [], 'https://seller.example/mcp', {
    message: 'The seller has not advertised the exact AdCP 3.2-rc.7 preview. No request was sent.',
    details: {
      feature: 'adcp_version',
      required_version: '3.2-rc.7',
      capability_path: 'adcp.supported_versions',
    },
  });
  const client = {
    executeTask: async () => {
      throw refusal;
    },
  };
  await assert.rejects(detectController(client, profile), error => error === refusal);
});

test('ordinary controller tool and transport failures still report unavailability', async () => {
  for (const failure of [
    new Error('connection reset'),
    new ProtocolFeatureUnsupportedError(['comply_test_controller'], [], undefined, {
      details: { feature: 'comply_test_controller' },
    }),
  ]) {
    const client = {
      executeTask: async () => {
        throw failure;
      },
    };
    assert.deepEqual(await detectController(client, profile), { detected: false });
  }
});
