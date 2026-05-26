const { test, describe } = require('node:test');
const assert = require('node:assert');

const { unwrapProtocolResponse } = require('../../dist/lib/signing/protocol-response.js');

describe('signing protocol response unwrap', () => {
  test('uses latest A2A artifact DataPart for capability discovery', () => {
    const response = {
      result: {
        kind: 'task',
        id: 'a2a-task-id',
        status: { state: 'completed' },
        artifacts: [
          {
            artifactId: 'stale-capabilities',
            parts: [
              {
                kind: 'data',
                data: {
                  request_signing: { supported: false },
                  identity: { brand_json_url: 'https://seller.example/stale-brand.json' },
                },
              },
            ],
          },
          {
            artifactId: 'final-capabilities',
            parts: [
              {
                kind: 'data',
                data: {
                  request_signing: { supported: false },
                  identity: { brand_json_url: 'https://seller.example/stale-final-part.json' },
                },
              },
              {
                kind: 'data',
                data: {
                  request_signing: { supported: true, required_for: ['create_media_buy'] },
                  identity: { brand_json_url: 'https://seller.example/final-brand.json' },
                },
              },
            ],
          },
        ],
      },
    };

    const payload = unwrapProtocolResponse(response);

    assert.deepStrictEqual(payload.request_signing, {
      supported: true,
      required_for: ['create_media_buy'],
    });
    assert.strictEqual(payload.identity.brand_json_url, 'https://seller.example/final-brand.json');
  });

  test('uses latest DataPart for A2A Message responses', () => {
    const response = {
      result: {
        kind: 'message',
        parts: [
          {
            kind: 'data',
            data: { request_signing: { supported: false } },
          },
          {
            kind: 'data',
            data: { request_signing: { supported: true } },
          },
        ],
      },
    };

    const payload = unwrapProtocolResponse(response);

    assert.deepStrictEqual(payload, { request_signing: { supported: true } });
  });
});
