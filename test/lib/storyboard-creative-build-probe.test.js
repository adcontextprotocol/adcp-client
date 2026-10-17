const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveCreativeBuildProbe,
  createTestClient,
  parseStoryboard,
  runStoryboard,
  runStoryboardStep,
} = require('../../dist/lib/testing');

const spec = { context_prefix: 'evaluator_build', message: 'Create one creative for a sandbox fixture.' };
const route = (id, operations, kind = 'image') => ({
  capability_id: id,
  ...(operations !== undefined && { operations }),
  format: { format_kind: kind, params: {}, technical_requirements_complete: true },
});
const creative = (...routes) => ({ supports_generation: true, supports_evaluator: true, supported_formats: routes });
const recipe = {
  match: [{ path: '/format/format_kind', operator: 'equals', value: 'image' }],
  input: {
    creative_manifest: {
      format_kind: 'image',
      assets: {
        image_main: {
          asset_type: 'image',
          url: 'https://test-assets.example/image.jpg',
          width: 300,
          height: 250,
        },
      },
    },
  },
};

test('selects build after preview/validate entries without changing the catalog', () => {
  const caps = creative(route('preview', ['preview']), route('validate', ['validate']), route('build', ['build']));
  const before = structuredClone(caps);
  const result = resolveCreativeBuildProbe(caps, spec);
  assert.equal(result.status, 'resolved');
  assert.equal(result.capabilityId, 'build');
  assert.equal(result.source, 'generation');
  assert.deepEqual(result.context.evaluator_build_creative_manifest, { format_kind: 'image', assets: {} });
  assert.deepEqual(caps, before);
});

test('legacy omitted operations means build; missing ID remains a legal unaddressable route', () => {
  assert.equal(resolveCreativeBuildProbe(creative(route('legacy')), spec).capabilityId, 'legacy');
  assert.equal(
    resolveCreativeBuildProbe(creative({ format: { format_kind: 'image', params: {} } }), spec).status,
    'unsatisfied'
  );
});

test('does not infer generation route in a mixed build catalog', () => {
  assert.equal(
    resolveCreativeBuildProbe(creative(route('transform', ['build']), route('generate', ['build'])), spec).status,
    'unsatisfied'
  );
});

test('selects first satisfiable route and binds its provisioned input atomically', () => {
  const result = resolveCreativeBuildProbe(
    {
      supports_transformation: true,
      supported_formats: [route('audio', ['build'], 'audio_vast'), route('image', ['build'])],
    },
    spec,
    { creative_build_probes: [recipe] }
  );
  assert.equal(result.capabilityId, 'image');
  assert.deepEqual(result.context.evaluator_build_creative_manifest, recipe.input.creative_manifest);
  assert.equal(result.source, 'test_kit');
});

test('no image/video/custom source assets are fabricated when fixture information is unavailable', () => {
  for (const kind of ['image', 'video_vast', 'custom']) {
    const target = route('transform', ['build'], kind);
    if (kind === 'custom')
      Object.assign(target.format, {
        format_shape: 'custom-fixture',
        canonical_formats_only: true,
        format_schema: { uri: 'https://agent.example/schema.json', digest: `sha256:${'a'.repeat(64)}` },
      });
    const result = resolveCreativeBuildProbe({ supports_transformation: true, supported_formats: [target] }, spec, {
      assets: {},
    });
    assert.equal(result.status, 'unsatisfied');
  }
});

test('rejects malformed catalogs, duplicate IDs and malformed operation declarations', () => {
  assert.equal(resolveCreativeBuildProbe({ supported_formats: 'invalid' }, spec).status, 'failed');
  assert.match(
    resolveCreativeBuildProbe(creative(route('same', ['build']), route('same', ['preview'])), spec).detail,
    /unique/
  );
  assert.match(resolveCreativeBuildProbe(creative(route('x', [])), spec).detail, /operations/);
  for (const format of [
    { format_kind: 'bogus', params: {} },
    { format_kind: 'image', params: {}, technical_requirements_complete: 'true' },
  ]) {
    assert.equal(resolveCreativeBuildProbe(creative({ capability_id: 'x', format }), spec).status, 'failed');
  }
});

