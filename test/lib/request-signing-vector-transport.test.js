const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const {
  resolveVectorTransport,
  probeRequestSigningVector,
  SIGNING_VECTORS_UNAVAILABLE_DETAIL,
} = require('../../dist/lib/testing/storyboard/request-signing/probe-dispatch.js');
const { DETAILED_SKIP_TO_CANONICAL } = require('../../dist/lib/testing/storyboard/types.js');

test("vector transport defaults to 'mcp' — the runner reaches agents via tools/call, so raw REST replay 404s on MCP agents by construction (adcp#6548)", () => {
  assert.strictEqual(resolveVectorTransport({}), 'mcp');
});

test("explicit 'raw' opt-in for REST-binding agents is respected", () => {
  assert.strictEqual(resolveVectorTransport({ transport: 'raw' }), 'raw');
});

test("explicit 'mcp' setting is respected", () => {
  assert.strictEqual(resolveVectorTransport({ transport: 'mcp' }), 'mcp');
});

test("an mcp-protocol run still resolves to 'mcp'", () => {
  assert.strictEqual(resolveVectorTransport({}, 'mcp'), 'mcp');
});

test('an a2a-protocol run with no explicit transport has no gradable transport (adcp-client#2954)', () => {
  assert.strictEqual(resolveVectorTransport({}, 'a2a'), undefined);
});

test('an explicit transport still wins on an a2a run — escape hatch for a co-mounted MCP/REST binding', () => {
  assert.strictEqual(resolveVectorTransport({ transport: 'mcp' }, 'a2a'), 'mcp');
  assert.strictEqual(resolveVectorTransport({ transport: 'raw' }, 'a2a'), 'raw');
});

test('a2a vector dispatch reports missing coverage, not agent inapplicability', async () => {
  const result = await probeRequestSigningVector('negative-001-no-signature-header', 'https://agent.invalid/a2a', {
    protocol: 'a2a',
  });

  assert.strictEqual(result.skipped, true);
  // The reason names the fail-closed discovery gap; what keeps the track
  // partial is that no vector reached the agent — see the aggregate tests below.
  assert.strictEqual(result.skip_reason, 'signing_transport_unavailable');
  // Canonical `not_applicable` with the sub-reason token as `skip.detail` is
  // the shape runner-output-contract.yaml defines for a registered
  // `canonical_detail_sub_reasons` entry; the gap's weight rides on coverage
  // (`signingCoverage`), not on the canonical reason.
  assert.strictEqual(DETAILED_SKIP_TO_CANONICAL[result.skip_reason], 'not_applicable');
  assert.strictEqual(result.status, 0);
  assert.ok(result.error.startsWith(SIGNING_VECTORS_UNAVAILABLE_DETAIL));
  // The operator has to be able to act on the skip: say it is a gap, and
  // name the remedy.
  assert.match(result.error, /Coverage unavailable/);
  assert.match(result.error, /publish a reachable modern or legacy Agent Card/);
});

test('an a2a run still grades the in-library vector', async () => {
  // 025 is decided against the library verifier with no wire exchange, so
  // the run's protocol is irrelevant to it.
  const inLibrary = await probeRequestSigningVector('negative-025-jwk-alg-crv-mismatch', 'https://agent.invalid/a2a', {
    protocol: 'a2a',
  });

  assert.strictEqual(inLibrary.skipped, undefined, 'in-library vector must still be graded on a2a');
  assert.strictEqual(inLibrary.error, undefined);
});

test('the protocol-method vector is NOT replayed raw at an A2A endpoint', async () => {
  // Vector 028's body is a complete `tasks/cancel` JSON-RPC envelope, which
  // makes raw replay at an A2A endpoint look safe. It is not: writing those
  // bytes to the endpoint ourselves is a hand-rolled A2A dispatch, which
  // AGENTS.md forbids without exception. `@a2a-js/sdk` can issue
  // `tasks/cancel` perfectly well — what is missing is this runner wiring a
  // signing probe through it. Until that exists 028 is missing coverage like
  // any other probed vector: no allowlist, no verbatim-replay carve-out.
  const result = await probeRequestSigningVector(
    'negative-028-unsigned-protocol-method-required',
    'https://agent.invalid/a2a',
    { protocol: 'a2a' }
  );

  assert.strictEqual(result.skipped, true, 'no raw A2A dispatch may be attempted');
  assert.strictEqual(result.skip_reason, 'signing_transport_unavailable');
  assert.strictEqual(DETAILED_SKIP_TO_CANONICAL[result.skip_reason], 'not_applicable');
});

test('the protocol-method vector still grades on MCP, posting its own JSON-RPC body verbatim', async t => {
  // The coverage 028 exists to prove (`protocol_methods_required_for`) is
  // unaffected on the transport that can carry it: the fixture bytes go to
  // the MCP mount unchanged, with no `tools/call` wrapper.
  const received = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({ url: req.url, method: req.method, body: Buffer.concat(chunks).toString('utf8') });
    res.writeHead(401, {
      'content-type': 'application/json',
      'www-authenticate': 'Signature error="request_signature_required"',
    });
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const agentUrl = `http://127.0.0.1:${server.address().port}/mcp`;

  const result = await probeRequestSigningVector('negative-028-unsigned-protocol-method-required', agentUrl, {
    protocol: 'mcp',
    allow_http: true,
    // Documented sentinel: skip the `initialize` handshake so the probe is
    // the only request this fixture server has to answer.
    request_signing: { mcpSessionId: '' },
  });

  assert.strictEqual(result.skipped, undefined, `expected a graded vector, got skip ${result.skip_reason}`);
  assert.strictEqual(result.status, 401);
  assert.strictEqual(result.error, undefined, `expected a passing grade, got: ${result.error}`);

  assert.strictEqual(received.length, 1);
  assert.strictEqual(received[0].url, '/mcp');
  const body = JSON.parse(received[0].body);
  assert.strictEqual(body.method, 'tasks/cancel', 'protocol-method body is not wrapped in tools/call');
  assert.deepStrictEqual(body.params, { taskId: 'task_conformance_001' });
});

test('a2a dispatch with an explicit transport does not self-skip (it probes and reports the probe outcome)', async () => {
  // `agent.invalid` never resolves, so the probe reports a network error
  // rather than a skip. Asserting the positive outcome — dispatch attempted,
  // no skip of any kind — rather than the absence of one reason: the escape
  // hatch is worthless if the vector comes back `signing_transport_unavailable`.
  const result = await probeRequestSigningVector('negative-001-no-signature-header', 'https://agent.invalid/a2a', {
    protocol: 'a2a',
    request_signing: { transport: 'raw' },
  });

  assert.strictEqual(result.skipped, undefined, `expected a dispatch attempt, got skip: ${result.skip_reason}`);
  assert.strictEqual(result.skip_reason, undefined);
  assert.match(result.error, /agent\.invalid/, 'the probe should report the failed exchange it attempted');
});

test('the storyboard runner threads its resolved protocol into the vector dispatch', async () => {
  // Step-level proof for the wiring the unit tests above assume: an A2A run
  // reaches `probeRequestSigningVector` with `protocol: 'a2a'` and the step
  // skips before any dispatch. The agent URL never resolves, so a regression
  // that dropped the protocol would surface as a probe error, not a skip.
  const { runStoryboardStep } = require('../../dist/lib/testing/storyboard/runner.js');

  const result = await runStoryboardStep(
    'https://agent.invalid/a2a',
    a2aVectorStoryboard(),
    'negative-001-no-signature-header',
    {
      protocol: 'a2a',
      // Pre-supplied profile: skips capability discovery so the step runs
      // without a live agent.
      profile: A2A_SIGNING_PROFILE,
    }
  );

  assert.strictEqual(result.skipped, true, `expected a skipped step, got: ${JSON.stringify(result.skip ?? result)}`);
  assert.strictEqual(result.skip_reason, 'signing_transport_unavailable');
  // Registered-sub-reason shape: canonical reason plus the token verbatim as
  // `skip.detail`, empty validations, no counter movement — the contract's
  // `rate_limit_not_triggered` precedent.
  assert.strictEqual(result.skip.reason, 'not_applicable');
  assert.strictEqual(result.skip.detail, 'signing_transport_unavailable');
  assert.match(result.response.error, /Coverage unavailable/, 'the remedy rides on the probe result');
  assert.deepStrictEqual(result.validations, [], 'an ungradable vector must not run its HTTP validations');
});

