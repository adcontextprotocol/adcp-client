/**
 * CI gates for `examples/hello_seller_adapter_proposal_mode.ts`.
 *
 * The proposal-mode reference adapter — exercises the v1.5 ProposalManager
 * surface end-to-end against the sales-guaranteed mock-server's proposal
 * lifecycle endpoints. Validates the design works when an adapter wraps
 * a real upstream proposal API.
 *
 * Storyboard: `media_buy_seller/proposal_finalize` — sync_accounts
 * (sole-stateful exemption) → brief_with_proposals → refine_proposal →
 * finalize_proposal → accept_proposal (create_media_buy with proposal_id).
 *
 * Issue-#1549 invariant assertions (in addition to the shared three gates)
 * verify the SDK behavior PR adcp-client#1545 added: a proposal-mode
 * adopter that doesn't advertise `sync_accounts` (because account state
 * materializes on the first `get_products` call) MUST NOT trip the
 * cross-phase cascade. The downstream phases are entitled to run on
 * their own merits — pass or fail, but never `prerequisite_failed` from
 * a setup-phase skip.
 */

const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { runHelloAdapterGates } = require('./_helpers/runHelloAdapterGates');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const STORYBOARD_ID = 'media_buy_seller/proposal_finalize';

// adcp#4086 / PR #4088 fixed the storyboard's context chaining for the
// refine steps; the SDK fix in request-builder.ts (PR adcp-client#1600)
// forwards `context.proposal_id` into `create_media_buy` so the
// proposal-mode adapter's `ctx.recipes` is hydrated and the accept step
// passes end-to-end. No expected failures remain.
const EXPECTED_FAILURES = [];

function isExpectedFailure(f) {
  return EXPECTED_FAILURES.some(e => e.storyboard_id === (f.storyboard_id || '') && e.step_id === (f.step_id || ''));
}

// ── Issue-#1549 invariant assertions ───────────────────────────────────
//
// The grader emits a per-phase TestResult under the `media_buy` track
// (one per storyboard phase, scenario id `<storyboard_id>/<phase_id>`).
// Each step carries `skipped`, `skip_reason`, and a `warnings[0]` line
// holding the runner's `skip.detail` string when skipped.
//
// PR adcp-client#1545's emitted marker for the sole-stateful exemption:
const EXEMPTION_MARKER = /Sole stateful step exemption applied for phase 'setup'/;
// Cascade trigger phrase the runner emits when a downstream stateful
// step skips because a prior step in setup didn't pass:
const SETUP_CASCADE_PHRASE = /prior stateful step "sync_accounts" (skipped|failed)/;

function findScenario(grader, scenarioId) {
  for (const track of grader.tracks ?? []) {
    for (const scn of track.scenarios ?? []) {
      if (scn.scenario === scenarioId) return scn;
    }
  }
  return undefined;
}

