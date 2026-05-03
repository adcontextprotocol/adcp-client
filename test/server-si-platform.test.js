process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  createAdcpServerFromPlatform,
  createCtxMetadataStore,
  memoryCtxMetadataStore,
} = require('../dist/lib/server/legacy/v5');
const { getSdkServer } = require('../dist/lib/server/adcp-server');

function registeredTools(server) {
  const sdk = getSdkServer(server);
  if (!sdk) throw new Error('registeredTools: value is not an AdcpServer');
  return Object.keys(sdk._registeredTools);
}

function makeStore() {
  return createCtxMetadataStore({
    backend: memoryCtxMetadataStore({ sweepIntervalMs: 0 }),
  });
}

function makePlatform(siOverrides = {}) {
  return {
    capabilities: {
      adcp_version: '3.0.0',
      specialisms: [],
      idempotency: { replay_ttl_seconds: 86400 },
    },
    accounts: {
      resolution: 'derived',
      resolve: async () => ({ id: 'acct_default', operator: 'test', ctx_metadata: {} }),
      upsert: async () => ({ ok: true, items: [] }),
      list: async () => ({ items: [], nextCursor: null }),
    },
    sponsoredIntelligence: {
      getOffering: async () => ({
        available: true,
        offering_token: 'oqt_default',
        offering: { offering_id: 'off_default', title: 'Default', summary: 'Default offering' },
      }),
      initiateSession: async () => ({
        session_id: 'sess_default',
        session_status: 'active',
        session_ttl_seconds: 600,
      }),
      sendMessage: async () => ({
        session_id: 'sess_default',
        session_status: 'active',
      }),
      terminateSession: async () => ({
        session_id: 'sess_default',
        terminated: true,
        session_status: 'terminated',
      }),
      ...siOverrides,
    },
  };
}

describe('SponsoredIntelligencePlatform — v6 protocol-keyed dispatch', () => {
  it('registers all four SI tools when sponsoredIntelligence platform field is present', () => {
    const platform = makePlatform();
    const ctxMetadata = makeStore();
    const server = createAdcpServerFromPlatform(platform, {
      name: 'Test SI',
      version: '1.0.0',
      ctxMetadata,
      validation: { requests: 'off', responses: 'off' },
    });
    const registered = registeredTools(server);
    assert.ok(registered.includes('si_get_offering'), 'si_get_offering registered');
    assert.ok(registered.includes('si_initiate_session'), 'si_initiate_session registered');
    assert.ok(registered.includes('si_send_message'), 'si_send_message registered');
    assert.ok(registered.includes('si_terminate_session'), 'si_terminate_session registered');
  });

  it('declares sponsored_intelligence in supported_protocols when SI platform field is present', async () => {
    const platform = makePlatform();
    const ctxMetadata = makeStore();
    const server = createAdcpServerFromPlatform(platform, {
      name: 'Test SI',
      version: '1.0.0',
      ctxMetadata,
      validation: { requests: 'off', responses: 'off' },
    });
    const res = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_adcp_capabilities', arguments: {} },
    });
    const caps = res.structuredContent;
    assert.ok(caps.supported_protocols.includes('sponsored_intelligence'));
  });

  it('auto-stores the session record after initiateSession so sendMessage hydrates req.session', async () => {
    let initObserved, sendObserved;
    const platform = makePlatform({
      initiateSession: async (params, _ctx) => {
        initObserved = params;
        return {
          session_id: 'sess_42',
          session_status: 'active',
          session_ttl_seconds: 900,
          negotiated_capabilities: { commerce: { acp_checkout: true } },
        };
      },
      sendMessage: async (params, _ctx) => {
        sendObserved = params;
        return { session_id: params.session_id, session_status: 'active' };
      },
    });
    const ctxMetadata = makeStore();
    const server = createAdcpServerFromPlatform(platform, {
      name: 'Test SI',
      version: '1.0.0',
      ctxMetadata,
      validation: { requests: 'off', responses: 'off' },
    });

    await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'si_initiate_session',
        arguments: {
          intent: 'shopping for trail shoes',
          offering_id: 'off_trail',
          identity: { consent_granted: false },
          idempotency_key: 'idem_si_init_001_aaaaaaaa',
        },
      },
    });
    assert.equal(initObserved.intent, 'shopping for trail shoes');

    await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'si_send_message',
        arguments: {
          session_id: 'sess_42',
          message: 'show me the second one',
          idempotency_key: 'idem_si_send_001_aaaaaaaa',
        },
      },
    });

    assert.ok(sendObserved, 'sendMessage was called');
    assert.ok(sendObserved.session, 'req.session was hydrated from the auto-stored record');
    assert.equal(sendObserved.session.session_id, 'sess_42');
    assert.equal(sendObserved.session.intent, 'shopping for trail shoes');
    assert.equal(sendObserved.session.offering_id, 'off_trail');
    assert.equal(sendObserved.session.session_status, 'active');
    assert.equal(sendObserved.session.session_ttl_seconds, 900);
    assert.deepEqual(sendObserved.session.negotiated_capabilities, { commerce: { acp_checkout: true } });
  });

  it('hydrates req.session on terminateSession with the same record from initiateSession', async () => {
    let terminateObserved;
    const platform = makePlatform({
      initiateSession: async () => ({ session_id: 'sess_term', session_status: 'active' }),
      terminateSession: async (params, _ctx) => {
        terminateObserved = params;
        return { session_id: params.session_id, terminated: true, session_status: 'terminated' };
      },
    });
    const ctxMetadata = makeStore();
    const server = createAdcpServerFromPlatform(platform, {
      name: 'Test SI',
      version: '1.0.0',
      ctxMetadata,
      validation: { requests: 'off', responses: 'off' },
    });

    await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'si_initiate_session',
        arguments: {
          intent: 'quick browse',
          identity: { consent_granted: false },
          idempotency_key: 'idem_si_init_002_aaaaaaaa',
        },
      },
    });

    await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'si_terminate_session',
        arguments: { session_id: 'sess_term', reason: 'user_exit' },
      },
    });

    assert.ok(terminateObserved.session, 'req.session was hydrated on terminateSession');
    assert.equal(terminateObserved.session.session_id, 'sess_term');
    assert.equal(terminateObserved.session.intent, 'quick browse');
  });

  it('does not register SI tools when sponsoredIntelligence platform field is absent', () => {
    const platform = {
      capabilities: { adcp_version: '3.0.0', specialisms: [], idempotency: { replay_ttl_seconds: 86400 } },
      accounts: {
        resolution: 'derived',
        resolve: async () => ({ id: 'acct_default', operator: 'test', ctx_metadata: {} }),
        upsert: async () => ({ ok: true, items: [] }),
        list: async () => ({ items: [], nextCursor: null }),
      },
    };
    const ctxMetadata = makeStore();
    const server = createAdcpServerFromPlatform(platform, {
      name: 'Test no-SI',
      version: '1.0.0',
      ctxMetadata,
      validation: { requests: 'off', responses: 'off' },
    });
    const registered = registeredTools(server);
    assert.equal(registered.includes('si_initiate_session'), false);
    assert.equal(registered.includes('si_send_message'), false);
  });
});
