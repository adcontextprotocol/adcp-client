const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  applyFixtureBindingsSafely,
  buildStepRequest,
  prepareGovernedStoryboardWireArgs,
  runStoryboardStep,
} = require('../../dist/lib/testing/storyboard/runner.js');
const { prepareProtocolToolCall } = require('../../dist/lib/protocols/index.js');
const { preparedProtocolToolCallFor } = require('../../dist/lib/protocols/prepared-call-context.js');
const { computeGovernedPayloadHash } = require('../../dist/lib/governance/authorization.js');
const { SingleAgentClient, ProtocolClient } = require('../../dist/lib/index.js');

const options = {
  protocol: 'mcp',
  adcpVersion: '3.2.0-rc.7',
  versionEnvelope: 'auto',
  brand: { domain: 'advertiser.example' },
};

test('check_governance approves the same version envelope sent to the governed tool', () => {
  const payload = {
    account: { account_id: 'acc-1' },
    mode: 'generate',
    transformer_id: 'transformer-1',
    message: 'Summer sale',
    idempotency_key: 'build-1',
  };
  const step = {
    id: 'approve',
    title: 'Approve creative build',
    task: 'check_governance',
    sample_request: {
      phase: 'intent',
      plan_id: 'plan-1',
      tool: 'build_creative',
      target_agent: 'https://creative.example/mcp',
      payload,
    },
  };
  const request = buildStepRequest(step, step, {}, { ...options, brand: undefined });
  assert.deepEqual(request.payload, {
    adcp_major_version: 3,
    adcp_version: '3.2-rc.7',
    ...payload,
  });
  const governedStep = {
    id: 'build',
    title: 'Build creative',
    task: 'build_creative',
    sample_request: { ...payload, governance_context: { token: 'approved' } },
  };
  const built = buildStepRequest(governedStep, governedStep, {}, { ...options, brand: undefined });
  const received = prepareProtocolToolCall(
    { id: 'creative', name: 'Creative', agent_uri: 'https://creative.example/mcp', protocol: 'mcp' },
    built,
    { toolName: 'build_creative', adcpVersion: options.adcpVersion, versionEnvelope: options.versionEnvelope }
  ).args;
  assert.equal(computeGovernedPayloadHash(request.payload), computeGovernedPayloadHash(received));
});

test('a governed build_creative request keeps the approved business payload', () => {
  const approvedPayload = {
    account: { account_id: 'acc-1' },
    mode: 'generate',
    transformer_id: 'transformer-1',
    message: 'Summer sale',
    idempotency_key: 'build-1',
  };
  const step = {
    id: 'build',
    title: 'Build creative',
    task: 'build_creative',
    sample_request: { ...approvedPayload, governance_context: { token: 'approved' } },
  };
  const request = buildStepRequest(step, step, {}, { ...options, brand: undefined });
  assert.deepEqual(request, step.sample_request);
  assert.equal('brand' in request, false);
  assert.equal('quality' in request, false);
  assert.equal('include_preview' in request, false);
});

test('a governed request override remains exact after context injection', () => {
  const override = {
    account: { account_id: 'acc-1' },
    mode: 'generate',
    message: '$context.message',
    idempotency_key: 'build-override',
    governance_context: { token: 'approved' },
  };
  const step = { id: 'override', title: 'Override', task: 'build_creative', sample_request: {} };
  const request = buildStepRequest(
    step,
    step,
    { message: 'Approved copy' },
    {
      ...options,
      brand: undefined,
      request: override,
    }
  );
  assert.deepEqual(request, { ...override, message: 'Approved copy' });
});

test('context_inputs governance token preserves the approved build_creative request', () => {
  const payload = { mode: 'generate', message: 'Summer sale', idempotency_key: 'context-build' };
  const step = {
    id: 'build_from_context',
    title: 'Build',
    task: 'build_creative',
    sample_request: payload,
    context_inputs: [{ key: 'token', inject_at: 'governance_context' }],
  };
  const built = buildStepRequest(step, step, { token: { token: 'approved' } }, { ...options, brand: undefined });
  assert.deepEqual(built, { ...payload, governance_context: { token: 'approved' } });
  assert.equal('quality' in built, false);
  assert.equal('include_preview' in built, false);
});

