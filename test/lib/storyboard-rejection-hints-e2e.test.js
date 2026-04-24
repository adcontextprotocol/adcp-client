/**
 * End-to-end integration test for context_value_rejected hints
 * (adcp-client#882, #870, #875).
 *
 * Unlike the unit tests in `storyboard-rejection-hints.test.js` (which
 * call the detector directly) and `storyboard-step-provenance-threading.
 * test.js` (which uses `_client` to bypass the transport), this test
 * drives the full `runStoryboard` loop through the real MCP transport:
 *
 *   - `createAdcpServer` with custom signals handlers → `serve()` on an
 *     ephemeral port → `runStoryboard(url, sb)` hitting the live wire.
 *   - Step 1 (`get_signals`) returns a signal with a pricing_option_id;
 *     runner extracts it via `context_outputs`.
 *   - Step 2 (`activate_signal`) sends that value; the stub agent
 *     rejects with `errors[].details.available` pointing at a different
 *     pricing_option_id (classic catalog-inconsistency symptom from
 *     adcp-client#862).
 *   - Assertion: the step result carries a `context_value_rejected` hint
 *     tracing the rejected value back to step 1's `context_outputs` write.
 *
 * This is the check a refactor to the runner's wiring in `executeStep`
 * (e.g. dropping the `detectContextRejectionHints` call or passing the
 * wrong context snapshot) would regress — transport-level rather than
 * module-boundary coverage.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { runAgainstLocalAgent } = require('../../dist/lib/testing/index.js');
const { createAdcpServer } = require('../../dist/lib/server/index.js');

// Two-step storyboard: discover → activate. Matches the shape #862 / #870
// describe: step 1 writes `first_signal_pricing_option_id` via
// `context_outputs`, step 2 sends it, seller rejects.
const storyboard = {
  id: 'rejection_hint_e2e',
  version: '1.0.0',
  title: 'rejection hints E2E',
  category: 'test',
  summary: '',
  narrative: '',
  agent: { interaction_model: '*', capabilities: [] },
  caller: { role: 'buyer_agent' },
  phases: [
    {
      id: 'p1',
      title: 'discover → activate',
      steps: [
        {
          id: 'search_by_spec',
          title: 'discover signals',
          task: 'get_signals',
          sample_request: {
            signal_spec: 'bogus',
            destinations: [{ type: 'platform', platform: 'the-trade-desk' }],
          },
          context_outputs: [
            { key: 'first_signal_id', path: 'signals[0].signal_agent_segment_id' },
            {
              key: 'first_signal_pricing_option_id',
              path: 'signals[0].pricing_options[0].pricing_option_id',
            },
          ],
        },
        {
          id: 'activate',
          title: 'activate signal',
          task: 'activate_signal',
          sample_request: {
            signal_agent_segment_id: '$context.first_signal_id',
            pricing_option_id: '$context.first_signal_pricing_option_id',
            destinations: [{ type: 'platform', platform: 'the-trade-desk' }],
          },
          // Not `expect_error` — we want the step to fail so the hint gate
          // opens. If the rejection were expected, the runner would stay
          // silent by design (see runner.ts hint-gate comment).
        },
      ],
    },
  ],
};

const searchResponse = {
  signals: [
    {
      // Shape matches get-signals-response.json required fields + their
      // referenced schemas. The client-side response-schema validator runs
      // strict in dev/test, so every field has to satisfy its spec shape or
      // the step fails before the hint gate evaluates.
      signal_id: { source: 'catalog', data_provider_domain: 'prism.example', id: 'abandoner' },
      signal_agent_segment_id: 'sig_prism_abandoner',
      name: 'PRISM abandoner audience',
      description: 'Users who abandoned checkout in the last 30 days.',
      signal_type: 'marketplace',
      data_provider: 'PRISM Data Co.',
      coverage_percentage: 42,
      deployments: [{ type: 'platform', platform: 'the-trade-desk', is_live: true }],
      pricing_options: [
        {
          pricing_option_id: 'po_prism_abandoner_cpm',
          model: 'cpm',
          cpm: 3.5,
          currency: 'USD',
        },
      ],
    },
  ],
};

// Classic catalog-inconsistency rejection — `activate_signal` declares it
// only accepts `po_prism_cart_cpm` while `get_signals` advertised
// `po_prism_abandoner_cpm`. Identical symptom to the #862 / #870 reporter
// case.
const activateRejection = {
  errors: [
    {
      code: 'INVALID_PRICING_MODEL',
      message: 'Pricing option not found: po_prism_abandoner_cpm',
      field: 'pricing_option_id',
      details: { available: ['po_prism_cart_cpm'] },
    },
  ],
};

function createStubAgent() {
  return createAdcpServer({
    name: 'Rejection Hints E2E Stub',
    version: '0.0.1',
    // Disable schema validation both directions — this stub returns
    // intentionally-shaped payloads (including a raw `errors[]` rejection
    // envelope) that the strict spec-shape validator would otherwise
    // reject before the wire-level test can observe hint behavior.
    validation: { requests: 'off', responses: 'off' },
    signals: {
      // Typed get_signals response — runner unwraps to `taskResult.data`
      // which carries `signals[0].pricing_options[0].pricing_option_id`
      // for the context_outputs extraction.
      getSignals: async () => searchResponse,
      // Raw McpToolResponse so the client sees `data.errors` as the
      // rejection-hint detector expects (the typed `activateSignalResponse`
      // wrapper would encode the success shape, not a rejection). isError:
      // true makes the wire envelope a task failure — see the hint gate at
      // runner.ts.
      activateSignal: async () => ({
        content: [{ type: 'text', text: 'Rejected: pricing option mismatch' }],
        structuredContent: activateRejection,
        isError: true,
      }),
    },
  });
}

describe('E2E: context_value_rejected hints via real MCP transport (#882)', () => {
  test('hints fire on step 2 after step 1 wrote the rejected value into context', async () => {
    const result = await runAgainstLocalAgent({
      createAgent: () => createStubAgent(),
      storyboards: [storyboard],
      fixtures: false, // Not needed — the stub handles the two tools directly.
      webhookReceiver: false, // Not needed for this storyboard.
    });

    // A capability-skipped storyboard shows up in `not_applicable[]` and
    // leaves `results[]` empty — check that first so a skip doesn't
    // surface as the opaque "runs exactly the provided storyboard" below.
    assert.equal(
      result.not_applicable?.length ?? 0,
      0,
      `storyboard was skipped: ${JSON.stringify(result.not_applicable)}`
    );
    assert.equal(result.results.length, 1, 'runs exactly the provided storyboard');
    const sb = result.results[0];
    assert.equal(sb.storyboard_id, 'rejection_hint_e2e');
    assert.equal(sb.phases.length, 1);

    const steps = sb.phases[0].steps;
    assert.equal(steps.length, 2, 'storyboard has both steps');

    const searchStep = steps.find(s => s.step_id === 'search_by_spec');
    assert.ok(searchStep, 'search step present');
    // If the fixture drifts out of spec, the failure lands in
    // `validations[]`, not on `.error` — dump both so future maintainers
    // don't chase an empty string.
    const failingValidations = (searchStep.validations ?? []).filter(v => !v.passed);
    assert.equal(
      searchStep.passed,
      true,
      `search step should pass: error=${searchStep.error ?? '(none)'}; failing validations=${JSON.stringify(failingValidations)}`
    );
    assert.ok(searchStep.context_provenance, 'search step surfaces context_provenance (#880)');
    assert.equal(
      searchStep.context_provenance.first_signal_pricing_option_id.source_step_id,
      'search_by_spec',
      'provenance cites the correct source step'
    );
    assert.equal(
      searchStep.context_provenance.first_signal_pricing_option_id.response_path,
      'signals[0].pricing_options[0].pricing_option_id',
      'provenance carries the YAML response path'
    );

    const activateStep = steps.find(s => s.step_id === 'activate');
    assert.ok(activateStep, 'activate step present');
    assert.equal(activateStep.passed, false, 'activate step failed as set up');
    assert.ok(
      Array.isArray(activateStep.hints) && activateStep.hints.length === 1,
      `activate step should carry one hint, got: ${JSON.stringify(activateStep.hints)}`
    );
    const [hint] = activateStep.hints;
    assert.equal(hint.kind, 'context_value_rejected');
    assert.equal(hint.context_key, 'first_signal_pricing_option_id');
    assert.equal(hint.source_step_id, 'search_by_spec');
    assert.equal(hint.source_kind, 'context_outputs');
    assert.equal(hint.response_path, 'signals[0].pricing_options[0].pricing_option_id');
    assert.equal(hint.rejected_value, 'po_prism_abandoner_cpm');
    assert.deepEqual(hint.accepted_values, ['po_prism_cart_cpm']);
    assert.equal(hint.error_code, 'INVALID_PRICING_MODEL');
  });
});
