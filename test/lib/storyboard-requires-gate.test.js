/**
 * Tests for the storyboard-level `requires:` gate (adcp-client#1626).
 *
 * The gate runs before any phase setup. A storyboard whose `requires` tag
 * names a runtime requirement that isn't available on this run skips the
 * whole storyboard with a structured `skip.requirement` field — distinct
 * from the per-step `requires_tool` cascade that today produces a chain of
 * `missing_test_controller` skips.
 *
 * Uses `_profile` injection so the tests run without the schema cache; the
 * gate fires before any phase or network call.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { runStoryboard, runStoryboardStep } = require('../../dist/lib/testing/storyboard/index.js');
const { parseStoryboard, validateStoryboardShape } = require('../../dist/lib/testing/storyboard/loader.js');

function buildStoryboard(overrides = {}) {
  return {
    id: 'requires_gate_test',
    version: '1.0.0',
    title: 'requires gate test',
    category: 'test',
    summary: 'Skipped when a requires tag is unmet.',
    narrative: '',
    agent: { interaction_model: 'sync', capabilities: [] },
    caller: { role: 'buyer_agent' },
    phases: [
      {
        id: 'p1',
        title: 'Phase 1',
        steps: [
          {
            id: 'step1',
            title: 'A trivial read',
            task: 'get_products',
          },
        ],
      },
    ],
    ...overrides,
  };
}

const profileWithoutController = {
  name: 'Test Agent (no controller)',
  tools: ['get_adcp_capabilities', 'get_products'],
  raw_capabilities: {},
};

const profileWithController = {
  name: 'Test Agent (controller present)',
  tools: ['get_adcp_capabilities', 'get_products', 'comply_test_controller'],
  raw_capabilities: {},
};

describe('Storyboard.requires gate (#1626)', () => {
  test('requires: [controller] skips with missing_test_controller when agent lacks it', async () => {
    const sb = buildStoryboard({ requires: ['controller'] });
    const result = await runStoryboard('http://fake-local-99999', sb, {
      _profile: profileWithoutController,
      agentTools: profileWithoutController.tools,
    });

    assert.equal(result.overall_passed, true, 'requires-unmet is not a failure');
    assert.equal(result.skipped_count, 1);
    assert.equal(result.passed_count, 0);
    assert.equal(result.failed_count, 0);

    const step = result.phases[0].steps[0];
    assert.equal(step.skipped, true);
    assert.equal(
      step.skip_reason,
      'missing_test_controller',
      'controller maps to existing missing_test_controller skip_reason for back-compat'
    );
    assert.ok(step.skip, 'structured skip block present');
    assert.equal(step.skip.reason, 'missing_test_controller');
    assert.equal(step.skip.requirement, 'controller', 'requirement field carries the unmet requirement name');
    assert.match(step.skip.detail, /comply_test_controller/);
  });

  test('requires: [controller] runs storyboard normally when agent advertises it', async () => {
    const sb = buildStoryboard({ requires: ['controller'] });
    // The synthetic phase has no executable wire calls; we only need to
    // observe that the gate did NOT short-circuit. Discovery would have
    // failed on the fake URL otherwise.
    const result = await runStoryboard('http://fake-local-99999', sb, {
      _profile: profileWithController,
      agentTools: profileWithController.tools,
    });

    // The gate passed — phases ran. The single phase fails on transport
    // (fake URL), but that's a separate signal: the synthetic
    // requirement_unmet phase is NOT present.
    const phaseIds = result.phases.map(p => p.phase_id);
    assert.ok(!phaseIds.includes('requirement_unmet'), 'gate must not synthesize requirement_unmet phase');
  });

  test('requires: [seeded_state] skips with requirement_unmet when flag absent', async () => {
    const sb = buildStoryboard({ requires: ['seeded_state'] });
    const result = await runStoryboard('http://fake-local-99999', sb, {
      _profile: profileWithoutController,
      agentTools: profileWithoutController.tools,
    });

    const step = result.phases[0].steps[0];
    assert.equal(step.skip_reason, 'requirement_unmet', 'seeded_state uses the new requirement_unmet skip_reason');
    assert.equal(step.skip.reason, 'requirement_unmet');
    assert.equal(step.skip.requirement, 'seeded_state');
    assert.match(step.skip.detail, /--asserts-seeded-state/);
  });

  test('requires: [seeded_state] passes when assertsSeededState: true', async () => {
    const sb = buildStoryboard({ requires: ['seeded_state'] });
    const result = await runStoryboard('http://fake-local-99999', sb, {
      _profile: profileWithoutController,
      agentTools: profileWithoutController.tools,
      assertsSeededState: true,
    });

    const phaseIds = result.phases.map(p => p.phase_id);
    assert.ok(!phaseIds.includes('requirement_unmet'), 'flag flips seeded_state to available');
  });

  test('requires: [real_wire] is always available (no-op gate)', async () => {
    const sb = buildStoryboard({ requires: ['real_wire'] });
    const result = await runStoryboard('http://fake-local-99999', sb, {
      _profile: profileWithoutController,
      agentTools: profileWithoutController.tools,
    });

    const phaseIds = result.phases.map(p => p.phase_id);
    assert.ok(!phaseIds.includes('requirement_unmet'), 'real_wire never blocks');
  });

  test('requires: [multi_agent] skips without options.agents', async () => {
    const sb = buildStoryboard({ requires: ['multi_agent'] });
    const result = await runStoryboard('http://fake-local-99999', sb, {
      _profile: profileWithoutController,
      agentTools: profileWithoutController.tools,
    });

    const step = result.phases[0].steps[0];
    assert.equal(step.skipped, true);
    assert.equal(step.skip_reason, 'requirement_unmet');
    assert.equal(step.skip.reason, 'requirement_unmet');
    assert.equal(step.skip.requirement, 'multi_agent');
    assert.match(step.skip.detail, /at least two distinct agent keys/);
    assert.match(step.skip.detail, /Available agents: \[\(none\)\]/);
  });

  test('requires: [multi_agent] passes with two distinct declared route keys', async () => {
    const sb = buildStoryboard({
      requires: ['multi_agent'],
      phases: [
        {
          id: 'p1',
          title: 'Phase 1',
          steps: [{ id: 'step1', title: 'A routed read', task: 'get_products', agent: 'signals' }],
        },
      ],
    });
    const result = await runStoryboard('', sb, {
      allow_http: true,
      agents: {
        sales: { url: 'http://127.0.0.1:1/sales/mcp' },
        signals: { url: 'http://127.0.0.1:1/signals/mcp' },
      },
      default_agent: 'sales',
    });

    const phaseIds = result.phases.map(p => p.phase_id);
    assert.ok(!phaseIds.includes('requirement_unmet'), 'two distinct route keys satisfy multi_agent');
  });

  test('requires: [multi_agent] stays unmet when routes resolve to one distinct key', async () => {
    const sb = buildStoryboard({
      requires: ['multi_agent'],
      phases: [
        {
          id: 'p1',
          title: 'Phase 1',
          steps: [{ id: 'step1', title: 'A routed read', task: 'get_products', agent: 'sales' }],
        },
      ],
    });
    const result = await runStoryboard('', sb, {
      allow_http: true,
      agents: {
        sales: { url: 'http://127.0.0.1:1/sales/mcp' },
        signals: { url: 'http://127.0.0.1:1/signals/mcp' },
      },
      default_agent: 'sales',
    });

    const step = result.phases[0].steps[0];
    assert.equal(step.skipped, true);
    assert.equal(step.skip_reason, 'requirement_unmet');
    assert.equal(step.skip.requirement, 'multi_agent');
    assert.match(step.skip.detail, /Resolved route keys: \[sales\]/);
    assert.match(step.skip.detail, /Available agents: \[sales, signals\]/);
  });

  test('multiple requires: first unmet wins', async () => {
    // Both controller and seeded_state are unmet; the gate reports the
    // first one in the array order, not a synthesized aggregate.
    const sb = buildStoryboard({ requires: ['controller', 'seeded_state'] });
    const result = await runStoryboard('http://fake-local-99999', sb, {
      _profile: profileWithoutController,
      agentTools: profileWithoutController.tools,
    });

    const step = result.phases[0].steps[0];
    assert.equal(step.skip.requirement, 'controller', 'first unmet requirement is reported');
  });

  test('mixed requires: multi_agent passes through to controller gate', async () => {
    const sb = buildStoryboard({
      requires: ['multi_agent', 'controller'],
      phases: [
        {
          id: 'p1',
          title: 'Phase 1',
          steps: [{ id: 'step1', title: 'A routed read', task: 'get_products', agent: 'signals' }],
        },
      ],
    });
    const result = await runStoryboard('', sb, {
      allow_http: true,
      agentTools: profileWithoutController.tools,
      agents: {
        sales: { url: 'http://127.0.0.1:1/sales/mcp' },
        signals: { url: 'http://127.0.0.1:1/signals/mcp' },
      },
      default_agent: 'sales',
    });

    const step = result.phases[0].steps[0];
    assert.equal(step.skip_reason, 'missing_test_controller');
    assert.equal(step.skip.requirement, 'controller');
  });

  test('unknown requires values load and skip with requirement_unmet at runtime', async () => {
    const sb = buildStoryboard({ requires: ['future_runtime'] });
    const result = await runStoryboard('http://fake-local-99999', sb, {
      _profile: profileWithoutController,
      agentTools: profileWithoutController.tools,
    });

    assert.equal(result.overall_passed, true, 'unknown requires-unmet is not a failure');
    assert.equal(result.skipped_count, 1);
    assert.equal(result.failed_count, 0);

    const step = result.phases[0].steps[0];
    assert.equal(step.skipped, true);
    assert.equal(step.skip_reason, 'requirement_unmet');
    assert.equal(step.skip.reason, 'requirement_unmet');
    assert.equal(step.skip.requirement, 'future_runtime');
    assert.match(step.skip.detail, /unknown runtime requirement 'future_runtime'/);
  });
});

describe('Storyboard upstream_traffic authoring checks', () => {
  function storyboardWithIdentifierPath(path) {
    return `
id: upstream_identifier_path_scope
version: 1.0.0
title: upstream identifier path scope
category: test
summary: scope check
agent:
  interaction_model: sync
  capabilities: []
caller:
  role: buyer_agent
phases:
  - id: p1
    title: Phase 1
    steps:
      - id: sync
        title: Sync
        task: get_products
        validations:
          - check: upstream_traffic
            description: identifier path scope
            identifier_paths:
              - ${path}
`;
  }

  test('rejects identifier_paths that point outside the request payload', () => {
    assert.throws(
      () => parseStoryboard(storyboardWithIdentifierPath('response.audiences[*].hashed_email')),
      /identifier_paths\[0\].*unsupported.*request payload/
    );
  });

  test('rejects identifier_paths with request prefix', () => {
    assert.throws(
      () => parseStoryboard(storyboardWithIdentifierPath('request.audiences[*].hashed_email')),
      /identifier_paths\[0\].*unsupported.*request payload/
    );
    assert.throws(
      () => parseStoryboard(storyboardWithIdentifierPath('Request.audiences[*].hashed_email')),
      /identifier_paths\[0\].*unsupported.*request payload/
    );
  });

  test('rejects bracket and recursive identifier_paths for all reserved roots', () => {
    for (const root of ['request', 'response', 'context']) {
      assert.throws(
        () => parseStoryboard(storyboardWithIdentifierPath(`$["${root}"].audiences[*].hashed_email`)),
        /identifier_paths\[0\].*unsupported.*request payload/
      );
      assert.throws(
        () => parseStoryboard(storyboardWithIdentifierPath(`$..${root}.audiences[*].hashed_email`)),
        /identifier_paths\[0\].*unsupported.*request payload/
      );
    }
  });

  test('rejects unsupported JSONPath identifier_paths that would resolve zero vectors', () => {
    assert.throws(
      () => parseStoryboard(storyboardWithIdentifierPath('$["audiences"][*].hashed_email')),
      /identifier_paths\[0\].*unsupported.*request payload/
    );
    assert.throws(
      () => parseStoryboard(storyboardWithIdentifierPath('audiences..hashed_email')),
      /identifier_paths\[0\].*unsupported.*request payload/
    );
  });

  test('rejects keyed numeric-array identifier_paths the runtime does not resolve', () => {
    assert.throws(
      () => parseStoryboard(storyboardWithIdentifierPath('audiences[*].add[0].hashed_email')),
      /identifier_paths\[0\].*unsupported.*request payload/
    );
  });

  test('accepts documented dotted identifier_paths with wildcard array selectors', () => {
    assert.doesNotThrow(() => parseStoryboard(storyboardWithIdentifierPath('audiences[*].add[*].hashed_email')));
  });

  test('accepts existing leading-dollar dotted identifier_paths', () => {
    assert.doesNotThrow(() => parseStoryboard(storyboardWithIdentifierPath('$.audiences[*].add[*].hashed_email')));
  });

  test('validates leading-dollar identifier_paths without mutating caller-owned strings', () => {
    const storyboard = buildStoryboard();
    storyboard.phases[0].steps[0].validations = [
      {
        check: 'upstream_traffic',
        description: 'valid programmatic authoring',
        identifier_paths: [' $.audiences[*].add[*].hashed_email '],
      },
    ];
    validateStoryboardShape(storyboard);
    assert.equal(
      storyboard.phases[0].steps[0].validations[0].identifier_paths[0],
      ' $.audiences[*].add[*].hashed_email '
    );
  });

  test('rejects invalid preferred_attestation_mode values', () => {
    const yaml = storyboardWithIdentifierPath('audiences[*].add[*].hashed_email').replace(
      'identifier_paths:',
      'preferred_attestation_mode: compact\n            identifier_paths:'
    );
    assert.throws(() => parseStoryboard(yaml), /preferred_attestation_mode.*must be "raw" or "digest"/);
  });

  test('runStoryboardStep invokes identifier_paths authoring validation', async () => {
    const storyboard = buildStoryboard();
    storyboard.phases[0].steps[0].validations = [
      {
        check: 'upstream_traffic',
        description: 'invalid programmatic authoring',
        identifier_paths: ['response.audiences[*].hashed_email'],
      },
    ];

    await assert.rejects(
      () =>
        runStoryboardStep('https://stub.example/mcp', storyboard, 'step1', {
          _profile: profileWithController,
        }),
      /identifier_paths\[0\].*unsupported.*request payload/
    );
  });

  test('runStoryboardStep invokes storyboard shape validation before discovery', async () => {
    await assert.rejects(
      () =>
        runStoryboardStep('https://stub.example/mcp', buildStoryboard({ requires: [] }), 'step1', {
          _profile: profileWithController,
        }),
      /requires: \[\] is not allowed/
    );
  });
});

describe('Storyboard.requires loader validation (#1626)', () => {
  test('rejects empty requires: []', () => {
    const yaml = `
id: bad_empty
version: "1.0.0"
title: empty requires
category: test
summary: ""
narrative: ""
requires: []
agent:
  interaction_model: sync
  capabilities: []
caller:
  role: buyer_agent
phases:
  - id: p1
    title: P
    steps: []
`;
    assert.throws(() => parseStoryboard(yaml), /requires: \[\] is not allowed/);
  });

  test('accepts unknown requirement names for forward-compatible runtime gating', () => {
    const yaml = `
id: ok_unknown
version: "1.0.0"
title: future gate
category: test
summary: ""
narrative: ""
requires: [multi_agent]
agent:
  interaction_model: sync
  capabilities: []
caller:
  role: buyer_agent
phases:
  - id: p1
    title: P
    steps: []
`;
    const parsed = parseStoryboard(yaml);
    assert.deepEqual(parsed.requires, ['multi_agent']);
  });

  test('rejects non-array requires', () => {
    const sb = {
      id: 'bad_shape',
      version: '1.0.0',
      title: 'bad shape',
      category: 'test',
      summary: '',
      narrative: '',
      requires: 'controller', // string, not array
      agent: { interaction_model: 'sync', capabilities: [] },
      caller: { role: 'buyer_agent' },
      phases: [{ id: 'p1', title: 'P', steps: [] }],
    };
    assert.throws(() => validateStoryboardShape(sb), /requires: must be an array/);
  });

  test('rejects malformed requires entries', () => {
    assert.throws(
      () => validateStoryboardShape(buildStoryboard({ requires: [''] })),
      /requires\[0\]: entries must be non-empty strings/
    );
    assert.throws(
      () => validateStoryboardShape(buildStoryboard({ requires: ['controller', 42] })),
      /requires\[1\]: entries must be non-empty strings/
    );
  });

  test('accepts known requirement names', () => {
    const yaml = `
id: ok_known
version: "1.0.0"
title: known names
category: test
summary: ""
narrative: ""
requires: [controller, seeded_state, real_wire]
agent:
  interaction_model: sync
  capabilities: []
caller:
  role: buyer_agent
phases:
  - id: p1
    title: P
    steps: []
`;
    const parsed = parseStoryboard(yaml);
    assert.deepEqual(parsed.requires, ['controller', 'seeded_state', 'real_wire']);
  });

  test('omitted requires field parses fine (default behavior)', () => {
    const yaml = `
id: ok_omitted
version: "1.0.0"
title: no requires
category: test
summary: ""
narrative: ""
agent:
  interaction_model: sync
  capabilities: []
caller:
  role: buyer_agent
phases:
  - id: p1
    title: P
    steps: []
`;
    const parsed = parseStoryboard(yaml);
    assert.equal(parsed.requires, undefined);
  });
});

// ────────────────────────────────────────────────────────────
// adcp-client#1678: implicit webhook_receiver requirement
// ────────────────────────────────────────────────────────────
//
// Storyboards that reference `{{runner.webhook_url:<step_id>}}` or
// `{{runner.webhook_base}}` in any step's `sample_request` need a
// webhook receiver to expand the tokens. Without one, the expander
// would ship literal mustache strings on the wire — rejected by
// 3.0-strict sellers as `INVALID_REQUEST: relative URL without a
// base`. The runner autodetects the requirement from token presence
// (no separate `requires: [webhook_receiver]` declaration needed) and
// grades the storyboard not_applicable when the operator did not
// configure a receiver.

function buildWebhookStoryboard(overrides = {}) {
  return buildStoryboard({
    phases: [
      {
        id: 'p1',
        title: 'Trigger webhook',
        steps: [
          {
            id: 'trigger_webhook',
            title: 'Trigger an operation that emits a webhook',
            task: 'create_media_buy',
            sample_request: {
              push_notification_config: {
                url: '{{runner.webhook_url:trigger_webhook}}',
              },
              idempotency_key: 'webhook-test-key',
            },
          },
        ],
      },
    ],
    ...overrides,
  });
}

describe('Storyboard.requires gate (#1678): implicit webhook_receiver', () => {
  test('storyboards referencing {{runner.webhook_url:…}} skip when no receiver configured', async () => {
    const sb = buildWebhookStoryboard();
    const result = await runStoryboard('http://fake-local-99999', sb, {
      _profile: profileWithoutController,
      agentTools: profileWithoutController.tools,
    });

    assert.equal(result.overall_passed, true, 'requires-unmet is not a failure');
    assert.equal(result.skipped_count, 1);
    assert.equal(result.failed_count, 0);

    const step = result.phases[0].steps[0];
    assert.equal(step.skipped, true);
    assert.equal(step.skip_reason, 'requirement_unmet');
    assert.equal(step.skip.requirement, 'webhook_receiver');
    assert.match(step.skip.detail, /webhook receiver is configured/);
  });

  test('storyboards referencing {{runner.webhook_base}} also trigger the gate', async () => {
    const sb = buildWebhookStoryboard({
      phases: [
        {
          id: 'p1',
          title: 'Compose a webhook URL',
          steps: [
            {
              id: 'inspect_base',
              title: 'A step that interpolates webhook_base',
              task: 'create_media_buy',
              sample_request: {
                meta: { reply_to: '{{runner.webhook_base}}/custom-path' },
              },
            },
          ],
        },
      ],
    });
    const result = await runStoryboard('http://fake-local-99999', sb, {
      _profile: profileWithoutController,
      agentTools: profileWithoutController.tools,
    });

    const step = result.phases[0].steps[0];
    assert.equal(step.skip.requirement, 'webhook_receiver');
  });

  test('storyboards with NO webhook tokens are unaffected by the autodetect gate', async () => {
    const sb = buildStoryboard(); // no webhook tokens anywhere
    const result = await runStoryboard('http://fake-local-99999', sb, {
      _profile: profileWithoutController,
      agentTools: profileWithoutController.tools,
    });

    // Gate did not synthesize requirement_unmet — storyboard proceeded to
    // phases (and may have failed for transport reasons against the fake URL,
    // but that's not what we're measuring here).
    const phaseIds = result.phases.map(p => p.phase_id);
    assert.ok(
      !phaseIds.includes('requirement_unmet'),
      'gate must not synthesize requirement_unmet when no webhook tokens are present'
    );
  });

  test('storyboards referencing webhook tokens nested in deep objects still trigger', async () => {
    const sb = buildStoryboard({
      phases: [
        {
          id: 'p1',
          title: 'Deeply-nested token',
          steps: [
            {
              id: 'deep',
              title: 'A step burying the token under arrays and objects',
              task: 'create_media_buy',
              sample_request: {
                a: { b: { c: [{ d: '{{runner.webhook_url:deep}}' }] } },
              },
            },
          ],
        },
      ],
    });
    const result = await runStoryboard('http://fake-local-99999', sb, {
      _profile: profileWithoutController,
      agentTools: profileWithoutController.tools,
    });

    const step = result.phases[0].steps[0];
    assert.equal(step.skip.requirement, 'webhook_receiver', 'recursive scan finds nested tokens');
  });

  test('webhook tokens in rate_limit_trip target requests also trigger the gate', async () => {
    const sb = buildStoryboard({
      phases: [
        {
          id: 'p1',
          title: 'Rate-limit target with webhook callback',
          steps: [
            {
              id: 'trip',
              title: 'Rate-limit trip target request needs a receiver',
              task: 'expect_rate_limit_not_replayed',
              rate_limit_trip: {
                trip_target_task: 'create_media_buy',
                trip_target_sample_request: {
                  buyer_ref: 'buyer-rate-limit-test',
                  packages: [{ product_id: 'prod_1', budget: 1000 }],
                  push_notification_config: {
                    url: '{{runner.webhook_url:trip}}',
                  },
                },
                max_attempts: 50,
              },
            },
          ],
        },
      ],
    });

    const result = await runStoryboard('http://fake-local-99999', sb, {
      _profile: profileWithoutController,
      agentTools: profileWithoutController.tools,
      contracts: ['rate_limit_trip_runner'],
    });

    const step = result.phases[0].steps[0];
    assert.equal(step.skipped, true);
    assert.equal(step.skip_reason, 'requirement_unmet');
    assert.equal(step.skip.requirement, 'webhook_receiver');
  });

  test('out-of-scope rate_limit_trip webhook tokens do not skip unrelated phases', async () => {
    const sb = buildStoryboard({
      phases: [
        {
          id: 'normal',
          title: 'Normal phase',
          steps: [
            {
              id: 'normal_read',
              title: 'Normal read still runs',
              task: 'get_products',
              sample_request: { buying_mode: 'brief', brief: 'show products' },
            },
          ],
        },
        {
          id: 'rate_limit',
          title: 'Out-of-scope rate-limit phase',
          steps: [
            {
              id: 'trip',
              title: 'Rate-limit trip target request needs a receiver only when the contract is in scope',
              task: 'expect_rate_limit_not_replayed',
              requires_contract: 'rate_limit_trip_runner',
              rate_limit_trip: {
                trip_target_task: 'create_media_buy',
                trip_target_sample_request: {
                  buyer_ref: 'buyer-rate-limit-test',
                  packages: [{ product_id: 'prod_1', budget: 1000 }],
                  push_notification_config: {
                    url: '{{runner.webhook_url:trip}}',
                  },
                },
                max_attempts: 50,
              },
            },
          ],
        },
      ],
    });

    const result = await runStoryboard('http://fake-local-99999', sb, {
      _profile: {
        ...profileWithoutController,
        tools: [...profileWithoutController.tools, 'create_media_buy'],
      },
      agentTools: [...profileWithoutController.tools, 'create_media_buy'],
    });

    assert.ok(
      !result.phases.some(phase => phase.phase_id === 'requirement_unmet'),
      'out-of-scope contract-gated webhook token must not trigger storyboard-level requirement_unmet'
    );
    assert.ok(
      result.phases.some(phase => phase.phase_id === 'normal'),
      'unrelated phase still runs'
    );
    const trip = result.phases
      .find(phase => phase.phase_id === 'rate_limit')
      ?.steps.find(step => step.step_id === 'trip');
    assert.equal(trip?.skipped, true);
    assert.equal(trip?.skip_reason, 'missing_test_kit_contract');
  });

  test('declared requires: [webhook_receiver] resolves the same way (loader allows the name)', () => {
    const yaml = `
id: ok_webhook_declared
version: "1.0.0"
title: explicit webhook_receiver tag
category: test
summary: ""
narrative: ""
requires: [webhook_receiver]
agent:
  interaction_model: sync
  capabilities: []
caller:
  role: buyer_agent
phases:
  - id: p1
    title: P
    steps: []
`;
    const parsed = parseStoryboard(yaml);
    assert.deepEqual(parsed.requires, ['webhook_receiver']);
  });
});

// ────────────────────────────────────────────────────────────
// adcp-client#1702: implicit request_signer requirement
// ────────────────────────────────────────────────────────────
//
// The signed-requests universal storyboard is capability-gated:
// `compliance/{version}/universal/signed-requests.yaml` declares that
// "Agents that do not advertise support are not tested against this
// storyboard — absence of advertisement is not a failure". The runner
// enforces that gate by autodetecting `request_signer` on any
// storyboard whose id is `signed_requests` or that contains a
// `request_signing_probe` step, and skipping with `not_applicable`
// when the agent's `get_adcp_capabilities` response lacks
// `request_signing.supported: true`.

function buildSignedRequestsStoryboard(overrides = {}) {
  return buildStoryboard({
    id: 'signed_requests',
    phases: [
      {
        id: 'capability_discovery',
        title: 'Capability discovery',
        steps: [
          {
            id: 'get_capabilities',
            title: 'Verify the agent declares request_signing.supported',
            task: 'get_adcp_capabilities',
          },
        ],
      },
      {
        id: 'positive_vectors',
        title: 'Positive vectors',
        steps: [
          {
            id: 'positive-001-basic-post',
            title: 'positive 001',
            task: 'request_signing_probe',
          },
        ],
      },
    ],
    ...overrides,
  });
}

const profileWithoutRequestSigning = {
  name: 'Bearer-only agent',
  tools: ['get_adcp_capabilities', 'get_products'],
  raw_capabilities: {}, // no request_signing block
};

const profileWithRequestSigningFalse = {
  name: 'Agent declaring request_signing.supported: false',
  tools: ['get_adcp_capabilities', 'get_products'],
  raw_capabilities: { request_signing: { supported: false } },
};

const profileWithRequestSigning = {
  name: 'Signing-verifier agent',
  tools: ['get_adcp_capabilities', 'get_products'],
  raw_capabilities: { request_signing: { supported: true } },
};

describe('Storyboard.requires gate (#1702): implicit request_signer', () => {
  test('signed_requests storyboard skips when agent omits request_signing block', async () => {
    const sb = buildSignedRequestsStoryboard();
    const result = await runStoryboard('http://fake-local-99999', sb, {
      _profile: profileWithoutRequestSigning,
      agentTools: profileWithoutRequestSigning.tools,
    });

    assert.equal(result.overall_passed, true, 'capability-gated skip is not a failure');
    assert.equal(result.skipped_count, 1);
    assert.equal(result.failed_count, 0);

    const step = result.phases[0].steps[0];
    assert.equal(step.skipped, true);
    assert.equal(step.skip_reason, 'not_applicable');
    assert.equal(step.skip.reason, 'not_applicable');
    assert.equal(step.skip.requirement, 'request_signer');
    assert.match(step.skip.detail, /request_signing\.supported: true/);
    // Forward-readiness signal — schema declares request_signing required in
    // AdCP 4.0 for spend-committing operations. Until structured notices
    // land (adcp-client follow-up), the warning rides in `skip.detail`.
    assert.match(step.skip.detail, /4\.0/, 'detail surfaces the 4.0 forward-readiness signal');
  });

  test('signed_requests storyboard skips when agent declares request_signing.supported: false', async () => {
    const sb = buildSignedRequestsStoryboard();
    const result = await runStoryboard('http://fake-local-99999', sb, {
      _profile: profileWithRequestSigningFalse,
      agentTools: profileWithRequestSigningFalse.tools,
    });

    const step = result.phases[0].steps[0];
    assert.equal(step.skip.requirement, 'request_signer', 'false is treated the same as absent');
    assert.match(step.skip.detail, /false/);
  });

  test('signed_requests storyboard runs when agent declares request_signing.supported: true', async () => {
    const sb = buildSignedRequestsStoryboard();
    const result = await runStoryboard('http://fake-local-99999', sb, {
      _profile: profileWithRequestSigning,
      agentTools: profileWithRequestSigning.tools,
    });

    const phaseIds = result.phases.map(p => p.phase_id);
    assert.ok(
      !phaseIds.includes('requirement_unmet'),
      'gate must not synthesize requirement_unmet when capability is advertised'
    );
  });

  test('non-signed_requests storyboard with a request_signing_probe step also triggers the gate', async () => {
    // Autodetect by step.task, not just storyboard.id, so a future
    // storyboard that embeds signing probes inherits the gate.
    const sb = buildStoryboard({
      id: 'embedded_signing_test',
      phases: [
        {
          id: 'p1',
          title: 'Signing probe inside a non-signed_requests storyboard',
          steps: [
            {
              id: 'positive-001-basic-post',
              title: 'embed',
              task: 'request_signing_probe',
            },
          ],
        },
      ],
    });
    const result = await runStoryboard('http://fake-local-99999', sb, {
      _profile: profileWithoutRequestSigning,
      agentTools: profileWithoutRequestSigning.tools,
    });

    const step = result.phases[0].steps[0];
    assert.equal(step.skip.requirement, 'request_signer');
  });

  test('storyboards with NO signing surface are unaffected by the autodetect gate', async () => {
    const sb = buildStoryboard(); // no signed_requests id, no request_signing_probe step
    const result = await runStoryboard('http://fake-local-99999', sb, {
      _profile: profileWithoutRequestSigning,
      agentTools: profileWithoutRequestSigning.tools,
    });

    const phaseIds = result.phases.map(p => p.phase_id);
    assert.ok(!phaseIds.includes('requirement_unmet'), 'no autodetect on unrelated storyboards');
  });
});

describe('Storyboard.required_any_of_tools gate (#1642)', () => {
  test('skips with requirement_unmet when no tool in a required family is advertised', async () => {
    const sb = buildStoryboard({
      required_any_of_tools: [{ tools: ['list_accounts', 'sync_accounts'], rationale: 'AdCP account discovery' }],
    });
    const result = await runStoryboard('http://fake-local-99999', sb, {
      _profile: profileWithoutController,
      agentTools: profileWithoutController.tools,
    });

    assert.equal(result.overall_passed, true);
    assert.equal(result.skipped_count, 1);
    assert.equal(result.failed_count, 0);

    const step = result.phases[0].steps[0];
    assert.equal(step.skipped, true);
    assert.equal(step.skip_reason, 'requirement_unmet');
    assert.equal(step.skip.reason, 'requirement_unmet');
    assert.equal(step.skip.requirement, undefined);
    assert.match(step.skip.detail, /^missing_required_tool_family: needs list_accounts or sync_accounts/);
    assert.match(step.skip.detail, /AdCP account discovery/);
  });

  test('enforces gate for reused-client callers that provide _profile.tools but omit agentTools', async () => {
    const sb = buildStoryboard({
      required_any_of_tools: [{ tools: ['list_accounts', 'sync_accounts'] }],
    });
    const result = await runStoryboard('http://fake-local-99999', sb, {
      _client: {},
      _profile: profileWithoutController,
    });

    const step = result.phases[0].steps[0];
    assert.equal(step.skipped, true);
    assert.equal(step.skip_reason, 'requirement_unmet');
    assert.match(step.skip.detail, /^missing_required_tool_family: needs list_accounts or sync_accounts/);
  });

  test('runs when any tool in a required family is advertised', async () => {
    const sb = buildStoryboard({
      required_any_of_tools: [{ tools: ['list_accounts', 'sync_accounts'] }],
    });
    const result = await runStoryboard('http://fake-local-99999', sb, {
      _profile: { ...profileWithoutController, tools: ['get_adcp_capabilities', 'sync_accounts'] },
      agentTools: ['get_adcp_capabilities', 'sync_accounts'],
    });

    const phaseIds = result.phases.map(p => p.phase_id);
    assert.ok(!phaseIds.includes('requirement_unmet'), 'one advertised tool satisfies the family');
  });

  test('loader rejects malformed required_any_of_tools gates', () => {
    assert.throws(
      () => validateStoryboardShape(buildStoryboard({ required_any_of_tools: [] })),
      /required_any_of_tools: \[\] is not allowed/
    );
    assert.throws(
      () => validateStoryboardShape(buildStoryboard({ required_any_of_tools: [{ tools: ['sync_accounts'] }] })),
      /must list at least two tool names/
    );
  });
});