test('governance approval payload is transport-independent without a webhook', () => {
  const step = {
    id: 'approve',
    title: 'Approve',
    task: 'check_governance',
    sample_request: {
      phase: 'intent',
      plan_id: 'plan-1',
      tool: 'activate_signal',
      target_agent: 'https://signals.example/mcp',
      payload: { account: { account_id: 'acc-1' }, idempotency_key: 'activate-1' },
    },
  };
  const mcpPayload = buildStepRequest(step, step, {}, { ...options, protocol: 'mcp' }).payload;
  const a2aPayload = buildStepRequest(step, step, {}, { ...options, protocol: 'a2a' }).payload;
  assert.deepEqual(a2aPayload, mcpPayload);
});

test('a consultation re-check with prior governance context still envelopes its intent payload', () => {
  const step = {
    id: 'recheck',
    title: 'Re-check',
    task: 'check_governance',
    sample_request: {
      phase: 'intent',
      plan_id: 'plan-1',
      tool: 'build_creative',
      target_agent: 'https://creative.example/mcp',
      governance_context: { token: 'prior' },
      payload: { mode: 'generate', message: 'Summer sale', idempotency_key: 'recheck-build' },
    },
  };
  const request = buildStepRequest(step, step, {}, { ...options, brand: undefined });
  assert.equal(request.payload.adcp_version, '3.2-rc.7');
  assert.equal(request.payload.adcp_major_version, 3);
});

test('governed mutations do not mint an unapproved idempotency key', () => {
  const step = {
    id: 'build_without_key',
    title: 'Build creative',
    task: 'build_creative',
    sample_request: { mode: 'generate', governance_context: { token: 'approved' } },
  };
  assert.deepEqual(buildStepRequest(step, step, {}, { ...options, brand: undefined }), step.sample_request);
});

test('the runner also suppresses the SDK idempotency default for governed steps', async () => {
  const step = {
    id: 'build_without_key',
    title: 'Build',
    task: 'build_creative',
    sample_request: { mode: 'generate', governance_context: 'approved' },
    expect_error: true,
    negative_path: 'schema_invalid',
    validations: [],
  };
  const storyboard = {
    id: 'governed_missing_key',
    version: '1.0.0',
    title: 'Governed request',
    category: 'test',
    summary: '',
    narrative: '',
    agent: { interaction_model: 'sync', capabilities: [] },
    caller: { role: 'buyer_agent' },
    phases: [{ id: 'p', title: 'Build', steps: [step] }],
  };
  let sent;
  const result = await runStoryboardStep('https://creative.example/mcp', storyboard, step.id, {
    protocol: 'mcp',
    agentTools: ['build_creative'],
    _profile: { name: 'Creative', tools: ['build_creative'] },
    _client: {
      getAgentInfo: async () => ({ name: 'Creative', tools: [{ name: 'build_creative' }] }),
      buildCreativeLegacy: async (params, _handler, taskOptions) => {
        sent = { params, taskOptions };
        return { success: true, status: 'completed', data: { creative_id: 'creative-1' }, metadata: {} };
      },
      resetContext: () => {},
    },
  });
  assert.ok(sent, JSON.stringify(result));
  assert.equal(sent.params.idempotency_key, undefined);
  assert.equal(sent.taskOptions.skipIdempotencyAutoInject, true);
  assert.equal(sent.taskOptions.preserveGovernedPayload, true);
});

