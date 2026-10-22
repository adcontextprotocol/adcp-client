/**
 * Protected fixture-capture namespace: the atomic write funnel and the
 * detached-snapshot boundary.
 *
 * The two properties are tested independently and neither is allowed to
 * stand in for the other:
 *
 *   - Namespace immutability — no caller, authored default, convention
 *     extractor, step capture, generator, task-completion capture, creative
 *     prefix cleanup, routed merge or seller response can write, delete or
 *     re-label a reserved key.
 *   - Reference isolation — guarding map assignment is not enough, because
 *     `injectContext` hands out `context[key]` by reference. A request built
 *     from a prepared snapshot must not be able to write back into it.
 *
 * Authority over prepared state is a separate boundary, covered in
 * `storyboard-prepared-fixtures.test.js`.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  injectContext,
  isProtectedContextKey,
  parseStoryboard,
  PROTECTED_CONTEXT_PREFIX,
  PreparedFixturesDeniedError,
  prepareStoryboardFixtures,
  runStoryboard,
  runStoryboardStep,
} = require('../../dist/lib/testing/index.js');
const { applyContextInputs } = require('../../dist/lib/testing/storyboard/context.js');
const {
  applyProtectedContextPatch,
  createProtectedContextWriter,
  forwardProtectedContext,
  listProtectedContextKeys,
  ProtectedContextViolation,
  registerProtectedContext,
} = require('../../dist/lib/testing/storyboard/protected-context.js');

const KEY = `${PROTECTED_CONTEXT_PREFIX}selected`;
const OTHER = `${PROTECTED_CONTEXT_PREFIX}price`;

function preparedContext(values = { [KEY]: { product_id: 'pinned', collections: [{ id: 'news' }] } }) {
  const writer = createProtectedContextWriter();
  const context = {};
  registerProtectedContext(context, writer);
  applyProtectedContextPatch(context, { set: values }, { writer, origin: 'test preparation' });
  return { context, writer };
}

// ────────────────────────────────────────────────────────────
// Funnel semantics
// ────────────────────────────────────────────────────────────

/**
 * Invoke an entry point expected to be refused, capturing both outcomes.
 *
 * A refused caller gets a typed denial and no result; the complete record
 * goes to the host's authorized audit sink. `record` is therefore the real
 * result when authorized and the audit copy when denied.
 */
async function runWithAudit(invoke) {
  let captured;
  const sink = record => {
    captured = record;
  };
  try {
    return { denial: undefined, record: await invoke(sink) };
  } catch (error) {
    if (!(error instanceof PreparedFixturesDeniedError)) throw error;
    return { denial: error, record: captured };
  }
}

