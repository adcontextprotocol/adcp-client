const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const { randomUUID } = require('node:crypto');
const {
  projectSyncCreativesForDelivery,
  CreativeFormatProjectionError,
} = require('../../dist/lib/v2/projection/index.js');

const OWNER = 'https://creative.adcontextprotocol.org';
const OPT_IN = { playerSizedRefs: 'omit_unstated_size' };
function creative(kind = 'video_vast') {
  return {
    creative_id: 'c30',
    name: '30-second creative',
    format_kind: kind,
    format_parameters: { duration_ms: 30000 },
    assets: { vast_tag: { asset_type: 'vast', delivery_type: 'url', url: 'https://ads.example/tag.xml' } },
  };
}
function container(package_id, height = 360, kind = 'video_vast', durations = [15000, 30000]) {
  const refs = durations.map(duration_ms => ({ agent_url: OWNER, id: kind, width: 640, height, duration_ms }));
  return {
    package_id,
    product_id: `product-${package_id}`,
    format_ids: refs,
    format_options: refs.map(ref => ({
      format_kind: kind,
      format_option_id: `${kind}-${ref.width}x${ref.height}-${ref.duration_ms}`,
      params: { width: ref.width, height: ref.height, duration_ms_exact: ref.duration_ms },
      v1_format_ref: [ref],
    })),
  };
}
function request(value = creative(), packages = ['A', 'B']) {
  return {
    creatives: [value],
    assignments: packages.map(package_id => ({ creative_id: value.creative_id, package_id })),
  };
}
function project(input, selectors, options, mode = 'legacy', resolver) {
  return projectSyncCreativesForDelivery(input, selectors, mode, undefined, resolver, undefined, options);
}
function refusal(input, selectors, options) {
  let error;
  try {
    project(input, selectors, options);
  } catch (cause) {
    error = cause;
  }
  assert.ok(error instanceof CreativeFormatProjectionError);
  assert.equal(error.code, 'ADCP_CREATIVE_FORMAT_PROJECTION_FAILED');
  assert.equal(error.operation, 'sync_creatives');
  assert.equal(error.creativeId, 'c30');
  return error;
}

