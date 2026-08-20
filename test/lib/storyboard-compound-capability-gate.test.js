const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  describeStoryboardCapabilityGates,
  runStoryboard,
  runStoryboardStep,
} = require('../../dist/lib/testing/storyboard/index.js');
const { validateStoryboardShape } = require('../../dist/lib/testing/storyboard/loader.js');

function buildStoryboard(overrides = {}) {
  return {
    id: 'compound_capability_gate',
    version: '1.0.0',
    title: 'Compound capability gate',
    category: 'testing',
    summary: '',
    narrative: '',
    agent: { interaction_model: 'media_buy_seller', capabilities: [] },
    caller: { role: 'buyer_agent' },
    requires_all_capabilities: [
      { path: 'media_buy.propagation_surfaces', contains: 'snapshot' },
      { path: 'creative.has_creative_library', equals: true },
    ],
    required_tools: ['sync_creatives', 'get_products'],
    phases: [
      {
        id: 'run',
        title: 'Run',
        steps: [
          {
            id: 'discover',
            title: 'Discover',
            task: 'get_products',
            sample_request: { buying_mode: 'brief', brief: 'test' },
            validations: [],
          },
        ],
      },
    ],
    ...overrides,
  };
}

function profile({ snapshot = true, creativeLibrary = true, autoApprove } = {}) {
  return {
    name: 'Compound gate seller',
    tools: ['get_adcp_capabilities', 'sync_creatives', 'get_products'],
    raw_capabilities: {
      media_buy: {
        propagation_surfaces: snapshot ? ['snapshot'] : ['webhook'],
        ...(autoApprove === undefined
          ? {}
          : { creative_approval_mode: autoApprove ? 'auto_approve' : 'require_human' }),
      },
      creative: { has_creative_library: creativeLibrary },
    },
  };
}

function client() {
  const calls = [];
  return {
    calls,
    instance: {
      async executeTask(name, params) {
        calls.push({ name, params });
        return { success: true, data: { products: [] } };
      },
    },
  };
}

