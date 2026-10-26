const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prepareStoryboardFixtures } = require('../../dist/lib/testing');
const { CAPS, TOOLS, ENDPOINT, board, transport, SELECTED } = require('../helpers/fixture-discovery-seller');

for (const suppliedProfile of [false, true]) {
  for (const gate of ['requires_capability', 'requires_all_capabilities', 'required_tools']) {
    test(`preparation applies ${gate} before seeding (supplied profile: ${suppliedProfile})`, async () => {
      const capabilities = { ...CAPS, media_buy: { buying_modes: ['brief'] } };
      const io = transport([SELECTED], { capabilities: () => capabilities });
      if (suppliedProfile) io.options.profile.raw_capabilities = capabilities;
      else delete io.options.profile;
      const storyboard = board();
      const predicate = { path: 'media_buy.buying_modes', contains: 'wholesale' };
      if (gate === 'requires_capability') storyboard.requires_capability = predicate;
      if (gate === 'requires_all_capabilities')
        storyboard.requires_all_capabilities = [predicate, { path: 'media_buy.buying_modes', contains: 'brief' }];
      if (gate === 'required_tools') storyboard.required_tools = ['list_products', 'buy_products'];
      let authorizations = 0;
      const state = await prepareStoryboardFixtures(ENDPOINT, storyboard, {
        ...io.options,
        prepared_fixtures_preparation_authorizer: lookup => {
          authorizations++;
          assert.equal(lookup.gate, 'prepare');
          assert.deepEqual(io.wire, [], 'authorization precedes every seller exchange');
          return { authorized: true };
        },
      });
      assert.equal(authorizations, 1);
      assert.equal(state.disposition.status, 'unsupported');
      assert.equal(state.disposition.reason, 'not_applicable');
      assert.match(state.disposition.detail, gate === 'required_tools' ? /list_products/ : /wholesale/);
      assert.deepEqual(state.resolutions, []);
      assert.deepEqual(state.captures, {});
      assert.equal(
        io.calls.some(call => call.task !== 'get_adcp_capabilities'),
        false
      );
      assert.equal(state.phase.phase_id, 'discovery');
      assert.equal(state.phase.passed, true);
      if (!suppliedProfile) {
        assert.ok(state.phase.steps[0].request);
        assert.ok(state.phase.steps[0].response_record);
      }
    });
  }
}

test('preparation accepts any required tool and seeds when all root capability predicates pass', async () => {
  const io = transport([SELECTED]);
  delete io.options.profile;
  const storyboard = board();
  storyboard.required_tools = ['list_products', TOOLS[1]];
  storyboard.requires_capability = { path: 'media_buy.buying_modes', contains: 'wholesale' };
  storyboard.requires_all_capabilities = [
    { path: 'media_buy.buying_modes', contains: 'brief' },
    { path: 'adcp.major_versions', contains: 3 },
  ];
  const state = await prepareStoryboardFixtures(ENDPOINT, storyboard, io.options);
  assert.equal(state.disposition.status, 'resolved');
  assert.ok(io.calls.some(call => call.task === 'get_products'));
});

const RIGHTS_ENDPOINT = 'https://prepared-rights-test.example/mcp';
const ROOT_PREDICATE = { path: 'wholesale_feed_versioning.supported', equals: true };

function routedTransport({ sellerSupports = true, rightsSupports = true, rightsFailure = false } = {}) {
  const capabilities = supported => ({ ...CAPS, wholesale_feed_versioning: { supported } });
  const seller = transport([SELECTED], { capabilities: () => capabilities(sellerSupports) });
  const rights = transport([], {
    tools: ['get_adcp_capabilities', 'get_rights'],
    capabilities: () =>
      rightsFailure
        ? {
            ...capabilities(rightsSupports),
            supported_protocols: 'malformed',
          }
        : { ...capabilities(rightsSupports), supported_protocols: ['brand'] },
  });
  const exchanges = [];
  return {
    seller,
    rights,
    exchanges,
    options: {
      ...seller.options,
      profile: undefined,
      auth: { type: 'bearer', token: 'run-token' },
      agents: {
        seller: { url: ENDPOINT, auth: { type: 'bearer', token: 'seller-token' } },
        rights: { url: RIGHTS_ENDPOINT },
      },
      transport: {
        trustedFetchFn: async (input, init) => {
          const url = input instanceof Request ? input.url : String(input);
          exchanges.push({ url, authorization: new Headers(init?.headers).get('authorization') });
          return (url.startsWith(RIGHTS_ENDPOINT) ? rights : seller).options.transport.trustedFetchFn(input, init);
        },
      },
    },
  };
}

function assertNoFixtureReads(io) {
  for (const route of [io.seller, io.rights]) {
    assert.equal(
      route.calls.some(call => call.task !== 'get_adcp_capabilities'),
      false
    );
  }
}