test('missing approved idempotency keys fail their step before dispatch', async () => {
  const step = {
    id: 'build_without_approved_key',
    title: 'Build',
    task: 'build_creative',
    sample_request: { mode: 'generate', governance_context: 'approved' },
    validations: [],
  };
  const storyboard = {
    id: 'governed_authoring_error',
    version: '1.0.0',
    title: 'Governed request',
    category: 'test',
    summary: '',
    narrative: '',
    agent: { interaction_model: 'sync', capabilities: [] },
    caller: { role: 'buyer_agent' },
    phases: [{ id: 'p', title: 'Build', steps: [step] }],
  };
  const result = await runStoryboardStep('https://creative.example/mcp', storyboard, step.id, {
    protocol: 'mcp',
    agentTools: ['build_creative'],
    _profile: { name: 'Creative', tools: ['build_creative'] },
    _client: {
      getAgentInfo: async () => ({ name: 'Creative', tools: [{ name: 'build_creative' }] }),
      buildCreativeLegacy: async () => {
        throw new Error('invalid fixture must not dispatch');
      },
      resetContext: () => {},
    },
  });
  assert.equal(result.passed, false);
  assert.match(result.error, /must author the idempotency_key approved by check_governance/);
  assert.equal(result.validations[0].json_pointer, '/idempotency_key');
});

test('the approved payload matches the SDK protocol boundary for build_creative', async () => {
  const agent = { id: 'creative', name: 'Creative', agent_uri: 'https://creative.example/mcp', protocol: 'mcp' };
  const payload = {
    account: { account_id: 'acc-1' },
    mode: 'generate',
    message: 'Summer sale',
    idempotency_key: 'wire-build',
  };
  const approvalStep = {
    id: 'approve_wire',
    title: 'Approve',
    task: 'check_governance',
    sample_request: {
      phase: 'intent',
      plan_id: 'plan-1',
      tool: 'build_creative',
      target_agent: agent.agent_uri,
      payload,
    },
  };
  const governedStep = {
    id: 'build_wire',
    title: 'Build',
    task: 'build_creative',
    sample_request: { ...payload, governance_context: 'approved' },
  };
  const approval = buildStepRequest(approvalStep, approvalStep, {}, options);
  const governed = buildStepRequest(governedStep, governedStep, {}, options);
  const client = new SingleAgentClient(agent, {
    adcpVersion: options.adcpVersion,
    validateFeatures: false,
    validation: { requests: 'off', responses: 'off' },
  });
  client.ensureEndpointDiscovered = async () => agent;
  client.detectServerVersion = async () => 'v3';
  client.getCapabilities = async () => ({
    version: 'v3',
    majorVersions: [3],
    supportedVersions: [options.adcpVersion],
    protocols: ['creative'],
    features: {},
    extensions: [],
    _synthetic: true,
  });
  const originalCallTool = ProtocolClient.callTool;
  let sent;
  ProtocolClient.callTool = async (target, tool, params, taskOptions) => {
    assert.equal(tool, 'build_creative');
    sent = preparedProtocolToolCallFor(target, tool, params)?.args;
    assert.ok(sent, 'TaskExecutor must hand the prepared wire request to ProtocolClient');
    return { structuredContent: { status: 'completed', creative_id: 'creative-1' } };
  };
  try {
    await client.buildCreativeLegacy(governed, undefined, { preserveGovernedPayload: true });
  } finally {
    ProtocolClient.callTool = originalCallTool;
  }
  assert.equal(computeGovernedPayloadHash(approval.payload), computeGovernedPayloadHash(sent));
});

