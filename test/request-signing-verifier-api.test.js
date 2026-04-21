const { describe, it } = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const {
  RequestSignatureError,
  verifyRequestSignature,
  signRequest,
  InMemoryReplayStore,
  InMemoryRevocationStore,
  StaticJwksResolver,
} = require('../dist/lib/signing');

const keysPath = path.join(
  __dirname,
  '..',
  'compliance',
  'cache',
  'latest',
  'test-vectors',
  'request-signing',
  'keys.json'
);
const { keys } = JSON.parse(readFileSync(keysPath, 'utf8'));
const primary = keys.find(k => k.kid === 'test-ed25519-2026');
const primaryPublic = { ...primary };
delete primaryPublic._private_d_for_test_only;
delete primaryPublic.d;
const primaryPrivate = { ...primary, d: primary._private_d_for_test_only };
delete primaryPrivate._private_d_for_test_only;

const baseStores = () => ({
  jwks: new StaticJwksResolver([primaryPublic]),
  replayStore: new InMemoryReplayStore(),
  revocationStore: new InMemoryRevocationStore(),
});

describe('verifier API v3: operation optional + VerifyResult discriminated union', () => {
  it('unsigned request with no operation returns { status: "unsigned" }', async () => {
    const result = await verifyRequestSignature(
      {
        method: 'POST',
        url: 'https://seller.example.com/adcp/create_media_buy',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
      {
        ...baseStores(),
        capability: { supported: true, covers_content_digest: 'either', required_for: ['create_media_buy'] },
        now: () => 1_776_520_800,
        // operation deliberately omitted — middleware's always-verify mode
      }
    );
    assert.strictEqual(result.status, 'unsigned');
    assert.strictEqual(typeof result.verified_at, 'number');
    assert.ok(!('keyid' in result), 'unsigned result has no keyid');
    // JS consumers reading `result.keyid` directly (no TS guard) must see
    // `undefined`, not the old `''` sentinel. Both are falsy, but code that
    // passes `result.keyid` to a logger or map key would get different
    // textual output under the old shape — this assertion locks in the new
    // behavior so a future refactor can't reintroduce an empty-string sentinel.
    assert.strictEqual(result.keyid, undefined);
  });

  it('unsigned request with operation in required_for throws request_signature_required', async () => {
    await assert.rejects(
      () =>
        verifyRequestSignature(
          {
            method: 'POST',
            url: 'https://seller.example.com/adcp/create_media_buy',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          },
          {
            ...baseStores(),
            capability: { supported: true, covers_content_digest: 'either', required_for: ['create_media_buy'] },
            now: () => 1_776_520_800,
            operation: 'create_media_buy',
          }
        ),
      err => err instanceof RequestSignatureError && err.code === 'request_signature_required'
    );
  });

  it('unsigned request with operation NOT in required_for returns { status: "unsigned" }', async () => {
    const result = await verifyRequestSignature(
      {
        method: 'POST',
        url: 'https://seller.example.com/adcp/list_inventory',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
      {
        ...baseStores(),
        capability: { supported: true, covers_content_digest: 'either', required_for: ['create_media_buy'] },
        now: () => 1_776_520_800,
        operation: 'list_inventory',
      }
    );
    assert.strictEqual(result.status, 'unsigned');
  });

  it('successful verification returns { status: "verified", keyid, verified_at }', async () => {
    const now = 1_776_520_800;
    const url = 'https://seller.example.com/adcp/create_media_buy';
    const body = '{"plan_id":"plan_001"}';
    const signed = signRequest(
      { method: 'POST', url, headers: { 'Content-Type': 'application/json' }, body },
      { keyid: 'test-ed25519-2026', alg: 'ed25519', privateKey: primaryPrivate },
      { now: () => now, windowSeconds: 300, nonce: 'api-shape-test-xxxx' }
    );
    const result = await verifyRequestSignature(
      { method: 'POST', url, headers: signed.headers, body },
      {
        ...baseStores(),
        capability: { supported: true, covers_content_digest: 'either', required_for: ['create_media_buy'] },
        now: () => now,
        operation: 'create_media_buy',
      }
    );
    assert.strictEqual(result.status, 'verified');
    assert.strictEqual(result.keyid, 'test-ed25519-2026');
    assert.strictEqual(typeof result.verified_at, 'number');
    // No empty-string sentinel anymore.
    assert.notStrictEqual(result.keyid, '');
  });

  // ── Vector 027: webhook-authentication downgrade resistance ─────────
  //
  // The verifier rejects unsigned requests whose JSON body carries a
  // non-empty `push_notification_config.authentication` anywhere in the
  // tree, regardless of whether the operation is in `required_for`.
  // These tests lock the surface around the happy-path conformance
  // vector (which only proves the top-level-object case).

  const webhookOperation = 'update_media_buy';
  const webhookUrl = `https://seller.example.com/adcp/${webhookOperation}`;
  const webhookCapability = {
    supported: true,
    covers_content_digest: 'either',
    // Deliberately empty so the webhook-auth rule is the ONLY reason to
    // reject — not the `required_for` precedence above it.
    required_for: [],
  };

  async function verifyUnsigned(body) {
    return verifyRequestSignature(
      { method: 'POST', url: webhookUrl, headers: { 'Content-Type': 'application/json' }, body },
      { ...baseStores(), capability: webhookCapability, now: () => 1_776_520_800, operation: webhookOperation }
    );
  }

  it('unsigned request with push_notification_config but no authentication returns unsigned', async () => {
    const result = await verifyUnsigned(
      JSON.stringify({ push_notification_config: { url: 'https://buyer.example/webhook' } })
    );
    assert.strictEqual(result.status, 'unsigned');
  });

  it('unsigned request with empty authentication object returns unsigned', async () => {
    const result = await verifyUnsigned(
      JSON.stringify({ push_notification_config: { url: 'https://buyer.example/webhook', authentication: {} } })
    );
    assert.strictEqual(result.status, 'unsigned');
  });

  it('unsigned request with authentication: null returns unsigned', async () => {
    const result = await verifyUnsigned(
      JSON.stringify({ push_notification_config: { url: 'https://buyer.example/webhook', authentication: null } })
    );
    assert.strictEqual(result.status, 'unsigned');
  });

  it('unsigned request with authentication as a string (non-object) returns unsigned', async () => {
    const result = await verifyUnsigned(
      JSON.stringify({
        push_notification_config: { url: 'https://buyer.example/webhook', authentication: 'Bearer xyz' },
      })
    );
    assert.strictEqual(result.status, 'unsigned');
  });

  it('unsigned request with authentication nested inside an array rejects', async () => {
    await assert.rejects(
      () =>
        verifyUnsigned(
          JSON.stringify({
            updates: [
              { media_buy_id: 'mb_001' },
              {
                media_buy_id: 'mb_002',
                push_notification_config: {
                  url: 'https://buyer.example/webhook',
                  authentication: { scheme: 'HMAC-SHA256', credentials: 'secret' },
                },
              },
            ],
          })
        ),
      err => err instanceof RequestSignatureError && err.code === 'request_signature_required'
    );
  });

  it('unsigned request with non-JSON body does not reject', async () => {
    const result = await verifyRequestSignature(
      {
        method: 'POST',
        url: webhookUrl,
        headers: { 'Content-Type': 'text/plain' },
        body: 'push_notification_config authentication credentials=secret',
      },
      { ...baseStores(), capability: webhookCapability, now: () => 1_776_520_800, operation: webhookOperation }
    );
    assert.strictEqual(result.status, 'unsigned');
  });

  it('unsigned body over the inspection cap rejects (defense in depth)', async () => {
    // Build a 1 MB + 1 byte body of arbitrary JSON. We can't prove absence
    // of webhook auth over our DoS budget, so we must reject.
    const padding = 'x'.repeat(1_048_576);
    const oversized = JSON.stringify({ padding });
    assert.ok(oversized.length > 1_048_576, 'body exceeds 1 MB cap');
    await assert.rejects(
      () => verifyUnsigned(oversized),
      err => err instanceof RequestSignatureError && err.code === 'request_signature_required'
    );
  });

  it('signed request carrying webhook authentication reaches the crypto path (not re-rejected at step 0)', async () => {
    const now = 1_776_520_800;
    const body = JSON.stringify({
      media_buy_id: 'mb_001',
      push_notification_config: {
        url: 'https://buyer.example/webhook',
        authentication: { scheme: 'HMAC-SHA256', credentials: 'shared-secret' },
      },
    });
    const signed = signRequest(
      { method: 'POST', url: webhookUrl, headers: { 'Content-Type': 'application/json' }, body },
      { keyid: 'test-ed25519-2026', alg: 'ed25519', privateKey: primaryPrivate },
      { now: () => now, windowSeconds: 300, nonce: 'webhook-signed-zzzz' }
    );
    const result = await verifyRequestSignature(
      { method: 'POST', url: webhookUrl, headers: signed.headers, body },
      { ...baseStores(), capability: webhookCapability, now: () => now, operation: webhookOperation }
    );
    assert.strictEqual(result.status, 'verified');
    assert.strictEqual(result.keyid, 'test-ed25519-2026');
  });

  it('agent_url is populated on verified via agentUrlForKeyid hook', async () => {
    const now = 1_776_520_800;
    const url = 'https://seller.example.com/adcp/create_media_buy';
    const body = '{}';
    const signed = signRequest(
      { method: 'POST', url, headers: { 'Content-Type': 'application/json' }, body },
      { keyid: 'test-ed25519-2026', alg: 'ed25519', privateKey: primaryPrivate },
      { now: () => now, windowSeconds: 300, nonce: 'agent-url-test-yyyy' }
    );
    const result = await verifyRequestSignature(
      { method: 'POST', url, headers: signed.headers, body },
      {
        ...baseStores(),
        capability: { supported: true, covers_content_digest: 'either', required_for: [] },
        now: () => now,
        operation: 'create_media_buy',
        agentUrlForKeyid: kid =>
          kid === 'test-ed25519-2026' ? 'https://buyer.example/.well-known/adcp-jwks.json' : undefined,
      }
    );
    assert.strictEqual(result.status, 'verified');
    assert.strictEqual(result.agent_url, 'https://buyer.example/.well-known/adcp-jwks.json');
  });
});