test('routed required tools use the authoritative topology union after authorization, retaining route credentials', async () => {
  const io = routedTransport();
  const storyboard = board();
  storyboard.required_tools = ['get_rights'];
  const state = await prepareStoryboardFixtures('', storyboard, {
    ...io.options,
    default_agent: 'seller',
    prepared_fixtures_preparation_authorizer: () => {
      assert.deepEqual(io.exchanges, []);
      return { authorized: true };
    },
  });
  assert.equal(state.disposition.status, 'resolved');
  assert.ok(io.seller.calls.some(call => call.task === 'get_products'));
  assert.ok(io.exchanges.some(exchange => exchange.url.startsWith(RIGHTS_ENDPOINT)));
  for (const exchange of io.exchanges) {
    assert.equal(
      exchange.authorization,
      exchange.url.startsWith(RIGHTS_ENDPOINT) ? 'Bearer run-token' : 'Bearer seller-token'
    );
  }
});

for (const [sellerSupports, rightsSupports] of [
  [false, true],
  [true, false],
]) {
  test(`routed root capabilities belong to default_agent, independently of insertion order (${sellerSupports}/${rightsSupports})`, async () => {
    const io = routedTransport({ sellerSupports, rightsSupports });
    const storyboard = board();
    storyboard.requires_capability = ROOT_PREDICATE;
    const state = await prepareStoryboardFixtures('', storyboard, { ...io.options, default_agent: 'rights' });
    assert.equal(state.disposition.status, rightsSupports ? 'resolved' : 'unsupported');
    if (!rightsSupports) {
      assert.equal(state.disposition.reason, 'not_applicable');
      assertNoFixtureReads(io);
      assert.equal(state.phase.steps.length, 2);
      assert.deepEqual(new Set(state.phase.steps.map(step => step.agent_url)), new Set([ENDPOINT, RIGHTS_ENDPOINT]));
      assert.ok(
        state.phase.steps.every(step => step.request?.operation === 'get_adcp_capabilities' && step.response_record)
      );
    }
  });
}

for (const rightsSupports of [true, false]) {
  test(`without a default route, preparation skips only when every callable route declines (${rightsSupports})`, async () => {
    const io = routedTransport({ sellerSupports: false, rightsSupports });
    const storyboard = board({
      steps: ['seller', 'rights'].map(agent => ({
        id: `${agent}_probe`,
        title: `${agent} discovery`,
        agent,
        task: 'get_adcp_capabilities',
        sample_request: {},
        validations: [],
      })),
    });
    storyboard.requires_capability = ROOT_PREDICATE;
    const state = await prepareStoryboardFixtures('', storyboard, io.options);
    assert.equal(state.disposition.status, rightsSupports ? 'resolved' : 'unsupported');
    if (!rightsSupports) {
      assert.equal(state.disposition.reason, 'not_applicable');
      assertNoFixtureReads(io);
    }
  });
}

for (const routed of [false, true]) {
  test(`required_any_of_tools is evaluated before fixture reads (routed: ${routed})`, async () => {
    const io = routed ? routedTransport() : transport([SELECTED]);
    const storyboard = board();
    storyboard.required_any_of_tools = [{ tools: ['list_accounts', 'sync_accounts'], rationale: 'account discovery' }];
    const state = await prepareStoryboardFixtures(routed ? '' : ENDPOINT, storyboard, io.options);
    assert.equal(state.disposition.status, 'unsupported');
    assert.equal(state.disposition.reason, 'not_applicable');
    assert.match(
      state.disposition.detail,
      /missing_required_tool_family.*list_accounts or sync_accounts.*account discovery/
    );
    if (routed) assertNoFixtureReads(io);
    else assert.deepEqual(io.calls, []);
  });
}

test('routed tool families may be satisfied by a peer route', async () => {
  const io = routedTransport();
  const storyboard = board();
  storyboard.required_any_of_tools = [{ tools: ['get_rights', 'acquire_rights'] }];
  const state = await prepareStoryboardFixtures('', storyboard, { ...io.options, default_agent: 'seller' });
  assert.equal(state.disposition.status, 'resolved');
});

test('a failed peer discovery stays terminal and retains the failed exchange before applicability', async () => {
  const io = routedTransport({ sellerSupports: false, rightsFailure: true });
  const storyboard = board();
  storyboard.requires_capability = ROOT_PREDICATE;
  const state = await prepareStoryboardFixtures('', storyboard, {
    ...io.options,
    default_agent: 'seller',
    discovery_resilient: true,
  });
  assert.equal(state.disposition.status, 'failed');
  assert.match(state.disposition.detail, /[Ss]chema validation failed.*supported_protocols/);
  const failed = state.phase.steps.find(step => !step.passed);
  assert.equal(failed.request.operation, 'get_adcp_capabilities');
  assert.ok(failed.response_record);
  assertNoFixtureReads(io);
});

test('an unknown authored route is a terminal preparation failure before seller contact', async () => {
  const io = routedTransport();
  const storyboard = board();
  storyboard.required_tools = ['get_products'];
  storyboard.phases[0].steps[0].agent = 'missing';
  const state = await prepareStoryboardFixtures('', storyboard, io.options);
  assert.equal(state.disposition.status, 'failed');
  assert.match(state.disposition.detail, /not in the agents map/);
  assert.deepEqual(io.exchanges, []);
});

test('ungated routed preparation preserves first-route behavior without contacting peers', async () => {
  const io = routedTransport({ rightsFailure: true });
  const state = await prepareStoryboardFixtures('', board(), io.options);
  assert.equal(state.disposition.status, 'resolved');
  assert.ok(io.seller.calls.some(call => call.task === 'get_products'));
  assert.deepEqual(io.rights.wire, []);
});