test('an A2A run reports every ungradable vector as a coverage gap, never a storyboard-wide pass', async () => {
  // The storyboard itself must still run: gating the whole storyboard on the
  // run-level protocol both hides the gap behind one synthetic skip and
  // breaks routed runs (a top-level `a2a` run can carry an MCP seller).
  const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner.js');

  const result = await runStoryboard('https://agent.invalid/a2a', a2aVectorStoryboard(), {
    protocol: 'a2a',
    profile: A2A_SIGNING_PROFILE,
  });

  const steps = result.phases.flatMap(phase => phase.steps);
  assert.deepStrictEqual(
    steps.map(step => step.step_id),
    ['negative-001-no-signature-header'],
    'the storyboard runs; the vector step is where the gap is reported'
  );
  assert.strictEqual(steps[0].skipped, true);
  assert.strictEqual(steps[0].skip.reason, 'not_applicable');
  assert.strictEqual(steps[0].skip_reason, 'signing_transport_unavailable');
  assert.strictEqual(steps[0].skip.detail, 'signing_transport_unavailable');
  assert.match(steps[0].response.error, /Coverage unavailable/);
  assert.strictEqual(result.overall_passed, false, 'a run that graded no vector cannot pass');
  assert.strictEqual(result.passed_count, 0, 'no verifier behavior was graded');
  assert.strictEqual(
    steps[0].selection_result,
    undefined,
    'a coverage gap is a skipped step, not an out-of-profile exclusion'
  );
});

test('a passing sibling storyboard cannot roll the security_transport track up to pass', async () => {
  // `oauth_setup` and `signed_requests` share the security_transport track.
  // With no vector reaching the agent, the track
  // grades `partial` even though the sibling passed every step — the
  // false-assurance case a whole-storyboard `not_applicable` skip allowed.
  const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner.js');
  const { mapStoryboardResultsToTrackResult } = require('../../dist/lib/testing/compliance/storyboard-tracks.js');
  const { computeOverallStatus } = require('../../dist/lib/testing/compliance/comply.js');

  const signing = await runStoryboard('https://agent.invalid/a2a', a2aVectorStoryboard(), {
    protocol: 'a2a',
    profile: A2A_SIGNING_PROFILE,
  });

  const sibling = {
    storyboard_id: 'oauth_setup',
    storyboard_title: 'OAuth setup',
    agent_url: 'https://agent.invalid/a2a',
    overall_passed: true,
    passed_count: 6,
    failed_count: 0,
    skipped_count: 0,
    total_duration_ms: 1,
    phases: [
      {
        phase_id: 'oauth_discovery',
        phase_title: 'OAuth discovery',
        passed: true,
        duration_ms: 1,
        steps: [
          { step_id: 'prm', phase_id: 'oauth_discovery', title: 'PRM', task: 'x', passed: true, validations: [] },
        ],
      },
    ],
    context: {},
    notices: [],
  };

  const track = mapStoryboardResultsToTrackResult('security_transport', [sibling, signing], { name: 'a', tools: [] });
  assert.strictEqual(track.status, 'partial', `expected partial, got ${track.status}`);

  const overall = computeOverallStatus({
    tracks_passed: 3,
    tracks_failed: 0,
    tracks_partial: 1,
    tracks_skipped: 0,
    tracks_silent: 0,
  });
  assert.strictEqual(overall, 'partial', 'a run with an ungraded signing track must not report passing');
});

test('a storyboard whose wire coverage was unavailable cannot report overall_passed', async () => {
  // The in-library self-check (025) grades green while every probed vector is
  // unavailable. Without this rule the storyboard reports `overall_passed:
  // true` off an SDK self-check the agent never saw (adcp-client#2954).
  const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner.js');

  const storyboard = {
    id: 'signed_requests',
    title: 'Signed requests',
    phases: [
      {
        id: 'negative_vectors',
        title: 'Negative vectors',
        steps: [
          {
            id: 'negative-025-jwk-alg-crv-mismatch',
            title: 'SDK self-check',
            task: 'request_signing_probe',
            validations: [{ check: 'probe_passed' }],
          },
          {
            id: 'negative-001-no-signature-header',
            title: 'Wire vector',
            task: 'request_signing_probe',
            validations: [{ check: 'http_status', value: 401 }],
          },
        ],
      },
    ],
  };

  const result = await runStoryboard('https://agent.invalid/a2a', storyboard, {
    protocol: 'a2a',
    profile: A2A_SIGNING_PROFILE,
  });

  assert.strictEqual(result.passed_count, 1, 'the in-library self-check still grades');
  assert.strictEqual(result.failed_count, 0);
  assert.strictEqual(
    result.overall_passed,
    false,
    `a storyboard with unverified wire coverage must not report a pass beside an SDK self-check: ${JSON.stringify(
      result.phases
        .flatMap(p => p.steps)
        .map(s => ({
          id: s.step_id,
          task: s.task,
          skipped: s.skipped,
          checks: (s.validations || []).map(v => v.check),
        }))
    )}`
  );
});

test('excluding every wire vector cannot launder a pass out of the SDK self-check', async () => {
  // `--signing-transport`'s siblings let an operator narrow scope. Narrowed to
  // zero agent-graded vectors, the only step that can still pass is the
  // in-library self-check — which verifies the SDK, not the agent. Both
  // exclusion flags must leave the storyboard non-passing.
  const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner.js');

  for (const request_signing of [
    { onlyVectors: ['025-jwk-alg-crv-mismatch'] },
    { skipVectors: ['001-no-signature-header'] },
  ]) {
    const result = await runStoryboard('https://agent.invalid/mcp', selfCheckPlusWireStoryboard(), {
      protocol: 'mcp',
      profile: A2A_SIGNING_PROFILE,
      request_signing,
    });

    assert.strictEqual(result.passed_count, 1, 'the SDK self-check still grades');
    assert.strictEqual(result.failed_count, 0, 'excluded vectors are skips, not failures');
    assert.strictEqual(
      result.overall_passed,
      false,
      `zero agent-graded vectors must not report a pass (${JSON.stringify(request_signing)})`
    );
  }
});