test('governed requests bypass buyer normalization and seller field stripping', async () => {
  const agent = { id: 'creative', name: 'Creative', agent_uri: 'https://creative.example/mcp', protocol: 'mcp' };
  const payload = {
    account_id: 'acc-1',
    mode: 'generate',
    message: 'Summer sale',
    idempotency_key: 'preserved-build',
  };
  const approvalStep = {
    id: 'approve_preserved',
    title: 'Approve',
    task: 'check_governance',
    sample_request: {
      phase: 'intent',
      plan_id: 'plan-1',
      tool: 'build_creative',
      target_agent: agent.agent_uri,
      payload,
    },
  };
  const governedStep = {
    id: 'build_preserved',
    title: 'Build',
    task: 'build_creative',
    sample_request: { ...payload, governance_context: 'approved' },
  };
  const approval = buildStepRequest(approvalStep, approvalStep, {}, options);
  const governed = buildStepRequest(governedStep, governedStep, {}, options);
  const client = new SingleAgentClient(agent, {
    adcpVersion: options.adcpVersion,
    validateFeatures: false,
    validation: { requests: 'off', responses: 'off' },
  });
  client.ensureEndpointDiscovered = async () => agent;
  client.detectServerVersion = async () => 'v3';
  client.cachedToolSchemas = new Map([['build_creative', { mode: {}, message: {}, idempotency_key: {} }]]);
  client.getCapabilities = async () => ({
    version: 'v3',
    majorVersions: [3],
    supportedVersions: [options.adcpVersion],
    protocols: ['creative'],
    features: {},
    extensions: [],
    _synthetic: true,
  });
  const originalCallTool = ProtocolClient.callTool;
  let sent;
  ProtocolClient.callTool = async (target, tool, params) => {
    sent = preparedProtocolToolCallFor(target, tool, params)?.args;
    assert.ok(sent);
    return { structuredContent: { status: 'completed', creative_id: 'creative-1' } };
  };
  try {
    await client.buildCreativeLegacy(governed, undefined, {
      preserveGovernedPayload: true,
      skipRequestValidation: true,
    });
  } finally {
    ProtocolClient.callTool = originalCallTool;
  }
  assert.equal(sent.account_id, 'acc-1');
  assert.equal(sent.account, undefined);
  assert.equal(computeGovernedPayloadHash(approval.payload), computeGovernedPayloadHash(sent));
});

test('the preservation option also blocks SDK idempotency minting', async () => {
  const agent = { id: 'creative', name: 'Creative', agent_uri: 'https://creative.example/mcp', protocol: 'mcp' };
  const client = new SingleAgentClient(agent, {
    adcpVersion: options.adcpVersion,
    validateFeatures: false,
    validation: { requests: 'off', responses: 'off' },
  });
  client.ensureEndpointDiscovered = async () => agent;
  client.detectServerVersion = async () => 'v3';
  client.getCapabilities = async () => ({
    version: 'v3',
    majorVersions: [3],
    supportedVersions: [options.adcpVersion],
    protocols: ['creative'],
    features: {},
    extensions: [],
    _synthetic: true,
  });
  const originalCallTool = ProtocolClient.callTool;
  let sent;
  ProtocolClient.callTool = async (target, tool, params) => {
    sent = preparedProtocolToolCallFor(target, tool, params)?.args;
    return { structuredContent: { status: 'completed', creative_id: 'creative-1' } };
  };
  try {
    await client.buildCreativeLegacy(
      { mode: 'generate', message: 'Summer sale', governance_context: 'approved' },
      undefined,
      { preserveGovernedPayload: true, skipRequestValidation: true }
    );
  } finally {
    ProtocolClient.callTool = originalCallTool;
  }
  assert.ok(sent);
  assert.equal(sent.idempotency_key, undefined);
});

test('governed media buys send approved legacy aliases without local rewriting', async () => {
  const agent = { id: 'sales', name: 'Sales', agent_uri: 'https://sales.example/mcp', protocol: 'mcp' };
  const client = new SingleAgentClient(agent, {
    adcpVersion: options.adcpVersion,
    validateFeatures: false,
    validation: { requests: 'off', responses: 'off' },
  });
  client.ensureEndpointDiscovered = async () => agent;
  client.detectServerVersion = async () => 'v3';
  client.getCapabilities = async () => ({
    version: 'v3',
    majorVersions: [3],
    supportedVersions: [options.adcpVersion],
    protocols: ['media_buy'],
    features: {},
    extensions: [],
    _synthetic: true,
  });
  const approvedPayload = {
    account_id: 'acc-1',
    packages: [{ product_id: 'product-1', optimization_goal: 'reach' }],
    idempotency_key: 'alias-buy',
  };
  const originalCallTool = ProtocolClient.callTool;
  let sent;
  ProtocolClient.callTool = async (target, tool, params) => {
    sent = preparedProtocolToolCallFor(target, tool, params)?.args;
    return { structuredContent: { status: 'completed', media_buy_id: 'buy-1' } };
  };
  try {
    await client.createMediaBuyLegacy({ ...approvedPayload, governance_context: 'approved' }, undefined, {
      preserveGovernedPayload: true,
    });
  } finally {
    ProtocolClient.callTool = originalCallTool;
  }
  assert.ok(sent);
  assert.equal(sent.account_id, 'acc-1');
  assert.equal(sent.account, undefined);
  assert.equal(sent.packages[0].optimization_goal, 'reach');
  assert.equal(sent.packages[0].optimization_goals, undefined);
  const expected = prepareGovernedStoryboardWireArgs(approvedPayload, 'create_media_buy', agent.agent_uri, options);
  assert.equal(computeGovernedPayloadHash(expected), computeGovernedPayloadHash(sent));
});

