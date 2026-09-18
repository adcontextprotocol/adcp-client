/**
 * In-library request-signing vectors (`jwks_override`) must grade through a
 * probe-verdict assertion, never through a synthesized HTTP status.
 *
 * The grader decides these vectors against the SDK verifier — the malformed
 * JWK is never published by the agent under test — and reports
 * `http_status: 0` by contract. Synthesizing `http_status: 401` for them
 * failed a step the grader had passed, with no implementation able to move it
 * (adcontextprotocol/adcp-client#2955).
 */

const test = require('node:test');
const assert = require('node:assert');

const { synthesizeRequestSigningSteps } = require('../../dist/lib/testing/storyboard/request-signing/synthesize.js');
const { probeRequestSigningVector } = require('../../dist/lib/testing/storyboard/request-signing/probe-dispatch.js');
const { loadRequestSigningVectors } = require('../../dist/lib/testing/storyboard/request-signing/vector-loader.js');
const { runValidations } = require('../../dist/lib/testing/storyboard/validations.js');

const JWKS_OVERRIDE_VECTOR = '025-jwk-alg-crv-mismatch';

function synthesizeNegativeSteps() {
  const storyboard = {
    id: 'signed_requests',
    title: 'Signed requests',
    phases: [{ id: 'negative_vectors', title: 'Negative vectors', steps: [] }],
  };
  return synthesizeRequestSigningSteps(storyboard).phases[0].steps;
}

function stepFor(vectorId) {
  const step = synthesizeNegativeSteps().find(s => s.id === `negative-${vectorId}`);
  assert.ok(step, `expected a synthesized step for ${vectorId}`);
  return step;
}

test('the jwks_override vector fixture still carries an inline keyset (guards the branch condition)', () => {
  const vector = loadRequestSigningVectors().negative.find(v => v.id === JWKS_OVERRIDE_VECTOR);
  assert.ok(vector, `expected vector ${JWKS_OVERRIDE_VECTOR} in the compliance cache`);
  assert.ok(vector.jwks_override, 'vector must ship jwks_override for the in-library grading path');
});

test('a jwks_override negative synthesizes a probe_passed check, not http_status 401', () => {
  const step = stepFor(JWKS_OVERRIDE_VECTOR);

  assert.deepStrictEqual(
    step.validations.map(v => v.check),
    ['probe_passed']
  );
  assert.ok(!step.validations.some(v => v.check === 'http_status'));
});

test('the in-library step title says the agent was not contacted (JUnit drops the narrative)', () => {
  const step = stepFor(JWKS_OVERRIDE_VECTOR);

  assert.match(step.title, /SDK verifier self-check/);
  assert.match(step.title, /agent not contacted/);
});

test('an ordinary negative vector keeps its http_status 401 check', () => {
  const step = stepFor('001-no-signature-header');

  const httpStatus = step.validations.find(v => v.check === 'http_status');
  assert.ok(httpStatus, 'probed negatives still assert the wire rejection status');
  assert.strictEqual(httpStatus.value, 401);
});

test('a passing in-library grade passes its synthesized step (the #2955 regression)', async () => {
  // No network: the grader resolves this vector against the library verifier,
  // so the URL is never contacted.
  const probe = await probeRequestSigningVector(
    `negative-${JWKS_OVERRIDE_VECTOR}`,
    'https://agent.example.com/mcp',
    {}
  );

  assert.strictEqual(probe.skipped, undefined, 'vector should be graded, not skipped');
  assert.strictEqual(probe.status, 0, 'in-library grades report no HTTP status by contract');
  assert.strictEqual(probe.error, undefined, 'the library verifier rejects this vector as expected');

  const results = runValidations(stepFor(JWKS_OVERRIDE_VECTOR).validations, {
    taskName: 'request_signing_probe',
    httpResult: probe,
    agentUrl: 'https://agent.example.com/mcp',
  });

  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].passed, true, `expected a passing step, got: ${results[0].error}`);
});

test('a failed in-library grade fails the step and surfaces the grader diagnostic', () => {
  const results = runValidations(stepFor(JWKS_OVERRIDE_VECTOR).validations, {
    taskName: 'request_signing_probe',
    httpResult: {
      url: 'https://agent.example.com/mcp',
      status: 0,
      headers: {},
      body: null,
      error: 'library verifier accepted a request expected to fail with error="request_signature_key_purpose_invalid"',
    },
    agentUrl: 'https://agent.example.com/mcp',
  });

  assert.strictEqual(results[0].passed, false);
  assert.match(results[0].error, /library verifier accepted/);
});

test('probe_passed requires a probe result — it grades as a hard failure on a task step', () => {
  const [result] = runValidations([{ check: 'probe_passed', description: 'needs a probe' }], {
    taskName: 'get_products',
    taskResult: { success: true, data: {} },
    agentUrl: 'https://agent.example.com/mcp',
  });

  assert.strictEqual(result.passed, false);
  assert.match(result.error, /requires an HTTP probe result/);
});