test('narrowing scope while still grading a wire vector keeps a legitimate pass', async t => {
  // The guard above must not punish ordinary use: skip one vector, grade
  // another against the agent, and the storyboard passes as before.
  const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner.js');

  const server = http.createServer((_req, res) => {
    res.writeHead(401, {
      'content-type': 'application/json',
      'www-authenticate': 'Signature error="request_signature_required"',
    });
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const result = await runStoryboard(`http://127.0.0.1:${server.address().port}/mcp`, selfCheckPlusWireStoryboard(), {
    protocol: 'mcp',
    allow_http: true,
    profile: A2A_SIGNING_PROFILE,
    // `mcpSessionId: ''` is the documented opt-out from the initialize
    // handshake, so this fixture server only has to answer the probe.
    request_signing: { mcpSessionId: '' },
  });

  assert.strictEqual(result.failed_count, 0, `expected a clean run, got: ${JSON.stringify(result.phases[0].steps)}`);
  assert.strictEqual(result.passed_count, 2, 'self-check plus one agent-graded vector');
  assert.strictEqual(result.overall_passed, true, 'a run that did verify the agent still passes');
});

test('the legacy fixture_unavailable reasons keep their pre-existing track semantics', () => {
  // The hoisted check is narrowed to the signing reason on purpose: seeding
  // gaps, exhausted fixture ladders and creative-asset gaps have always
  // graded an all-skipped track `skip`, and this PR must not reclassify
  // tracks that have nothing to do with signing.
  const { mapStoryboardResultsToTrackResult } = require('../../dist/lib/testing/compliance/storyboard-tracks.js');

  // `task` matters: the hoisted rule is scoped to request-signing probe
  // steps, which is the only place the signing reason is ever emitted.
  const allSkipped = (detailedReason, task = 'comply_test_controller') => ({
    storyboard_id: 'media_buy_seller',
    storyboard_title: 'Seller',
    agent_url: 'https://agent.invalid/mcp',
    overall_passed: true,
    passed_count: 0,
    failed_count: 0,
    skipped_count: 1,
    total_duration_ms: 1,
    context: {},
    notices: [],
    phases: [
      {
        phase_id: 'p',
        phase_title: 'p',
        passed: true,
        duration_ms: 1,
        steps: [
          {
            step_id: 's',
            phase_id: 'p',
            title: 'seed',
            task,
            passed: true,
            skipped: true,
            skip_reason: detailedReason,
            skip: { reason: 'fixture_unavailable', detail: 'ladder exhausted' },
            validations: [],
            response: { status: 0 },
          },
        ],
      },
    ],
  });
  const profile = { name: 'a', tools: [] };

  assert.strictEqual(
    mapStoryboardResultsToTrackResult('media_buy', [allSkipped('fixture_unsatisfied')], profile).status,
    'skip',
    'a legacy runner fixture gap keeps its long-standing all-skipped verdict'
  );
  assert.strictEqual(
    mapStoryboardResultsToTrackResult(
      'security_transport',
      [allSkipped('signing_transport_unavailable', 'request_signing_probe')],
      profile
    ).status,
    'partial',
    'unverified signing coverage still holds the track open'
  );
});

test('a track whose every step was unavailable stays partial instead of evaporating into skip', async () => {
  // `computeTrackStatus` returned `skip` for an all-skipped track, and
  // `computeOverallStatus` ignores skipped tracks — so sibling tracks alone
  // could carry the run to `passing` while signing verified nothing.
  const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner.js');
  const { mapStoryboardResultsToTrackResult } = require('../../dist/lib/testing/compliance/storyboard-tracks.js');
  const { computeOverallStatus } = require('../../dist/lib/testing/compliance/comply.js');

  const signing = await runStoryboard('https://agent.invalid/a2a', a2aVectorStoryboard(), {
    protocol: 'a2a',
    profile: A2A_SIGNING_PROFILE,
  });
  assert.strictEqual(signing.passed_count, 0, 'every step in this track is a coverage gap');
  assert.strictEqual(signing.skipped_count, 1);

  const track = mapStoryboardResultsToTrackResult('security_transport', [signing], { name: 'a', tools: [] });
  assert.strictEqual(track.status, 'partial', `an all-unavailable track must not be skip, got ${track.status}`);

  // And a partial track keeps the whole run off `passing`, however many
  // other tracks passed.
  const overall = computeOverallStatus({
    tracks_passed: 7,
    tracks_failed: 0,
    tracks_partial: 1,
    tracks_skipped: 0,
    tracks_silent: 0,
  });
  assert.strictEqual(overall, 'partial');
});

test('a routed MCP agent still grades its vectors under a top-level a2a run', async t => {
  // adcp-client#2958 review: the run-level protocol is not the dispatch
  // protocol in a routed run. Gating on it would strand a perfectly gradable
  // MCP seller.
  const { probeRequestSigningVector } = require('../../dist/lib/testing/storyboard/request-signing/probe-dispatch.js');
  const { routedAgentOptions } = require('../../dist/lib/testing/storyboard/agent-routing.js');

  const routed = routedAgentOptions(
    { url: 'https://seller.invalid/mcp', transport: 'mcp' },
    { protocol: 'a2a' },
    { name: 'seller', tools: ['get_adcp_capabilities'] }
  );
  assert.strictEqual(routed.protocol, 'mcp', 'routed options carry the entry transport');

  const result = await probeRequestSigningVector(
    'negative-001-no-signature-header',
    'https://seller.invalid/mcp',
    routed
  );
  assert.notStrictEqual(
    result.skip_reason,
    'signing_transport_unavailable',
    'an MCP-routed seller must still be graded'
  );
  t.diagnostic(`routed probe outcome: ${result.skip_reason ?? result.error ?? 'graded'}`);
});

function selfCheckPlusWireStoryboard() {
  return {
    id: 'signed_requests',
    title: 'Signed requests',
    phases: [
      {
        id: 'negative_vectors',
        title: 'Negative vectors',
        steps: [
          {
            id: 'negative-025-jwk-alg-crv-mismatch',
            title: 'SDK self-check',
            task: 'request_signing_probe',
            validations: [{ check: 'probe_passed' }],
          },
          {
            id: 'negative-001-no-signature-header',
            title: 'Wire vector',
            task: 'request_signing_probe',
            validations: [{ check: 'http_status', value: 401 }],
          },
        ],
      },
    ],
  };
}

const A2A_SIGNING_PROFILE = {
  name: 'a2a-agent',
  tools: ['get_adcp_capabilities'],
  raw_capabilities: { request_signing: { supported: true } },
};

function a2aVectorStoryboard() {
  return {
    id: 'signed_requests',
    title: 'Signed requests',
    phases: [
      {
        id: 'negative_vectors',
        title: 'Negative vectors',
        steps: [
          {
            id: 'negative-001-no-signature-header',
            title: 'Negative vector',
            task: 'request_signing_probe',
            validations: [{ check: 'http_status', value: 401 }],
          },
        ],
      },
    ],
  };
}

test('operator vector selection is applied before transport availability', async () => {
  // A vector the operator never selected is out of scope, not missing
  // coverage. Reporting it as a runner-owned gap would manufacture one (and
  // drag the track to partial) over vectors nobody asked to grade.
  const unselected = await probeRequestSigningVector('negative-001-no-signature-header', 'https://agent.invalid/a2a', {
    protocol: 'a2a',
    request_signing: { onlyVectors: ['002-wrong-tag'] },
  });

  assert.strictEqual(unselected.skipped, true);
  assert.strictEqual(unselected.skip_reason, 'not_in_only_vectors');
  assert.strictEqual(DETAILED_SKIP_TO_CANONICAL[unselected.skip_reason], 'not_applicable');
  assert.strictEqual(unselected.error, undefined, 'an unselected vector carries no coverage-gap remedy');

  // …and the vector the operator DID select keeps its truthful verdict.
  const selected = await probeRequestSigningVector('negative-002-wrong-tag', 'https://agent.invalid/a2a', {
    protocol: 'a2a',
    request_signing: { onlyVectors: ['002-wrong-tag'] },
  });
  assert.strictEqual(selected.skip_reason, 'signing_transport_unavailable');
  assert.strictEqual(DETAILED_SKIP_TO_CANONICAL[selected.skip_reason], 'not_applicable');
});

test('skipVectors is also applied before transport availability', async () => {
  const result = await probeRequestSigningVector('negative-001-no-signature-header', 'https://agent.invalid/a2a', {
    protocol: 'a2a',
    request_signing: { skipVectors: ['001-no-signature-header'] },
  });

  assert.strictEqual(result.skip_reason, 'operator_skip', 'an operator exclusion is not a coverage gap');
});

test('the rate-abuse probe count comes from the test-kit contract, not an SDK-chosen number', () => {
  // `rateAbuseCap` drives a `for (i < cap)` probe loop. This PR types the
  // option on `ComplyOptions`; it does not widen its reach — it is public on
  // `StoryboardRunOptions.request_signing` and `GradeOptions` on origin/main,
  // and already flowed through comply()'s rest-spread there. What bounds the
  // default is the shipped contract, asserted here so an SDK-side default can
  // never quietly exceed it.
  const { loadSignedRequestsRunnerContract } = require('../../dist/lib/testing/storyboard/request-signing/test-kit.js');

  const contract = loadSignedRequestsRunnerContract();
  assert.ok(contract, 'expected the bundled signed-requests runner contract');
  const target = contract.stateful_vector_contract.rate_abuse.grading_target_per_keyid_cap_requests;
  assert.strictEqual(typeof target, 'number');
  assert.ok(target > 0 && target <= 1000, `contract cap should be a bounded probe count, got ${target}`);
});

test('--signing-skip-rate-abuse still short-circuits the vector before any lookup of the cap', async () => {
  const result = await probeRequestSigningVector('negative-020-rate-abuse', 'https://agent.invalid/mcp', {
    request_signing: { skipRateAbuse: true, rateAbuseCap: 1_000_000 },
  });

  assert.strictEqual(result.skip_reason, 'rate_abuse_opt_out');
});

test('an intrinsically ungradable vector reports the same reason on A2A as on MCP', async () => {
  // 026 signs a non-ASCII authority. No HTTP client can carry it — fetch()
  // punycodes the Host before the request leaves — so the grader excludes it
  // on every binding. Ordering the protocol gate first would relabel that
  // permanent exclusion as this A2A run's missing coverage, inflating the
  // gap count and dragging the track partial over a vector that was never
  // gradable anywhere (adcp-client#2954).
  const onA2a = await probeRequestSigningVector('negative-026-non-ascii-host', 'https://agent.invalid/a2a', {
    protocol: 'a2a',
  });
  const onMcp = await probeRequestSigningVector('negative-026-non-ascii-host', 'https://agent.invalid/mcp', {
    protocol: 'mcp',
  });

  assert.strictEqual(onA2a.skip_reason, 'transport_ungradable');
  assert.strictEqual(onA2a.skip_reason, onMcp.skip_reason, 'the exclusion must not depend on the run protocol');
  assert.strictEqual(DETAILED_SKIP_TO_CANONICAL[onA2a.skip_reason], 'not_applicable');
  // The grader's own diagnostic travels with the skip so an operator can
  // audit why the vector was dropped, and it is identical on both protocols.
  assert.match(onA2a.error, /punycodes U-labels/);
  assert.strictEqual(onA2a.error, onMcp.error);
});

test("a protocol-method vector the agent's profile never opted into is profile-excluded, on either protocol", async () => {
  // 028 only applies to an agent that requires signatures on `tasks/cancel`.
  // One that declares no protocol-method bucket is out of scope, exactly as
  // `required_for` scopes the AdCP-tool vectors — so it is `profile_excluded`
  // rather than an A2A coverage gap.
  const profile = {
    name: 'agent-without-protocol-method-signing',
    tools: ['get_adcp_capabilities'],
    raw_capabilities: {
      request_signing: { supported: true, covers_content_digest: 'either', required_for: ['create_media_buy'] },
    },
  };

  for (const protocol of ['a2a', 'mcp']) {
    const result = await probeRequestSigningVector(
      'negative-028-unsigned-protocol-method-required',
      `https://agent.invalid/${protocol}`,
      { protocol, _profile: profile }
    );
    assert.strictEqual(result.skip_reason, 'capability_profile_mismatch', `on ${protocol}`);
    assert.strictEqual(DETAILED_SKIP_TO_CANONICAL[result.skip_reason], 'not_applicable', `on ${protocol}`);
  }
});

test('a protocol-method vector the agent DOES require still reports the A2A coverage gap', async () => {
  // The other half of the rule: when the vector is in scope, an A2A run must
  // say so honestly rather than hiding behind the profile exclusion.
  const profile = {
    name: 'agent-requiring-tasks-cancel-signatures',
    tools: ['get_adcp_capabilities'],
    raw_capabilities: {
      request_signing: {
        supported: true,
        covers_content_digest: 'either',
        required_for: [],
        protocol_methods_required_for: ['tasks/cancel'],
      },
    },
  };

  const result = await probeRequestSigningVector(
    'negative-028-unsigned-protocol-method-required',
    'https://agent.invalid/a2a',
    { protocol: 'a2a', _profile: profile }
  );

  assert.strictEqual(result.skip_reason, 'signing_transport_unavailable');
  assert.strictEqual(DETAILED_SKIP_TO_CANONICAL[result.skip_reason], 'not_applicable');
  assert.match(result.error, /official A2A client/);
});

test('an advertised capability block cannot shrink the graded vector set beyond narrow profile gates', async () => {
  // Guard against re-deriving the whole capability profile from the agent's
  // advertisement: the vectors' `verifier_capability` describes the profile
  // each vector was authored against, so comparing it to a live
  // advertisement (`covers_content_digest: 'either', required_for: []`)
  // excludes 39 of 40 vectors — an agent could turn the storyboard off by
  // under-declaring. Only the protocol-method and content-digest dimensions
  // are read, each by its own narrow mismatch gate.
  const permissive = {
    name: 'permissive-advertiser',
    tools: ['get_adcp_capabilities'],
    raw_capabilities: {
      request_signing: { supported: true, covers_content_digest: 'either', required_for: [] },
    },
  };

  for (const vector of [
    'negative-002-wrong-tag',
    'positive-002-post-with-content-digest',
    'negative-010-content-digest-mismatch',
    'negative-023-multi-valued-content-digest',
  ]) {
    const result = await probeRequestSigningVector(vector, 'http://127.0.0.1:1', {
      protocol: 'mcp',
      allow_http: true,
      _profile: permissive,
      request_signing: { transport: 'raw' },
    });

    assert.strictEqual(result.skipped, undefined, vector);
    assert.strictEqual(result.probe_error, true, vector);
    assert.match(result.error, /probe error: fetch failed/, vector);
  }
});

test('storyboard dispatch applies the declared content-digest policy before MCP or A2A transport gating', async () => {
  const profile = {
    name: 'either-content-digest-policy',
    tools: ['get_adcp_capabilities'],
    raw_capabilities: {
      request_signing: { supported: true, covers_content_digest: 'either', required_for: [] },
    },
  };

  for (const protocol of ['mcp', 'a2a']) {
    for (const vector of ['negative-007-missing-content-digest', 'negative-018-digest-covered-when-forbidden']) {
      const result = await probeRequestSigningVector(vector, `https://agent.invalid/${protocol}`, {
        protocol,
        _profile: profile,
        ...(protocol === 'mcp' ? { request_signing: { transport: 'raw' } } : {}),
      });

      assert.strictEqual(result.skipped, true, `${protocol}: ${vector}`);
      assert.strictEqual(result.skip_reason, 'capability_profile_mismatch', `${protocol}: ${vector}`);
    }
  }
});

test('storyboard dispatch grades matching strict-policy refusal vectors', async t => {
  const expectedErrors = ['request_signature_components_incomplete', 'request_signature_components_unexpected'];
  let requestIndex = 0;
  const server = http.createServer((_req, res) => {
    res.writeHead(401, {
      'content-type': 'application/json',
      'www-authenticate': `Signature error="${expectedErrors[requestIndex++]}"`,
    });
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const agentUrl = `http://127.0.0.1:${server.address().port}`;

  for (const [vector, policy] of [
    ['negative-007-missing-content-digest', 'required'],
    ['negative-018-digest-covered-when-forbidden', 'forbidden'],
  ]) {
    const result = await probeRequestSigningVector(vector, agentUrl, {
      protocol: 'mcp',
      allow_http: true,
      _profile: {
        name: `${policy}-content-digest-policy`,
        tools: ['get_adcp_capabilities'],
        raw_capabilities: {
          request_signing: { supported: true, covers_content_digest: policy, required_for: [] },
        },
      },
      request_signing: { transport: 'raw' },
    });

    assert.strictEqual(result.skipped, undefined, vector);
    assert.strictEqual(result.error, undefined, vector);
  }
  assert.strictEqual(requestIndex, 2);
});

test('storyboard dispatch excludes only the incompatible strict-policy refusal vector', async () => {
  for (const [vector, policy] of [
    ['negative-007-missing-content-digest', 'forbidden'],
    ['negative-018-digest-covered-when-forbidden', 'required'],
  ]) {
    const result = await probeRequestSigningVector(vector, 'https://agent.invalid/a2a', {
      protocol: 'a2a',
      _profile: {
        name: `${policy}-content-digest-policy`,
        tools: ['get_adcp_capabilities'],
        raw_capabilities: {
          request_signing: { supported: true, covers_content_digest: policy, required_for: [] },
        },
      },
    });
    assert.strictEqual(result.skip_reason, 'capability_profile_mismatch', vector);
  }
});

test('legacy omitted content-digest policy defaults to either before transport gating', async () => {
  const profile = {
    name: 'legacy-default-content-digest-policy',
    tools: ['get_adcp_capabilities'],
    raw_capabilities: { request_signing: { supported: true, required_for: [] } },
  };
  for (const vector of ['negative-007-missing-content-digest', 'negative-018-digest-covered-when-forbidden']) {
    const result = await probeRequestSigningVector(vector, 'https://agent.invalid/a2a', {
      protocol: 'a2a',
      adcpVersion: '3.1.18',
      _profile: profile,
    });
    assert.strictEqual(result.skip_reason, 'capability_profile_mismatch', vector);
  }
});

test('malformed or unsupported content-digest declarations cannot suppress vectors', async t => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const agentUrl = `http://127.0.0.1:${server.address().port}`;

  const declarations = [
    { covers_content_digest: 'either' },
    { supported: false, covers_content_digest: 'either' },
    { supported: true },
    { supported: true, covers_content_digest: 'sometimes' },
    { supported: true, covers_content_digest: null },
  ];
  for (const requestSigning of declarations) {
    const result = await probeRequestSigningVector('negative-007-missing-content-digest', agentUrl, {
      protocol: 'mcp',
      allow_http: true,
      _profile: {
        name: 'malformed-content-digest-policy',
        tools: ['get_adcp_capabilities'],
        raw_capabilities: { request_signing: requestSigning },
      },
      request_signing: { transport: 'raw' },
    });

    assert.strictEqual(result.skipped, undefined, JSON.stringify(requestSigning));
    assert.match(result.error, /expected 401/, JSON.stringify(requestSigning));
  }
});

test('a broken vector cache surfaces as an error, never as a coverage gap', async () => {
  // The load failure used to be swallowed, which left the transport gate to
  // report a missing compliance cache as "this protocol cannot carry the
  // fixtures" — wrong, and skip-shaped, so it could never fail a run.
  const { mkdtempSync } = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const emptyDir = mkdtempSync(path.join(os.tmpdir(), 'adcp-empty-compliance-'));

  const result = await probeRequestSigningVector('negative-001-no-signature-header', 'https://agent.invalid/a2a', {
    protocol: 'a2a',
    complianceDir: emptyDir,
  });

  assert.strictEqual(result.skipped, undefined, 'a runner fault must not be reported as a skip');
  assert.strictEqual(result.skip_reason, undefined);
  assert.match(result.error, /could not load request-signing vectors/);
});

test('the canonical compliance report names an unverified signing storyboard and its remedy', () => {
  // The steps are pass-shaped, so without this the scenario prints a bare ❌
  // with no failing step under it — or, on a track a sibling scenario
  // carries, nothing at all. Grouped per storyboard, so the per-phase
  // projection cannot print a gap for a storyboard that graded vectors.
  const { formatComplianceResults } = require('../../dist/lib/testing/compliance/comply.js');

  const probeStep = overrides => ({
    step: 'Negative vector',
    task: 'request_signing_probe',
    passed: true,
    duration_ms: 0,
    ...overrides,
  });
  const report = result =>
    formatComplianceResults({
      agent_url: 'https://agent.invalid/a2a',
      agent_profile: { name: 'a2a-agent', tools: [] },
      total_duration_ms: 1000,
      completeness: 'complete',
      observations: [],
      summary: { headline: '1 track partial', tracks_failed: 0, tracks_partial: 1, tracks_silent: 0 },
      tracks: [
        {
          track: 'security_transport',
          status: 'partial',
          label: 'Security & transport',
          duration_ms: 1000,
          scenarios: result,
          skipped_scenarios: [],
          observations: [],
        },
      ],
      failures: [],
    });

  const unverified = report([
    {
      scenario: 'signed_requests/negative_vectors',
      overall_passed: false,
      steps: [
        probeStep({
          skipped: true,
          skip_reason: 'signing_transport_unavailable',
          observation_data: { status: 0, error: 'Coverage unavailable: … Remedy: grade the MCP binding.' },
        }),
      ],
    },
  ]);
  assert.match(unverified, /COVERAGE UNAVAILABLE — signed_requests: none of 1 request-signing vector\(s\)/);
  assert.match(unverified, /no dispatch shape for the vectors/);
  assert.match(unverified, /Remedy: grade the MCP binding\./);

  // Operator scope reads differently, and a storyboard that graded a vector
  // in any phase prints no block at all.
  const excluded = report([
    {
      scenario: 'signed_requests/negative_vectors',
      overall_passed: false,
      steps: [probeStep({ skipped: true, skip_reason: 'operator_skip', observation_data: { status: 0 } })],
    },
  ]);
  assert.match(excluded, /every vector was excluded by this run's own selection/);

  const graded = report([
    {
      scenario: 'signed_requests/positive_vectors',
      overall_passed: true,
      steps: [probeStep({ observation_data: { status: 200 } })],
    },
    {
      scenario: 'signed_requests/negative_vectors',
      overall_passed: false,
      steps: [probeStep({ skipped: true, skip_reason: 'operator_skip', observation_data: { status: 0 } })],
    },
  ]);
  assert.doesNotMatch(graded, /COVERAGE UNAVAILABLE/, 'a storyboard that graded a vector has no gap to report');
});

test('the assessment exit contract fires on unverified signing coverage, whatever excluded it', () => {
  // `partial` maps to exit 0 by policy — a silent or partially exercised
  // track is a reportable observation. The one exception is a run that set
  // out to grade a verifier and graded nothing (adcp-client#2954/#2956).
  //
  // Keyed on coverage, not on a skip reason, and grouped by storyboard: a
  // per-scenario rule reads the per-phase projection and fails a run whose
  // positives graded fine. The two causes stay distinguishable in the row.
  const { unverifiedSigningCoverage } = require('../../bin/adcp-storyboard-summary.js');

  const tracksOf = (...scenarios) => ({ tracks: [{ scenarios }] });
  const phase = (name, steps) => ({ scenario: `signed_requests/${name}`, steps });
  const probeStep = overrides => ({ task: 'request_signing_probe', ...overrides });
  const skippedProbe = reason =>
    probeStep({ passed: true, skipped: true, skip_reason: reason, observation_data: { status: 0 } });
  const gradedProbe = status => probeStep({ passed: true, observation_data: { status } });

  assert.deepStrictEqual(
    unverifiedSigningCoverage(tracksOf(phase('negative_vectors', [skippedProbe('signing_transport_unavailable')]))),
    [{ storyboard_id: 'signed_requests', coverage: 'transport_unverified' }],
    'no dispatch shape for this protocol'
  );
  assert.deepStrictEqual(
    unverifiedSigningCoverage(
      tracksOf(phase('negative_vectors', [skippedProbe('operator_skip'), skippedProbe('not_in_only_vectors')]))
    ),
    [{ storyboard_id: 'signed_requests', coverage: 'scope_excluded' }],
    "the run's own selection removed every vector — distinct cause, still unverified"
  );
  assert.deepStrictEqual(
    unverifiedSigningCoverage(
      // The in-library self-check: graded, passing, `http_status: 0` by
      // contract because it never contacts the agent.
      tracksOf(phase('negative_vectors', [probeStep({ passed: true, observation_data: { status: 0 } })]))
    ),
    [{ storyboard_id: 'signed_requests', coverage: 'self_check_only' }],
    'an SDK self-check is not agent coverage, and says so in its own words'
  );

  // The false-CI-failure case: scenarios are per phase, so a per-scenario
  // rule reports a gap for `negative_vectors` while the storyboard graded
  // vectors and the report prints green.
  assert.deepStrictEqual(
    unverifiedSigningCoverage(
      tracksOf(
        phase('positive_vectors', [gradedProbe(200)]),
        phase('negative_vectors', [skippedProbe('operator_skip')])
      )
    ),
    [],
    'one graded vector anywhere in the storyboard is coverage'
  );

  const legacyGap = {
    tracks: [
      {
        scenarios: [
          { scenario: 'media_buy_lifecycle/flow', steps: [{ task: 'create_media_buy', skipped: true }] },
          { scenario: 'creative_upload/flow', steps: [{ task: 'sync_creatives', skipped: true }] },
        ],
      },
    ],
  };
  assert.deepStrictEqual(unverifiedSigningCoverage(legacyGap), [], 'scenarios without signing probes keep exit 0');
  assert.deepStrictEqual(unverifiedSigningCoverage({}), []);
});

test('only a runner-owned signing gap makes a single step exit nonzero', () => {
  // `adcp storyboard step` maps `passed` to the exit code, and a skip is
  // `passed: true`. The gap the runner owns must not read as success; an
  // operator's own exclusion and a legacy fixture gap keep exit 0 — the
  // output contract says `fixture_unavailable` must not move a verdict.
  const { isCoverageUnavailableStep } = require('../../bin/adcp-storyboard-summary.js');

  assert.strictEqual(
    isCoverageUnavailableStep({
      task: 'request_signing_probe',
      passed: true,
      skipped: true,
      skip_reason: 'signing_transport_unavailable',
      response: { status: 0 },
    }),
    true
  );
  assert.strictEqual(
    isCoverageUnavailableStep({
      task: 'request_signing_probe',
      passed: true,
      skipped: true,
      skip_reason: 'operator_skip',
      response: { status: 0 },
    }),
    false,
    "the operator's own exclusion is not a runner gap"
  );
  assert.strictEqual(
    isCoverageUnavailableStep({
      task: 'create_media_buy',
      passed: true,
      skipped: true,
      skip_reason: 'fixture_unsatisfied',
      skip: { reason: 'fixture_unavailable' },
    }),
    false,
    'legacy fixture gaps keep their long-standing exit 0'
  );
  assert.strictEqual(
    isCoverageUnavailableStep({
      task: 'request_signing_probe',
      passed: true,
      response: { status: 401 },
    }),
    false,
    'a graded vector is not a gap'
  );
});

test('an unverified signing scenario still caps its bundle under the capability-rollup rule', () => {
  // Merge-sensitive: #2960 made a storyboard the agent's own capability
  // declaration puts out of scope neutral at the bundle level. The rule is
  // anchored on the synthetic applicability row, but the storyboard it
  // neutralizes looks exactly like this one — a capability predicate and a
  // ≥3.2 `adcp_version` — so an unverified signing run must not ride that
  // exemption into a clean bundle (adcp-client#2954 × #2960).
  const { buildComplianceBundleResults } = require('../../dist/lib/testing/compliance/comply.js');
  const { ADCP_VERSION } = require('../../dist/lib/version.js');

  const storyboard = {
    id: 'signed_requests',
    adcp_version: ADCP_VERSION,
    requires_capability: { path: 'request_signing.supported', equals: true },
    phases: [{ id: 'negative_vectors' }],
  };
  const bundle = {
    ref: { kind: 'universal', id: 'signed-requests', path: '/unused' },
    storyboards: [storyboard],
  };

  // Control: the neutrality rule really does reach this storyboard, so the
  // assertion below is about the signing result and not about a predicate
  // that never matched. Row shape mirrors `buildCapabilityUnsupportedResult`
  // (see `test/lib/storyboard-capability-rollup.test.js`).
  const applicabilityRow = {
    storyboard_id: 'signed_requests',
    storyboard_title: 'Signed requests',
    agent_url: 'http://127.0.0.1:1/mcp',
    context: {},
    total_duration_ms: 0,
    runner_capability_version: 'test',
    tested_at: '2026-01-01T00:00:00.000Z',
    strict_validation_summary: {
      observable: false,
      checked: 0,
      passed: 0,
      failed: 0,
      strict_only_failures: 0,
      lenient_also_failed: 0,
    },
    notices: [],
    overall_passed: true,
    passed_count: 0,
    failed_count: 0,
    skipped_count: 1,
    phases: [
      {
        phase_id: 'capability_unsupported',
        phase_title: 'Capability unsupported',
        passed: true,
        steps: [
          {
            storyboard_id: 'signed_requests',
            step_id: 'capability_unsupported',
            phase_id: 'capability_unsupported',
            title: 'Storyboard skipped: capability not supported by this agent',
            task: '',
            passed: true,
            skipped: true,
            skip_reason: 'capability_unsupported',
            skip: { reason: 'not_applicable', detail: 'detail' },
            duration_ms: 0,
            validations: [],
            context: {},
            error: 'detail',
            extraction: { path: 'none' },
          },
        ],
        duration_ms: 0,
      },
    ],
  };
  assert.strictEqual(
    buildComplianceBundleResults([bundle], [applicabilityRow])[0].status,
    'not_applicable',
    'control: the capability-rollup exemption applies to this storyboard'
  );

  // The real case: an agent that DID claim `request_signing.supported`, whose
  // vectors this run could not dispatch. Skip-shaped and failure-free, so
  // every count reads clean — the bundle must still be capped.
  const unverified = {
    storyboard_id: 'signed_requests',
    overall_passed: false,
    passed_count: 0,
    failed_count: 0,
    skipped_count: 2,
    phases: [
      {
        phase_id: 'negative_vectors',
        steps: [
          {
            step_id: 'negative-001-no-signature-header',
            task: 'request_signing_probe',
            passed: true,
            skipped: true,
            skip_reason: 'signing_transport_unavailable',
            skip: { reason: 'not_applicable', detail: 'signing_transport_unavailable' },
          },
          {
            step_id: 'negative-002-wrong-tag',
            task: 'request_signing_probe',
            passed: true,
            skipped: true,
            skip_reason: 'signing_transport_unavailable',
            skip: { reason: 'not_applicable', detail: 'signing_transport_unavailable' },
          },
        ],
      },
    ],
  };

  assert.strictEqual(buildComplianceBundleResults([bundle], [unverified])[0].status, 'partial');
});

test('a track whose every vector the operator excluded stays partial, and the two rules agree', () => {
  // The exclusion route review found open (adcp-client#2954 exact-head codex,
  // all three personas): with every vector excluded, no step carries
  // `signing_transport_unavailable`, so a reason-keyed track rule returned
  // `skip` at the all-skipped check — erasing the track from
  // `computeOverallStatus`'s `attempted` count and letting sibling tracks
  // carry the run to `passing` with the verifier untouched.
  const { mapStoryboardResultsToTrackResult } = require('../../dist/lib/testing/compliance/storyboard-tracks.js');
  const { computeOverallStatus } = require('../../dist/lib/testing/compliance/comply.js');
  const { unverifiedSigningCoverage } = require('../../bin/adcp-storyboard-summary.js');
  const profile = { name: 'agent', tools: [] };

  const skippedProbe = (stepId, reason) => ({
    step_id: stepId,
    task: 'request_signing_probe',
    passed: true,
    skipped: true,
    skip_reason: reason,
    skip: { reason: 'not_applicable', detail: 'excluded' },
    duration_ms: 0,
    validations: [],
    response: { status: 0 },
  });
  const allExcluded = {
    storyboard_id: 'signed_requests',
    overall_passed: false,
    passed_count: 0,
    failed_count: 0,
    skipped_count: 2,
    phases: [
      {
        phase_id: 'negative_vectors',
        steps: [
          skippedProbe('negative-001-no-signature-header', 'not_in_only_vectors'),
          skippedProbe('negative-002-wrong-tag', 'operator_skip'),
        ],
      },
    ],
  };

  const signingTrack = mapStoryboardResultsToTrackResult('security_transport', [allExcluded], profile);
  assert.strictEqual(signingTrack.status, 'partial', 'an all-excluded signing track must not evaporate into skip');

  // …and it must still cap the run when a sibling track passes everything.
  const passingSibling = mapStoryboardResultsToTrackResult(
    'core',
    [
      {
        storyboard_id: 'core_discovery',
        overall_passed: true,
        passed_count: 3,
        failed_count: 0,
        skipped_count: 0,
        phases: [],
      },
    ],
    profile
  );
  assert.strictEqual(passingSibling.status, 'pass');
  assert.notStrictEqual(computeOverallStatus([signingTrack, passingSibling]), 'passing');

  // The CLI exit contract reads the mapped `TestStepResult` copy of the same
  // run. Pin the two rules against one result so they cannot drift apart.
  // The CLI groups the per-phase projection back to the storyboard, so the
  // operator sees one id and the two rules agree on the same run.
  assert.deepStrictEqual(unverifiedSigningCoverage({ tracks: [signingTrack] }), [
    { storyboard_id: 'signed_requests', coverage: 'scope_excluded' },
  ]);
});

test('the 028 gate reads only its own capability field, on every compliance line', async () => {
  // The gate `compliance/{version}/universal/signed-requests.yaml` specifies:
  // skip when the agent does not declare the bucket, FAIL when it declares
  // the bucket but does not enforce. The capabilities schema requires only
  // `supported` under `request_signing`, so requiring siblings to be present
  // made a schema-legal agent miss the exclusion and fail a vector it never
  // claimed.
  const vector = 'negative-028-unsigned-protocol-method-required';
  const url = 'https://agent.invalid/a2a';
  const probe = (requestSigning, version) =>
    probeRequestSigningVector(vector, url, {
      protocol: 'a2a',
      ...(version && { adcpVersion: version }),
      _profile: { name: 'agent', tools: [], raw_capabilities: { request_signing: requestSigning } },
    });

  for (const version of [undefined, '3.1.18']) {
    const line = version ?? 'default';
    // Absent bucket: the spec-defined gate. Excluded.
    assert.strictEqual(
      (await probe({ supported: true }, version)).skip_reason,
      'capability_profile_mismatch',
      `${line}: a schema-minimal block still gates 028`
    );
    // Declared-empty bucket: same answer.
    assert.strictEqual(
      (await probe({ supported: true, protocol_methods_required_for: [] }, version)).skip_reason,
      'capability_profile_mismatch',
      `${line}: declared-empty bucket`
    );
    // Declared bucket: in scope, so the A2A gap is reported instead.
    assert.strictEqual(
      (await probe({ supported: true, protocol_methods_required_for: ['tasks/cancel'] }, version)).skip_reason,
      'signing_transport_unavailable',
      `${line}: a claimant gets the coverage gap, not an exclusion`
    );
    // Unrelated fields, valid or malformed, are never read.
    assert.strictEqual(
      (await probe({ supported: true, covers_content_digest: 'required', required_for: ['create_media_buy'] }, version))
        .skip_reason,
      'capability_profile_mismatch',
      `${line}: a fully populated block gates the same way`
    );
    assert.strictEqual(
      (await probe({ supported: true, supported_for: 'create_media_buy' }, version)).skip_reason,
      'capability_profile_mismatch',
      `${line}: a malformed unrelated field is not read`
    );
  }
});

test('a schema-invalid protocol-method declaration cannot suppress vector 028', async () => {
  // Fail-closed. Every value below is rejected by the capabilities schema's
  // `items` constraint for its line, and reading any of them as "the bucket
  // was not declared" excludes the vector — which is how a server that
  // accepts an unsigned `tasks/cancel` reports `overall_passed: true` and
  // exit 0 with the vector never dispatched. The declaration is discarded
  // and the vector graded instead.
  const vector = 'negative-028-unsigned-protocol-method-required';
  const probe = (declaration, version) =>
    probeRequestSigningVector(vector, 'https://agent.invalid/a2a', {
      protocol: 'a2a',
      ...(version && { adcpVersion: version }),
      _profile: {
        name: 'agent',
        tools: [],
        raw_capabilities: {
          request_signing: { supported: true, protocol_methods_required_for: declaration },
        },
      },
    });

  const invalidEverywhere = [
    null,
    [''],
    ['   '],
    ['tasks/cancel '],
    [' tasks/cancel'],
    ['tasks cancel'],
    ['tasks/cancel', ''],
    [1],
    [null],
    [['tasks/cancel']],
    'tasks/cancel',
    42,
    true,
    {},
  ];
  // Length is deliberately not in this list: 3.2 caps names at 256 and 3.1
  // declares no cap, so an over-long name is line-specific. See the
  // length-cap test below.
  for (const version of [undefined, '3.1.18']) {
    const line = version ?? '3.2';
    for (const declaration of invalidEverywhere) {
      const result = await probe(declaration, version);
      assert.strictEqual(
        result.skip_reason,
        'signing_transport_unavailable',
        `${line}: ${JSON.stringify(declaration)} must not exclude the vector`
      );
    }
  }

  // Line-specific grammars. Honouring a name the run's own schema rejects
  // would accept a declaration that omits `tasks/cancel`, which suppresses
  // the vector — so the check is keyed to the line, not to their union.
  //   3.2 adds A2A 1.0 PascalCase names and multi-segment paths, and forbids
  //   `tools/call`; 3.1 allows a single lowercase pair only.
  const perLine = [
    { declaration: ['CancelTask'], valid: '3.2', invalid: '3.1.18' },
    { declaration: ['tasks/pushNotificationConfig/set'], valid: '3.2', invalid: '3.1.18' },
    { declaration: ['tools/call'], valid: '3.1.18', invalid: '3.2' },
  ];
  for (const { declaration, valid, invalid } of perLine) {
    const honoured = await probe(declaration, valid === '3.2' ? undefined : valid);
    assert.strictEqual(
      honoured.skip_reason,
      'capability_profile_mismatch',
      `${valid}: ${JSON.stringify(declaration)} is schema-valid, so the declaration is honoured`
    );
    const discarded = await probe(declaration, invalid === '3.2' ? undefined : invalid);
    assert.strictEqual(
      discarded.skip_reason,
      'signing_transport_unavailable',
      `${invalid}: ${JSON.stringify(declaration)} is schema-invalid, so it cannot suppress the vector`
    );
  }
});

test('the protocol-method grammars match the shipped capabilities schemas', () => {
  // The grammars are copied from the schema so the dispatch does not do
  // schema I/O per vector. A copy that drifts wider than the schema accepts
  // a declaration the agent's own line rejects, which re-opens the
  // suppression above — so pin both lines against the shipped files.
  const fs = require('node:fs');
  const { PROTOCOL_METHOD_GRAMMARS } = require('../../dist/lib/testing/storyboard/request-signing/probe-dispatch.js');

  const itemsFor = version =>
    JSON.parse(fs.readFileSync(`schemas/cache/${version}/bundled/protocol/get-adcp-capabilities-response.json`, 'utf8'))
      .properties.request_signing.properties.protocol_methods_required_for.items;

  // `RegExp.source` escapes the forward slash the schema writes bare.
  const sourceOf = pattern => pattern.source.replaceAll('\\/', '/');

  const since32 = itemsFor('3.2.0-rc.4');
  assert.strictEqual(sourceOf(PROTOCOL_METHOD_GRAMMARS.since_3_2.pattern), since32.pattern);
  assert.strictEqual(PROTOCOL_METHOD_GRAMMARS.since_3_2.maxLength, since32.maxLength);
  assert.deepStrictEqual([...PROTOCOL_METHOD_GRAMMARS.since_3_2.forbidden], [since32.not.const]);

  const pre32 = itemsFor('3.1.18');
  assert.strictEqual(sourceOf(PROTOCOL_METHOD_GRAMMARS.pre_3_2.pattern), pre32.pattern);
  // 3.1 declares no cap and no forbidden constant; imposing either would
  // reject a name that line accepts, and a rejected declaration is graded.
  assert.strictEqual(pre32.maxLength, undefined, 'the 3.1 schema declares no maxLength');
  assert.strictEqual(PROTOCOL_METHOD_GRAMMARS.pre_3_2.maxLength, undefined);
  assert.strictEqual(pre32.not, undefined, 'the 3.1 schema forbids no constant');
  assert.deepStrictEqual([...PROTOCOL_METHOD_GRAMMARS.pre_3_2.forbidden], []);
});

test('a probe that never completed is not reported as an operator exclusion', () => {
  // `scope_excluded` used to be the catch-all, so a failed MCP handshake or
  // DNS lookup told the operator to drop `--signing-skip-vectors` flags they
  // had not passed. Each way of ending with no graded vector gets its own
  // state, and only actual skips are scope exclusions.
  const { signingCoverage } = require('../../dist/lib/testing/storyboard/runner.js');
  const probeStep = response => ({ task: 'request_signing_probe', response });
  const skipped = reason => ({
    task: 'request_signing_probe',
    skipped: true,
    skip_reason: reason,
    response: { status: 0 },
  });

  assert.strictEqual(
    signingCoverage([
      probeStep({
        status: 0,
        error: 'request_signing_probe threw: MCP initialize precondition failed',
        probe_error: true,
      }),
    ]),
    'probe_errored'
  );
  // An in-library grade that failed reports the same `status: 0` with an
  // error, and it IS a verdict — it must not read as a transport fault.
  assert.strictEqual(
    signingCoverage([probeStep({ status: 0, error: 'library verifier accepted a request expected to fail' })]),
    'self_check_only'
  );
  assert.strictEqual(signingCoverage([skipped('operator_skip')]), 'scope_excluded');
  assert.strictEqual(signingCoverage([skipped('signing_transport_unavailable')]), 'transport_unverified');
  assert.strictEqual(signingCoverage([probeStep({ status: 401 })]), 'graded');
  assert.strictEqual(signingCoverage([{ task: 'create_media_buy', passed: true }]), 'not_probed');

  // A transport gap plus an unreachable agent: the connection failure is the
  // thing the operator has to fix first.
  assert.strictEqual(
    signingCoverage([
      skipped('signing_transport_unavailable'),
      probeStep({ status: 0, error: 'request_signing_probe threw: DNS lookup failed', probe_error: true }),
    ]),
    'probe_errored'
  );
});

test('the compliance report strips control characters from the text it prints', () => {
  // The producers are library constants today; this is the seam where an
  // adopter-supplied skip detail would land, and the CLI-side renderer
  // escapes for the same reason. Built from char codes so the fixture
  // carries no literal escape sequence.
  const { formatComplianceResults } = require('../../dist/lib/testing/compliance/comply.js');
  const esc = String.fromCharCode(27);
  const bell = String.fromCharCode(7);
  const escaped = code => '\\u' + code.toString(16).padStart(4, '0');
  const hostile = `remedy${esc}[2Kspoofed${bell}`;

  const report = formatComplianceResults({
    agent_url: 'https://agent.invalid/a2a',
    agent_profile: { name: 'a2a-agent', tools: [] },
    total_duration_ms: 1,
    completeness: 'complete',
    observations: [],
    summary: { headline: '1 track partial', tracks_failed: 0, tracks_partial: 1, tracks_silent: 0 },
    tracks: [
      {
        track: 'security_transport',
        status: 'partial',
        label: 'Security & transport',
        duration_ms: 1,
        scenarios: [
          {
            scenario: 'signed_requests/negative_vectors',
            overall_passed: false,
            steps: [
              {
                step: 'Negative vector',
                task: 'request_signing_probe',
                passed: true,
                duration_ms: 0,
                skipped: true,
                skip_reason: 'signing_transport_unavailable',
                observation_data: { status: 0, error: hostile },
              },
            ],
          },
        ],
        skipped_scenarios: [],
        observations: [],
      },
    ],
    failures: [],
  });

  assert.ok(!report.includes(esc), 'no raw escape sequence may reach the terminal');
  assert.ok(!report.includes(bell));
  assert.ok(
    report.includes(`remedy${escaped(27)}[2Kspoofed${escaped(7)}`),
    'the escaped form must still be readable in the report'
  );
});

test("method-name length is capped only where the line's schema caps it", async () => {
  // 3.2 declares `maxLength: 256`; 3.1 declares none. Applying 3.2's cap to
  // a 3.1 run rejects a name that line accepts, and a rejected declaration
  // is graded — failing vector 028 against an agent that never claimed the
  // method.
  const vector = 'negative-028-unsigned-protocol-method-required';
  const probe = (declaration, version) =>
    probeRequestSigningVector(vector, 'https://agent.invalid/a2a', {
      protocol: 'a2a',
      ...(version && { adcpVersion: version }),
      _profile: {
        name: 'agent',
        tools: [],
        raw_capabilities: {
          request_signing: { supported: true, protocol_methods_required_for: declaration },
        },
      },
    });

  const short31 = ['tasks/cancel_other'];
  // 258 characters: over 3.2's cap, valid on 3.1 which declares none.
  const long31 = [`tasks/${'a'.repeat(252)}`];
  assert.strictEqual(long31[0].length, 258);

  assert.strictEqual(
    (await probe(short31, '3.1.18')).skip_reason,
    'capability_profile_mismatch',
    '3.1: a short valid name is honoured'
  );
  assert.strictEqual(
    (await probe(long31, '3.1.18')).skip_reason,
    'capability_profile_mismatch',
    '3.1: a 258-character name is valid on this line and must stay honoured'
  );
  assert.strictEqual(
    (await probe(short31)).skip_reason,
    'capability_profile_mismatch',
    '3.2: a short valid name is honoured'
  );
  assert.strictEqual(
    (await probe(long31)).skip_reason,
    'signing_transport_unavailable',
    "3.2: a 258-character name exceeds this line's cap, so the declaration is discarded"
  );
});

test('a replay pair whose second probe never completes is a probe fault', async t => {
  // `gradeReplayWindow` runs (accept, replay) pairs. Only the first probe's
  // fault was carried, so a run whose first submission succeeded and whose
  // replay probe died on the wire came back `http_status: 0` with a
  // diagnostic — indistinguishable from a verdict, and reported as "only the
  // SDK self-check ran" while the agent was in fact unreachable mid-pair.
  const http = require('node:http');
  const { signingCoverage } = require('../../dist/lib/testing/storyboard/runner.js');

  let requests = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    // Odd request = the pair's first submission, which must be accepted.
    // Even request = the replay probe; kill the socket so the client sees a
    // network error rather than a status.
    if (requests % 2 === 1) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    req.destroy();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });

  const result = await probeRequestSigningVector(
    'negative-016-replayed-nonce',
    `http://127.0.0.1:${server.address().port}/adcp`,
    {
      protocol: 'mcp',
      allow_http: true,
      request_signing: { transport: 'raw', allowLiveSideEffects: true },
    }
  );

  assert.strictEqual(result.skipped, undefined, 'the vector was dispatched');
  assert.ok(requests >= 2, `expected both probes of a pair to run, saw ${requests}`);
  assert.strictEqual(result.probe_error, true, "the second probe's transport fault must survive");
  assert.strictEqual(
    signingCoverage([{ task: 'request_signing_probe', response: result }]),
    'probe_errored',
    'a replay probe that died on the wire is not an SDK self-check'
  );
});

test('a transport failure is reported as a probe fault, not as an SDK self-check', async () => {
  // A DNS or connect failure reaches the grader as `ProbeResult.error` and
  // comes back as `http_status: 0` with text — the same shape as an
  // in-library grade. Without provenance the coverage classifier called it
  // `self_check_only`, so the report told the operator only the SDK check
  // ran while the agent was in fact unreachable.
  const { signingCoverage } = require('../../dist/lib/testing/storyboard/runner.js');

  const unreachable = await probeRequestSigningVector('negative-001-no-signature-header', 'https://agent.invalid/mcp', {
    protocol: 'mcp',
    request_signing: { transport: 'raw' },
  });
  assert.strictEqual(unreachable.skipped, undefined, 'a dispatch was attempted');
  assert.strictEqual(unreachable.probe_error, true, 'the transport fault is marked');
  assert.match(unreachable.error, /agent\.invalid|ENOTFOUND|probe error/i);
  assert.strictEqual(
    signingCoverage([{ task: 'request_signing_probe', response: unreachable }]),
    'probe_errored',
    'an unreachable agent must not be reported as a self-check-only run'
  );

  // The in-library self-check on the same run shape is a verdict, not a
  // fault, and must keep its own classification.
  const selfCheck = await probeRequestSigningVector('negative-025-jwk-alg-crv-mismatch', 'https://agent.invalid/a2a', {
    protocol: 'a2a',
  });
  assert.strictEqual(selfCheck.skipped, undefined);
  assert.strictEqual(selfCheck.probe_error, undefined, 'an in-library grade is not a transport fault');
  assert.strictEqual(signingCoverage([{ task: 'request_signing_probe', response: selfCheck }]), 'self_check_only');
});

test('a rate-abuse cap that was never established cannot pass', async t => {
  // `020-rate-abuse` fills the per-keyid cap, then sends one more request and
  // expects `request_signature_rate_abuse`. If a fill request dies on the
  // wire the cap was never reached, so the (cap+1) rejection proves nothing —
  // an agent that rejects everything with that code would "pass". Worse, the
  // rejection carries `status: 401`, so a status-only coverage rule called
  // the run graded.
  const http = require('node:http');
  const { signingCoverage } = require('../../dist/lib/testing/storyboard/runner.js');

  const cap = 2;
  let seen = 0;
  const server = http.createServer((req, res) => {
    seen += 1;
    if (seen <= cap) {
      // Cap-fill request: kill the socket so the limiter never sees it.
      req.destroy();
      return;
    }
    // (cap+1): answer exactly what the vector expects.
    res.writeHead(401, {
      'content-type': 'application/json',
      'www-authenticate': 'Signature error="request_signature_rate_abuse"',
    });
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });

  const result = await probeRequestSigningVector(
    'negative-020-rate-abuse',
    `http://127.0.0.1:${server.address().port}/adcp`,
    {
      protocol: 'mcp',
      allow_http: true,
      request_signing: { transport: 'raw', allowLiveSideEffects: true, rateAbuseCap: cap },
    }
  );

  assert.strictEqual(result.skipped, undefined, 'the vector was dispatched');
  assert.strictEqual(seen, cap + 1, `expected ${cap} fills plus one probe, saw ${seen}`);
  assert.strictEqual(result.status, 401, 'the (cap+1) response really did carry the expected status');
  assert.strictEqual(result.probe_error, true, 'the cap-fill fault must reach the caller');
  assert.ok(result.error, 'a vector that cannot be graded must not report a clean pass');
  assert.match(result.error, /cap was never established/);
  assert.match(result.error, /cap-fill request 1 of 2 never completed/, 'the first fill failure is named');

  const faulted = { task: 'request_signing_probe', response: result };
  assert.strictEqual(
    signingCoverage([faulted]),
    'probe_errored',
    'a 401 carrying a transport fault is not evidence the verifier was exercised'
  );

  // …but a sibling vector that completed cleanly still counts, so one bad
  // pair cannot erase real coverage.
  const cleanWireProbe = { task: 'request_signing_probe', response: { status: 401, headers: {}, body: null } };
  assert.strictEqual(signingCoverage([faulted, cleanWireProbe]), 'graded');

  // The in-library self-check keeps its own classification either way.
  const selfCheck = { task: 'request_signing_probe', response: { status: 0, headers: {}, body: null } };
  assert.strictEqual(signingCoverage([selfCheck]), 'self_check_only');
  assert.strictEqual(signingCoverage([faulted, selfCheck]), 'probe_errored');
});

test('a rate-abuse run whose cap was established still passes', async t => {
  // False-negative guard for the rule above: when every fill completes, the
  // (cap+1) rejection is real evidence and the vector must pass exactly as
  // before — the new check keys on fill faults, not on the mere presence of
  // a limiter response.
  const http = require('node:http');
  const { signingCoverage } = require('../../dist/lib/testing/storyboard/runner.js');

  const cap = 2;
  let seen = 0;
  const server = http.createServer((req, res) => {
    seen += 1;
    if (seen <= cap) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    res.writeHead(401, {
      'content-type': 'application/json',
      'www-authenticate': 'Signature error="request_signature_rate_abuse"',
    });
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });

  const result = await probeRequestSigningVector(
    'negative-020-rate-abuse',
    `http://127.0.0.1:${server.address().port}/adcp`,
    {
      protocol: 'mcp',
      allow_http: true,
      request_signing: { transport: 'raw', allowLiveSideEffects: true, rateAbuseCap: cap },
    }
  );

  assert.strictEqual(seen, cap + 1);
  assert.strictEqual(result.status, 401);
  assert.strictEqual(result.probe_error, undefined, 'no fill faulted, so there is no transport fault to report');
  assert.strictEqual(result.error, undefined, 'the vector passed');
  assert.strictEqual(signingCoverage([{ task: 'request_signing_probe', response: result }]), 'graded');
});