test('canonical creative methods reject exact-payload preservation before reshaping', async () => {
  const agent = { id: 'sales', name: 'Sales', agent_uri: 'https://sales.example/mcp', protocol: 'mcp' };
  const client = new SingleAgentClient(agent, { adcpVersion: options.adcpVersion });
  for (const [method, request] of [
    ['createMediaBuy', { packages: [{ format_ids: ['format-1'] }], governance_context: 'approved' }],
    ['updateMediaBuy', { packages: [{ format_ids: ['format-1'] }], governance_context: 'approved' }],
    ['syncCreatives', { creatives: [], governance_context: 'approved' }],
  ]) {
    await assert.rejects(
      client[method](request, undefined, { preserveGovernedPayload: true }),
      /requires the raw legacy task method/
    );
  }
});

test('MCP auth overrides use the same wire envelope as the approved payload', () => {
  const payload = { mode: 'generate', message: 'Summer sale', idempotency_key: 'auth-build' };
  const agentUri = 'https://creative.example/mcp';
  const approvalStep = {
    id: 'approve_auth',
    title: 'Approve',
    task: 'check_governance',
    sample_request: { phase: 'intent', plan_id: 'plan-1', tool: 'build_creative', target_agent: agentUri, payload },
  };
  const governedStep = {
    id: 'build_auth',
    title: 'Build',
    task: 'build_creative',
    auth: { type: 'valid' },
    sample_request: { ...payload, governance_context: 'approved' },
  };
  const approval = buildStepRequest(approvalStep, approvalStep, {}, options);
  const governed = buildStepRequest(governedStep, governedStep, {}, options);
  const rawProbeArgs = prepareGovernedStoryboardWireArgs(governed, governedStep.task, agentUri, options);

  assert.equal(rawProbeArgs.adcp_version, approval.payload.adcp_version);
  assert.equal(rawProbeArgs.adcp_major_version, approval.payload.adcp_major_version);
  assert.equal(computeGovernedPayloadHash(approval.payload), computeGovernedPayloadHash(rawProbeArgs));
});

test('legacy governance steps keep their previous runner defaults', () => {
  const step = {
    id: 'legacy_build',
    title: 'Build',
    task: 'build_creative',
    sample_request: { mode: 'generate', governance_context: 'legacy-token' },
  };
  const request = buildStepRequest(step, step, {}, { ...options, adcpVersion: '3.1.24' });
  assert.equal(typeof request.idempotency_key, 'string');
  assert.equal(request.quality, 'draft');
  assert.equal(request.include_preview, true);
});

test('sandbox hints are identical in approval payloads and governed requests', () => {
  const runOptions = { ...options, disable_sandbox: true };
  const payload = {
    account: { account_id: 'acc-1' },
    packages: [],
    idempotency_key: 'buy-sandbox',
  };
  const approvalStep = {
    id: 'approve_sandbox',
    title: 'Approve',
    task: 'check_governance',
    sample_request: {
      phase: 'intent',
      plan_id: 'plan-1',
      tool: 'create_media_buy',
      target_agent: 'https://sales.example/mcp',
      payload,
    },
  };
  const governedStep = {
    id: 'buy_sandbox',
    title: 'Buy',
    task: 'create_media_buy',
    sample_request: { ...payload, governance_context: { token: 'approved' } },
  };
  const approval = buildStepRequest(approvalStep, approvalStep, {}, runOptions);
  const governed = buildStepRequest(governedStep, governedStep, {}, runOptions);
  assert.deepEqual(approval.payload.ext, { adcp: { disable_sandbox: true } });
  assert.deepEqual(governed.ext, approval.payload.ext);
  const sent = prepareProtocolToolCall(
    { id: 'sales', name: 'Sales', agent_uri: 'https://sales.example/mcp', protocol: 'mcp' },
    governed,
    { toolName: 'create_media_buy', adcpVersion: runOptions.adcpVersion, versionEnvelope: runOptions.versionEnvelope }
  ).args;
  assert.equal(computeGovernedPayloadHash(approval.payload), computeGovernedPayloadHash(sent));
});