describe('requires_all_capabilities compound storyboard gate (#2623)', () => {
  test('skips when snapshot passes but creative library fails, despite advertised mutation tools', async () => {
    const fake = client();
    const result = await runStoryboard('https://seller.example/mcp', buildStoryboard(), {
      protocol: 'mcp',
      _profile: profile({ creativeLibrary: false }),
      agentTools: ['get_adcp_capabilities', 'sync_creatives', 'get_products'],
      _client: fake.instance,
    });
    assert.equal(result.phases[0].steps[0].skip_reason, 'capability_unsupported');
    assert.match(result.phases[0].steps[0].skip.detail, /creative\.has_creative_library/);
    assert.match(result.phases[0].steps[0].skip.detail, /false/);
    assert.deepEqual(fake.calls, []);
  });

  test('skips when creative library passes but snapshot support fails', async () => {
    const result = await runStoryboard('https://seller.example/mcp', buildStoryboard(), {
      _profile: profile({ snapshot: false }),
    });
    const step = result.phases[0].steps[0];
    assert.equal(step.skip.reason, 'not_applicable');
    assert.match(step.skip.detail, /media_buy\.propagation_surfaces/);
    assert.match(step.skip.detail, /\["webhook"\]/);
  });

  test('dispatches only when every compound predicate passes', async () => {
    const fake = client();
    const result = await runStoryboard('https://seller.example/mcp', buildStoryboard(), {
      protocol: 'mcp',
      _profile: profile(),
      agentTools: profile().tools,
      _client: fake.instance,
    });
    assert.equal(result.skipped_count, 0);
    assert.equal(result.passed_count, 1);
    assert.deepEqual(
      fake.calls.map(call => call.name),
      ['get_products']
    );
  });

  test('compound gates use schema defaults and identify default provenance', async () => {
    const fake = client();
    const defaultSnapshot = await runStoryboard('https://seller.example/mcp', buildStoryboard(), {
      _profile: {
        name: 'Default snapshot seller',
        tools: ['get_products'],
        raw_capabilities: { media_buy: {}, creative: { has_creative_library: true } },
      },
      agentTools: ['get_products'],
      _client: fake.instance,
    });
    assert.equal(defaultSnapshot.skipped_count, 0);
    assert.deepEqual(
      fake.calls.map(call => call.name),
      ['get_products']
    );

    const defaultCreativeLibrary = await runStoryboard('https://seller.example/mcp', buildStoryboard(), {
      _profile: {
        name: 'Default creative-library seller',
        tools: ['get_products'],
        raw_capabilities: { media_buy: { propagation_surfaces: ['snapshot'] }, creative: {} },
      },
    });
    const detail = defaultCreativeLibrary.phases[0].steps[0].skip.detail;
    assert.match(detail, /creative\.has_creative_library/);
    assert.match(detail, /resolved schema default false/);
  });

  test('combines singular and compound forms and reports every failed predicate', async () => {
    const storyboard = buildStoryboard({
      requires_capability: { path: 'media_buy.creative_approval_mode', equals: 'auto_approve' },
    });
    const result = await runStoryboard('https://seller.example/mcp', storyboard, {
      _profile: profile({ snapshot: false, creativeLibrary: false, autoApprove: false }),
    });
    const detail = result.phases[0].steps[0].skip.detail;
    assert.match(detail, /media_buy\.creative_approval_mode/);
    assert.match(detail, /media_buy\.propagation_surfaces/);
    assert.match(detail, /creative\.has_creative_library/);
  });

  test('capability gate precedes runtime requirements', async () => {
    const result = await runStoryboard(
      'https://seller.example/mcp',
      buildStoryboard({ requires: ['webhook_receiver'] }),
      { _profile: profile({ creativeLibrary: false }) }
    );
    assert.equal(result.phases[0].steps[0].skip_reason, 'capability_unsupported');
  });

  test('catalog description renders every predicate as an AND gate', () => {
    const description = describeStoryboardCapabilityGates(buildStoryboard());
    assert.equal(
      description,
      'media_buy.propagation_surfaces contains "snapshot" AND creative.has_creative_library = true'
    );
    assert.doesNotMatch(description, /always graded/);
  });

  test('auto-approval plus missing creative library skips pending-creatives-shaped workflows', async () => {
    const storyboard = buildStoryboard({
      requires_all_capabilities: [
        { path: 'media_buy.creative_approval_mode', equals: 'auto_approve' },
        { path: 'creative.has_creative_library', equals: true },
      ],
    });
    const result = await runStoryboard('https://seller.example/mcp', storyboard, {
      _profile: profile({ creativeLibrary: false, autoApprove: true }),
    });
    const detail = result.phases[0].steps[0].skip.detail;
    assert.match(detail, /creative\.has_creative_library/);
    assert.match(detail, /declared value false/);
  });

  test('multi-pass returns one whole-storyboard skip before dispatch', async () => {
    const result = await runStoryboard(
      ['https://seller-a.example/mcp', 'https://seller-b.example/mcp'],
      buildStoryboard(),
      {
        multi_instance_strategy: 'multi-pass',
        _profile: profile({ creativeLibrary: false }),
      }
    );
    assert.equal(result.phases.length, 1);
    assert.equal(result.phases[0].steps[0].skip_reason, 'capability_unsupported');
    assert.equal(result.passes, undefined);
  });

  test('single-step execution enforces the compound gate before its tool call', async () => {
    const fake = client();
    const result = await runStoryboardStep('https://seller.example/mcp', buildStoryboard(), 'discover', {
      _profile: profile({ creativeLibrary: false }),
      _client: fake.instance,
    });
    assert.equal(result.skip_reason, 'not_applicable');
    assert.match(result.skip.detail, /creative\.has_creative_library/);
    assert.deepEqual(fake.calls, []);
  });

  test('single-step capability gate precedes invalid webhook receiver setup', async () => {
    const fake = client();
    const result = await runStoryboardStep('https://seller.example/mcp', buildStoryboard(), 'discover', {
      _profile: profile({ creativeLibrary: false }),
      _client: fake.instance,
      webhook_receiver: { mode: 'proxy_url' },
    });
    assert.equal(result.skip_reason, 'not_applicable');
    assert.deepEqual(fake.calls, []);
  });

  test('fails closed when discovery advertises tools but yields no raw capability declaration', async () => {
    const noDeclaration = {
      name: 'Auto-registered tools without capability declaration',
      tools: ['get_adcp_capabilities', 'sync_creatives', 'get_products'],
    };
    const fake = client();
    const normal = await runStoryboard('https://seller.example/mcp', buildStoryboard(), {
      _profile: noDeclaration,
      agentTools: noDeclaration.tools,
      _client: fake.instance,
    });
    assert.equal(normal.phases[0].steps[0].skip_reason, 'capability_unsupported');

    const multi = await runStoryboard(
      ['https://seller-a.example/mcp', 'https://seller-b.example/mcp'],
      buildStoryboard(),
      { multi_instance_strategy: 'multi-pass', _profile: noDeclaration, agentTools: noDeclaration.tools }
    );
    assert.equal(multi.phases[0].steps[0].skip_reason, 'capability_unsupported');

    const single = await runStoryboardStep('https://seller.example/mcp', buildStoryboard(), 'discover', {
      _profile: noDeclaration,
      agentTools: noDeclaration.tools,
      _client: fake.instance,
    });
    assert.equal(single.skip_reason, 'not_applicable');
    assert.deepEqual(fake.calls, []);
  });

  test('no raw payload cannot satisfy present:false, while a declared empty payload can', async () => {
    const storyboard = buildStoryboard({
      requires_all_capabilities: [
        { path: 'creative.external_library', present: false },
        { path: 'media_buy.external_planner', present: false },
      ],
    });
    const missingRaw = await runStoryboard('https://seller.example/mcp', storyboard, {
      _profile: { name: 'No raw payload', tools: ['get_products'] },
    });
    assert.equal(missingRaw.phases[0].steps[0].skip_reason, 'capability_unsupported');
    assert.match(missingRaw.phases[0].steps[0].skip.detail, /raw capabilities unavailable/);

    const fake = client();
    const declaredEmpty = await runStoryboard('https://seller.example/mcp', storyboard, {
      _profile: { name: 'Declared empty payload', tools: ['get_products'], raw_capabilities: {} },
      agentTools: ['get_products'],
      _client: fake.instance,
    });
    assert.equal(declaredEmpty.skipped_count, 0);
    assert.deepEqual(
      fake.calls.map(call => call.name),
      ['get_products']
    );
  });

  test('loader rejects lists with fewer than two valid predicates', () => {
    assert.throws(
      () => validateStoryboardShape(buildStoryboard({ requires_all_capabilities: [] })),
      /must list at least two predicates/
    );
    assert.throws(
      () =>
        validateStoryboardShape(
          buildStoryboard({ requires_all_capabilities: [{ path: 'creative.has_creative_library', equals: true }] })
        ),
      /must list at least two predicates/
    );
    assert.throws(
      () =>
        validateStoryboardShape(
          buildStoryboard({
            requires_all_capabilities: [
              { path: '', equals: true },
              { path: 'creative.has_creative_library', present: 'yes' },
            ],
          })
        ),
      /path: must be a non-empty string/
    );
    assert.throws(
      () =>
        validateStoryboardShape(
          buildStoryboard({
            requires_all_capabilities: [
              { path: ' media_buy.propagation_surfaces', contains: 'snapshot' },
              { path: 'creative.has_creative_library', equals: true },
            ],
          })
        ),
      /canonical dotted capability path/
    );
    assert.throws(
      () =>
        validateStoryboardShape(
          buildStoryboard({
            requires_all_capabilities: [
              { path: 'media_buy.propagation_surfaces', contains: 'snapshot', equals: true },
              { path: 'creative.has_creative_library', equals: true },
            ],
          })
        ),
      /must declare exactly one/
    );
    assert.throws(
      () =>
        validateStoryboardShape(
          buildStoryboard({
            requires_all_capabilities: [
              { path: 'media_buy.propagation_surfaces', contains: 'snapshot' },
              { path: 'creative.has_creative_library', present: 'yes' },
            ],
          })
        ),
      /present: must be a boolean/
    );
    assert.throws(
      () =>
        validateStoryboardShape(
          buildStoryboard({
            requires_all_capabilities: [
              { path: 'media_buy.propagation_surfaces', contains: 'snapshot' },
              { path: 'creative.has_creative_library', equals: [] },
            ],
          })
        ),
      /equals: must be a boolean, string, number, or null/
    );
  });
});
