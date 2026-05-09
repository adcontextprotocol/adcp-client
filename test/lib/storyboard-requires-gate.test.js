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
