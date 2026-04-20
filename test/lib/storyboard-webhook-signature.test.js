/**
 * End-to-end signing conformance: runStoryboard + a signed publisher.
 *
 * Generates an Ed25519 keypair, exposes the public half via a
 * `StaticJwksResolver`, stands up a fake publisher that signs an outbound
 * webhook with `signWebhook`, and runs a storyboard whose
 * `expect_webhook_signature_valid` step delegates to the 9421 verifier.
 *
 * Also exercises the negative path — a publisher emitting the wrong tag
 * must fail with `signature_tag_invalid`.
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { generateKeyPairSync } = require('node:crypto');

const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner.js');
const { signWebhook } = require('../../dist/lib/signing/signer.js');
const { WEBHOOK_SIGNING_TAG } = require('../../dist/lib/signing/webhook-verifier.js');
const { StaticJwksResolver } = require('../../dist/lib/signing/jwks.js');

// ────────────────────────────────────────────────────────────
// Key + JWKS setup
// ────────────────────────────────────────────────────────────

function generateEd25519Keypair(kid) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const priv = privateKey.export({ format: 'jwk' });
  const pub = publicKey.export({ format: 'jwk' });
  const privateJwk = {
    ...priv,
    kid,
    alg: 'ed25519',
    adcp_use: 'webhook-signing',
    key_ops: ['sign'],
  };
  const publicJwk = {
    ...pub,
    kid,
    alg: 'ed25519',
    adcp_use: 'webhook-signing',
    key_ops: ['verify'],
  };
  return { privateJwk, publicJwk };
}

// ────────────────────────────────────────────────────────────
// Signed fake publisher
// ────────────────────────────────────────────────────────────

async function startSignedPublisher({ signerKey, tag = WEBHOOK_SIGNING_TAG } = {}) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const toolName = rpc.params?.name;
    const args = rpc.params?.arguments ?? {};

    if (toolName === '__test_fire_webhook') {
      const url = args.push_notification_config?.url;
      const body = JSON.stringify({
        idempotency_key: 'evt_signed_' + '0123456789abcdef'.slice(0, 16),
        task: { task_id: args.task_id ?? 'mb-1', status: 'completed' },
      });
      const signed = signWebhook(
        {
          method: 'POST',
          url,
          headers: { 'content-type': 'application/json' },
          body,
        },
        signerKey,
        // Route through the verifier's required tag — default is
        // `adcp/webhook-signing/v1`; override lets the negative test
        // emit a wrong tag.
        tag === WEBHOOK_SIGNING_TAG ? {} : { now: () => Math.floor(Date.now() / 1000) }
      );
      // For the negative-tag test we rebuild headers with a different tag
      // by re-signing via a patched params — simplest is a fake publisher
      // that just swaps the tag in Signature-Input. Since the verifier
      // checks the tag before the crypto, the underlying signature can be
      // untouched; the tag mismatch is what the receiver surfaces.
      if (tag !== WEBHOOK_SIGNING_TAG) {
        signed.headers['Signature-Input'] = signed.headers['Signature-Input'].replace(
          `tag="${WEBHOOK_SIGNING_TAG}"`,
          `tag="${tag}"`
        );
      }
      try {
        await fetch(url, { method: 'POST', headers: signed.headers, body });
      } catch {
        // Swallow — test asserts via the expect_webhook* step's outcome.
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: { structuredContent: { fired: true } },
        })
      );
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}/mcp` };
}

function stop(p) {
  return new Promise(r => p.server.close(r));
}

function storyboardWith(steps) {
  return {
    id: 'webhook_signing_sb',
    version: '1.0.0',
    title: 'Webhook signing test',
    category: 'testing',
    summary: '',
    narrative: '',
    agent: { interaction_model: '*', capabilities: [] },
    caller: { role: 'compliance_runner' },
    phases: [{ id: 'p', title: 'sign', steps }],
  };
}

const AGENT_TOOLS = ['__test_fire_webhook'];
const RUN_OPTIONS_BASE = {
  protocol: 'mcp',
  allow_http: true,
  agentTools: AGENT_TOOLS,
  _profile: { name: 'fake', tools: AGENT_TOOLS.map(name => ({ name })) },
};

describe('runStoryboard: expect_webhook_signature_valid (E2E with signed publisher)', () => {
  let publisher;
  afterEach(async () => {
    if (publisher) await stop(publisher);
    publisher = undefined;
  });

  test('passes when publisher signs with the correct 9421 webhook tag + key', async () => {
    const { privateJwk, publicJwk } = generateEd25519Keypair('key_webhook_v1');
    publisher = await startSignedPublisher({
      signerKey: { keyid: 'key_webhook_v1', alg: 'ed25519', privateKey: privateJwk },
    });
    const jwks = new StaticJwksResolver([publicJwk]);

    const storyboard = storyboardWith([
      {
        id: 'trigger',
        title: 'Trigger signed webhook',
        task: '__test_fire_webhook',
        auth: 'none',
        sample_request: {
          task_id: 'mb-signed',
          push_notification_config: { url: '{{runner.webhook_url:trigger}}' },
        },
      },
      {
        id: 'assert_sig',
        title: 'Assert 9421 signature verifies',
        task: 'expect_webhook_signature_valid',
        triggered_by: 'trigger',
        timeout_seconds: 2,
      },
    ]);

    const result = await runStoryboard(publisher.url, storyboard, {
      ...RUN_OPTIONS_BASE,
      webhook_receiver: {},
      webhook_signing: { jwks },
    });

    const assertStep = result.phases[0].steps[1];
    assert.strictEqual(
      assertStep.passed,
      true,
      `expected pass; got: ${JSON.stringify(assertStep.validations)} skip: ${JSON.stringify(assertStep.skip)}`
    );
    assert.strictEqual(assertStep.validations[0].check, 'expect_webhook_signature_valid');
  });

  test('fails with signature_tag_invalid when publisher uses the wrong tag', async () => {
    const { privateJwk, publicJwk } = generateEd25519Keypair('key_webhook_v1');
    publisher = await startSignedPublisher({
      signerKey: { keyid: 'key_webhook_v1', alg: 'ed25519', privateKey: privateJwk },
      tag: 'adcp/request-signing/v1', // wrong tag on purpose
    });
    const jwks = new StaticJwksResolver([publicJwk]);

    const storyboard = storyboardWith([
      {
        id: 'trigger',
        title: 'Trigger wrong-tag signed webhook',
        task: '__test_fire_webhook',
        auth: 'none',
        sample_request: {
          task_id: 'mb-wrong-tag',
          push_notification_config: { url: '{{runner.webhook_url:trigger}}' },
        },
      },
      {
        id: 'assert_sig',
        title: 'Assert signature fails with tag_invalid',
        task: 'expect_webhook_signature_valid',
        triggered_by: 'trigger',
        timeout_seconds: 2,
      },
    ]);

    const result = await runStoryboard(publisher.url, storyboard, {
      ...RUN_OPTIONS_BASE,
      webhook_receiver: {},
      webhook_signing: { jwks },
    });

    const assertStep = result.phases[0].steps[1];
    assert.strictEqual(assertStep.passed, false);
    assert.strictEqual(assertStep.validations[0].actual.code, 'signature_tag_invalid');
  });

  test('fails with signature_key_unknown when JWKS has no matching kid', async () => {
    const { privateJwk } = generateEd25519Keypair('key_webhook_v1');
    const { publicJwk: otherPublic } = generateEd25519Keypair('some_other_key');
    publisher = await startSignedPublisher({
      signerKey: { keyid: 'key_webhook_v1', alg: 'ed25519', privateKey: privateJwk },
    });
    const jwks = new StaticJwksResolver([otherPublic]); // mismatching kid

    const storyboard = storyboardWith([
      {
        id: 'trigger',
        title: 'Trigger',
        task: '__test_fire_webhook',
        auth: 'none',
        sample_request: {
          task_id: 'mb-unknown-key',
          push_notification_config: { url: '{{runner.webhook_url:trigger}}' },
        },
      },
      {
        id: 'assert_sig',
        title: 'Assert unknown key fails',
        task: 'expect_webhook_signature_valid',
        triggered_by: 'trigger',
        timeout_seconds: 2,
      },
    ]);

    const result = await runStoryboard(publisher.url, storyboard, {
      ...RUN_OPTIONS_BASE,
      webhook_receiver: {},
      webhook_signing: { jwks },
    });

    const assertStep = result.phases[0].steps[1];
    assert.strictEqual(assertStep.passed, false);
    assert.strictEqual(assertStep.validations[0].actual.code, 'signature_key_unknown');
  });
});