test('fixtures cannot replace evaluator, account, correlation or authentication controls', () => {
  for (const key of ['evaluator', 'account', 'context', 'idempotency_key', 'auth', 'task']) {
    assert.throws(
      () =>
        resolveCreativeBuildProbe(creative(route('x')), spec, {
          creative_build_probes: [{ ...recipe, input: { ...recipe.input, [key]: {} } }],
        }),
      /input may only/
    );
  }
  assert.throws(
    () =>
      resolveCreativeBuildProbe(creative(route('x')), spec, {
        creative_build_probes: [{ ...recipe, input: { message: 'Build', config: { api_key: 'do-not-forward' } } }],
      }),
    /credential/
  );
});

function storyboard() {
  return parseStoryboard(`
id: evaluator_probe
version: "1.0.0"
title: Evaluator probe
category: creative
summary: Resolver contract regression
requires_all_capabilities:
  - path: creative
    present: true
  - path: creative.supports_evaluator
    equals: true
creative_build_probe:
  context_prefix: evaluator_build
  message: Create one sandbox creative
phases:
  - id: direct
    title: Direct
    steps:
      - id: reject_direct
        title: Direct rejection
        task: build_creative
        requires_contract: creative_build_probe_runner
        expect_error: true
        stateful: true
        sample_request:
          evaluator:
            agent_url: "https://off-list.example/adcp"
        context_inputs:
          - key: evaluator_build_capability_id
            inject_at: target_capability_id
          - key: evaluator_build_target_format_id
            inject_at: target_format_id
          - key: evaluator_build_creative_id
            inject_at: creative_id
          - key: evaluator_build_transformer_id
            inject_at: transformer_id
          - key: evaluator_build_config
            inject_at: config
          - key: evaluator_build_message
            inject_at: message
          - key: evaluator_build_creative_manifest
            inject_at: creative_manifest
        validations:
          - check: error_code
            value: EVALUATOR_AGENT_NOT_ACCEPTED
  - id: nested
    title: Nested
    steps:
      - id: reject_nested
        title: Nested rejection
        task: build_creative
        requires_contract: creative_build_probe_runner
        expect_error: true
        stateful: true
        sample_request:
          evaluator:
            agent_url: "https://accepted.example/adcp"
            feature_agent:
              agent_url: "https://off-list.example/adcp"
        context_inputs:
          - key: evaluator_build_capability_id
            inject_at: target_capability_id
          - key: evaluator_build_target_format_id
            inject_at: target_format_id
          - key: evaluator_build_creative_id
            inject_at: creative_id
          - key: evaluator_build_transformer_id
            inject_at: transformer_id
          - key: evaluator_build_config
            inject_at: config
          - key: evaluator_build_message
            inject_at: message
          - key: evaluator_build_creative_manifest
            inject_at: creative_manifest
        validations:
          - check: error_code
            value: EVALUATOR_AGENT_NOT_ACCEPTED
`);
}
function options(caps, calls, badForm, testKit) {
  const tools = ['get_adcp_capabilities', 'build_creative', 'comply_test_controller'];
  return {
    _profile: { tools, raw_capabilities: { creative: caps } },
    agentTools: tools,
    context: {
      evaluator_build_creative_manifest: { stale: true },
      evaluator_build_config: { stale: true },
      evaluator_build_target_format_id: { stale: true },
    },
    test_kit: testKit,
    _client: {
      resetContext() {},
      async executeTask(task, input) {
        calls.push({ task, input });
        assert.equal(input.target_capability_id, 'build');
        assert.equal(input.target_format_id, undefined);
        assert.notDeepEqual(input.creative_manifest, { stale: true });
        assert.equal(input.config, undefined);
        const form = input.evaluator.feature_agent ? 'nested' : 'direct';
        return {
          success: false,
          data: {
            errors: [
              { code: form === badForm ? 'INVALID_REQUEST' : 'EVALUATOR_AGENT_NOT_ACCEPTED', message: 'Rejected' },
            ],
          },
        };
      },
    },
  };
}
for (const badForm of [undefined, 'direct', 'nested']) {
  test(`real runner preserves independent rejection grading after route preparation: ${badForm ?? 'good'}`, async () => {
    const calls = [];
    const result = await runStoryboard(
      'https://agent.example/mcp',
      storyboard(),
      options(creative(route('validate', ['validate']), route('build', ['build'])), calls, badForm)
    );
    assert.equal(result.overall_passed, !badForm);
    assert.equal(result.failed_count, badForm ? 1 : 0);
    assert.equal(calls.length, badForm === 'direct' ? 1 : 2);
    assert.equal(result.fixture_resolutions[0].status, 'resolved');
  });
}