describe('protected write funnel', () => {
  test('an untrusted write to the reserved namespace is refused', () => {
    const { context } = preparedContext();
    assert.throws(
      () => applyProtectedContextPatch(context, { set: { [KEY]: 'forged' } }, { origin: 'caller' }),
      error => error instanceof ProtectedContextViolation && error.code === 'unauthorized_write'
    );
    assert.equal(context[KEY].product_id, 'pinned');
  });

  test('an untrusted delete is refused', () => {
    const { context } = preparedContext();
    assert.throws(
      () => applyProtectedContextPatch(context, { unset: [KEY] }, { origin: 'caller' }),
      error => error instanceof ProtectedContextViolation && error.code === 'unauthorized_delete'
    );
    assert.ok(KEY in context);
  });

  test('metadata is guarded too — suppression is as damaging as overwriting', () => {
    const { context } = preparedContext();
    const provenance = new Map([[KEY, { source_step_id: 'prep', source_kind: 'fixture_preparation' }]]);
    const unavailable = new Map();
    for (const patch of [
      { setProvenance: { [KEY]: { source_step_id: 'forged', source_kind: 'context_outputs' } } },
      { unsetProvenance: [KEY] },
      { markUnavailable: { [KEY]: 'suppressed' } },
      { clearUnavailable: [KEY] },
    ]) {
      assert.throws(
        () => applyProtectedContextPatch(context, patch, { origin: 'caller', sinks: { provenance, unavailable } }),
        error => error instanceof ProtectedContextViolation && error.code === 'unauthorized_metadata',
        JSON.stringify(patch)
      );
    }
    assert.equal(provenance.get(KEY).source_kind, 'fixture_preparation');
    assert.equal(unavailable.size, 0);
  });

  test('a rejected patch applies nothing at all, including its ordinary keys', () => {
    const { context } = preparedContext();
    context.ordinary = 'before';
    const provenance = new Map();
    assert.throws(() =>
      applyProtectedContextPatch(
        context,
        {
          set: { ordinary: 'after', [KEY]: 'forged' },
          unset: ['ordinary'],
          setProvenance: { ordinary: { source_step_id: 's', source_kind: 'context_outputs' } },
        },
        { origin: 'caller', sinks: { provenance } }
      )
    );
    assert.equal(context.ordinary, 'before', 'the ordinary key in a rejected batch must not half-land');
    assert.equal(context[KEY].product_id, 'pinned');
    assert.equal(provenance.size, 0);
  });

  test('ordinary keys keep their existing semantics', () => {
    const { context } = preparedContext();
    applyProtectedContextPatch(context, { set: { plain: 1 } }, { origin: 'caller' });
    assert.equal(context.plain, 1);
    applyProtectedContextPatch(context, { set: { plain: 2 } }, { origin: 'caller' });
    assert.equal(context.plain, 2, 'ordinary keys are freely overwritable, as before');
    applyProtectedContextPatch(context, { unset: ['plain'] }, { origin: 'caller' });
    assert.equal('plain' in context, false);
  });

  test('removals apply before writes so alias-group clearing stays correct', () => {
    const { context } = preparedContext();
    context.product_id = 'old';
    applyProtectedContextPatch(
      context,
      { unset: ['product_id', 'feed_version'], set: { product_id: 'new' } },
      { origin: 'convention' }
    );
    assert.equal(context.product_id, 'new');
  });

  test('even the preparation capability commits a reserved key once', () => {
    const { context, writer } = preparedContext();
    assert.throws(
      () => applyProtectedContextPatch(context, { set: { [KEY]: 'again' } }, { writer, origin: 'preparation' }),
      error => error instanceof ProtectedContextViolation && error.code === 'already_committed'
    );
  });

  test('a different capability cannot write another run’s protected context', () => {
    const { context } = preparedContext();
    const foreign = createProtectedContextWriter();
    assert.throws(
      () => applyProtectedContextPatch(context, { set: { [OTHER]: 1 } }, { writer: foreign, origin: 'other run' }),
      error => error instanceof ProtectedContextViolation && error.code === 'unauthorized_write'
    );
  });

  test('a look-alike capability object is not a capability', () => {
    const { context } = preparedContext();
    const forged = { kind: 'adcp.storyboard.protected-context-writer' };
    const cloned = structuredClone(createProtectedContextWriter());
    for (const writer of [forged, cloned]) {
      assert.throws(
        () => applyProtectedContextPatch(context, { set: { [OTHER]: 1 } }, { writer, origin: 'forged' }),
        error => error instanceof ProtectedContextViolation
      );
    }
  });

  test('prototype-sensitive keys are refused for every writer, trusted or not', () => {
    const { context, writer } = preparedContext();
    // `JSON.parse('{"__proto__": …}')` yields an OWN data property that
    // survives object spread and Object.entries. A plain assignment on it
    // invokes the Object.prototype setter and replaces the context's
    // prototype, after which a prototype-chain read answers for any reserved
    // key that has no own property.
    const callerJson = JSON.parse('{"__proto__": {"__adcp_fixture_price": "FORGED"}}');
    for (const options of [{ origin: 'caller' }, { writer, origin: 'preparation' }]) {
      assert.throws(
        () => applyProtectedContextPatch(context, { set: callerJson }, options),
        error => error instanceof ProtectedContextViolation && error.code === 'reserved_key'
      );
    }
    assert.equal(Object.getPrototypeOf(context), Object.prototype);
    assert.equal(context[OTHER], undefined);
    assert.equal(injectContext({ v: `$context.${OTHER}` }, context).v, `$context.${OTHER}`);
  });

  test('context reads are own-key only, so a polluted prototype answers for nothing', () => {
    const { context } = preparedContext();
    // Simulate pollution having happened by some other route: the read side
    // must still refuse to resolve an inherited reserved key.
    const polluted = Object.create({ [OTHER]: 'INHERITED' });
    Object.assign(polluted, context);
    assert.equal(polluted[OTHER], 'INHERITED', 'the inherited value is reachable by plain indexing');
    assert.equal(injectContext({ v: `$context.${OTHER}` }, polluted).v, `$context.${OTHER}`);
    assert.deepEqual(applyContextInputs({}, [{ key: OTHER, inject_at: 'v' }], polluted), {});
  });

  test('a value Object.freeze cannot make immutable is refused, not silently stored', () => {
    const { context, writer } = preparedContext({});
    for (const value of [new Map([['a', 1]]), new Set([1]), new Date()]) {
      assert.throws(
        () => applyProtectedContextPatch(context, { set: { [OTHER]: value } }, { writer, origin: 'preparation' }),
        error => error instanceof ProtectedContextViolation && error.code === 'uncloneable_value',
        String(value)
      );
    }
    assert.equal(OTHER in context, false);
  });

  test('malformed and prototype-sensitive reserved keys are rejected', () => {
    const writer = createProtectedContextWriter();
    const context = {};
    registerProtectedContext(context, writer);
    for (const key of [
      `${PROTECTED_CONTEXT_PREFIX}bad-dash`,
      `${PROTECTED_CONTEXT_PREFIX}`,
      `${PROTECTED_CONTEXT_PREFIX}a.b`,
    ]) {
      assert.throws(
        () => applyProtectedContextPatch(context, { set: { [key]: 1 } }, { writer, origin: 'preparation' }),
        error => error instanceof ProtectedContextViolation && error.code === 'invalid_key',
        key
      );
    }
    // Prototype pollution via an ordinary key is also not a write we accept
    // into the reserved namespace, and `__proto__` is not a reserved key.
    assert.equal(isProtectedContextKey('__proto__'), false);
  });

  test('an unregistered context refuses even a genuine capability', () => {
    const writer = createProtectedContextWriter();
    const orphan = {};
    // Fail closed: an unforwarded clone is a context this module never
    // vouched for, so accepting a trusted write into it would silently drop
    // both the single-commit rule and the writer-identity binding.
    assert.throws(
      () => applyProtectedContextPatch(orphan, { set: { [KEY]: 'x' } }, { writer, origin: 'orphan' }),
      error => error instanceof ProtectedContextViolation && error.code === 'unauthorized_write'
    );
  });

  test('protection follows the context identity across clones', () => {
    const { context } = preparedContext();
    const clone = { ...context };
    // An un-forwarded clone is a fresh unprotected object by design; the
    // runner forwards protection at every clone site it owns.
    forwardProtectedContext(context, clone);
    assert.deepEqual(listProtectedContextKeys(clone), [KEY]);
    assert.throws(() => applyProtectedContextPatch(clone, { set: { [KEY]: 'x' } }, { origin: 'clone' }));
  });

  test('concurrent untrusted patches cannot interleave into a partial write', async () => {
    const { context } = preparedContext();
    const attempts = Array.from({ length: 32 }, (_, i) =>
      Promise.resolve().then(() => {
        try {
          applyProtectedContextPatch(
            context,
            { set: { [`plain_${i}`]: i, [KEY]: `forged_${i}` } },
            { origin: `racer ${i}` }
          );
          return 'accepted';
        } catch (error) {
          return error.code;
        }
      })
    );
    const outcomes = await Promise.all(attempts);
    assert.deepEqual([...new Set(outcomes)], ['unauthorized_write']);
    assert.equal(context[KEY].product_id, 'pinned');
    assert.equal(
      Object.keys(context).filter(key => key.startsWith('plain_')).length,
      0,
      'no racer may land its ordinary keys from a rejected batch'
    );
  });
});