test('run-scoped brand is applied before approval and remains equal downstream', () => {
  const payload = {
    mode: 'generate',
    message: 'Summer sale',
    idempotency_key: 'brand-build',
  };
  const approvalStep = {
    id: 'approve_brand',
    title: 'Approve',
    task: 'check_governance',
    sample_request: {
      phase: 'intent',
      plan_id: 'plan-1',
      tool: 'build_creative',
      target_agent: 'https://creative.example/mcp',
      payload,
    },
  };
  const governedStep = {
    id: 'build_brand',
    title: 'Build',
    task: 'build_creative',
    sample_request: { ...payload, governance_context: { token: 'approved' } },
  };
  const approval = buildStepRequest(approvalStep, approvalStep, {}, options);
  const governed = buildStepRequest(governedStep, governedStep, {}, options);
  assert.deepEqual(approval.payload.brand, options.brand);
  assert.deepEqual(governed.brand, options.brand);
  const sent = prepareProtocolToolCall(
    { id: 'creative', name: 'Creative', agent_uri: 'https://creative.example/mcp', protocol: 'mcp' },
    governed,
    { toolName: 'build_creative', adcpVersion: options.adcpVersion, versionEnvelope: options.versionEnvelope }
  ).args;
  assert.equal(computeGovernedPayloadHash(approval.payload), computeGovernedPayloadHash(sent));
});

test('fixture handles resolve identically in approval payload and governed request', () => {
  const payload = {
    account: { account_id: 'acc-1' },
    brand: { domain: 'advertiser.example' },
    packages: [{ product_id: 'fixture-product', pricing_option_id: 'fixture-price' }],
    total_budget: 100,
    start_time: 'asap',
    end_time: '2027-01-01T00:00:00Z',
    idempotency_key: 'buy-1',
  };
  const bindings = {
    productId: value => (value === 'fixture-product' ? 'seller-product' : undefined),
    pricingOptionId: (value, product) =>
      value === 'fixture-price' && product === 'fixture-product' ? 'seller-price' : undefined,
  };
  const runState = { fixtureBindings: bindings };
  const approvalStep = {
    id: 'approve_buy',
    title: 'Approve buy',
    task: 'check_governance',
    sample_request: {
      phase: 'intent',
      plan_id: 'plan-1',
      tool: 'create_media_buy',
      target_agent: 'https://sales.example/mcp',
      payload,
    },
  };
  const governedStep = {
    id: 'buy',
    title: 'Buy',
    task: 'create_media_buy',
    sample_request: { ...payload, governance_context: { token: 'approved' } },
  };
  const approval = applyFixtureBindingsSafely(
    buildStepRequest(approvalStep, approvalStep, {}, options),
    'check_governance',
    options,
    runState
  );
  const governed = applyFixtureBindingsSafely(
    buildStepRequest(governedStep, governedStep, {}, options),
    'create_media_buy',
    options,
    runState
  );
  assert.equal(approval.ok, true);
  assert.equal(governed.ok, true);
  assert.equal(approval.request.payload.packages[0].product_id, 'seller-product');
  assert.equal(approval.request.payload.packages[0].pricing_option_id, 'seller-price');
  assert.equal(governed.request.packages[0].product_id, 'seller-product');
  const sent = prepareProtocolToolCall(
    { id: 'sales', name: 'Sales', agent_uri: 'https://sales.example/mcp', protocol: 'mcp' },
    governed.request,
    { toolName: 'create_media_buy', adcpVersion: options.adcpVersion, versionEnvelope: options.versionEnvelope }
  ).args;
  assert.equal(computeGovernedPayloadHash(approval.request.payload), computeGovernedPayloadHash(sent));
});