test('unsatisfied fixture preflights before seeding or ordinary steps and receives zero coverage', async () => {
  const calls = [];
  const sb = storyboard();
  sb.prerequisites = { controller_seeding: true };
  sb.fixtures = { accounts: [{ account_id: 'sandbox-account' }] };
  const result = await runStoryboard(
    'https://agent.example/mcp',
    sb,
    options(
      { supports_evaluator: true, supports_transformation: true, supported_formats: [route('build', ['build'])] },
      calls
    )
  );
  assert.equal(result.overall_passed, true);
  assert.equal(result.passed_count, 0);
  assert.equal(result.failed_count, 0);
  assert.equal(result.skipped_count, 1);
  assert.equal(result.coverage_gaps[0].reason, 'fixture_unsatisfied');
  assert.deepEqual(calls, []);
});

test('standalone step uses the same atomic preparation', async () => {
  const calls = [];
  const result = await runStoryboardStep(
    'https://agent.example/mcp',
    storyboard(),
    'reject_nested',
    options(
      { supports_evaluator: true, supports_transformation: true, supported_formats: [route('build', ['build'])] },
      calls,
      undefined,
      { creative_build_probes: [recipe] }
    )
  );
  assert.equal(result.passed, true);
  assert.equal(result.skipped, undefined);
  assert.deepEqual(calls[0].input.creative_manifest, recipe.input.creative_manifest);
});

test('generation alone never proves missing input constraints absent', () => {
  for (const change of [
    r => delete r.format.technical_requirements_complete,
    r => (r.format.params.slots = []),
    r => (r.format.required_connections = []),
    r => (r.required_input = 'seed'),
    r => (r.format.locale_policy = {}),
    r => (r.format.macro_resolution_capabilities = []),
    r => (r.format.format_schema = {}),
    r => (r.format.unknown_extension = {}),
  ]) {
    const r = route('build');
    change(r);
    assert.notEqual(resolveCreativeBuildProbe(creative(r), spec).status, 'resolved');
  }
});

test('manifest and recipe mode validation rejects malformed harness inputs before transport', () => {
  for (const input of [
    {
      creative_manifest: {
        format_kind: 'image',
        format_id: { agent_url: 'https://agent.example', id: 'x' },
        assets: {},
      },
    },
    { creative_manifest: { format_kind: 'image' } },
    { creative_manifest: recipe.input.creative_manifest, creative_id: 'library-id' },
    { message: 'Build', config: {} },
  ])
    assert.throws(() =>
      resolveCreativeBuildProbe(creative(route('build')), spec, { creative_build_probes: [{ ...recipe, input }] })
    );
});
test('input mode eligibility never suppresses a later satisfiable provisioned route', () => {
  for (const [input, flag] of [
    [{ creative_id: 'provisioned-library-id' }, 'has_creative_library'],
    [{ transformer_id: 'provisioned-transformer', config: {} }, 'supports_transformers'],
  ]) {
    const kit = {
      creative_build_probes: [{ match: [{ path: '/capability_id', operator: 'equals', value: 'build' }], input }],
    };
    const caps = { supported_formats: [route('build')] };
    assert.equal(resolveCreativeBuildProbe(caps, spec, kit).status, 'unsatisfied');
    caps[flag] = true;
    assert.equal(resolveCreativeBuildProbe(caps, spec, kit).status, 'resolved');
  }
});
test('standalone unsatisfied fixture is an explicit zero-validation skip', async () => {
  const result = await runStoryboardStep(
    'https://agent.example/mcp',
    storyboard(),
    'reject_nested',
    options({ supports_evaluator: true, supports_transformation: true, supported_formats: [route('build')] }, [])
  );
  assert.equal(result.skip_reason, 'fixture_unsatisfied');
  assert.match(result.skip.detail, /creative_format:evaluator_build/);
  assert.deepEqual(result.validations, []);
});