function assertIssue1549Invariants(grader) {
  // (a) sync_accounts skip: skipped + exemption-eligible reason + marker.
  const setup = findScenario(grader, `${STORYBOARD_ID}/setup`);
  assert.ok(setup, `setup phase scenario missing from grader output`);
  const syncStep = (setup.steps ?? []).find(s => s.task === 'sync_accounts');
  assert.ok(syncStep, `setup phase did not emit a sync_accounts step result`);
  assert.equal(syncStep.skipped, true, `sync_accounts must be skipped (proposal-mode adopters omit the tool)`);
  // PR adcp-client#1545 expanded the exemption family: `not_applicable`
  // (account-mode-derived), `missing_tool` (advertised tools omit
  // sync_accounts), and `missing_test_controller` are all exemption-
  // eligible. This adapter projects `account.require_operator_auth: true`
  // via `accounts.resolution: 'explicit'`, so the runner grades the
  // skip as `not_applicable` here — but the assertion accepts any reason
  // in the exemption family so a future projection change doesn't flip
  // the test red without an underlying behavior regression.
  assert.ok(
    ['not_applicable', 'missing_tool', 'missing_test_controller'].includes(syncStep.skip_reason),
    `sync_accounts skip_reason ${JSON.stringify(syncStep.skip_reason)} is not in the exemption family`
  );
  const skipDetail = (syncStep.warnings ?? []).join(' | ');
  assert.match(
    skipDetail,
    EXEMPTION_MARKER,
    `sync_accounts skip detail must carry the sole-stateful exemption marker (PR adcp-client#1545):\n${skipDetail}`
  );

  // (b) Each downstream phase RAN — no setup-cascade trip. Phases may
  // pass, fail, or skip on their own merits, but the skip detail must
  // NOT name sync_accounts as the cascade trigger. With the #1545 fix,
  // `brief_with_proposals` runs (and passes), `refine_proposal` runs
  // (and currently fails per #4086), `finalize_proposal` and
  // `accept_proposal` skip because of refine's failure with detail
  // "prior stateful step failed." (no step name) — never with detail
  // referencing sync_accounts.
  const downstreamPhases = ['brief_with_proposals', 'refine_proposal', 'finalize_proposal', 'accept_proposal'];
  for (const phaseId of downstreamPhases) {
    const scn = findScenario(grader, `${STORYBOARD_ID}/${phaseId}`);
    assert.ok(scn, `downstream phase ${phaseId} missing from grader output`);
    for (const step of scn.steps ?? []) {
      const detail = (step.warnings ?? []).join(' | ');
      assert.doesNotMatch(
        detail,
        SETUP_CASCADE_PHRASE,
        `downstream phase ${phaseId} step ${step.step}: skip detail names sync_accounts as cascade trigger ` +
          `— sole-stateful exemption regressed (PR adcp-client#1545):\n${detail}`
      );
    }
  }
}

runHelloAdapterGates({
  suiteName: 'examples/hello_seller_adapter_proposal_mode',
  exampleFile: path.join(REPO_ROOT, 'examples', 'hello_seller_adapter_proposal_mode.ts'),
  specialism: 'sales-guaranteed',
  storyboardId: STORYBOARD_ID,
  adcpAuthToken: 'sk_harness_do_not_use_in_prod',
  mockOptions: { apiKey: 'mock_sales_guaranteed_key_do_not_use_in_prod' },
  extraEnv: {
    UPSTREAM_API_KEY: 'mock_sales_guaranteed_key_do_not_use_in_prod',
  },
  // Façade gate: assert all routes the full proposal lifecycle drives.
  // createOrder + createLineItem are now reachable since the SDK forwards
  // proposal_id into create_media_buy (PR adcp-client#1600).
  expectedRoutes: [
    'GET /_lookup/network',
    'GET /v1/products',
    'POST /v1/proposals',
    'POST /v1/orders',
    'POST /v1/orders/{id}/lineitems',
  ],
  filterFailures: grader => {
    // Issue-#1549 invariants run alongside the failure filter so the gate
    // fires on regressions even when the storyboard pass-count is clean.
    assertIssue1549Invariants(grader);
    // Defensive: every entry in EXPECTED_FAILURES must appear in the
    // pre-filter set. A spec rename or runner fix that eliminates one
    // of these failures should flip the gate red so we know to drop the
    // entry — silent green CI on a stale allowlist hides regressions.
    const failures = grader.failures || [];
    for (const expected of EXPECTED_FAILURES) {
      const present = failures.some(f => f.storyboard_id === expected.storyboard_id && f.step_id === expected.step_id);
      assert.ok(
        present,
        `EXPECTED_FAILURES is stale: ${expected.storyboard_id}/${expected.step_id} ` +
          `(see adcp#4086 / PR #4088) is no longer reported as a failure. ` +
          `Drop it from the allowlist and re-run; the gate should now pass unfiltered.`
      );
    }
    return failures.filter(f => !isExpectedFailure(f));
  },
  storyboardSummary:
    'sole-stateful exemption (sync_accounts skipped, downstream phases run) + full proposal lifecycle through accept',
});

// Surface assert is a no-op if `node --test` doesn't import it; placed at
// module top-level to keep the gate self-checking even without invocation.
void test;
