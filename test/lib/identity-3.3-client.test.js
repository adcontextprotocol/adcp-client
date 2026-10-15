const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SingleAgentClient } = require('../../dist/lib/core/SingleAgentClient');
const { ProtocolClient } = require('../../dist/lib/protocols');
const { validateIdentity33Payload } = require('../../dist/lib/identity-3.3');
const agent = { id: 'identity33-seller', name: 'Seller', agent_uri: 'https://seller.example.com/mcp', protocol: 'mcp' };
function params(reporting_webhook) {
  return {
    account: { account_id: 'acc' },
    brand: { domain: 'brand.com' },
    start_time: 'asap',
    end_time: '2026-12-31T00:00:00Z',
    packages: [{ product_id: 'prod', budget: 1000, pricing_option_id: 'price', format_kind: 'image', params: {} }],
    ...(reporting_webhook !== undefined && { reporting_webhook }),
  };
}
for (const scenario of [
  { served: '3.3', supported: true, omit: true },
  { served: '3.2', supported: true, omit: false },
  { served: '3.3', supported: false, omit: false },
  { served: undefined, supported: true, omit: false },
])
  test(`reporting authentication follows negotiated version ${scenario.served} and webhook support ${scenario.supported}`, async () => {
    const calls = [],
      original = ProtocolClient.callTool;
    ProtocolClient.callTool = async (_agent, task, parameters) => {
      calls.push({ task, parameters });
      return { status: 'completed', media_buy_id: 'buy' };
    };
    const caps = {
      version: 'v3',
      majorVersions: [3],
      servedVersion: scenario.served,
      supportedVersions: ['3.2', '3.3'],
      protocols: ['media_buy'],
      features: {},
      extensions: [],
      _synthetic: false,
      _raw: { webhook_signing: { supported: scenario.supported, profiles: ['adcp/webhook-signing/v1'] } },
    };
    const makeClient = () => {
      const c = new SingleAgentClient(agent, {
        experimentalIdentity33: true,
        webhookUrlTemplate: {
          template: 'https://buyer.example.com/webhooks/{task_type}/{operation_id}',
          tools: ['media_buy_delivery', 'create_media_buy'],
        },
        webhookSecret: 'configured-secret-of-at-least-32-characters',
        validateFeatures: false,
        validation: { requests: 'off', responses: 'off' },
      });
      c.cachedCapabilities = caps;
      c.getCapabilities = async () => caps;
      c.ensureEndpointDiscovered = async () => agent;
      c.detectServerVersion = async () => 'v3';
      return c;
    };
    const client = makeClient();
    try {
      await client.createMediaBuy(params());
      const webhook = calls.find(c => c.task === 'create_media_buy').parameters.reporting_webhook;
      assert.equal(Object.hasOwn(webhook, 'authentication'), !scenario.omit);
      assert.equal(client.executor.config.signedIdentity33Webhooks(), scenario.omit);
      if (!scenario.omit)
        assert.equal(webhook.authentication.credentials, 'configured-secret-of-at-least-32-characters');
      await client.createMediaBuy(
        params({ authentication: { schemes: ['Bearer'], credentials: 'caller-supplied-bearer' } })
      );
      assert.equal(
        calls.filter(c => c.task === 'create_media_buy')[1].parameters.reporting_webhook.authentication.credentials,
        'caller-supplied-bearer'
      );
      // A caller URL without credentials is valid only once 3.3 signed webhooks
      // are negotiated; below that the client refuses rather than pair its own
      // secret with the caller's host. A fresh client keeps this month's
      // delivery operation id free of the registration made above.
      const callerClient = makeClient();
      const callerReporting = params({ url: 'https://buyer.example.com/own-reports', reporting_frequency: 'daily' });
      if (scenario.omit) {
        await callerClient.createMediaBuy(callerReporting);
        const sent = calls.filter(c => c.task === 'create_media_buy')[2].parameters.reporting_webhook;
        assert.equal(sent.url, 'https://buyer.example.com/own-reports');
        assert.equal(Object.hasOwn(sent, 'authentication'), false);
        assert.equal(sent.signing_profile, 'adcp/webhook-signing/v1');
      } else {
        await assert.rejects(
          () => callerClient.createMediaBuy(callerReporting),
          /reporting_webhook requires an `authentication` block/
        );
        assert.equal(calls.filter(c => c.task === 'create_media_buy').length, 2);
      }
    } finally {
      ProtocolClient.callTool = original;
    }
  });