test('payload-bound governance requires fresh prepared authorization, never a static recipe', () => {
  const caps = creative(route('build'));
  const enforcement = task => ({ tasks: [{ task, modes: ['signed_context'] }] });
  assert.equal(
    resolveCreativeBuildProbe(caps, spec, undefined, undefined, enforcement('build_creative')).status,
    'unsatisfied'
  );
  assert.equal(
    resolveCreativeBuildProbe(caps, spec, undefined, undefined, enforcement('create_media_buy')).status,
    'resolved'
  );
});

test('credential fields, credential URLs and invalid automatic manifests are never dispatched', () => {
  for (const config of [
    { token: 'secret' },
    { credentials: {} },
    { password: 'secret' },
    { private_key: 'secret' },
    { asset_url: 'https://user:password@assets.example/x' },
    { asset_url: 'https://assets.example/x?access_token=secret' },
  ]) {
    assert.throws(
      () =>
        resolveCreativeBuildProbe(creative(route('build')), spec, {
          creative_build_probes: [
            { ...recipe, input: { transformer_id: 'provisioned-transformer', config, message: 'Render' } },
          ],
        }),
      /credential/
    );
  }
  assert.notEqual(
    resolveCreativeBuildProbe(creative(route('build', ['build'], 'coordinated_placements')), spec).status,
    'resolved'
  );
});
test('operator manifest recipe is preserved without adding a brief', () => {
  const result = resolveCreativeBuildProbe(
    { supports_transformation: true, supported_formats: [route('build')] },
    spec,
    { creative_build_probes: [recipe] }
  );
  assert.equal(result.status, 'resolved');
  assert.equal(result.context.evaluator_build_message, undefined);
});

test('inert descriptive metadata does not remove applicable security coverage', async () => {
  const r = route('build');
  Object.assign(r.format, {
    seller_preference: 'preferred',
    experimental: false,
    sample_render_url: 'https://agent.example/sample',
    applies_to_channels: ['display'],
    canonical_formats_only: true,
  });
  assert.equal(resolveCreativeBuildProbe(creative(r), spec).status, 'resolved');
  const result = await runStoryboard('https://agent.example/mcp', storyboard(), options(creative(r), []));
  assert.equal(result.overall_passed, true);
  assert.equal(result.passed_count, 2);
});
test('malformed producer catalog is a graded failure, never an uncaught crash or unavailable fixture', async () => {
  const r = route('build');
  r.format.seller_preference = 'NOT_AN_ENUM_VALUE';
  const caps = creative(r);
  const calls = [];
  const result = await runStoryboard('https://agent.example/mcp', storyboard(), options(caps, calls));
  assert.equal(result.overall_passed, false);
  assert.equal(result.failed_count, 1);
  assert.equal(result.fixture_resolutions[0].status, 'failed');
  assert.match(result.phases[0].steps[0].validations[0].error, /supported_formats\[0\]/);
  assert.deepEqual(calls, []);
  const step = await runStoryboardStep(
    'https://agent.example/mcp',
    storyboard(),
    'reject_nested',
    options(caps, calls)
  );
  assert.equal(step.passed, false);
  assert.equal(step.validations[0].passed, false);
});
test('no-phases fixture gap replaces the sentinel and counts once', async () => {
  const sb = storyboard();
  sb.phases = [];
  const result = await runStoryboard('https://agent.example/mcp', sb, options({ supported_formats: [] }, []));
  assert.equal(result.skipped_count, 1);
  assert.equal(result.passed_count, 0);
  assert.equal(
    result.phases.some(phase => phase.phase_id === 'no_phases'),
    false
  );
});

