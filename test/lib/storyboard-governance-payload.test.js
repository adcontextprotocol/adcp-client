const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyFixtureBindingsSafely, buildStepRequest } = require('../../dist/lib/testing/storyboard/runner.js');
const { prepareProtocolToolCall } = require('../../dist/lib/protocols/index.js');
const { computeGovernedPayloadHash } = require('../../dist/lib/governance/authorization.js');

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