// ────────────────────────────────────────────────────────────
// Reference isolation
// ────────────────────────────────────────────────────────────

describe('detached snapshot views', () => {
  test('injectContext hands a request a detached copy of a protected value', () => {
    const { context } = preparedContext();
    const request = injectContext({ selected: `$context.${KEY}` }, context);
    assert.notStrictEqual(request.selected, context[KEY]);
    assert.deepEqual(request.selected, context[KEY]);
    request.selected.product_id = 'request-mutated';
    request.selected.collections[0].id = 'mutated';
    request.selected.collections.push({ id: 'appended' });
    assert.equal(context[KEY].product_id, 'pinned', 'nested mutation must not reach the snapshot');
    assert.equal(context[KEY].collections[0].id, 'news');
    assert.equal(context[KEY].collections.length, 1);
  });

  test('applyContextInputs is detached on the same terms', () => {
    const { context } = preparedContext();
    const request = applyContextInputs({ packages: [{}] }, [{ key: KEY, inject_at: 'packages[0].selected' }], context);
    assert.notStrictEqual(request.packages[0].selected, context[KEY]);
    request.packages[0].selected.product_id = 'mutated';
    assert.equal(context[KEY].product_id, 'pinned');
  });

  test('the canonical snapshot is deeply frozen', () => {
    const { context } = preparedContext();
    assert.equal(Object.isFrozen(context[KEY]), true);
    assert.equal(Object.isFrozen(context[KEY].collections), true);
    assert.equal(Object.isFrozen(context[KEY].collections[0]), true);
    assert.throws(() => {
      'use strict';
      context[KEY].collections[0].id = 'mutated';
    }, TypeError);
  });

  test('ingestion deep-clones, so the producer object cannot be mutated into the snapshot', () => {
    const live = { product_id: 'pinned', collections: [{ id: 'news' }] };
    const { context } = preparedContext({ [KEY]: live });
    live.product_id = 'changed-after-commit';
    live.collections[0].id = 'changed';
    assert.equal(context[KEY].product_id, 'pinned');
    assert.equal(context[KEY].collections[0].id, 'news');
  });

  test('ordinary keys keep their documented by-reference injection behavior', () => {
    const context = { ordinary: { product_id: 'p' } };
    const request = injectContext({ selected: '$context.ordinary' }, context);
    assert.strictEqual(request.selected, context.ordinary);
  });
});