test('replicated multi-pass preparation is one explicit gap before seeding', { timeout: 5000 }, async () => {
  const opts = options(creative(route('build')), []);
  delete opts._client;
  opts.multi_instance_strategy = 'multi-pass';
  opts._controllerCapabilities = { detected: false, scenarios: [] };
  const result = await runStoryboard(['https://first.example/mcp', 'https://second.example/mcp'], storyboard(), opts);
  assert.equal(result.passed_count, 0);
  assert.equal(result.failed_count, 0);
  assert.equal(result.skipped_count, 1);
  assert.match(result.coverage_gaps[0].detail, /independent fixture/);
  await assert.rejects(
    runStoryboard(['https://first.example/mcp', 'https://second.example/mcp'], storyboard(), {
      ...opts,
      webhook_receiver: {},
    }),
    /incompatible/
  );
});

test('missing selected-version catalog validators never authorize a probe, including an operator recipe', () => {
  const result = resolveCreativeBuildProbe(
    creative(route('build')),
    spec,
    {
      creative_build_probes: [
        {
          match: [{ path: '/capability_id', operator: 'equals', value: 'build' }],
          input: { message: 'Provisioned brief' },
        },
      ],
    },
    'v2.5'
  );
  assert.equal(result.status, 'unsatisfied');
  assert.match(result.detail, /schema validators are unavailable/);
});

test('missing selected-version validators block full and standalone dispatch with zero credit', async () => {
  const calls = [];
  const opts = { ...options(creative(route('build')), calls), adcpVersion: 'v2.5' };
  const full = await runStoryboard('https://agent.example/mcp', storyboard(), opts);
  assert.equal(full.passed_count, 0);
  assert.equal(full.failed_count, 0);
  assert.match(full.coverage_gaps[0].detail, /schema validators are unavailable/);
  const single = await runStoryboardStep('https://agent.example/mcp', storyboard(), 'reject_nested', opts);
  assert.equal(single.skip_reason, 'fixture_unsatisfied');
  assert.deepEqual(single.validations, []);
  assert.deepEqual(calls, []);
});
test('operator recipe budgets bound repeated aliases and bytes before recursive normalization', () => {
  let alias = { value: 'x' };
  for (let i = 0; i < 20; i++) alias = { left: alias, right: alias };
  for (const value of [alias, 'x'.repeat(4 * 1024 * 1024 + 1)]) {
    assert.throws(
      () =>
        resolveCreativeBuildProbe(creative(route('build')), spec, {
          creative_build_probes: [
            { match: [{ path: '/format', operator: 'equals', value }], input: { message: 'Build' } },
          ],
        }),
      /budget/
    );
  }
});

