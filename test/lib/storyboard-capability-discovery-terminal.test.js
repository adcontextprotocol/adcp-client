const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runStoryboard, runStoryboardStep } = require('../../dist/lib/testing/index.js');
const { CAPS, TOOLS, ENDPOINT, board, transport } = require('../helpers/fixture-discovery-seller.js');
function storyboard() {
  const doc = board({
    steps: [
      {
        id: 'probe',
        title: 'Observe capabilities',
        task: 'get_adcp_capabilities',
        sample_request: {},
        validations: [
          { check: 'field_present', path: 'adcp.major_versions', description: 'Actual capability response' },
        ],
      },
    ],
  });
  delete doc.fixtures;
  delete doc.fixture_resolution;
  doc.requires_capability = { path: 'wholesale_feed_versioning.supported', equals: true };
  return doc;
}
const healthy = { ...CAPS, wholesale_feed_versioning: { supported: true } };
function seller(mode, failOnce = false) {
  const io = transport([], { capabilities: () => (mode === 'absent' ? CAPS : healthy) });
  const original = io.options.transport.trustedFetchFn;
  let probes = 0;
  delete io.options.profile;
  io.options.transport.trustedFetchFn = async (input, init = {}) => {
    const rpc = init.body ? JSON.parse(init.body) : undefined;
    if (rpc?.method === 'tools/call' && rpc.params.name === 'get_adcp_capabilities') {
      probes++;
      if ((!failOnce || probes === 1) && ['protocol', 'schema', 'version'].includes(mode)) {
        const data =
          mode === 'schema'
            ? { ...healthy, supported_protocols: 'malformed-protocols' }
            : {
                status: 'failed',
                adcp_error: {
                  code: mode === 'version' ? 'VERSION_UNSUPPORTED' : 'INVALID_REQUEST',
                  message: 'Seller capability rejection',
                  recovery: 'terminal',
                  details:
                    mode === 'version'
                      ? { supported_versions: ['3.1'], requested_version: '3.2' }
                      : { private_key: 'must-not-appear' },
                },
              };
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              ...(mode !== 'schema' && { isError: true }),
              content: [{ type: 'text', text: JSON.stringify(data) }],
            },
          }),
          { headers: { 'content-type': 'application/json' } }
        );
      }
    }
    return original(input, init);
  };
  return { ...io, probes: () => probes };
}
for (const mode of ['protocol', 'schema', 'version']) {
  for (const standalone of [false, true]) {
    test(`${mode} discovery failure is terminal before ${standalone ? 'standalone' : 'full'} capability gates`, async () => {
      const io = seller(mode);
      const result = standalone
        ? await runStoryboardStep(ENDPOINT, storyboard(), 'probe', io.options)
        : await runStoryboard(ENDPOINT, storyboard(), io.options);
      const step = standalone ? result : result.phases[0].steps[0];
      assert.equal(step.step_id, 'discovery_failed', JSON.stringify(result));
      assert.equal(step.task, 'get_adcp_capabilities');
      assert.equal(step.passed, false);
      assert.equal(step.skipped, false);
      assert.equal(step.request.operation, 'get_adcp_capabilities');
      assert.ok(step.response_record, 'actual failing protocol response is retained');
      assert.equal(step.response_record.transport, 'mcp');
      assert.doesNotMatch(JSON.stringify(result), /must-not-appear/);
      if (!standalone) {
        assert.equal(result.failed_count, 1);
        assert.equal(result.skipped_count, 0);
      }
      assert.equal(io.probes(), 1, 'the authored probe must not run after failed preflight');
    });
  }
}
test('successful discovery with an absent optional capability remains a truthful skip', async () => {
  for (const standalone of [false, true]) {
    const io = seller('absent');
    const result = standalone
      ? await runStoryboardStep(ENDPOINT, storyboard(), 'probe', io.options)
      : await runStoryboard(ENDPOINT, storyboard(), io.options);
    const step = standalone ? result : result.phases[0].steps[0];
    assert.equal(step.passed, true);
    assert.equal(step.skipped, true);
    assert.equal(step.skip_reason, standalone ? 'not_applicable' : 'capability_unsupported');
    assert.equal(io.probes(), 1);
  }
});
test('a fail-once seller can recover on the next full or standalone invocation', async () => {
  for (const standalone of [false, true]) {
    const io = seller('protocol', true);
    const run = () =>
      standalone
        ? runStoryboardStep(ENDPOINT, storyboard(), 'probe', io.options)
        : runStoryboard(ENDPOINT, storyboard(), io.options);
    const first = await run();
    assert.equal(standalone ? first.passed : first.overall_passed, false);
    const recovered = await run();
    assert.equal(standalone ? recovered.passed : recovered.overall_passed, true, JSON.stringify(recovered));
    assert.equal(io.probes(), 3);
  }
});
for (const evidence of [
  { capabilities_probe_error: 'Previous capability probe failed' },
  {
    capabilities_failure: {
      step: 'Discover capabilities',
      passed: false,
      duration_ms: 0,
      error: 'Previous capability probe failed',
    },
  },
  { raw_capabilities: [] },
  { raw_capabilities: { adcp_error: { code: 'INVALID_REQUEST' } } },
]) {
  test(`failed supplied profile cannot become an applicability skip: ${JSON.stringify(evidence)}`, async () => {
    for (const standalone of [false, true]) {
      const io = seller('healthy');
      const options = { ...io.options, profile: { name: 'Caller-owned profile', tools: TOOLS, ...evidence } };
      const result = standalone
        ? await runStoryboardStep(ENDPOINT, storyboard(), 'probe', options)
        : await runStoryboard(ENDPOINT, storyboard(), options);
      const step = standalone ? result : result.phases[0].steps[0];
      assert.equal(step.step_id, 'discovery_failed', JSON.stringify(result));
      assert.equal(step.passed, false);
      assert.equal(step.skipped, false);
      assert.equal(io.probes(), 0, 'caller-provided evidence is not silently re-probed');
    }
  });
}
test('malformed public profile tools are rejected as caller input before contact', async () => {
  const io = seller('healthy');
  await assert.rejects(
    runStoryboard(ENDPOINT, storyboard(), { ...io.options, profile: { name: 'Malformed', tools: 42 } }),
    /profile.*tool names/
  );
  assert.deepEqual(io.wire, []);
});
function oauthSeller() {
  const io = seller('healthy');
  const original = io.options.transport.trustedFetchFn;
  let challenged = false;
  io.options.transport.trustedFetchFn = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/metadata') || url.includes('/.well-known/oauth-protected-resource'))
      return Response.json({ resource: ENDPOINT, authorization_servers: ['https://issuer.example'] });
    if (url.startsWith('https://issuer.example'))
      return Response.json({
        issuer: 'https://issuer.example',
        authorization_endpoint: 'https://issuer.example/authorize',
        token_endpoint: 'https://issuer.example/token',
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
      });
    const rpc = init.body ? JSON.parse(init.body) : undefined;
    if (rpc?.method === 'tools/call' && rpc.params?.name === 'get_adcp_capabilities') challenged = true;
    if (challenged && (rpc?.method === 'tools/list' || rpc?.params?.name === 'get_adcp_capabilities'))
      return new Response(null, {
        status: 401,
        headers: { 'www-authenticate': `Bearer resource_metadata="https://prepared-fixtures-test.example/metadata"` },
      });
    return original(input, init);
  };
  return io;
}
test('OAuth metadata from a capability challenge survives native discovery failure', async () => {
  const io = oauthSeller();
  const result = await runStoryboard(ENDPOINT, storyboard(), io.options);
  const failed = result.phases[0].steps[0];
  assert.equal(failed.step_id, 'discovery_failed');
  assert.equal(failed.passed, false);
  assert.equal(failed.authorization_required?.resource, ENDPOINT, JSON.stringify(failed));
  assert.equal(failed.authorization_required.authorizationEndpoint, 'https://issuer.example/authorize');
});