test('3.3 onboarding validation requires feature declaration and supported billing/sandbox tiers', () => {
  const body = {
    status: 'completed',
    supported_protocols: ['media_buy'],
    adcp: { major_versions: [3], idempotency: { supported: false } },
    account: {
      require_operator_auth: false,
      supported_billing: ['operator'],
      sandbox: true,
      required_for_products: false,
      agent_onboarding: { sandbox: { mode: 'open' }, billing: { operator: { mode: 'application' } } },
    },
    experimental_features: ['account.agent_onboarding'],
  };
  const valid = validateIdentity33Payload('get_adcp_capabilities', 'response', body);
  assert(valid.valid, JSON.stringify(valid.issues));
  assert.equal(
    validateIdentity33Payload('get_adcp_capabilities', 'response', { ...body, experimental_features: [] }).valid,
    false
  );
  assert.equal(
    validateIdentity33Payload('get_adcp_capabilities', 'response', {
      ...body,
      account: { ...body.account, sandbox: false },
    }).valid,
    false
  );
});

test('persisted WBA webhook profile survives receiver restart and never falls back to RFC parsing', async t => {
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  t.after(() => {
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
  });
  const { generateKeyPairSync } = require('crypto');
  const { createWebhookEmitter } = require('../../dist/lib/server/webhook-emitter');
  const { InMemoryWebhookRegistrationStore } = require('../../dist/lib/core/webhook-registration');
  const {
    jwkThumbprint,
    createSignedSignatureDirectory,
    SignatureDirectoryResolver,
  } = require('../../dist/lib/identity-3.3');
  const pair = generateKeyPairSync('ed25519'),
    priv = pair.privateKey.export({ format: 'jwk' }),
    pub = pair.publicKey.export({ format: 'jwk' });
  const kid = jwkThumbprint(pub),
    origin = 'https://seller.example.com';
  const callbackUrl = 'https://buyer.example.com/webhooks/create_media_buy/op-wba';
  const directoryProof = await createSignedSignatureDirectory(origin, [{ privateKey: { ...priv, kid } }]);
  const store = new InMemoryWebhookRegistrationStore();
  const producer = new SingleAgentClient(agent, {
    experimentalIdentity33: true,
    webhookRegistrationStore: store,
    strictSchemaValidation: false,
    validateFeatures: false,
  });
  await producer.persistWebhookRegistration({
    agent,
    taskType: 'create_media_buy',
    operationId: 'op-wba',
    callbackUrl,
    mode: 'rfc9421',
    signingProfile: 'web-bot-auth',
  });
  const calls = [];
  const emitter = createWebhookEmitter({
    signerKey: {
      keyid: 'legacy-key',
      alg: 'ed25519',
      privateKey: { ...priv, kid: 'legacy-key', alg: 'ed25519', adcp_use: 'webhook-signing' },
    },
    webBotAuth: { origin, key: { privateKey: { ...priv, kid } } },
    fetch: async (url, init) => {
      calls.push({ url, ...init });
      return { status: 204, headers: { get: () => undefined } };
    },
  });
  const payload = {
    operation_id: 'op-wba',
    task_id: 'task-wba',
    task_type: 'create_media_buy',
    status: 'completed',
    timestamp: new Date().toISOString(),
    result: { media_buy_id: 'buy', packages: [] },
  };
  await emitter.emit({ url: callbackUrl, payload, delivery_id: 'identity33-wba', signingProfile: 'web-bot-auth' });
  const receiver = new SingleAgentClient(agent, {
    experimentalIdentity33: true,
    webhookRegistrationStore: store,
    strictSchemaValidation: false,
    validateFeatures: false,
    webhookVerification: {
      webBotAuth: {
        directory: new SignatureDirectoryResolver({
          fetchOptions: {
            trustedFetchFn: async () =>
              new Response(directoryProof.body, { status: 200, headers: directoryProof.headers }),
          },
        }),
        isRevoked: async () => false,
      },
    },
  });
  const parse = call =>
    receiver.verifyAndParseWebhook({
      rawBody: call.body,
      headers: call.headers,
      taskType: 'create_media_buy',
      operationId: 'op-wba',
      requestMethod: 'POST',
      requestUrl: callbackUrl,
    });
  const parsed = await parse(calls[0]);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  await emitter.emit({
    url: callbackUrl,
    payload: { ...payload, task_id: 'task-legacy' },
    delivery_id: 'identity33-rfc',
    signingProfile: 'adcp/webhook-signing/v1',
  });
  assert.equal((await parse(calls[1])).ok, false);
});