const legacyTarget = { agent_url: 'https://formats.example', id: 'provisioned_format' };
test('selected 3.1 catalog/selector contract accepts explicit provisioned FormatID without inventing capability identity', () => {
  for (const capability_id of [undefined, 'seller.route:with-dots']) {
    const entry = { format: { format_kind: 'image', params: {} }, ...(capability_id && { capability_id }) };
    const kit = { creative_build_probes: [{ ...recipe, input: { ...recipe.input, target_format_id: legacyTarget } }] };
    const result = resolveCreativeBuildProbe(
      { supports_transformation: true, supported_formats: [entry] },
      spec,
      kit,
      '3.1.29'
    );
    assert.equal(result.status, 'resolved');
    assert.deepEqual(result.formatId, legacyTarget);
    assert.deepEqual(result.context.evaluator_build_target_format_id, legacyTarget);
    assert.equal(result.context.evaluator_build_capability_id, undefined);
    assert.equal(resolveCreativeBuildProbe(creative(entry), spec, undefined, '3.1.29').status, 'unsatisfied');
  }
});
test('3.1 open-enum unknown route is preserved while later known provisioned route executes', () => {
  const caps = {
    supports_transformation: true,
    supported_formats: [route('future', undefined, 'future_canonical'), route('known')],
  };
  const before = structuredClone(caps);
  const kit = { creative_build_probes: [{ ...recipe, input: { ...recipe.input, target_format_id: legacyTarget } }] };
  assert.equal(resolveCreativeBuildProbe(caps, spec, kit, '3.1.29').status, 'resolved');
  assert.deepEqual(caps, before);
  assert.equal(
    resolveCreativeBuildProbe({ ...caps, supported_formats: [caps.supported_formats[0]] }, spec, kit, '3.1.29').status,
    'unsatisfied'
  );
});
for (const standalone of [false, true])
  for (const badForm of [undefined, 'direct', 'nested']) {
    test(`transformer-only provisioned recipe dispatches and grades independently: standalone=${standalone}, bad=${badForm}`, async () => {
      const calls = [];
      const opts = options(
        { supports_evaluator: true, supports_transformers: true, supported_formats: [route('build')] },
        calls,
        badForm,
        {
          creative_build_probes: [
            { ...recipe, input: { transformer_id: 'provisioned-transformer', config: { headline: 'Winter offer' } } },
          ],
        }
      );
      opts._client.executeTask = async (task, input) => {
        calls.push({ task, input });
        assert.equal(input.message, undefined);
        assert.equal(input.creative_manifest, undefined);
        assert.equal(input.transformer_id, 'provisioned-transformer');
        assert.deepEqual(input.config, { headline: 'Winter offer' });
        return {
          success: false,
          data: {
            errors: [
              {
                code:
                  (input.evaluator.feature_agent ? 'nested' : 'direct') === badForm
                    ? 'INVALID_REQUEST'
                    : 'EVALUATOR_AGENT_NOT_ACCEPTED',
                message: 'Rejected',
              },
            ],
          },
        };
      };
      if (standalone) {
        for (const [id, form] of [
          ['reject_direct', 'direct'],
          ['reject_nested', 'nested'],
        ]) {
          const result = await runStoryboardStep('https://agent.example/mcp', storyboard(), id, opts);
          assert.equal(result.passed, badForm !== form);
        }
      } else {
        const result = await runStoryboard('https://agent.example/mcp', storyboard(), opts);
        assert.equal(result.overall_passed, !badForm);
      }
      assert.ok(calls.length > 0);
    });
  }
for (const key of [
  'x-api-key',
  'x_api_key',
  'signing_key',
  'signingKey',
  'secretKey',
  'hmac_key',
  'clientKey',
  'jwksUri',
]) {
  test(`operator credential alias ${key} is rejected in objects and URL queries`, () => {
    for (const config of [{ [key]: 'secret' }, { asset_url: `https://assets.example/x?${key}=secret` }]) {
      assert.throws(
        () =>
          resolveCreativeBuildProbe({ supports_transformers: true, supported_formats: [route('build')] }, spec, {
            creative_build_probes: [{ ...recipe, input: { transformer_id: 'provisioned-transformer', config } }],
          }),
        /credential/
      );
    }
  });
}

