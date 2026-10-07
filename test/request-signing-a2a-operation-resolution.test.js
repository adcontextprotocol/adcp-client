/**
 * adcp#7945 "Operation resolution over A2A": the shared resolver, the core
 * verifier, and the buyer signer, graded against the 33 published A2A vectors
 * (vendored under test/fixtures/request-signing-a2a/).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { readFileSync, readdirSync, existsSync } = require('node:fs');
const path = require('node:path');

const {
  RequestSignatureError,
  StaticJwksResolver,
  InMemoryReplayStore,
  InMemoryRevocationStore,
  verifyRequestSignature,
  resolveRequestOperation,
  UNRESOLVABLE_OPERATION,
  isUnresolvableOperation,
} = require('../dist/lib/signing/server.js');
const { extractAdcpOperation } = require('../dist/lib/signing/agent-fetch.js');
const { adcpOperationResolver, mcpToolNameResolver } = require('../dist/lib/server/auth-signature.js');

const FIXTURES = path.join(__dirname, 'fixtures', 'request-signing-a2a');
const KEYS_PATH = path.join(
  __dirname,
  '..',
  'compliance',
  'cache',
  'latest',
  'test-vectors',
  'request-signing',
  'keys.json'
);

const keys = JSON.parse(readFileSync(KEYS_PATH, 'utf8')).keys;
const publicKeys = keys.map(k => {
  const copy = { ...k };
  delete copy._private_d_for_test_only;
  return copy;
});

function loadVectors(kind) {
  const dir = path.join(FIXTURES, kind);
  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => ({ id: `${kind}/${f.replace(/\.json$/, '')}`, ...JSON.parse(readFileSync(path.join(dir, f), 'utf8')) }));
}

const negative = loadVectors('negative');
const positive = loadVectors('positive');

function resolveVector(vector) {
  const { request } = vector;
  return resolveRequestOperation({ rawBody: request.body, method: request.method, url: request.url });
}

async function verifyVector(vector) {
  const { request, verifier_capability: capability } = vector;
  return verifyRequestSignature(
    { method: request.method, url: request.url, headers: request.headers, body: request.body },
    {
      capability,
      jwks: new StaticJwksResolver(publicKeys.filter(k => (vector.jwks_ref ?? []).includes(k.kid))),
      replayStore: new InMemoryReplayStore(),
      revocationStore: new InMemoryRevocationStore({
        issuer: 'http://seller.example.com',
        updated: new Date(vector.reference_now * 1000).toISOString(),
        next_update: new Date((vector.reference_now + 3600) * 1000).toISOString(),
        revoked_kids: [],
        revoked_jtis: [],
      }),
      now: () => vector.reference_now,
      adcpVersion: '3.2.0',
      operation: resolveVector(vector),
    }
  );
}

describe('A2A vector corpus', () => {
  it('is complete (26 negative, 7 positive)', () => {
    assert.strictEqual(negative.length, 26);
    assert.strictEqual(positive.length, 7);
    assert.ok(existsSync(path.join(FIXTURES, 'README.md')));
  });
});

describe('resolveRequestOperation against the A2A vectors', () => {
  for (const vector of [...negative, ...positive]) {
    const expected = vector.expected_outcome;
    it(`${vector.id}: ${vector.name}`, () => {
      const resolved = resolveVector(vector);
      if (expected.error_code === 'request_body_malformed') {
        assert.ok(isUnresolvableOperation(resolved), `expected unresolvable, got ${String(resolved)}`);
      } else if (expected.resolved_operation === null) {
        assert.strictEqual(resolved, undefined);
      } else {
        assert.strictEqual(resolved, expected.resolved_operation);
      }
    });
  }
});

describe('verifyRequestSignature against the A2A vectors', () => {
  for (const vector of negative) {
    const expected = vector.expected_outcome;
    it(`${vector.id}: rejects with ${expected.error_code}`, async () => {
      try {
        await verifyVector(vector);
      } catch (err) {
        assert.ok(err instanceof RequestSignatureError, `unexpected error: ${err}`);
        // negative/023 (batch): a verifier that does not accept batches rejects it
        // as malformed. The vector allows `request_signature_required` only for one that does.
        assert.strictEqual(err.code, expected.error_code);
        assert.strictEqual(err.failedStep, expected.failed_step);
        return;
      }
      assert.fail('expected the verifier to reject');
    });
  }

  for (const vector of positive) {
    const expected = vector.expected_outcome;
    it(`${vector.id}: ${expected.status}`, async () => {
      const result = await verifyVector(vector);
      assert.strictEqual(result.status, expected.status);
      if (expected.status === 'verified') assert.strictEqual(result.keyid, 'test-ed25519-2026');
    });
  }
});

describe('adcpOperationResolver', () => {
  const rpc = (method, params) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const msg = parts => ({ message: { messageId: 'm', role: 'ROLE_USER', parts } });
  const data = (skill, extra = {}) => ({ data: { skill, input: {}, ...extra } });

  it('resolves MCP tools/call to params.name', () => {
    assert.strictEqual(
      adcpOperationResolver({
        rawBody: rpc('tools/call', { name: 'create_media_buy', arguments: {} }),
        method: 'POST',
      }),
      'create_media_buy'
    );
  });

  it('resolves all four A2A send methods to the sole DataPart skill', () => {
    for (const method of ['SendMessage', 'SendStreamingMessage', 'message/send', 'message/stream']) {
      assert.strictEqual(
        adcpOperationResolver({ rawBody: rpc(method, msg([data('create_media_buy')])), method: 'POST' }),
        'create_media_buy',
        method
      );
    }
  });

  it('resolves the A2A HTTP+JSON binding from the path', () => {
    const body = JSON.stringify(msg([data('create_media_buy')]));
    for (const url of ['/a2a/v1/message:send', '/a2a/v1/message:stream?x=1']) {
      assert.strictEqual(adcpOperationResolver({ rawBody: body, method: 'POST', url }), 'create_media_buy', url);
    }
    // Without the binding path the same body has no JSON-RPC method.
    assert.ok(isUnresolvableOperation(adcpOperationResolver({ rawBody: body, method: 'POST', url: '/a2a' })));
  });

  it('resolves other JSON-RPC methods and non-POST requests to no operation', () => {
    for (const method of ['tasks/get', 'tasks/cancel', 'CancelTask', 'GetTask', 'initialize', 'tools/list']) {
      assert.strictEqual(
        adcpOperationResolver({ rawBody: rpc(method, { id: 'x' }), method: 'POST' }),
        undefined,
        method
      );
    }
    assert.strictEqual(adcpOperationResolver({ method: 'GET' }), undefined);
    assert.strictEqual(adcpOperationResolver({ method: 'DELETE', rawBody: '' }), undefined);
  });

  it('matches methods and skills exactly (no case folding, trimming, or aliasing)', () => {
    assert.strictEqual(
      adcpOperationResolver({ rawBody: rpc('sendmessage', msg([data('create_media_buy')])), method: 'POST' }),
      undefined
    );
    assert.strictEqual(
      adcpOperationResolver({ rawBody: rpc('SendMessage', msg([data(' create_media_buy')])), method: 'POST' }),
      ' create_media_buy'
    );
    assert.strictEqual(
      adcpOperationResolver({ rawBody: rpc('SendMessage', msg([data('Create_Media_Buy')])), method: 'POST' }),
      'Create_Media_Buy'
    );
  });

  it('accepts decoy TextParts and ignores message metadata', () => {
    const body = rpc('SendMessage', {
      metadata: { skill: 'create_media_buy' },
      message: {
        messageId: 'm',
        role: 'ROLE_USER',
        metadata: { skill: 'create_media_buy' },
        parts: [{ text: 'AdCP task: create_media_buy' }, data('get_products')],
      },
    });
    assert.strictEqual(adcpOperationResolver({ rawBody: body, method: 'POST' }), 'get_products');
  });

  describe('is unresolvable (never "no operation") for', () => {
    const unresolvable = {
      'an empty POST body': '',
      whitespace: '  \n',
      'non-JSON': '{not json',
      'a bare string': '"create_media_buy"',
      null: 'null',
      'a number': '7',
      'a batch': `[${rpc('tools/call', { name: 'get_products' })}]`,
      'a missing method': JSON.stringify({ jsonrpc: '2.0', params: msg([data('create_media_buy')]) }),
      'a numeric method': JSON.stringify({ jsonrpc: '2.0', method: 7 }),
      'tools/call without a name': rpc('tools/call', { arguments: {} }),
      'tools/call with a non-string name': rpc('tools/call', { name: 7 }),
      'tools/call with an empty name': rpc('tools/call', { name: '' }),
      'a message method without params': rpc('SendMessage', undefined),
      'a message method without a message': rpc('SendMessage', {}),
      'parts that are not an array': rpc('SendMessage', { message: { parts: {} } }),
      'zero parts': rpc('SendMessage', msg([])),
      'a text-only message': rpc('SendMessage', msg([{ text: 'hi' }])),
      'two DataParts': rpc('SendMessage', msg([data('get_products'), data('create_media_buy')])),
      'a second non-invocation DataPart': rpc('SendMessage', msg([data('get_products'), { data: { note: 1 } }])),
      'a url FilePart': rpc('SendMessage', msg([data('get_products'), { url: 'https://x.example/f' }])),
      'a raw FilePart': rpc('SendMessage', msg([data('get_products'), { raw: 'AAAA' }])),
      'a 0.3 file FilePart': rpc('message/send', msg([data('get_products'), { kind: 'file', file: { uri: 'x' } }])),
      'a Part with text and data': rpc('SendMessage', msg([{ text: 'x', data: { skill: 'get_products' } }])),
      'a Part with no content member': rpc('SendMessage', msg([{ mediaType: 'application/json' }])),
      'a Part that is not an object': rpc('SendMessage', msg(['get_products'])),
      'a kind that disagrees with the member': rpc(
        'message/send',
        msg([{ kind: 'text', data: { skill: 'get_products' } }])
      ),
      'data that is an array': rpc('SendMessage', msg([{ data: ['get_products'] }])),
      'data that is null': rpc('SendMessage', msg([{ data: null }])),
      'a missing skill': rpc('SendMessage', msg([{ data: { input: {} } }])),
      'a numeric skill': rpc('SendMessage', msg([{ data: { skill: 7 } }])),
      'an empty skill': rpc('SendMessage', msg([{ data: { skill: '' } }])),
      'a duplicate envelope key': '{"jsonrpc":"2.0","method":"tasks/get","method":"SendMessage","params":{}}',
      'a duplicate skill key':
        '{"method":"SendMessage","params":{"message":{"parts":[{"data":{"skill":"a","skill":"b"}}]}}}',
      'an escaped duplicate skill key':
        '{"method":"SendMessage","params":{"message":{"parts":[{"data":{"skill":"a","sk\\u0069ll":"b"}}]}}}',
      'a duplicate parts key':
        '{"method":"SendMessage","params":{"message":{"parts":[],"parts":[{"data":{"skill":"a"}}]}}}',
      'a case-variant skill': rpc('SendMessage', msg([{ data: { skill: 'get_products', Skill: 'create_media_buy' } }])),
      'a case-variant parts': rpc('SendMessage', {
        message: { Parts: [data('create_media_buy')], parts: [data('get_products')] },
      }),
      'a case-variant data member': rpc(
        'SendMessage',
        msg([{ Data: { skill: 'create_media_buy' }, data: { skill: 'get_products' } }])
      ),
      'a case-variant method member':
        '{"Method":"tools/call","method":"tasks/get","params":{"name":"create_media_buy"}}',
      'a __proto__ key': '{"method":"tools/call","params":{"name":"get_products","__proto__":{"x":1}}}',
    };
    for (const [name, rawBody] of Object.entries(unresolvable)) {
      it(name, () => {
        assert.strictEqual(adcpOperationResolver({ rawBody, method: 'POST' }), UNRESOLVABLE_OPERATION);
      });
    }
  });

  it('is not fooled by a method string that merely contains tools/call', () => {
    assert.strictEqual(
      adcpOperationResolver({ rawBody: rpc('tools/call/extra', { name: 'x' }), method: 'POST' }),
      undefined
    );
  });

  it('resolves a JSON-RPC response object (a client reply on MCP) to no operation', () => {
    assert.strictEqual(
      adcpOperationResolver({ rawBody: '{"jsonrpc":"2.0","id":3,"result":{}}', method: 'POST' }),
      undefined
    );
    assert.strictEqual(
      adcpOperationResolver({ rawBody: '{"jsonrpc":"2.0","id":3,"error":{"code":-1,"message":"x"}}', method: 'POST' }),
      undefined
    );
    // ...but a request-shaped body without a method is still malformed.
    assert.strictEqual(
      adcpOperationResolver({ rawBody: '{"jsonrpc":"2.0","id":3,"result":{},"params":{}}', method: 'POST' }),
      UNRESOLVABLE_OPERATION
    );
  });

  it('accepts a Buffer body', () => {
    assert.strictEqual(
      adcpOperationResolver({ rawBody: Buffer.from(rpc('SendMessage', msg([data('get_products')]))), method: 'POST' }),
      'get_products'
    );
  });
});

describe('mcpToolNameResolver is MCP-only and lenient (documented)', () => {
  it('does not resolve A2A messages, which is why it must not guard an A2A route', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method: 'SendMessage',
      params: { message: { parts: [{ data: { skill: 'create_media_buy', input: {} } }] } },
    });
    assert.strictEqual(mcpToolNameResolver({ rawBody: body }), undefined);
    assert.strictEqual(adcpOperationResolver({ rawBody: body, method: 'POST' }), 'create_media_buy');
  });
});

describe('buyer signer extractAdcpOperation aligns with the seller (sole DataPart rule)', () => {
  for (const vector of [...negative, ...positive].filter(v => !/message:send$/.test(v.request.url))) {
    it(`${vector.id}`, () => {
      const expected = vector.expected_outcome;
      const operation = extractAdcpOperation(vector.request.body);
      if (expected.error_code === 'request_body_malformed') {
        assert.strictEqual(
          operation,
          undefined,
          'the buyer never signs on the basis of a different part than the seller resolves'
        );
      } else if (expected.resolved_operation === null) {
        assert.strictEqual(operation, undefined);
      } else {
        assert.strictEqual(operation, expected.resolved_operation);
      }
    });
  }
});