describe('player-sized creative assignment projection (#3496)', () => {
  for (const kind of ['video_vast', 'audio_vast']) {
    for (const packages of [['A'], ['A', 'A2']]) {
      test(`${kind}: ${packages.join('+')} retains its exact seller ref`, () => {
        const input = request(creative(kind), packages);
        const selectors = packages.map(id => container(id, 360, kind));
        for (const policy of [undefined, OPT_IN]) {
          assert.deepEqual(project(input, selectors, policy).creatives[0].format_id, selectors[0].format_ids[1]);
        }
      });
    }
    test(`${kind}: opts into one shared duration ref across different players`, () => {
      const input = request(creative(kind));
      const selectors = [container('A', 360, kind), container('B', 480, kind)];
      const before = structuredClone({ input, selectors });
      const result = project(input, selectors, OPT_IN);
      assert.deepEqual(result.creatives[0].format_id, { agent_url: OWNER, id: kind, duration_ms: 30000 });
      assert.deepEqual(result.assignments, input.assignments);
      assert.deepEqual(result.creatives[0].assets, input.creatives[0].assets);
      assert.deepEqual({ input, selectors }, before);
    });
    test(`${kind}: strict default reports each assigned package's duration-matched ref`, () => {
      const selectors = [container('A', 360, kind), container('B', 480, kind)];
      const error = refusal(request(creative(kind)), selectors);
      assert.deepEqual(
        error.details.package_refs,
        selectors.map(value => ({ package_id: value.package_id, ref: value.format_ids[1] }))
      );
      assert.match(error.message, /A.*B/);
    });
  }
  test('does not omit dimensions explicitly stated on a VAST creative or its asset', () => {
    for (const source of ['parameters', 'asset']) {
      const value = creative();
      Object.assign(source === 'parameters' ? value.format_parameters : value.assets.vast_tag, {
        width: 640,
        height: 360,
      });
      const error = refusal(request(value), [container('A'), container('B', 480)], OPT_IN);
      assert.deepEqual(
        error.details.package_refs.map(item => item.ref),
        [container('A').format_ids[1], container('B', 480).format_ids[1]]
      );
    }
  });
  for (const [field, fact] of [
    ['aspect_ratio', '16:9'],
    ['orientation', 'landscape'],
    ['min_width', 640],
    ['max_width', 640],
    ['min_height', 360],
    ['max_height', 360],
  ]) {
    test(`does not omit a creative's stated ${field}`, () => {
      const value = creative();
      value.format_parameters[field] = fact;
      refusal(request(value), [container('A'), container('B', 480)], OPT_IN);
    });
  }
  test('keeps the creative duration range when considering size omission', () => {
    const value = creative();
    delete value.format_parameters.duration_ms;
    const selectors = [container('A', 360, 'video_vast', [30000]), container('B', 480, 'video_vast', [30000])];
    value.format_parameters.duration_ms_range = [15000, 20000];
    refusal(request(value), selectors, OPT_IN);
    value.format_parameters.duration_ms_range = [15000, 30000];
    assert.equal(project(request(value), selectors, OPT_IN).creatives[0].format_id.duration_ms, 30000);
    value.format_parameters.duration_ms_range = [15000, 20000];
    value.format_parameters.duration_ms_exact = 30000;
    assert.equal(project(request(value), selectors, OPT_IN).creatives[0].format_id.duration_ms, 30000);
  });
  test('sized hosted media refuses cross-package sizes and reports both seller refs', () => {
    const value = {
      ...creative('video_hosted'),
      format_parameters: { width: 640, height: 360, duration_ms: 30000 },
      assets: {
        video: {
          asset_type: 'video',
          url: 'https://cdn.example/video.mp4',
          width: 640,
          height: 360,
          duration_ms: 30000,
        },
      },
    };
    const selectors = [container('A', 360, 'video_hosted'), container('B', 480, 'video_hosted')];
    const error = refusal(request(value), selectors, OPT_IN);
    assert.deepEqual(
      error.details.package_refs.map(item => item.ref),
      selectors.map(item => item.format_ids[1])
    );
    assert.match(error.details.package_refs[1].reason, /cannot select/);
  });
  for (const field of ['agent_url', 'id']) {
    test(`does not merge conflicting ${field} identities`, () => {
      const selectors = [container('A'), container('B', 480)];
      const replacement = field === 'id' ? 'seller_vast' : 'https://different.example/formats';
      selectors[1].format_ids.forEach(ref => {
        ref[field] = replacement;
      });
      refusal(request(), selectors, OPT_IN);
    });
  }
  test('uses an actual VAST asset duration to resolve each package', () => {
    const value = creative();
    delete value.format_parameters;
    value.assets.vast_tag.duration_ms = 30000;
    const output = project(request(value), [container('A'), container('B', 480)], OPT_IN);
    assert.deepEqual(output.creatives[0].format_id, { agent_url: OWNER, id: 'video_vast', duration_ms: 30000 });
    assert.equal(value.format_parameters, undefined);
    assert.equal(output.creatives[0].format_parameters, undefined);
  });
  test('strict same-size assignments retain asset-only duration ambiguity', () => {
    const value = creative();
    delete value.format_parameters;
    value.assets.vast_tag.duration_ms = 30000;
    refusal(request(value, ['A']), [container('A')]);
    refusal(request(value), [container('A'), container('B')]);
    const output = project(request(value), [container('A'), container('B')], OPT_IN);
    assert.equal(output.creatives[0].format_parameters, undefined);
    assert.equal(output.creatives[0].format_id.duration_ms, 30000);
  });
  test('refuses conflicting measured asset and format durations', () => {
    const value = creative();
    value.assets.vast_tag.duration_ms = 15000;
    const error = refusal(request(value), [container('A'), container('B', 480)], OPT_IN);
    assert.ok(error.details.package_refs.every(entry => entry.reason.includes('conflicting durations')));
  });
  test('does not merge different durations when the creative omits a duration', () => {
    const value = creative();
    delete value.format_parameters;
    const selectors = [container('A', 360, 'video_vast', [15000]), container('B', 480, 'video_vast', [30000])];
    refusal(request(value), selectors, OPT_IN);
  });
  test('does not collapse ambiguity inside one assigned package', () => {
    const a = container('A', 360, 'video_vast', [30000]);
    const second = container('A', 480, 'video_vast', [30000]);
    a.format_ids.push(...second.format_ids);
    a.format_options.push(...second.format_options);
    const error = refusal(request(), [a, container('B', 480, 'video_vast', [30000])], OPT_IN);
    assert.equal(error.details.package_refs[0].refs.length, 2);
    assert.match(error.details.package_refs[0].reason, /advertised 2/);
  });
  test('a missing assigned package is refused with an explicit unresolved entry', () => {
    const error = refusal(request(), [container('A')], OPT_IN);
    assert.deepEqual(error.details.package_refs[1].refs, []);
    assert.equal(error.details.package_refs[1].package_id, 'B');
    assert.ok(error.details.package_refs[1].reason);
  });
  test('ignores unassigned selectors and assignments belonging to another creative', () => {
    const input = request();
    input.assignments.push({ creative_id: 'other', package_id: 'C' });
    const selectors = [container('A'), container('B', 480), container('C', 900)];
    assert.deepEqual(project(input, selectors, OPT_IN).creatives[0].format_id, {
      agent_url: OWNER,
      id: 'video_vast',
      duration_ms: 30000,
    });
  });
  test('canonical wire stays canonical for different player sizes', () => {
    const input = request();
    assert.deepEqual(project(input, [container('A'), container('B', 480)], OPT_IN, 'canonical'), input);
  });
  test('unknown wire follows the same explicit opt-in policy as legacy delivery', () => {
    assert.equal(
      project(request(), [container('A'), container('B', 480)], OPT_IN, 'unknown').creatives[0].format_id.width,
      undefined
    );
  });
  test('mixed canonical-only and legacy options preserve the strict default', () => {
    const selectors = [container('A'), container('B')];
    selectors.forEach(value =>
      value.format_options.push({
        format_option_id: 'simid',
        format_kind: 'video_vast',
        canonical_formats_only: true,
        params: {},
      })
    );
    assert.deepEqual(project(request(), selectors).creatives[0].format_id, selectors[0].format_ids[1]);
  });
  for (const putDurationOnRef of [false, true]) {
    test(`refuses conflicting option durations (duration on ref: ${putDurationOnRef})`, () => {
      const value = creative();
      delete value.format_parameters;
      const selectors = [container('A', 360, 'video_vast', [30000]), container('B', 480, 'video_vast', [30000])];
      selectors[0].format_options[0].params.duration_ms_exact = 15000;
      if (!putDurationOnRef)
        selectors.forEach(item =>
          item.format_ids.forEach(ref => {
            delete ref.duration_ms;
          })
        );
      const error = refusal(request(value), selectors, OPT_IN);
      assert.match(error.message, /non-size format parameters/);
    });
  }
  test('equivalent duration evidence need not use identical redundant parameter fields', () => {
    const selectors = [container('A'), container('B', 480)];
    selectors[0].format_options.forEach(option => {
      delete option.params.duration_ms_exact;
    });
    assert.deepEqual(project(request(), selectors, OPT_IN).creatives[0].format_id, {
      agent_url: OWNER,
      id: 'video_vast',
      duration_ms: 30000,
    });
  });
  for (const nested of [false, true]) {
    test(`a selected option cannot fall back to an unselected matching ref (nested: ${nested})`, () => {
      const a = container('A');
      a.format_option_refs = [{ format_option_id: a.format_options[0].format_option_id }];
      const selectors = [nested ? { package_id: 'A', selector_containers: [a] } : a, container('B')];
      for (const policy of [undefined, OPT_IN]) {
        const error = refusal(request(), selectors, policy);
        assert.deepEqual(error.details.package_refs[0].ref, a.format_ids[0]);
        assert.match(error.details.package_refs[0].reason, /selected package format options/);
        assert.deepEqual(error.details.package_refs[1].ref, selectors[1].format_ids[1]);
      }
    });
  }
  test('selected migrated IDs retain their bare legacy refs for one or multiple packages', () => {
    const { migratedFormatOptionId } = require('../../dist/lib/v2/projection/v1-to-v2.js');
    const ref = { agent_url: OWNER, id: 'video_vast', duration_ms: 30000 };
    for (const legacy of [false, true]) {
      const value = legacy ? { ...creative(), format_id: ref } : creative();
      if (legacy) delete value.format_kind;
      for (const packages of [['A'], ['A', 'B']]) {
        const selectors = packages.map(package_id => ({
          package_id,
          format_kind: 'video_vast',
          format_ids: [ref],
          format_option_refs: [{ format_option_id: migratedFormatOptionId(ref) }],
        }));
        for (const policy of [undefined, OPT_IN]) {
          assert.deepEqual(project(request(value, packages), selectors, policy).creatives[0].format_id, ref);
        }
      }
    }
  });
  test('creative-only resolvers still map selected options with unmapped legacy routes', () => {
    const value = creative();
    value.format_option_ref = { format_option_id: 'selected-no-route' };
    const selectors = [container('A'), container('B')];
    selectors.forEach(selector => {
      selector.format_options.push({
        format_kind: 'video_vast',
        format_option_id: 'selected-no-route',
        params: { duration_ms_exact: 30000 },
      });
    });
    const resolver = context =>
      context.source === 'creative'
        ? {
            agent_url: OWNER,
            id: 'custom_vast_route',
            width: 640,
            height: context.selector.package_id === 'B' ? 480 : 360,
            duration_ms: 30000,
          }
        : undefined;
    const output = project(request(value), selectors, OPT_IN, 'legacy', resolver);
    assert.deepEqual(output.creatives[0].format_id, { agent_url: OWNER, id: 'custom_vast_route', duration_ms: 30000 });
    // Identical custom mappings remain valid without opting into size omission.
    const sameRefResolver = context =>
      context.source === 'creative'
        ? {
            agent_url: OWNER,
            id: 'custom_vast_route',
            duration_ms: 30000,
          }
        : undefined;
    assert.deepEqual(project(request(value), selectors, undefined, 'legacy', sameRefResolver).creatives[0].format_id, {
      agent_url: OWNER,
      id: 'custom_vast_route',
      duration_ms: 30000,
    });
    selectors[1].format_options.at(-1).params.vast_versions = ['4.0'];
    assert.throws(() => project(request(value), selectors, OPT_IN, 'legacy', resolver), CreativeFormatProjectionError);
  });
  test('selected option duration ranges must accept the chosen ref, with exact duration taking precedence', () => {
    const selectors = [container('A', 360, 'video_vast', [30000]), container('B', 480, 'video_vast', [30000])];
    for (const selector of selectors) {
      delete selector.format_options[0].params.duration_ms_exact;
      selector.format_options[0].params.duration_ms_range = [1000, 5000];
    }
    refusal(request(), selectors, OPT_IN);
    selectors.forEach(selector => {
      selector.format_options[0].params.duration_ms_range = [15000, 30000];
    });
    assert.equal(project(request(), selectors, OPT_IN).creatives[0].format_id.duration_ms, 30000);
    selectors.forEach(selector => {
      selector.format_options[0].params.duration_ms_range = [1000, 5000];
      selector.format_options[0].params.duration_ms_exact = 30000;
    });
    assert.equal(project(request(), selectors, OPT_IN).creatives[0].format_id.duration_ms, 30000);
  });
  test('resolver answers are snapshotted when a caller reuses one mutable ref object', () => {
    const value = creative();
    value.format_parameters.duration_ms = 15000;
    const selectors = [container('A'), container('B', 480)];
    selectors.forEach(item => {
      delete item.format_ids;
      item.format_options.forEach(option => {
        delete option.v1_format_ref;
      });
    });
    const before = structuredClone({ value, selectors });
    const shared = {};
    let calls = 0;
    const resolver = context => {
      if (context.source !== 'product') return undefined;
      calls++;
      return Object.assign(shared, {
        agent_url: OWNER,
        id: 'video_vast',
        width: context.declaration.params.width,
        height: context.declaration.params.height,
        duration_ms: context.declaration.params.duration_ms_exact,
      });
    };
    const output = project(request(value), selectors, OPT_IN, 'legacy', resolver);
    assert.deepEqual(output.creatives[0].format_id, { agent_url: OWNER, id: 'video_vast', duration_ms: 15000 });
    assert.equal(calls, 4);
    assert.deepEqual({ value, selectors }, before);
  });
  test('duplicate creative resolver answers retain single-result validation across packages', () => {
    const resolver = context => {
      if (context.source !== 'creative') return undefined;
      const ref = { agent_url: OWNER, id: 'video_vast', width: 640, height: 360, duration_ms: 30000 };
      return [ref, ref];
    };
    for (const packages of [['A'], ['A', 'B']]) {
      for (const policy of [undefined, OPT_IN]) {
        assert.throws(
          () =>
            project(
              request(creative(), packages),
              packages.map(package_id => ({ package_id })),
              policy,
              'legacy',
              resolver
            ),
          error =>
            error instanceof CreativeFormatProjectionError &&
            /invalid or ambiguous creative mapping/.test(error.message)
        );
      }
    }
  });
  test('does not discard different non-size VAST declarations', () => {
    const selectors = [container('A'), container('B', 480)];
    selectors[0].format_options.forEach(option => {
      option.params.vast_versions = ['3.0'];
    });
    selectors[1].format_options.forEach(option => {
      option.params.vast_versions = ['4.0'];
    });
    refusal(request(), selectors, OPT_IN);
  });
  test('resolver-backed failures retain actual refs without calling the resolver twice', () => {
    const value = {
      ...creative('video_hosted'),
      format_parameters: { width: 640, height: 360, duration_ms: 30000 },
      assets: { video: { asset_type: 'video', url: 'https://cdn.example/video.mp4' } },
    };
    const selectors = [container('A', 360, 'video_hosted'), container('B', 480, 'video_hosted')];
    selectors.forEach(item => {
      delete item.format_ids;
      item.format_options.forEach(option => {
        delete option.v1_format_ref;
      });
    });
    let calls = 0;
    const resolver = context => {
      if (context.source !== 'product') return undefined;
      calls++;
      const params = context.declaration.params;
      return {
        agent_url: OWNER,
        id: 'video_hosted',
        width: params.width,
        height: params.height,
        duration_ms: params.duration_ms_exact,
      };
    };
    let error;
    try {
      project(request(value), selectors, OPT_IN, 'legacy', resolver);
    } catch (cause) {
      error = cause;
    }
    assert.ok(error instanceof CreativeFormatProjectionError);
    assert.deepEqual(error.details.package_refs[1].ref, {
      agent_url: OWNER,
      id: 'video_hosted',
      width: 640,
      height: 480,
      duration_ms: 30000,
    });
    assert.equal(calls, 4);
  });
  test('resolver-backed ambiguity reports every remaining resolved ref', () => {
    const a = container('A', 360, 'video_vast', [30000]);
    a.format_options.push(...container('A', 720, 'video_vast', [30000]).format_options);
    const selectors = [a, container('B', 480, 'video_vast', [30000])];
    selectors.forEach(item => {
      delete item.format_ids;
      item.format_options.forEach(option => {
        delete option.v1_format_ref;
      });
    });
    const resolver = context =>
      context.source === 'product'
        ? {
            agent_url: OWNER,
            id: 'video_vast',
            width: context.declaration.params.width,
            height: context.declaration.params.height,
            duration_ms: context.declaration.params.duration_ms_exact,
          }
        : undefined;
    let error;
    try {
      project(request(), selectors, OPT_IN, 'legacy', resolver);
    } catch (cause) {
      error = cause;
    }
    assert.ok(error instanceof CreativeFormatProjectionError);
    assert.deepEqual(
      error.details.package_refs[0].refs.map(ref => ref.height),
      [360, 720]
    );
  });
  test('does not override a package canonical-only declaration', () => {
    const selectors = [container('A'), container('B', 480)];
    selectors[1].format_options.forEach(option => {
      option.canonical_formats_only = true;
    });
    const error = refusal(request(), selectors, OPT_IN);
    assert.match(error.details.package_refs[1].reason, /forbids legacy/);
  });
  test('public sync API snapshots the policy and keeps projection options out of task execution', async () => {
    const { SingleAgentClient } = require('../../dist/lib/index.js');
    const client = new SingleAgentClient(
      { id: 'player-sizes', name: 'Player sizes', protocol: 'mcp', agent_uri: 'https://seller.example/mcp' },
      { adcpVersion: '3.1.29' }
    );
    const projection = { selectorContainers: [container('A'), container('B', 480)], ...OPT_IN };
    client.resolveCreativeWireMode = async () => {
      projection.playerSizedRefs = undefined;
      return 'legacy';
    };
    let delivered;
    client.executeAndHandle = async (_tool, _handler, params, _input, options) => {
      delivered = params;
      assert.equal(options.creativeFormatProjection, undefined);
      return { success: true, status: 'completed', data: { creatives: [] } };
    };
    await client.syncCreatives(
      { account: { account_id: 'account' }, idempotency_key: randomUUID(), ...request() },
      undefined,
      { creativeFormatProjection: projection }
    );
    assert.deepEqual(delivered.creatives[0].format_id, { agent_url: OWNER, id: 'video_vast', duration_ms: 30000 });
    assert.equal(delivered.playerSizedRefs, undefined);
    assert.equal(delivered.creativeFormatProjection, undefined);
  });
});