test('legacy recipes honor explicit no-projection and named-format pairing declarations', () => {
  const kit = { creative_build_probes: [{ ...recipe, input: { ...recipe.input, target_format_id: legacyTarget } }] };
  const r = route('build');
  const caps = { supports_transformation: true, supported_formats: [r] };
  r.format.canonical_formats_only = true;
  assert.equal(resolveCreativeBuildProbe(caps, spec, kit, '3.1.29').status, 'unsatisfied');
  delete r.format.canonical_formats_only;
  r.format.v1_format_ref = [{ ...legacyTarget, id: 'different_provisioned_format' }];
  assert.equal(resolveCreativeBuildProbe(caps, spec, kit, '3.1.29').status, 'unsatisfied');
  r.format.v1_format_ref = [{ ...legacyTarget, agent_url: 'https://FORMATS.example:443/' }];
  assert.equal(resolveCreativeBuildProbe(caps, spec, kit, '3.1.29').status, 'resolved');
});
for (const standalone of [false, true])
  test(`legacy full/standalone binding clears opposite selector: ${standalone}`, async () => {
    const calls = [];
    const opts = options(
      { supports_evaluator: true, supports_transformation: true, supported_formats: [route('build')] },
      calls,
      undefined,
      {
        creative_build_probes: [{ ...recipe, input: { ...recipe.input, target_format_id: legacyTarget } }],
      }
    );
    opts.adcpVersion = '3.1.29';
    opts.context.evaluator_build_capability_id = 'stale-canonical-route';
    opts._client.executeTask = async (task, input) => {
      calls.push(input);
      assert.equal(input.target_capability_id, undefined);
      assert.deepEqual(input.target_format_id, legacyTarget);
      return { success: false, data: { errors: [{ code: 'EVALUATOR_AGENT_NOT_ACCEPTED', message: 'Rejected' }] } };
    };
    opts._client = Object.assign(createTestClient('https://agent.example/mcp', 'mcp', opts), opts._client);
    opts._client.buildCreativeLegacy = input => opts._client.executeTask('build_creative', input);
    if (standalone) {
      assert.equal(
        (await runStoryboardStep('https://agent.example/mcp', storyboard(), 'reject_nested', opts)).passed,
        true
      );
    } else {
      const result = await runStoryboard('https://agent.example/mcp', storyboard(), opts);
      assert.equal(result.overall_passed, true);
      assert.deepEqual(result.fixture_resolutions[0].seller_ids, { format_id: legacyTarget });
    }
    assert.ok(calls.length > 0);
  });

test('3.1 unknown-kind tolerance does not suppress unrelated declared catalog errors', () => {
  const caps = {
    supports_transformation: true,
    supported_formats: [{ capability_id: 123, format: { format_kind: 'future_kind', params: {} } }, route('build')],
  };
  const kit = { creative_build_probes: [{ ...recipe, input: { ...recipe.input, target_format_id: legacyTarget } }] };
  assert.equal(resolveCreativeBuildProbe(caps, spec, kit, '3.1.29').status, 'failed');
});

test('legacy explicit pairing cannot equate two URLs rejected by the authoritative canonicalizer', () => {
  const id = { ...legacyTarget, agent_url: 'ftp://formats.example' };
  const r = route('build');
  r.format.v1_format_ref = [id];
  assert.equal(
    resolveCreativeBuildProbe(
      { supports_transformation: true, supported_formats: [r] },
      spec,
      { creative_build_probes: [{ ...recipe, input: { ...recipe.input, target_format_id: id } }] },
      '3.1.29'
    ).status,
    'unsatisfied'
  );
});

test('3.1 undeclared extension fields do not acquire newer producer requirements', () => {
  const r = route('legacy.route:id', ['preview']);
  r.format.technical_requirements_complete = 'extension-value';
  const kit = { creative_build_probes: [{ ...recipe, input: { ...recipe.input, target_format_id: legacyTarget } }] };
  assert.equal(
    resolveCreativeBuildProbe({ supports_transformation: true, supported_formats: [r] }, spec, kit, '3.1.29').status,
    'resolved'
  );
});
test('3.2 permits an explicitly provisioned legacy selector without requiring a new catalog ID', () => {
  const r = route(undefined, ['build']);
  delete r.capability_id;
  const kit = { creative_build_probes: [{ ...recipe, input: { ...recipe.input, target_format_id: legacyTarget } }] };
  const result = resolveCreativeBuildProbe(
    { supports_transformation: true, supported_formats: [r] },
    spec,
    kit,
    '3.2.5'
  );
  assert.equal(result.status, 'resolved');
  assert.equal(result.context.evaluator_build_capability_id, undefined);
  assert.deepEqual(result.context.evaluator_build_target_format_id, legacyTarget);
});
