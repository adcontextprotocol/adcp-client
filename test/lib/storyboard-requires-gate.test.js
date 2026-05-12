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

const { runStoryboard } = require('../../dist/lib/testing/storyboard/index.js');
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

  test('rejects unknown requirement names', () => {
    const yaml = `
id: bad_unknown
version: "1.0.0"
title: bad name
category: test
summary: ""
narrative: ""
requires: [contoller]
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
    assert.throws(() => parseStoryboard(yaml), /unknown requirement 'contoller'/);
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
