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