// ────────────────────────────────────────────────────────────
// Real write paths through the runner
// ────────────────────────────────────────────────────────────

const CAPS = {
  status: 'completed',
  adcp: { major_versions: [3], supported_versions: ['3.2'], idempotency: { supported: false } },
  supported_protocols: ['media_buy'],
  media_buy: { buying_modes: ['brief', 'wholesale'] },
};
const TOOLS = ['get_adcp_capabilities', 'get_products', 'create_media_buy'];
const ENDPOINT = 'https://protected-context-test.example/mcp';

function product(id, extra = {}) {
  return {
    product_id: id,
    name: 'Catalog offer',
    description: 'Protected-context probe offer.',
    publisher_properties: [{ publisher_domain: 'publisher.example', selection_type: 'all' }],
    channels: ['ctv'],
    delivery_type: 'non_guaranteed',
    format_options: [{ format_option_id: 'video', format_kind: 'video_hosted', params: { duration_ms_exact: 30000 } }],
    pricing_options: [{ pricing_option_id: 'seller-price', pricing_model: 'cpm', currency: 'USD', fixed_price: 10 }],
    collections: [{ publisher_domain: 'owner.example', collection_ids: ['news', 'music'] }],
    reporting_capabilities: {
      available_reporting_frequencies: ['daily'],
      expected_delay_minutes: 0,
      timezone: 'UTC',
      supports_webhooks: false,
      available_metrics: ['impressions', 'spend'],
      date_range_support: 'date_range',
    },
    ...extra,
  };
}

function transport(catalog, overrides = {}) {
  const calls = [];
  const wire = [];
  const trustedFetchFn = async (_input, init = {}) => {
    const message = JSON.parse(init.body);
    wire.push(message.method);
    let result;
    if (message.method === 'initialize') {
      result = {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'protected-context-test', version: '1' },
      };
    } else if (message.method.startsWith('notifications/')) {
      return new Response(null, { status: 202 });
    } else if (message.method === 'tools/list') {
      result = {
        tools: TOOLS.map(name => ({
          name,
          description: name,
          inputSchema: { type: 'object', additionalProperties: true },
        })),
      };
    } else if (message.method === 'tools/call') {
      const { name, arguments: request } = message.params;
      calls.push({ task: name, request });
      let data;
      if (name === 'get_adcp_capabilities') data = CAPS;
      else if (name === 'get_products')
        data = overrides.read?.(request) ?? {
          status: 'completed',
          products: catalog,
          cache_scope: 'account',
          wholesale_feed_version: 'v1',
        };
      else if (name === 'create_media_buy')
        data = {
          status: 'completed',
          media_buy_id: 'seller-buy',
          revision: 1,
          confirmed_at: '2026-10-19T00:00:00Z',
          packages: [],
        };
      else throw new Error(`Unexpected tool ${name}`);
      result = { content: [{ type: 'text', text: JSON.stringify(data) }] };
    } else {
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }),
        { headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  return {
    calls,
    wire,
    options: {
      adcpVersion: '3.2.5',
      timeout_ms: 5000,
      profile: { tools: TOOLS, raw_capabilities: CAPS, supported_protocols: ['media_buy'] },
      transport: { trustedFetchFn },
    },
  };
}