test("the grader's no-diagnostic fallback still fails the step (never a silent pass)", () => {
  // `probeRequestSigningVector` sets `error` to the grade diagnostic, or to
  // the literal `vector grade failed` when a failing grade carried none. The
  // fallback exists so a failed verdict can never arrive as an empty `error`,
  // which `probe_passed` would read as a pass.
  const results = runValidations(stepFor(JWKS_OVERRIDE_VECTOR).validations, {
    taskName: 'request_signing_probe',
    httpResult: {
      url: 'https://agent.example.com/mcp',
      status: 0,
      headers: {},
      body: null,
      error: 'vector grade failed',
    },
    agentUrl: 'https://agent.example.com/mcp',
  });

  assert.strictEqual(results[0].passed, false, 'a failed grade with no diagnostic must still fail');
  assert.match(results[0].error, /vector grade failed/);
});

test('a failing signing step reaches the compliance summary as an actionable failure', () => {
  // Summary artifacts are what CI dashboards pin to. A grade failure whose
  // only text is the fallback must still land there with its step id, not be
  // rolled into a skip cause.
  const { buildComplianceSummary } = require('../../dist/lib/testing/compliance/summary.js');

  const summary = buildComplianceSummary(
    {
      agent_url: 'https://agent.example.com/mcp',
      overall_status: 'failing',
      total_duration_ms: 10,
      tracks: [],
      failures: [
        {
          storyboard_id: 'signed_requests',
          step_id: 'negative-025-jwk-alg-crv-mismatch',
          task: 'request_signing_probe',
          error: 'vector grade failed',
          fix_command: 'adcp grade request-signing https://agent.example.com/mcp --only 025-jwk-alg-crv-mismatch',
        },
      ],
      summary: {
        headline: '1 failure',
        tracks_failed: 1,
        tracks_partial: 0,
        tracks_silent: 0,
        steps_passed: 0,
        steps_failed: 1,
      },
    },
    { sdkVersion: '0.0.0-test', adcpVersion: '3.0.0' }
  );

  // `passed`/`failed` are step counts, not verdict booleans, and the summary
  // carries the failure text on `reason`.
  assert.strictEqual(summary.overall_status, 'failing');
  assert.strictEqual(summary.failed, 1);
  assert.ok(
    summary.failures.some(
      f => f.step_id === 'negative-025-jwk-alg-crv-mismatch' && /vector grade failed/.test(f.reason)
    ),
    `expected the grade failure in the summary, got ${JSON.stringify(summary.failures)}`
  );
});

test('the signing coverage gap reaches the compliance summary as an actionable skip cause', () => {
  // `isActionable` tests the raw reason before mapping it, so the detailed
  // reason is registered rather than the canonical one — widening canonical
  // `not_applicable` (or `fixture_unavailable`) would reclassify legacy skips
  // on runs that have nothing to do with signing.
  const { buildComplianceSummary } = require('../../dist/lib/testing/compliance/summary.js');

  const summaryFor = skipReason =>
    buildComplianceSummary(
      {
        agent_url: 'https://agent.invalid/a2a',
        overall_status: 'partial',
        total_duration_ms: 10,
        tracks: [
          {
            track: 'security_transport',
            status: 'partial',
            label: 'Security & transport',
            duration_ms: 10,
            scenarios: [
              {
                scenario: 'signed_requests/negative_vectors',
                overall_passed: false,
                steps: [
                  {
                    step: 'Negative vector',
                    task: 'request_signing_probe',
                    passed: true,
                    skipped: true,
                    skip_reason: skipReason,
                    duration_ms: 0,
                    warnings: ['skipped'],
                  },
                ],
              },
            ],
            skipped_scenarios: [],
            observations: [],
          },
        ],
        failures: [],
        summary: {
          headline: '1 track partial',
          tracks_failed: 0,
          tracks_partial: 1,
          tracks_silent: 0,
          steps_passed: 0,
          steps_failed: 0,
          steps_skipped: 1,
        },
      },
      { sdkVersion: '0.0.0-test', adcpVersion: '3.2.0' }
    );

  const gap = summaryFor('signing_transport_unavailable');
  assert.ok(
    gap.skip_causes?.some(cause => /request-signing dispatch for the run protocol/.test(cause.reason ?? cause.detail)),
    `expected the signing gap in skip_causes, got ${JSON.stringify(gap.skip_causes)}`
  );

  // A legacy creative-asset gap keeps its pre-existing classification.
  const legacy = summaryFor('creative_asset_fixture_unavailable');
  assert.ok(
    !legacy.skip_causes?.some(cause => /request-signing/.test(cause.reason ?? cause.detail ?? '')),
    'the signing cause must not attach to unrelated fixture gaps'
  );
});
