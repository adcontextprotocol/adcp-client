/**
 * `any_of` capability gates and object-subset `contains` (adcontextprotocol/adcp#8998).
 *
 * The motivating gate: a 3.3 seller accepts inline audience member pushes
 * when `supported_activation_methods` is absent (the 3.2 meaning) or lists an
 * entry whose `pattern` is `sync_audiences`. Expressing that needs an OR over
 * two predicates, and a `contains` that matches an object by a subset of its
 * fields, because activation-method entries are open objects.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  capabilityPathPredicates,
  describeStoryboardCapabilityGates,
  evaluateCapabilityPredicate,
  evaluateCapabilityPredicateAgainstCapabilities,
  isAnyOfCapabilityPredicate,
  runStoryboard,
} = require('../../dist/lib/testing/storyboard/index.js');
const { validateStoryboardShape } = require('../../dist/lib/testing/storyboard/loader.js');

const METHODS_PATH = 'media_buy.audience_targeting.supported_activation_methods';

const ACCEPTS_INLINE_PUSH = {
  any_of: [
    { path: METHODS_PATH, present: false },
    { path: METHODS_PATH, contains: { pattern: 'sync_audiences' } },
  ],
};

function capabilities(methods) {
  return {
    media_buy: {
      audience_targeting: {
        supported_identifier_types: ['hashed_email'],
        ...(methods === undefined ? {} : { supported_activation_methods: methods }),
      },
    },
  };
}

const NO_PUSH_METHODS = [
  { pattern: 'tmp_identity_match', buyer_agent: { agent_url: 'https://buyer.example/a2a' } },
  { pattern: 'clean_room', vendor: { domain: 'cleanroom.example' } },
];

describe('object-subset contains / not_contains', () => {
  test('an object value matches an entry carrying its keys plus others', () => {
    const predicate = { path: METHODS_PATH, contains: { pattern: 'sync_audiences' } };
    assert.equal(evaluateCapabilityPredicate(predicate, [{ pattern: 'sync_audiences' }]), null);
    assert.equal(evaluateCapabilityPredicate(predicate, [{ pattern: 'sync_audiences', note: 'crm only' }]), null);
    assert.match(evaluateCapabilityPredicate(predicate, NO_PUSH_METHODS), /must contain/);
  });

  test('every predicate key must be present with an equal value', () => {
    const predicate = { path: 'x.list', contains: { pattern: 'file_transfer', transport: 's3' } };
    assert.equal(evaluateCapabilityPredicate(predicate, [{ pattern: 'file_transfer', transport: 's3', v: 1 }]), null);
    assert.notEqual(evaluateCapabilityPredicate(predicate, [{ pattern: 'file_transfer', transport: 'gcs' }]), null);
    assert.notEqual(evaluateCapabilityPredicate(predicate, [{ pattern: 'file_transfer' }]), null);
  });

  test('nested values inside the subset still compare structurally', () => {
    const predicate = { path: 'x.list', contains: { vendor: { domain: 'a.example' } } };
    assert.equal(evaluateCapabilityPredicate(predicate, [{ vendor: { domain: 'a.example' }, pattern: 'p' }]), null);
    assert.notEqual(
      evaluateCapabilityPredicate(predicate, [{ vendor: { domain: 'a.example', extra: true } }]),
      null,
      'only the top level is a subset match'
    );
  });

  test('scalar and array values keep structural equality', () => {
    assert.equal(evaluateCapabilityPredicate({ path: 'x.list', contains: 'a' }, ['a', 'b']), null);
    assert.notEqual(evaluateCapabilityPredicate({ path: 'x.list', contains: ['a'] }, [['a', 'b']]), null);
    assert.notEqual(evaluateCapabilityPredicate({ path: 'x.list', contains: { a: 1 } }, ['a']), null);
  });

  test('not_contains uses the same subset match', () => {
    const predicate = { path: METHODS_PATH, not_contains: { pattern: 'sync_audiences' } };
    assert.equal(evaluateCapabilityPredicate(predicate, NO_PUSH_METHODS), null);
    assert.match(
      evaluateCapabilityPredicate(predicate, [{ pattern: 'sync_audiences', note: 'x' }]),
      /must not contain/
    );
  });

  test('governance task-mode matching is unchanged', () => {
    const predicate = {
      path: 'adcp.governance_enforcement.tasks',
      contains: { task: 'acquire_rights', modes: ['signed_context'] },
    };
    assert.equal(
      evaluateCapabilityPredicate(predicate, [{ task: 'acquire_rights', modes: ['signed_context', 'check_only'] }]),
      null
    );
    assert.notEqual(evaluateCapabilityPredicate(predicate, [{ task: 'acquire_rights', modes: ['check_only'] }]), null);
  });
});

describe('any_of evaluation', () => {
  test('passes when the path is absent (the 3.2 meaning)', () => {
    assert.equal(evaluateCapabilityPredicateAgainstCapabilities(ACCEPTS_INLINE_PUSH, capabilities(undefined)), null);
  });

  test('passes when the list includes the sync_audiences pattern, with or without extra keys', () => {
    for (const methods of [
      [{ pattern: 'sync_audiences' }],
      [...NO_PUSH_METHODS, { pattern: 'sync_audiences', note: 'inline push' }],
    ]) {
      assert.equal(evaluateCapabilityPredicateAgainstCapabilities(ACCEPTS_INLINE_PUSH, capabilities(methods)), null);
    }
  });

  test('fails with every alternative named when none passes', () => {
    const detail = evaluateCapabilityPredicateAgainstCapabilities(ACCEPTS_INLINE_PUSH, capabilities(NO_PUSH_METHODS));
    assert.match(detail, /no alternative passed/);
    assert.match(detail, /must be absent/);
    assert.match(detail, /must contain \{"pattern":"sync_audiences"\}/);
    assert.match(detail, /OR/);
  });

  test('nested any_of groups compose', () => {
    const nested = {
      any_of: [
        { path: 'a.flag', equals: true },
        {
          any_of: [
            { path: 'b.list', contains: 'x' },
            { path: 'c', present: true },
          ],
        },
      ],
    };
    assert.equal(evaluateCapabilityPredicateAgainstCapabilities(nested, { c: {} }), null);
    assert.equal(evaluateCapabilityPredicateAgainstCapabilities(nested, { b: { list: ['x'] } }), null);
    assert.notEqual(evaluateCapabilityPredicateAgainstCapabilities(nested, { a: { flag: false } }), null);
  });

  test('evaluateCapabilityPredicate refuses an any_of predicate', () => {
    assert.throws(() => evaluateCapabilityPredicate(ACCEPTS_INLINE_PUSH, undefined), TypeError);
  });

  test('helpers recognise and flatten any_of predicates', () => {
    assert.equal(isAnyOfCapabilityPredicate(ACCEPTS_INLINE_PUSH), true);
    assert.equal(isAnyOfCapabilityPredicate({ path: 'a', present: true }), false);
    assert.deepEqual(
      capabilityPathPredicates(ACCEPTS_INLINE_PUSH).map(predicate => predicate.path),
      [METHODS_PATH, METHODS_PATH]
    );
  });
});

function storyboard(overrides = {}) {
  return {
    id: 'any_of_gate',
    version: '1.0.0',
    title: 'any_of gate',
    category: 'testing',
    summary: '',
    narrative: '',
    agent: { interaction_model: 'media_buy_seller', capabilities: [] },
    caller: { role: 'buyer_agent' },
    phases: [
      {
        id: 'always',
        title: 'Runs for every audience-targeting seller',
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
      {
        id: 'push',
        title: 'Runs only when the seller accepts inline pushes',
        requires_capability: ACCEPTS_INLINE_PUSH,
        steps: [
          {
            id: 'discover_again',
            title: 'Discover again',
            task: 'get_products',
            sample_request: { buying_mode: 'brief', brief: 'push' },
            validations: [],
          },
        ],
      },
    ],
    ...overrides,
  };
}

function fakeClient() {
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

async function run(sb, raw_capabilities) {
  const fake = fakeClient();
  const tools = ['get_adcp_capabilities', 'get_products'];
  const result = await runStoryboard('https://seller.example/mcp', sb, {
    protocol: 'mcp',
    _profile: { name: 'seller', tools, ...(raw_capabilities === undefined ? {} : { raw_capabilities }) },
    agentTools: tools,
    _client: fake.instance,
  });
  return { result, calls: fake.calls };
}

describe('any_of on phase and storyboard gates', () => {
  test('a phase gate skips as not_applicable for a seller without inline push', async () => {
    const { result, calls } = await run(storyboard(), capabilities(NO_PUSH_METHODS));
    const push = result.phases.find(phase => phase.phase_id === 'push');
    assert.equal(push.steps[0].skipped, true);
    assert.equal(push.steps[0].skip.reason, 'not_applicable');
    assert.match(push.steps[0].skip.detail, /no alternative passed/);
    assert.deepEqual(
      calls.map(call => call.params.brief),
      ['test']
    );
  });

  test('a phase gate runs for a 3.2-shaped seller and for a seller listing sync_audiences', async () => {
    for (const methods of [undefined, [{ pattern: 'sync_audiences' }, ...NO_PUSH_METHODS]]) {
      const { result, calls } = await run(storyboard(), capabilities(methods));
      assert.equal(result.skipped_count, 0, JSON.stringify(methods));
      assert.deepEqual(
        calls.map(call => call.params.brief),
        ['test', 'push']
      );
    }
  });

  test('a root gate skips the whole storyboard', async () => {
    const sb = storyboard({ requires_capability: ACCEPTS_INLINE_PUSH });
    const { result, calls } = await run(sb, capabilities(NO_PUSH_METHODS));
    assert.deepEqual(calls, []);
    assert.ok(result.phases.every(phase => phase.steps.every(step => step.skipped)));
    assert.equal(
      describeStoryboardCapabilityGates(sb),
      `(${METHODS_PATH} absent OR ${METHODS_PATH} contains {"pattern":"sync_audiences"})`
    );
  });

  test('without raw capabilities each alternative uses the legacy fallback', async () => {
    const { result, calls } = await run(storyboard(), undefined);
    assert.equal(result.skipped_count, 0);
    assert.equal(calls.length, 2);
  });

  test('an any_of entry in requires_all_capabilities is AND-composed and fails closed', async () => {
    const sb = storyboard({
      requires_all_capabilities: [{ path: 'media_buy.audience_targeting', present: true }, ACCEPTS_INLINE_PUSH],
    });
    validateStoryboardShape(sb);
    const accepted = await run(sb, capabilities(undefined));
    assert.equal(accepted.calls.length, 2);
    const refused = await run(sb, capabilities(NO_PUSH_METHODS));
    assert.deepEqual(refused.calls, []);
    const noRaw = await run(sb, undefined);
    assert.deepEqual(noRaw.calls, [], 'compound gates fail closed without raw capabilities');
  });
});

describe('loader validation of any_of', () => {
  test('accepts a well-formed any_of on root, phase and compound gates', () => {
    assert.doesNotThrow(() => validateStoryboardShape(storyboard({ requires_capability: ACCEPTS_INLINE_PUSH })));
  });

  test('rejects an any_of with fewer than two entries', () => {
    const sb = storyboard({ requires_capability: { any_of: [{ path: 'a', present: true }] } });
    assert.throws(() => validateStoryboardShape(sb), /any_of: must list at least two predicates/);
  });

  test('rejects any_of combined with path or a matcher', () => {
    const sb = storyboard({
      requires_capability: { path: 'a', present: true, any_of: ACCEPTS_INLINE_PUSH.any_of },
    });
    assert.throws(() => validateStoryboardShape(sb), /any_of cannot be combined with path, present/);
  });

  test('rejects a malformed entry inside a phase any_of', () => {
    const sb = storyboard();
    sb.phases[1].requires_capability = { any_of: [{ path: 'a', present: true }, { path: 'b' }] };
    assert.throws(
      () => validateStoryboardShape(sb),
      /phase 'push': requires_capability\.any_of\[1\]: must declare exactly one/
    );
  });

  test('leaves legacy singular path gates unvalidated', () => {
    const sb = storyboard({ requires_capability: { path: 'a', present: true, note: 'legacy extra key' } });
    assert.doesNotThrow(() => validateStoryboardShape(sb));
  });
});