test('experimental instance schema scope does not enable 3.3 constructors or loaders for other instances', () => {
  const loader = require('../../dist/lib/validation/schema-loader');
  const { createAdcpServer } = require('../../dist/lib/server/create-adcp-server');
  new SingleAgentClient(agent, { experimentalIdentity33: true });
  assert.equal(loader.hasSchemaBundle('3.3'), false);
  assert.equal(loader.isExternalSchemaRootActive('3.3'), false);
  loader.withIdentity33SchemaScope(() => assert.throws(() => new SingleAgentClient(agent, { adcpVersion: '3.3' })));
  assert.throws(() => new SingleAgentClient(agent, { adcpVersion: '3.3' }));
  assert.throws(() => createAdcpServer({ name: 'plain', version: '1.0.0', adcpVersion: '3.3' }));
});

test('explicit RFC webhook selection persists and overrides a WBA emitter default on recovery', async t => {
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  t.after(() => {
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
  });
  const { createWebhookEmitter } = require('../../dist/lib/server/webhook-emitter');
  const priv = require('crypto').generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  const calls = [];
  let snapshot;
  const claim = {
    key: { publisherScope: 'publisher', tenantScope: 'tenant', deliveryId: 'recovery-profile' },
    leaseExpiresAtMs: Date.now() + 60000,
    renew: async () => true,
    settle: async () => true,
    release: async () => true,
  };
  const emitter = createWebhookEmitter({
    publisherScope: 'publisher',
    tenantScope: 'tenant',
    signerKey: {
      keyid: 'legacy',
      alg: 'ed25519',
      privateKey: { ...priv, kid: 'legacy', alg: 'ed25519', adcp_use: 'webhook-signing' },
    },
    signingProfile: 'web-bot-auth',
    webBotAuth: {
      origin: 'https://seller.example.com',
      key: { privateKey: { ...priv, kid: require('../../dist/lib/identity-3.3').jwkThumbprint(priv) } },
    },
    fetch: async (_url, init) => {
      calls.push(init);
      return { status: 204, headers: { get: () => undefined } };
    },
    deliveryRecovery: {
      durability: 'durable',
      checkpoint: async (_key, saved) => {
        snapshot = saved;
        return claim;
      },
      settle: async () => {},
    },
  });
  await emitter.emit({
    url: 'https://buyer.example.com/callback',
    payload: { status: 'completed' },
    delivery_id: claim.key.deliveryId,
    signingProfile: 'adcp/webhook-signing/v1',
  });
  assert.equal(snapshot.signingProfile, 'adcp/webhook-signing/v1');
  await emitter.emitRecovered({ ...claim, snapshot });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers['signature-agent'], undefined);
});