test('an ungated capability diagnostic retains schema notices and grades its actual response', async () => {
  const io = seller('schema');
  const doc = storyboard();
  delete doc.requires_capability;
  doc.phases[0].steps[0].validations = [
    { check: 'response_schema', description: 'Actual advertised capability schema' },
  ];
  const result = await runStoryboard(ENDPOINT, doc, io.options);
  const step = result.phases[0].steps[0];
  assert.equal(step.step_id, 'probe');
  assert.equal(step.validations.find(v => v.check === 'response_schema').passed, false);
  assert.ok(result.notices.some(n => n.code === 'capabilities_response_schema_invalid'));
  assert.equal(io.probes(), 2);
});

test('the public AgentClient retains validated OAuth requirements on TaskResult.errorInstance', async () => {
  const { AgentClient, NeedsAuthorizationError, closeMCPConnections } = require('../../dist/lib/index.js');
  const io = oauthSeller();
  const client = new AgentClient(
    { id: 'oauth-core', name: 'OAuth seller', protocol: 'mcp', agent_uri: ENDPOINT },
    { transport: io.options.transport, adcpVersion: '3.2.6' }
  );
  try {
    const result = await client.getAdcpCapabilities({});
    assert.equal(result.success, false);
    assert.ok(result.errorInstance instanceof NeedsAuthorizationError, JSON.stringify(result));
    assert.equal(result.errorInstance.requirements.resource, ENDPOINT);
    assert.equal(result.errorInstance.requirements.authorizationEndpoint, 'https://issuer.example/authorize');
  } finally {
    await closeMCPConnections();
  }
});

for (const gate of [
  'implicit_signer',
  'signed_requests',
  'explicit_signer',
  'oauth_metadata',
  'account_mode',
  'creative_build',
]) {
  test(`schema-invalid discovery is terminal before the ${gate} gate`, async () => {
    for (const standalone of [false, true]) {
      const io = seller('schema');
      const doc = storyboard();
      delete doc.requires_capability;
      if (gate === 'signed_requests') doc.id = 'signed_requests';
      if (gate === 'explicit_signer') doc.requires = ['request_signer'];
      if (gate === 'implicit_signer') doc.phases[0].steps[0].task = 'request_signing_probe';
      if (gate === 'oauth_metadata') doc.phases[0].steps[0].task = 'protected_resource_metadata';
      if (gate === 'account_mode') doc.phases[0].steps[0].task = 'sync_accounts';
      if (gate === 'creative_build')
        doc.creative_build_probe = { context_prefix: 'build', message: 'Build a sandbox creative' };
      const result = standalone
        ? await runStoryboardStep(ENDPOINT, doc, 'probe', io.options)
        : await runStoryboard(ENDPOINT, doc, io.options);
      const step = standalone ? result : result.phases[0].steps[0];
      assert.equal(step.step_id, 'discovery_failed', JSON.stringify(result));
      assert.equal(step.passed, false);
      assert.equal(step.skipped, false);
      assert.equal(io.probes(), 1);
    }
  });
}
