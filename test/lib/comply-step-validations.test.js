const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

const { comply, formatComplianceResultsJSON } = require('../../dist/lib/testing/compliance');
const { mapStoryboardResultsToTrackResult } = require('../../dist/lib/testing/compliance/storyboard-tracks');
const { ADCP_VERSION } = require('../../dist/lib/version');

describe('compact compliance validation projection (#3348)', () => {
  function map(validations) {
    const step = {
      step_id: 'authored_id',
      title: 'Display title',
      task: '__test_probe',
      passed: true,
      duration_ms: 1,
      validations,
      context: {},
    };
    const result = {
      storyboard_id: 'projection',
      storyboard_title: 'Projection',
      agent_url: 'https://example.test/mcp',
      overall_passed: true,
      phases: [{ phase_id: 'phase', phase_title: 'Phase', passed: true, steps: [step], duration_ms: 1 }],
      context: {},
      total_duration_ms: 1,
      passed_count: 1,
      failed_count: 0,
      skipped_count: 0,
      tested_at: '2026-01-01T00:00:00Z',
    };
    return mapStoryboardResultsToTrackResult('core', [result], { name: 'Test', tools: ['__test_probe'] }).scenarios[0]
      .steps[0];
  }

  test('copies only compact verdict fields and keeps display details unchanged', () => {
    const validation = {
      id: 'check_id',
      check: 'field_present',
      passed: false,
      severity: 'required',
      not_applicable: false,
      severity_promoted_from_advisory: true,
      description: 'Required field',
      error: 'Missing field',
      warning: 'Try again',
      request: { payload: { large: 'request diagnostic' } },
      response: { payload: { large: 'response diagnostic' } },
      expected: 'expected diagnostic',
      actual: 'actual diagnostic',
      json_pointer: '/missing',
      note: 'diagnostic note',
    };
    const mapped = map([validation]);
    assert.equal(mapped.step_id, 'authored_id');
    assert.equal(mapped.step, 'Display title');
    assert.deepEqual(mapped.validations, [
      {
        id: 'check_id',
        check: 'field_present',
        passed: false,
        severity: 'required',
        not_applicable: false,
        severity_promoted_from_advisory: true,
      },
    ]);
    assert.equal(mapped.details, '✗ Required field: Missing field [⚠ Try again]');
    assert.notEqual(mapped.validations[0], validation);
  });

  test('retains anonymous checks without inventing optional values or dropping false flags', () => {
    const mapped = map([
      { check: 'field_present', passed: true, description: 'Present' },
      {
        check: 'field_value',
        passed: false,
        severity: 'advisory',
        severity_promoted_from_advisory: false,
        description: 'Not promoted',
      },
    ]);
    assert.deepEqual(mapped.validations, [
      { check: 'field_present', passed: true },
      { check: 'field_value', passed: false, severity: 'advisory', severity_promoted_from_advisory: false },
    ]);
    assert.deepEqual(map([]).validations, []);
  });
});