test('server rejects a WBA-wide webhook default and unenabled WBA emission; RFC profile keeps legacy provenance', () => {
  const { createAdcpServer } = require('../../dist/lib/server/create-adcp-server');
  assert.throws(
    () => createAdcpServer({ name: 'Unsafe profile', version: '1.0.0', webhooks: { signingProfile: 'web-bot-auth' } }),
    /server-wide default/
  );
  assert.throws(
    () => createAdcpServer({ name: 'Unenabled profile', version: '1.0.0', webhooks: { webBotAuth: {} } }),
    /requires the identity33 experiment/
  );
  const { webhookRegistrationFingerprint } = require('../../dist/lib/core/webhook-registration');
  const registration = {
    agentId: agent.id,
    agentUrl: agent.agent_uri,
    protocol: 'mcp',
    operationId: 'legacy-registration',
    taskType: 'create_media_buy',
    callbackUrl: 'https://buyer.example.com/callback',
    method: 'POST',
    mode: 'rfc9421',
    createdAt: Date.now(),
    expiresAt: Date.now() + 60000,
  };
  assert.equal(
    webhookRegistrationFingerprint(registration),
    webhookRegistrationFingerprint({ ...registration, signingProfile: 'adcp/webhook-signing/v1' })
  );
});

test('update and artifact callbacks persist destination profile before dispatch and authenticate without task routing', async t => {
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  t.after(() => {
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
  });
  const { generateKeyPairSync } = require('crypto'),
    pair = generateKeyPairSync('ed25519');
  const priv = pair.privateKey.export({ format: 'jwk' });
  const identity = require('../../dist/lib/identity-3.3');
  priv.kid = identity.jwkThumbprint(priv);
  const proof = await identity.createSignedSignatureDirectory('https://seller.example.com', [{ privateKey: priv }]);
  const {
    InMemoryWebhookRegistrationStore,
    deliveryWebhookRegistrationId,
  } = require('../../dist/lib/core/webhook-registration');
  const store = new InMemoryWebhookRegistrationStore(),
    original = ProtocolClient.callTool,
    seen = [];
  const reportUrl = 'https://buyer.example.com/reports',
    artifactUrl = 'https://buyer.example.com/artifacts';
  const caps = {
    version: 'v3',
    majorVersions: [3],
    servedVersion: '3.3',
    supportedVersions: ['3.3'],
    protocols: ['media_buy'],
    features: {},
    extensions: [],
    _synthetic: false,
    _raw: { webhook_signing: { supported: true, profiles: ['adcp/webhook-signing/v1', 'web-bot-auth'] } },
  };
  const config = {
    experimentalIdentity33: true,
    webhookSigningProfile: 'web-bot-auth',
    webhookRegistrationStore: store,
    validateFeatures: false,
    validation: { requests: 'off', responses: 'off' },
    webhookVerification: {
      webBotAuth: {
        directory: new identity.SignatureDirectoryResolver({
          fetchOptions: {
            trustedFetchFn: async () => new Response(proof.body, { status: 200, headers: proof.headers }),
          },
        }),
        isRevoked: async () => false,
      },
    },
  };
  const client = new SingleAgentClient(agent, config);
  client.cachedCapabilities = caps;
  client.getCapabilities = async () => caps;
  client.ensureEndpointDiscovered = async () => agent;
  client.detectServerVersion = async () => 'v3';
  ProtocolClient.callTool = async (_agent, task, args) => {
    for (const [kind, url] of [
      ['reporting', reportUrl],
      ['artifact', artifactUrl],
    ]) {
      const registration = await store.get(agent.id, deliveryWebhookRegistrationId(kind, url));
      assert.equal(registration.signingProfile, 'web-bot-auth');
      assert.equal(registration.deliveryKind, kind);
    }
    seen.push({ task, args });
    return { status: 'completed', media_buy_id: 'buy', packages: [] };
  };
  try {
    await client.updateMediaBuy({
      media_buy_id: 'buy',
      account: { account_id: 'acc' },
      reporting_webhook: { url: reportUrl },
      artifact_webhook: { url: artifactUrl },
    });
    assert.equal(seen[0].task, 'update_media_buy');
    const receiver = new SingleAgentClient(agent, config),
      payload = {
        idempotency_key: 'artifact-delivery-unique-key',
        media_buy_id: 'buy',
        batch_id: 'batch',
        timestamp: new Date().toISOString(),
        artifacts: [],
      },
      body = JSON.stringify(payload);
    const headers = await identity.signWebBotAuth(
      { method: 'POST', url: artifactUrl, headers: { 'content-type': 'application/json' }, body },
      { privateKey: priv },
      { origin: 'https://seller.example.com' }
    );
    const parsed = await receiver.verifyAndParseWebhook({
      rawBody: body,
      headers,
      taskType: 'artifact_delivery',
      requestMethod: 'POST',
      requestUrl: artifactUrl,
    });
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    assert.deepEqual(parsed.result, payload);
    const report = {
      notification_type: 'scheduled',
      reporting_period: { start: '2026-10-01T00:00:00Z', end: '2026-10-02T00:00:00Z' },
      media_buy_deliveries: [],
    };
    const reportEnvelope = {
      idempotency_key: 'reporting-delivery-unique-key',
      operation_id: 'report-op',
      task_id: 'report-task',
      task_type: 'media_buy_delivery',
      status: 'completed',
      timestamp: new Date().toISOString(),
      result: report,
    };
    const reportBody = JSON.stringify(reportEnvelope),
      reportHeaders = await identity.signWebBotAuth(
        { method: 'POST', url: reportUrl, headers: { 'content-type': 'application/json' }, body: reportBody },
        { privateKey: priv },
        { origin: 'https://seller.example.com' }
      );
    const parsedReport = await receiver.verifyAndParseWebhook({
      rawBody: reportBody,
      headers: reportHeaders,
      taskType: 'media_buy_delivery',
      requestMethod: 'POST',
      requestUrl: reportUrl,
    });
    assert.equal(parsedReport.ok, true, JSON.stringify(parsedReport));
    assert.deepEqual(parsedReport.result, report);
    assert.deepEqual(parsedReport.envelope, reportEnvelope);
    const preservedUrl = 'https://buyer.example.com/approved-report';
    ProtocolClient.callTool = async (_agent, _task, args) => {
      assert.deepEqual(args.reporting_webhook, { url: preservedUrl });
      const registration = await store.get(agent.id, deliveryWebhookRegistrationId('reporting', preservedUrl));
      assert.equal(registration.signingProfile, 'adcp/webhook-signing/v1');
      return { status: 'completed', media_buy_id: 'buy', packages: [] };
    };
    await client.updateMediaBuyLegacy(
      { media_buy_id: 'buy', account: { account_id: 'acc' }, reporting_webhook: { url: preservedUrl } },
      undefined,
      { preserveGovernedPayload: true }
    );
  } finally {
    ProtocolClient.callTool = original;
  }
});