test('AdCP 3.1 player-sized delivery over the official in-process MCP transport', async () => {
  const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
  const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
  const { AgentClient } = require('../../dist/lib/index.js');
  const server = new Server({ name: 'player-sized-seller', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: 'get_adcp_capabilities', inputSchema: { type: 'object', additionalProperties: true } },
      {
        name: 'sync_creatives',
        inputSchema: {
          type: 'object',
          properties: {
            creatives: {
              type: 'array',
              items: { type: 'object', required: ['format_id'], properties: { format_id: { type: 'object' } } },
            },
          },
        },
      },
    ],
  }));
  const calls = [];
  server.setRequestHandler(CallToolRequestSchema, async req => {
    const result =
      req.params.name === 'get_adcp_capabilities'
        ? {
            adcp_version: '3.1',
            adcp: {
              major_versions: [3],
              supported_versions: ['3.0', '3.1'],
              idempotency: { supported: true, replay_ttl_seconds: 86400 },
            },
            supported_protocols: ['media_buy'],
            specialisms: [],
          }
        : { adcp_version: '3.1', creatives: [] };
    if (req.params.name === 'sync_creatives') calls.push(req.params.arguments);
    return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  const [buyerTransport, sellerTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'player-sized-buyer', version: '1.0.0' });
  try {
    await server.connect(sellerTransport);
    await mcp.connect(buyerTransport);
    const client = AgentClient.fromMCPClient(mcp, { adcpVersion: '3.1.29', validateFeatures: false });
    const selectors = [container('A'), container('B', 480)];
    // Persisted canonical product declarations use a caller resolver for the legacy route.
    for (const selector of selectors) {
      delete selector.format_ids;
      selector.format_options.forEach(option => {
        delete option.v1_format_ref;
      });
    }
    const result = await client.syncCreatives(
      { account: { account_id: 'account' }, idempotency_key: randomUUID(), ...request() },
      undefined,
      {
        creativeFormatProjection: { selectorContainers: selectors, ...OPT_IN },
        canonicalFormatLegacyResolver: context =>
          context.source === 'product'
            ? {
                agent_url: OWNER,
                id: 'video_vast',
                width: context.declaration.params.width,
                height: context.declaration.params.height,
                duration_ms: context.declaration.params.duration_ms_exact,
              }
            : undefined,
      }
    );
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].creatives[0].format_id, { agent_url: OWNER, id: 'video_vast', duration_ms: 30000 });
    assert.deepEqual(calls[0].assignments, request().assignments);
    assert.equal(calls[0].creativeFormatProjection, undefined);
  } finally {
    await mcp.close();
    await server.close();
  }
});
