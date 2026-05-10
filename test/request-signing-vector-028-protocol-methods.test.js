// Unit tests for vector 028 — `protocol_methods_required_for` namespace.
//
// Vector 028 was added to the AdCP spec in adcp#4326 / adcp#4327 (merge commit
// 47e4280461). At the time this SDK PR opened, no published release of the
// spec ships the vector yet, so tests load an inline fixture rather than the
// compliance cache. Once the spec ships a release containing 028, the
// fixture-count tests in `request-signing-grader-vectors.test.js` will pick
// it up automatically; the tests here focus on the SDK-side behaviors that
// don't depend on the cache contents.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  buildNegativeRequest,
  listSupportedNegativeVectors,
} = require('../dist/lib/testing/storyboard/request-signing/index.js');

// Inline copy of the negative/028-unsigned-protocol-method-required.json
// fixture (matching the spec PR adcp#4326). Carrying it inline so this test
// runs without the spec release having shipped vector 028 to the cache yet.
const VECTOR_028 = Object.freeze({
  kind: 'negative',
  id: '028-unsigned-protocol-method-required',
  name: 'Unsigned tasks/cancel JSON-RPC POST; method is in protocol_methods_required_for',
  reference_now: 1776520800,
  spec_reference: '#signed-requests-transport-layer (protocol_methods_* namespace; pre-check 0)',
  request: {
    method: 'POST',
    url: 'https://seller.example.com/mcp',
    headers: {
      'Content-Type': 'application/json',
    },
    body: '{"jsonrpc":"2.0","method":"tasks/cancel","params":{"taskId":"task_conformance_001"},"id":1}',
  },
  verifier_capability: {
    supported: true,
    covers_content_digest: 'either',
    required_for: [],
    protocol_methods_required_for: ['tasks/cancel'],
  },
  jwks_ref: ['test-ed25519-2026'],
  expected_error_code: 'request_signature_required',
  expected_failed_step: 0,
});

const EMPTY_KEYS = { keys: [] };

describe('vector 028 — adversarial builder', () => {
  test('mutator is registered alongside vectors 001-027', () => {
    const supported = new Set(listSupportedNegativeVectors());
    assert.ok(
      supported.has('028-unsigned-protocol-method-required'),
      'mutator must be registered so the grader can build the unsigned tasks/cancel probe'
    );
  });

  test('returns the JSON-RPC body verbatim — no tools/call wrapping', () => {
    const built = buildNegativeRequest(VECTOR_028, EMPTY_KEYS, {});
    const parsed = JSON.parse(built.body);
    assert.strictEqual(parsed.method, 'tasks/cancel', 'method must be `tasks/cancel`, not `tools/call`');
    assert.strictEqual(parsed.params.taskId, 'task_conformance_001');
    assert.strictEqual(parsed.params.name, undefined, 'must NOT carry params.name (would smuggle into AdCP namespace)');
  });

  test('strips signature headers (request is unsigned)', () => {
    const built = buildNegativeRequest(VECTOR_028, EMPTY_KEYS, {});
    assert.strictEqual(built.headers.Signature, undefined);
    assert.strictEqual(built.headers['Signature-Input'], undefined);
  });

  test('mcp transport targets baseUrl directly (no path join)', () => {
    const built = buildNegativeRequest(VECTOR_028, EMPTY_KEYS, {
      transport: 'mcp',
      baseUrl: 'https://agent.example.com/api/training-agent/mcp-strict',
    });
    assert.strictEqual(built.url, 'https://agent.example.com/api/training-agent/mcp-strict');
    assert.strictEqual(
      built.headers.Accept,
      'application/json, text/event-stream',
      'MCP Streamable HTTP requires Accept negotiation header'
    );
  });

  test('raw transport keeps the vector URL when no baseUrl is provided', () => {
    const built = buildNegativeRequest(VECTOR_028, EMPTY_KEYS, {});
    assert.strictEqual(built.url, 'https://seller.example.com/mcp');
  });
});

// Capability-gating coverage (agent without `tasks/cancel` in its declared
// `protocol_methods_required_for` must auto-skip vector 028 with
// `capability_profile_mismatch`) is exercised by the existing
// `request-signing-grader-vectors.test.js::preflightSkip` block once a
// release of the spec ships vector 028 to the compliance cache. Until then,
// the direct `capabilityMismatch` logic in grader.ts is verified by the
// type-checker and reviewed in adcp-client#<this PR>.