function readBoard(contextOutputs) {
  return {
    id: 'protected_context/read',
    version: '1.0.0',
    category: 'media_buy_seller',
    title: 'Protected context write paths',
    summary: 'Every real write funnel.',
    narrative: 'Exercises the public runner.',
    agent: { interaction_model: 'media_buy_seller', capabilities: ['sells_media'] },
    caller: { role: 'buyer_agent' },
    phases: [
      {
        id: 'read',
        title: 'Read',
        steps: [
          {
            id: 'read',
            title: 'Read the catalog',
            task: 'get_products',
            stateful: false,
            sample_request: { buying_mode: 'wholesale', ext: { adcp: { creative_wire: 'canonical' } } },
            ...(contextOutputs && { context_outputs: contextOutputs }),
            validations: [{ check: 'response_schema', description: 'Schema holds' }],
          },
        ],
      },
    ],
  };
}

describe('real runner write paths', () => {
  test('caller context cannot pre-seed the reserved namespace in the full runner', async () => {
    // Graded, not thrown, and graded the SAME WAY the standalone step route
    // grades it: a hosted route must answer a bad body with a verdict, and
    // two entry points answering one caller mistake differently is the bug.
    const io = transport([product('p')]);
    const { denial, record: result } = await runWithAudit(sink =>
      runStoryboard(ENDPOINT, readBoard(), {
        ...io.options,
        context: { [KEY]: { product_id: 'forged' } },
        prepared_fixtures_audit_sink: sink,
      })
    );
    assert.equal(denial?.refusalCode, 'unauthorized_metadata');
    assert.equal(result.overall_passed, false, JSON.stringify(result));
    const validation = result.phases
      .flatMap(phase => phase.steps)
      .flatMap(step => step.validations)
      .find(v => v.check === 'prepared_fixtures_authorization');
    assert.ok(validation, JSON.stringify(result.phases));
    assert.equal(validation.actual, 'unauthorized_metadata');
    assert.match(validation.error, /reserved or prototype-sensitive key/);
    assert.equal(io.calls.length, 0, 'a forged caller context must fail before any wire call');
    assert.deepEqual(io.wire ?? [], [], 'not even transport initialization');
  });

  test('__proto__ in caller JSON cannot forge a reserved key on the hosted step route', async () => {
    // The hosted `runStoryboardStep` route forwards an arbitrary JSON object
    // into `options.context`. Before the fix this reached the seller: the
    // polluted prototype answered for every uncommitted reserved key, and
    // the forged identity was built into the wire request with no violation
    // raised.
    const io = transport([product('p')]);
    const sb = readBoard();
    sb.phases[0].steps[0].sample_request.brief = `$context.${KEY}`;
    const { denial, record: result } = await runWithAudit(sink =>
      runStoryboardStep(ENDPOINT, sb, 'read', {
        ...io.options,
        context: JSON.parse(`{"__proto__": {"${KEY}": "FORGED-PRODUCT-ID"}}`),
        prepared_fixtures_audit_sink: sink,
      })
    );
    assert.equal(denial?.refusalCode, 'unauthorized_metadata');
    assert.equal(result.passed, false, JSON.stringify(result));
    assert.equal(result.validations[0].check, 'prepared_fixtures_authorization');
    assert.equal(result.validations[0].actual, 'unauthorized_metadata');
    assert.match(result.validations[0].error, /__proto__/);
    assert.equal(io.calls.length, 0, 'the forged identity must never reach the seller');
    assert.equal(
      JSON.stringify(result).includes('FORGED-PRODUCT-ID'),
      false,
      'the forged value must not be echoed back either'
    );
  });

  test('caller context cannot pre-seed the reserved namespace in the standalone runner', async () => {
    const io = transport([product('p')]);
    const { denial, record: result } = await runWithAudit(sink =>
      runStoryboardStep(ENDPOINT, readBoard(), 'read', {
        ...io.options,
        context: { [KEY]: 'forged' },
        prepared_fixtures_audit_sink: sink,
      })
    );
    assert.equal(denial?.refusalCode, 'unauthorized_metadata');
    assert.equal(result.passed, false, JSON.stringify(result));
    assert.equal(result.validations[0].actual, 'unauthorized_metadata');
    assert.equal(io.calls.length, 0);
  });

  test('not_applicable_if cannot name a reserved key', () => {
    const sb = readBoard();
    sb.phases[0].steps[0].not_applicable_if = [{ context_keys: [KEY] }];
    assert.throws(() => parseStoryboard(JSON.stringify(sb)), /reserved "__adcp_fixture_" prefix/);
  });

  test('a prototype-sensitive context key is refused at load', () => {
    const sb = readBoard();
    sb.context = JSON.parse('{"__proto__": {"a": 1}}');
    assert.throws(() => parseStoryboard(JSON.stringify(sb)), /prototype-sensitive context key/);
  });

  test('a step capture cannot promote a seller value into the reserved namespace', () => {
    assert.throws(
      () => parseStoryboard(JSON.stringify(readBoard([{ key: KEY, path: 'context.seller_value' }]))),
      /step captures cannot write fixture-preparation state/
    );
  });

  test('a generator output cannot mint into the reserved namespace', () => {
    assert.throws(
      () => parseStoryboard(JSON.stringify(readBoard([{ key: KEY, generate: 'uuid_v4' }]))),
      /step captures cannot write fixture-preparation state/
    );
  });

  test('a task_completion capture cannot write the reserved namespace', () => {
    assert.throws(
      () => parseStoryboard(JSON.stringify(readBoard([{ key: KEY, path: 'task_completion.media_buy_id' }]))),
      /step captures cannot write fixture-preparation state/
    );
  });

  test('a seller opaque context bag is still not implicitly merged', async () => {
    const io = transport([], {
      read: () => ({
        status: 'completed',
        products: [],
        cache_scope: 'account',
        wholesale_feed_version: 'v1',
        context: { [KEY]: { product_id: 'seller-forged' }, seller_value: 'untrusted' },
      }),
    });
    const result = await runStoryboardStep(ENDPOINT, readBoard(), 'read', io.options);
    assert.equal(result.passed, true, JSON.stringify(result.validations));
    assert.equal(KEY in result.context, false);
    assert.equal('seller_value' in result.context, false);
  });

  test('a creative_build_probe prefix cannot collide with the reserved namespace', () => {
    // The existing spec validator already constrains the prefix to a
    // lowercase identifier, which cannot begin with `__`. That is why the
    // foundation adds no second rule here: the collision is structurally
    // impossible, and an unreachable extra check would only look like
    // protection. Pin the property so a future relaxation of the identifier
    // rule fails this test instead of silently opening the namespace.
    const sb = readBoard();
    sb.creative_build_probe = { context_prefix: `${PROTECTED_CONTEXT_PREFIX}creative`, message: 'probe' };
    assert.throws(() => parseStoryboard(JSON.stringify(sb)), /lowercase identifier/);
  });

  test('a prepared capture survives an untrusted convention extraction on the same run', async () => {
    const io = transport([product('a-selected', { collection_targeting_allowed: true })]);
    const sb = {
      ...readBoard(),
      fixtures: { products: [product('authored', { collection_targeting_allowed: true })] },
      fixture_resolution: {
        products: [
          {
            handle: 'authored',
            strategies: ['discover'],
            match: [
              { path: '', operator: 'collection_selection_satisfies', value: { collection_targeting: 'selectable' } },
            ],
            context_outputs: [{ key: KEY, path: 'product_id' }],
          },
        ],
      },
    };
    // `get_products` has a convention extractor that writes ordinary keys.
    // It must leave the reserved capture alone and still do its own job.
    const result = await runStoryboard(ENDPOINT, sb, io.options);
    assert.equal(result.overall_passed, true, JSON.stringify(result));
    assert.equal(result.context[KEY], 'a-selected');
  });

  test('a prepared capture survives every phase boundary of a multi-phase run', async () => {
    const io = transport([product('a-selected', { collection_targeting_allowed: true })]);
    const readPhase = id => ({
      id,
      title: id,
      steps: [
        {
          id,
          title: id,
          task: 'get_products',
          stateful: false,
          sample_request: { buying_mode: 'wholesale', ext: { adcp: { creative_wire: 'canonical' } } },
          validations: [{ check: 'response_schema', description: 'Schema holds' }],
        },
      ],
    });
    const sb = {
      ...readBoard(),
      fixtures: { products: [product('authored', { collection_targeting_allowed: true })] },
      fixture_resolution: {
        products: [
          {
            handle: 'authored',
            strategies: ['discover'],
            match: [
              {
                path: '',
                operator: 'collection_selection_satisfies',
                value: { collection_targeting: 'selectable', minimum_pairs: 2 },
              },
            ],
            context_outputs: [{ key: KEY, witness: 'declared_selectors' }],
          },
        ],
      },
      phases: [readPhase('p1'), readPhase('p2'), readPhase('p3')],
    };
    const result = await runStoryboard(ENDPOINT, sb, io.options);
    assert.equal(result.overall_passed, true, JSON.stringify(result));
    // Protection rides the context object identity, and the runner creates a
    // fresh identity at every phase boundary. If it is not forwarded, the
    // single-commit rule and the writer binding stop being enforced from the
    // first executable phase onward.
    for (const step of result.phases.flatMap(phase => phase.steps)) {
      assert.deepEqual(step.context[KEY], [{ publisher_domain: 'owner.example', collection_ids: ['news', 'music'] }]);
      assert.equal(Object.isFrozen(step.context[KEY]), true, `frozen at ${step.step_id}`);
      assert.equal(Object.isFrozen(step.context[KEY][0]), true, `deeply frozen at ${step.step_id}`);
    }
    assert.deepEqual(listProtectedContextKeys(result.context), [KEY]);
  });

  test('caller-threaded provenance and unavailable maps cannot name reserved keys', async () => {
    const io = transport([product('p')]);
    for (const option of ['context_provenance', 'response_derived_not_applicable_context_keys']) {
      const value =
        option === 'context_provenance'
          ? { [KEY]: { source_step_id: 'forged', source_kind: 'fixture_preparation' } }
          : { [KEY]: 'suppressed by caller JSON' };
      // A graded refusal, not a thrown exception: a hosted route must answer
      // a bad request body with a verdict, not a 500.
      const { denial, record: result } = await runWithAudit(sink =>
        runStoryboardStep(ENDPOINT, readBoard(), 'read', {
          ...io.options,
          [option]: value,
          prepared_fixtures_audit_sink: sink,
        })
      );
      assert.equal(denial?.refusalCode, 'unauthorized_metadata', option);
      assert.equal(result.passed, false, option);
      assert.match(result.error, /fixture-preparation metadata is not caller-supplied/);
    }
    assert.deepEqual(io.wire, [], 'forged metadata must fail before any seller contact');
  });

  test('prepared state exposes captures only through detached copies', async () => {
    const io = transport([product('a-selected', { collection_targeting_allowed: true })]);
    const sb = {
      ...readBoard(),
      fixtures: { products: [product('authored', { collection_targeting_allowed: true })] },
      fixture_resolution: {
        products: [
          {
            handle: 'authored',
            strategies: ['discover'],
            match: [
              { path: '', operator: 'collection_selection_satisfies', value: { collection_targeting: 'selectable' } },
            ],
            context_outputs: [{ key: KEY, witness: 'declared_selectors' }],
          },
        ],
      },
    };
    const prepared = await prepareStoryboardFixtures(ENDPOINT, sb, io.options);
    const first = prepared.captures;
    first[KEY][0].publisher_domain = 'mutated.example';
    first[KEY].push({ publisher_domain: 'appended.example', collection_ids: ['x'] });
    const second = prepared.captures;
    assert.equal(second[KEY][0].publisher_domain, 'owner.example');
    assert.equal(second[KEY].length, 1);
    assert.notStrictEqual(first, second);
  });
});

describe('routed caller inputs', () => {
  test('comply route context cannot import reserved keys', async () => {
    const { buildRoutedStoryboardRunForTest } = require('../../dist/lib/testing/compliance/comply.js');
    if (typeof buildRoutedStoryboardRunForTest !== 'function') {
      // The builder is internal; the behavior is covered through routeStoryboard
      // in comply-route-storyboard.test.js. Assert the guard predicate instead
      // so the reserved-prefix contract is still pinned here.
      assert.equal(isProtectedContextKey(KEY), true);
      assert.equal(isProtectedContextKey('ordinary'), false);
      return;
    }
    const outcome = buildRoutedStoryboardRunForTest({ context: { [KEY]: 'forged' } });
    assert.match(outcome.refused, /reserved fixture-preparation key/);
  });
});