test('resolved webhook profiles cannot mix WBA with legacy credentials at either transport boundary', async t => {
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  t.after(() => {
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
  });
  const { createWebhookEmitter } = require('../../dist/lib/server/webhook-emitter');
  let effects = 0;
  const base = {
    signerProvider: {
      getKey: async () => {
        throw new Error('must not select signing key');
      },
    },
    webBotAuth: {},
    fetch: async () => {
      effects++;
      return { status: 204 };
    },
  };
  const payload = {
    task_id: 'task',
    task_type: 'create_media_buy',
    operation_id: 'operation',
    status: 'completed',
    result: {},
  };
  const emit = {
    url: 'https://buyer.example.com/webhook',
    payload,
    delivery_id: 'profile-conflict',
    authentication: { type: 'bearer', token: 'legacy-test-token' },
  };
  await assert.rejects(
    createWebhookEmitter({ ...base, signingProfile: 'web-bot-auth' }).emit(emit),
    /cannot be combined/
  );
  const emitter = createWebhookEmitter({
    ...base,
    authorizeAttempt: async () => ({
      decision: 'allow',
      signingProfile: 'web-bot-auth',
      authentication: { type: 'bearer', token: 'override-test-token' },
    }),
  });
  await assert.rejects(emitter.emit({ ...emit, authentication: null }), /cannot be combined/);
  assert.equal(effects, 0);
});
