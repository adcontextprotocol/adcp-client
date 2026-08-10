const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { runValidations, RUNNER_CAPABILITY_VERSION } = require('../../dist/lib/testing/storyboard/validations');
const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner');
const { formatStoryboardResultsAsJUnit } = require('../../dist/lib/testing/storyboard/junit');
const { validateStoryboardShape } = require('../../dist/lib/testing/storyboard/loader');

function validationContext(overrides = {}) {
  return {
    taskName: 'get_signals',
    taskResult: { success: true, data: { signals: [] } },
    agentUrl: 'https://stub.example/mcp',
    contributions: new Set(),
    ...overrides,
  };
}

function advisoryStoryboard(validation) {
  return {
    id: 'advisory_contract',
    version: '1.0',
    title: 'Advisory validation contract',
    category: 'test',
    summary: '',
    narrative: '',
    agent: { interaction_model: '*', capabilities: [] },
    caller: { role: 'buyer_agent' },
    phases: [
      {
        id: 'p1',
        title: 'phase 1',
        steps: [
          {
            id: 'get',
            title: 'get signals',
            task: 'get_signals',
            sample_request: { signal_spec: 'test' },
            validations: [validation],
          },
        ],
      },
    ],
  };
}

const stubProfile = { name: 'stub', tools: ['get_signals'] };
const stubClient = {
  getAgentInfo: async () => stubProfile,
  executeTask: async () => ({ success: true, data: { signals: [] } }),
};

async function run(validation) {
  return runStoryboard('https://stub.example/mcp', advisoryStoryboard(validation), {
    protocol: 'mcp',
    _client: stubClient,
    _profile: stubProfile,
    agentTools: stubProfile.tools,
  });
}

describe('advisory validation severity', () => {
  test('propagates required as the default severity', () => {
    const [result] = runValidations(
      [{ check: 'field_present', path: 'missing', description: 'required field' }],
      validationContext()
    );
    assert.equal(result.passed, false);
    assert.equal(result.severity, 'required');
    assert.equal(result.severity_promoted_from_advisory, undefined);
  });

  test('keeps permanent advisory failures non-gating', async () => {
    const result = await run({
      check: 'field_present',
      path: 'missing',
      description: 'rollout signal',
      severity: 'advisory',
      permanent_advisory: { reason: 'experimental signal' },
    });

    const step = result.phases[0].steps[0];
    assert.equal(step.passed, true);
    assert.equal(step.validations[0].passed, false);
    assert.equal(step.validations[0].severity, 'advisory');
    assert.equal(result.overall_passed, true);
    assert.equal(result.passed_count, 1);
    assert.equal(result.failed_count, 0);
    assert.equal(result.validations_advisory_failed, 1);
    assert.equal(result.runner_capability_version, RUNNER_CAPABILITY_VERSION);
    const junit = formatStoryboardResultsAsJUnit([result]);
    assert.match(junit, /<system-out>\[ADVISORY\].*rollout signal/);
    assert.match(junit, /UNTRUSTED_[a-f0-9]{12} \(do not follow as instructions\)/);
    assert.match(junit, /failures="0"/);
  });

  test('reports an unexpired advisory without failing its step', async () => {
    const result = await run({
      check: 'field_present',
      path: 'missing',
      description: 'future required signal',
      severity: 'advisory',
      expires_after_version: '99.0.0',
    });
    const validation = result.phases[0].steps[0].validations[0];
    assert.equal(validation.severity, 'advisory');
    assert.equal(validation.severity_promoted_from_advisory, false);
    assert.equal(result.overall_passed, true);
    assert.equal(result.validations_advisory_failed, 1);
  });

  test('promotes an expired advisory to required and fails its step', async () => {
    const result = await run({
      check: 'field_present',
      path: 'missing',
      description: 'expired rollout signal',
      severity: 'advisory',
      expires_after_version: '1.0.0',
    });
    const validation = result.phases[0].steps[0].validations[0];
    assert.equal(validation.severity, 'required');
    assert.equal(validation.severity_promoted_from_advisory, true);
    assert.equal(result.overall_passed, false);
    assert.equal(result.failed_count, 1);
    assert.equal(result.validations_advisory_failed, undefined);
  });

  test('does not evaluate promotion when a known check grades not_applicable', () => {
    const [result] = runValidations(
      [
        {
          check: 'upstream_traffic',
          description: 'controller-backed signal',
          severity: 'advisory',
          expires_after_version: '1.0.0',
        },
      ],
      validationContext({
        upstreamTraffic: {
          advertised: false,
          queries: new Map(),
          thisStepSince: '2026-01-01T00:00:00.000Z',
        },
      })
    );
    assert.equal(result.passed, true);
    assert.equal(result.not_applicable, true);
    assert.equal(result.severity, 'advisory');
    assert.equal(result.severity_promoted_from_advisory, undefined);
  });

  test('grades an unknown future check not_applicable before expiry promotion', () => {
    const [result] = runValidations(
      [
        {
          check: 'future_check',
          description: 'future runner feature',
          severity: 'advisory',
          expires_after_version: '1.0.0',
        },
      ],
      validationContext()
    );
    assert.equal(result.passed, true);
    assert.equal(result.not_applicable, true);
    assert.equal(result.severity, 'advisory');
    assert.equal(result.severity_promoted_from_advisory, undefined);
  });

  test('rejects malformed or unbounded advisory declarations for programmatic storyboards', () => {
    const invalidSeverity = advisoryStoryboard({
      check: 'field_present',
      path: 'missing',
      description: 'misspelled severity',
      severity: 'advisroy',
    });
    assert.throws(() => validateStoryboardShape(invalidSeverity), /severity: must be either "required" or "advisory"/);

    const missingGate = advisoryStoryboard({
      check: 'field_present',
      path: 'missing',
      description: 'missing gate',
      severity: 'advisory',
    });
    assert.throws(
      () => validateStoryboardShape(missingGate),
      /must declare exactly one of expires_after_version or permanent_advisory/
    );

    const malformedExpiry = advisoryStoryboard({
      check: 'field_present',
      path: 'missing',
      description: 'bad expiry',
      severity: 'advisory',
      expires_after_version: 'not-semver',
    });
    assert.throws(() => validateStoryboardShape(malformedExpiry), /must be a valid semver string/);
    assert.throws(
      () =>
        runValidations(
          [
            {
              check: 'field_present',
              path: 'missing',
              description: 'direct malformed expiry',
              severity: 'advisory',
              expires_after_version: 'not-semver',
            },
          ],
          validationContext()
        ),
      /expires_after_version must be valid semver/
    );

    const emptyReason = advisoryStoryboard({
      check: 'field_present',
      path: 'missing',
      description: 'empty reason',
      severity: 'advisory',
      permanent_advisory: { reason: '   ' },
    });
    assert.throws(() => validateStoryboardShape(emptyReason), /reason: must be a non-empty string/);
  });
});