describe('comply() structured step verdicts (#3348)', () => {
  let complianceDir;
  let server;
  let result;
  let serialized;
  const connections = [];

  const check = (id, overrides = {}) => ({ id, check: 'field_present', path: 'value', description: id, ...overrides });
  const step = (id, validation, overrides = {}) => ({
    id,
    title: 'Shared display title',
    task: '__test_probe',
    sample_request: {},
    validations: [validation],
    ...overrides,
  });

  before(async () => {
    complianceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-step-verdicts-'));
    fs.mkdirSync(path.join(complianceDir, 'universal'));
    fs.writeFileSync(
      path.join(complianceDir, 'index.json'),
      JSON.stringify({ adcp_version: ADCP_VERSION, universal: ['verdicts'], protocols: [], specialisms: [] })
    );
    fs.writeFileSync(
      path.join(complianceDir, 'universal', 'verdicts.yaml'),
      YAML.stringify({
        id: 'verdicts',
        version: '1.0.0',
        title: 'Structured verdicts',
        category: 'testing',
        track: 'core',
        summary: '',
        narrative: '',
        agent: { interaction_model: '*', capabilities: [] },
        caller: { role: 'buyer_agent' },
        invariants: { disable: ['status.monotonic', 'impairment.coherence'] },
        phases: [
          {
            id: 'checks',
            title: 'Checks',
            steps: [
              step('passing_step', check('passing_check')),
              step(
                'advisory_step',
                check('advisory_check', {
                  path: 'missing',
                  severity: 'advisory',
                  permanent_advisory: { reason: 'Future compatibility signal' },
                })
              ),
              step(
                'unobservable_step',
                check('unobservable_check', {
                  check: 'future_check_kind',
                  severity: 'advisory',
                  expires_after_version: '1.0.0',
                })
              ),
            ],
          },
          {
            id: 'branch_accept',
            title: 'Accept branch',
            optional: true,
            branch_set: { id: 'compatible', semantics: 'any_of' },
            steps: [step('accepted_step', check('accepted_check'), { contributes_to: 'compatible' })],
          },
          {
            id: 'branch_peer',
            title: 'Peer branch',
            optional: true,
            branch_set: { id: 'compatible', semantics: 'any_of' },
            steps: [step('peer_step', check('peer_check', { path: 'missing' }), { contributes_to: 'compatible' })],
          },
          {
            id: 'branch_gate',
            title: 'Branch gate',
            steps: [
              step('gate_step', check('gate_check', { check: 'any_of', allowed_values: ['compatible'] }), {
                task: 'assert_contribution',
              }),
            ],
          },
          {
            id: 'required',
            title: 'Required failure',
            steps: [step('required_step', check('required_check', { path: 'missing' }))],
          },
        ],
      })
    );

    server = http.createServer(async (req, res) => {
      const mcp = new McpServer({ name: 'structured-verdict-agent', version: '1.0.0' });
      for (const name of ['get_adcp_capabilities', '__test_probe']) {
        mcp.registerTool(name, {}, async () => {
          const data =
            name === 'get_adcp_capabilities'
              ? {
                  adcp: {
                    major_versions: [3],
                    supported_versions: [ADCP_VERSION],
                    build_version: ADCP_VERSION,
                    idempotency: { supported: false },
                  },
                  supported_protocols: [],
                  specialisms: [],
                }
              : { value: true };
          return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
        });
      }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      connections.push(mcp);
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    result = await comply(`http://127.0.0.1:${server.address().port}/mcp`, { allow_http: true, complianceDir });
    serialized = JSON.parse(formatComplianceResultsJSON(result));
  });

  after(async () => {
    await Promise.all(connections.map(mcp => mcp.close()));
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    if (complianceDir) fs.rmSync(complianceDir, { recursive: true, force: true });
  });

  function findStep(id) {
    const steps = serialized.tracks.flatMap(track => track.scenarios.flatMap(scenario => scenario.steps ?? []));
    const found = steps.find(s => s.step_id === id);
    assert.ok(found, `Missing authored step ${id}`);
    assert.equal(found.step, 'Shared display title');
    return found;
  }

  test('retains the passing authored validation in the public JSON result', () => {
    const validations = findStep('passing_step').validations;
    assert.deepEqual(
      validations.find(v => v.id === 'passing_check'),
      {
        id: 'passing_check',
        check: 'field_present',
        passed: true,
        severity: 'required',
      }
    );
    assert.ok(validations.some(v => v.check === 'assertion' && v.id === undefined));
  });

  test('retains required failures and leaves failures[] attribution unchanged', () => {
    const required = findStep('required_step');
    assert.equal(required.passed, false);
    assert.deepEqual(
      required.validations.find(v => v.id === 'required_check'),
      {
        id: 'required_check',
        check: 'field_present',
        passed: false,
        severity: 'required',
      }
    );
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].step_id, 'required_step');
    assert.equal(result.failures[0].validation.id, 'required_check');
    assert.equal(result.failures[0].validation.check, 'field_present');
  });

  test('keeps advisory failures visible while the step still passes', () => {
    const advisory = findStep('advisory_step');
    assert.equal(advisory.passed, true);
    assert.deepEqual(
      advisory.validations.find(v => v.id === 'advisory_check'),
      {
        id: 'advisory_check',
        check: 'field_present',
        passed: false,
        severity: 'advisory',
      }
    );
  });

  test('distinguishes not_applicable from graded passes without promoting the advisory', () => {
    const unobservable = findStep('unobservable_step');
    assert.equal(unobservable.passed, true);
    assert.deepEqual(
      unobservable.validations.find(v => v.id === 'unobservable_check'),
      {
        id: 'unobservable_check',
        check: 'future_check_kind',
        passed: true,
        severity: 'advisory',
        not_applicable: true,
      }
    );
  });

  test('preserves authored ids on both branch-set peers and the any_of gate', () => {
    assert.equal(findStep('accepted_step').validations[0].id, 'accepted_check');
    const peer = findStep('peer_step');
    assert.equal(peer.skipped, true);
    assert.equal(peer.skip_reason, 'peer_branch_taken');
    assert.equal(findStep('gate_step').validations[0].id, 'gate_check');
    assert.equal(findStep('gate_step').validations[0].check, 'any_of');
  });
});
