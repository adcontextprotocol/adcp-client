import { randomBytes } from 'crypto';
import { buildNegativeRequest, buildPositiveRequest, type BuildOptions, type SignedHttpRequest } from './builder';
import { probeSignedRequest, type ProbeResult } from './probe';
import { loadRequestSigningVectors, type LoadVectorsOptions } from './vector-loader';
import { loadSignedRequestsRunnerContract, type SignedRequestsRunnerContract } from './test-kit';
import {
  InMemoryReplayStore,
  InMemoryRevocationStore,
  RequestSignatureError,
  StaticJwksResolver,
  verifyRequestSignature,
  type AdcpJsonWebKey,
} from '../../../signing';
import type { NegativeVector, PositiveVector, VerifierCapabilityFixture } from './types';

export interface GradeOptions extends LoadVectorsOptions {
  /** Allow http:// and private-IP destinations. Off by default (match fetchProbe). */
  allowPrivateIp?: boolean;
  /** Skip the rate-abuse vector (it sends 100+ requests; slow). Defaults to false. */
  skipRateAbuse?: boolean;
  /**
   * Override the rate-abuse cap the grader targets. Defaults to the contract's
   * `grading_target_per_keyid_cap_requests`. Agents that advertise a smaller
   * per-keyid cap for the test counterparty MAY lower this so grading finishes
   * in a reasonable time — see test-kits/signed-requests-runner.yaml.
   */
  rateAbuseCap?: number;
  /**
   * Vector IDs to skip for operator-driven reasons (SDK-internal vectors,
   * environment-specific quirks, etc.). Capability-profile mismatches
   * don't belong here — pass {@link agentCapability} and the grader auto-
   * skips vectors whose `verifier_capability` can't match the agent.
   */
  skipVectors?: string[];
  /**
   * Agent's declared `request_signing` capability block — exactly the shape
   * in `get_adcp_capabilities.response.request_signing`. When provided, the
   * grader pre-flights every vector's `verifier_capability` against this
   * profile and auto-skips any vector that asserts a policy the agent
   * didn't advertise (e.g., vector 007 requires `covers_content_digest:
   * 'required'`; agent declares `'either'` — auto-skipped with
   * `skip_reason: 'capability_profile_mismatch'`).
   *
   * Without this option, every vector runs and cap-profile mismatches
   * produce failed vectors that the operator has to manually translate
   * into `skipVectors` entries — fragile and easy to get wrong per
   * profile. Set `agentCapability` and `skipVectors` collapses to just
   * the handful of operator-specific overrides (like vector 025, which
   * exercises the SDK library rather than the agent).
   */
  agentCapability?: VerifierCapabilityFixture;
  /**
   * When set, run only the named vector ids (all others auto-skip). Takes
   * precedence over `skipVectors`. Useful for isolated regression tests
   * against a single vector without hand-maintaining an inverted skip list.
   */
  onlyVectors?: string[];
  /**
   * Opt in to running vectors that produce live agent-side effects — vector
   * 016 (replay_window) sends a valid `create_media_buy`-shaped request the
   * agent will accept, and vector 020 (rate_abuse) floods cap+1 requests.
   * Required unless the test-kit contract declares `endpoint_scope: sandbox`
   * (in which case the agent asserts the operation is side-effect-free).
   * Default: false — side-effectful vectors auto-skip against non-sandbox
   * endpoints.
   */
  allowLiveSideEffects?: boolean;
  /**
   * Transport shape the agent speaks. `'raw'` (default) POSTs per-operation
   * AdCP endpoints matching the vectors' URL shape. `'mcp'` wraps each
   * vector body in a JSON-RPC `tools/call` envelope and POSTs to the MCP
   * mount path (`agentUrl`) — use when grading an MCP agent whose verifier
   * sits as transport-layer middleware ahead of MCP dispatch.
   *
   * See adcontextprotocol/adcp-client#612 for the MCP-mode rationale.
   */
  transport?: 'raw' | 'mcp';
  /**
   * Override the agent's base URL used for the grader's HTTP targets. When set,
   * each vector's `request.url` is rewritten by swapping origin+path under this
   * base — useful when the vectors point at `seller.example.com` but the agent
   * is reachable at a sandbox URL.
   */
  agentUrl?: string;
  /** Per-probe timeout. Default 10s. */
  timeoutMs?: number;
}

export interface VectorGradeResult {
  vector_id: string;
  kind: 'positive' | 'negative';
  passed: boolean;
  skipped?: boolean;
  skip_reason?: string;
  /** For negatives: the error code the agent returned (from WWW-Authenticate). */
  actual_error_code?: string;
  /** For negatives: the error code the spec says we should see. */
  expected_error_code?: string;
  http_status: number;
  diagnostic?: string;
  probe_duration_ms: number;
}

export interface GradeReport {
  agent_url: string;
  harness_mode: 'black_box';
  /**
   * `true` when the test-kit contract declares an endpoint_scope other than
   * `sandbox` — vectors 016 and 020 produce live side effects (a real
   * `create_media_buy` for 016, cap+1 flooding for 020). Treat as a warning
   * to the operator.
   */
  live_endpoint_warning: boolean;
  contract_loaded: boolean;
  positive: VectorGradeResult[];
  negative: VectorGradeResult[];
  passed: boolean;
  passed_count: number;
  failed_count: number;
  skipped_count: number;
  total_duration_ms: number;
}

/**
 * Grade an agent's RFC 9421 verifier against the 28 conformance vectors.
 *
 * Preconditions the caller owns:
 *   - Agent advertises `request_signing.supported: true` in `get_adcp_capabilities`.
 *   - Agent has pre-configured its verifier per `test-kits/signed-requests-runner.yaml`:
 *     - Runner's signing keyids (`test-ed25519-2026`, `test-es256-2026`) accepted.
 *     - `test-revoked-2026` pre-revoked.
 *     - Per-keyid rate cap within grading_target_per_keyid_cap_requests.
 *   - `agentUrl` targets a sandbox endpoint — the replay-window contract sends
 *     a live valid request that will be accepted before the second (rejected)
 *     copy fires.
 */
export async function gradeRequestSigning(agentUrl: string, options: GradeOptions = {}): Promise<GradeReport> {
  const start = Date.now();
  const loaded = loadRequestSigningVectors(options);
  const contract = loadSignedRequestsRunnerContract(options);

  const probeOpts = {
    allowPrivateIp: options.allowPrivateIp === true,
    timeoutMs: options.timeoutMs,
  };

  const buildOpts: BuildOptions = { baseUrl: agentUrl, transport: options.transport ?? 'raw' };

  const positive: VectorGradeResult[] = [];
  for (const vector of loaded.positive) {
    const skip = preflightSkip(vector, 'positive', contract, options);
    if (skip) {
      positive.push(skip);
      continue;
    }
    const signed = buildPositiveRequest(vector, loaded.keys, buildOpts);
    const probed = await probeSignedRequest(signed, probeOpts);
    positive.push(gradePositive(vector, probed));
  }

  const negative: VectorGradeResult[] = [];
  for (const vector of loaded.negative) {
    const skip = preflightSkip(vector, 'negative', contract, options);
    if (skip) {
      negative.push(skip);
      continue;
    }
    negative.push(await gradeNegative(vector, loaded, contract, probeOpts, buildOpts, options));
  }

  const all = [...positive, ...negative];
  const passed_count = all.filter(r => r.passed && !r.skipped).length;
  const skipped_count = all.filter(r => r.skipped).length;
  const failed_count = all.filter(r => !r.passed && !r.skipped).length;
  const passed = failed_count === 0;

  return {
    agent_url: agentUrl,
    harness_mode: 'black_box',
    // Default to TRUE when no contract is loaded — we can't prove the endpoint
    // is sandbox, so warn the operator that 016/020 could produce live side
    // effects. Only FALSE when a contract is loaded AND declares sandbox.
    live_endpoint_warning: !contract || contract.endpoint_scope !== 'sandbox',
    contract_loaded: Boolean(contract),
    positive,
    negative,
    passed,
    passed_count,
    failed_count,
    skipped_count,
    total_duration_ms: Date.now() - start,
  };
}

// Positive vectors whose edge-case coverage survives only under raw transport
// (per-operation endpoint URLs). Listed explicitly rather than heuristically
// so a spec author adding a new canonicalization-edge vector has to opt into
// the skip.
const MCP_FLATTENED_VECTORS = new Set([
  '005-default-port-stripped',
  '006-dot-segment-path',
  '007-query-byte-preserved',
  '008-percent-encoded-path',
]);

// Vectors whose failure mode can't reach a live agent through HTTP. Document
// why each entry can't be graded via probe so adding a new entry isn't a
// silent coverage loss.
const TRANSPORT_UNGRADABLE: Record<string, string> = {
  // fetch() and the Node URL parser normalize U-labels to A-labels before
  // the request leaves the client. A raw non-ASCII Host header reaches the
  // agent as Punycode, defeating the parse-time check. Direct verifier
  // tests exercise this edge.
  '026-non-ascii-host':
    'HTTP transport punycodes U-labels before the request leaves the client; verified at the library level.',
};

/**
 * Centralized skip decisions. Checks (in order): onlyVectors filter, operator
 * skipVectors, MCP-mode URL-edge flattening, rate-abuse opt-out,
 * stateful-contract missing, side-effect gate.
 */
function preflightSkip(
  vector: PositiveVector | NegativeVector,
  kind: 'positive' | 'negative',
  contract: SignedRequestsRunnerContract | undefined,
  options: GradeOptions
): VectorGradeResult | undefined {
  const expected_error_code = kind === 'negative' ? (vector as NegativeVector).expected_error_code : undefined;
  const base = {
    vector_id: vector.id,
    kind,
    passed: true, // skipped ≠ failed; overall pass/fail excludes skipped
    http_status: 0,
    probe_duration_ms: 0,
    ...(expected_error_code ? { expected_error_code } : {}),
  } as const;

  if (options.onlyVectors && !options.onlyVectors.includes(vector.id)) {
    return { ...base, skipped: true, skip_reason: 'not_in_only_vectors' };
  }
  if (options.skipVectors?.includes(vector.id)) {
    return { ...base, skipped: true, skip_reason: 'operator_skip' };
  }
  if (options.agentCapability) {
    const mismatch = capabilityMismatch(vector.verifier_capability, options.agentCapability);
    if (mismatch) {
      return {
        ...base,
        skipped: true,
        skip_reason: 'capability_profile_mismatch',
        diagnostic: mismatch,
      };
    }
  }
  const transportReason = TRANSPORT_UNGRADABLE[vector.id];
  if (transportReason) {
    return { ...base, skipped: true, skip_reason: 'transport_ungradable', diagnostic: transportReason };
  }
  // Canonicalization-edge positive vectors (005–008) bake their edge case
  // into the vector URL path, query, or port. MCP mode flattens every vector
  // to the same baseUrl (JSON-RPC single endpoint), so these vectors become
  // indistinguishable from vector 001 — passing under MCP is not evidence
  // the edge was tested. Skip with a distinct reason so the report doesn't
  // claim coverage it didn't deliver.
  if (kind === 'positive' && options.transport === 'mcp' && MCP_FLATTENED_VECTORS.has(vector.id)) {
    return {
      ...base,
      skipped: true,
      skip_reason: 'mcp_mode_flattens_url_edges',
      diagnostic:
        `Vector ${vector.id} tests a URL-canonicalization edge (port/path/query/encoding) ` +
        `that MCP mode neutralizes by routing every vector to the MCP endpoint. ` +
        `Grade this edge with \`--transport raw\` against a per-operation AdCP agent.`,
    };
  }
  if (kind === 'negative') {
    const neg = vector as NegativeVector;
    if (neg.requires_contract === 'rate_abuse' && options.skipRateAbuse) {
      return { ...base, skipped: true, skip_reason: 'rate_abuse_opt_out' };
    }
    if (neg.requires_contract && !contract) {
      return {
        ...base,
        skipped: true,
        skip_reason: 'missing_test_kit_contract',
        diagnostic:
          'Stateful vector requires `test-kits/signed-requests-runner.yaml` in the compliance cache. Run `npm run sync-schemas`.',
      };
    }
    // Sandbox opt-in: vectors 016 (replay_window) and 020 (rate_abuse) produce
    // live side effects on the agent. Refuse to run unless the contract says
    // sandbox OR the operator explicitly accepts the side effects.
    if (
      (neg.requires_contract === 'replay_window' || neg.requires_contract === 'rate_abuse') &&
      !options.allowLiveSideEffects &&
      contract?.endpoint_scope !== 'sandbox'
    ) {
      return {
        ...base,
        skipped: true,
        skip_reason: 'live_side_effect_opt_in_required',
        diagnostic:
          `Vector ${vector.id} produces live agent-side effects. Pass allowLiveSideEffects: true ` +
          `(or point the grader at an endpoint whose signed-requests-runner contract declares ` +
          `endpoint_scope: sandbox) to run it.`,
      };
    }
  }
  return undefined;
}

/**
 * Grade a single vector. Loads the vectors+keys+contract on every call; for
 * the storyboard-runner dispatch path where the caller runs many vectors in
 * sequence, prefer `gradeRequestSigning` which loads once.
 */
export async function gradeOneVector(
  vectorId: string,
  kind: 'positive' | 'negative',
  agentUrl: string,
  options: GradeOptions = {}
): Promise<VectorGradeResult> {
  const loaded = loadRequestSigningVectors(options);
  const contract = loadSignedRequestsRunnerContract(options);
  const probeOpts = {
    allowPrivateIp: options.allowPrivateIp === true,
    timeoutMs: options.timeoutMs,
  };
  const buildOpts: BuildOptions = { baseUrl: agentUrl, transport: options.transport ?? 'raw' };

  const vector =
    kind === 'positive' ? loaded.positive.find(v => v.id === vectorId) : loaded.negative.find(v => v.id === vectorId);
  if (!vector) throw new Error(`Unknown ${kind} vector "${vectorId}"`);

  const skip = preflightSkip(vector, kind, contract, options);
  if (skip) return skip;

  if (kind === 'positive') {
    const signed = buildPositiveRequest(vector as PositiveVector, loaded.keys, buildOpts);
    const probe = await probeSignedRequest(signed, probeOpts);
    return gradePositive(vector as PositiveVector, probe);
  }
  return gradeNegative(vector as NegativeVector, loaded, contract, probeOpts, buildOpts, options);
}

// ── Phase helpers ─────────────────────────────────────────────

function gradePositive(vector: PositiveVector, probe: ProbeResult): VectorGradeResult {
  const accepted = probe.status >= 200 && probe.status < 300;
  return {
    vector_id: vector.id,
    kind: 'positive',
    passed: accepted && !probe.error,
    http_status: probe.status,
    diagnostic: accepted ? undefined : buildPositiveDiagnostic(vector, probe),
    probe_duration_ms: probe.duration_ms,
  };
}

function buildPositiveDiagnostic(vector: PositiveVector, probe: ProbeResult): string {
  if (probe.error) return `probe error: ${probe.error}`;
  const expected = 'a 2xx status';
  const sigError = probe.wwwAuthenticateErrorCode;
  if (sigError) {
    return `expected ${expected}, got ${probe.status} with WWW-Authenticate error="${sigError}" — signer or agent-side JWKS likely mismatched. Vector: ${vector.name}`;
  }
  return `expected ${expected}, got ${probe.status}. Vector: ${vector.name}`;
}

async function gradeNegative(
  vector: NegativeVector,
  loaded: ReturnType<typeof loadRequestSigningVectors>,
  contract: SignedRequestsRunnerContract | undefined,
  probeOpts: { allowPrivateIp: boolean; timeoutMs?: number },
  buildOpts: BuildOptions,
  options: GradeOptions
): Promise<VectorGradeResult> {
  if (vector.jwks_override) {
    return gradeJwksOverrideNegative(vector);
  }
  switch (vector.requires_contract) {
    case 'replay_window':
      return gradeReplayWindow(vector, loaded, probeOpts, buildOpts);
    case 'rate_abuse':
      return gradeRateAbuse(vector, loaded, contract!, probeOpts, buildOpts, options);
    case 'revocation':
    default:
      return gradeStaticNegative(vector, loaded, probeOpts, buildOpts);
  }
}

/**
 * Grade vectors that ship an inline `jwks_override` against the library
 * verifier directly. The agent's JWKS can't be mutated per-vector at probe
 * time, so a black-box HTTP grade can't surface these failure modes.
 * Grading the library verifier is the only path that exercises what the
 * vector is testing — the inline JWK's kty/crv/alg consistency rules.
 */
async function gradeJwksOverrideNegative(vector: NegativeVector): Promise<VectorGradeResult> {
  const override = vector.jwks_override!;
  const start = Date.now();
  const jwks = new StaticJwksResolver(override.keys as unknown as AdcpJsonWebKey[]);
  const replayStore = new InMemoryReplayStore();
  const revocationStore = new InMemoryRevocationStore();
  const operation = new URL(vector.request.url).pathname.split('/').filter(Boolean).pop() ?? '';
  try {
    await verifyRequestSignature(vector.request, {
      capability: vector.verifier_capability,
      jwks,
      replayStore,
      revocationStore,
      now: () => vector.reference_now,
      operation,
    });
    return {
      vector_id: vector.id,
      kind: 'negative',
      passed: false,
      http_status: 0,
      expected_error_code: vector.expected_error_code,
      diagnostic: `library verifier accepted a request expected to fail with error="${vector.expected_error_code}"`,
      probe_duration_ms: Date.now() - start,
    };
  } catch (err) {
    if (err instanceof RequestSignatureError) {
      const passed = err.code === vector.expected_error_code;
      return {
        vector_id: vector.id,
        kind: 'negative',
        passed,
        http_status: 0,
        expected_error_code: vector.expected_error_code,
        actual_error_code: err.code,
        diagnostic: passed
          ? undefined
          : `library verifier rejected with error="${err.code}" but vector expects "${vector.expected_error_code}"`,
        probe_duration_ms: Date.now() - start,
      };
    }
    throw err;
  }
}

function gradeStaticNegative(
  vector: NegativeVector,
  loaded: ReturnType<typeof loadRequestSigningVectors>,
  probeOpts: { allowPrivateIp: boolean; timeoutMs?: number },
  buildOpts: BuildOptions
): Promise<VectorGradeResult> {
  const signed = buildNegativeRequest(vector, loaded.keys, buildOpts);
  return probeSignedRequest(signed, probeOpts).then(probe => ({
    vector_id: vector.id,
    kind: 'negative',
    passed: negativeAcceptedErrorCode(vector, probe),
    http_status: probe.status,
    expected_error_code: vector.expected_error_code,
    actual_error_code: probe.wwwAuthenticateErrorCode,
    diagnostic: buildNegativeDiagnostic(vector, probe),
    probe_duration_ms: probe.duration_ms,
  }));
}

async function gradeReplayWindow(
  vector: NegativeVector,
  loaded: ReturnType<typeof loadRequestSigningVectors>,
  probeOpts: { allowPrivateIp: boolean; timeoutMs?: number },
  buildOpts: BuildOptions
): Promise<VectorGradeResult> {
  // Build one valid signed request with a fixed nonce, then send it twice.
  const fixedNonce = randomBytes(16).toString('base64url');
  const signed = buildPositiveRequestFromNegative(vector, loaded, { ...buildOpts, nonce: fixedNonce });

  const first = await probeSignedRequest(signed, probeOpts);
  if (first.status < 200 || first.status >= 300) {
    return {
      vector_id: vector.id,
      kind: 'negative',
      passed: false,
      http_status: first.status,
      expected_error_code: vector.expected_error_code,
      actual_error_code: first.wwwAuthenticateErrorCode,
      diagnostic:
        `replay_window contract: first submission MUST be accepted but agent returned ${first.status}` +
        (first.wwwAuthenticateErrorCode ? ` (error="${first.wwwAuthenticateErrorCode}")` : '') +
        '. Check runner JWKS registration with the agent.',
      probe_duration_ms: first.duration_ms,
    };
  }

  const second = await probeSignedRequest(signed, probeOpts);
  return {
    vector_id: vector.id,
    kind: 'negative',
    passed: negativeAcceptedErrorCode(vector, second),
    http_status: second.status,
    expected_error_code: vector.expected_error_code,
    actual_error_code: second.wwwAuthenticateErrorCode,
    diagnostic: buildNegativeDiagnostic(vector, second),
    probe_duration_ms: first.duration_ms + second.duration_ms,
  };
}

async function gradeRateAbuse(
  vector: NegativeVector,
  loaded: ReturnType<typeof loadRequestSigningVectors>,
  contract: SignedRequestsRunnerContract,
  probeOpts: { allowPrivateIp: boolean; timeoutMs?: number },
  buildOpts: BuildOptions,
  options: GradeOptions
): Promise<VectorGradeResult> {
  const cap =
    options.rateAbuseCap ?? contract.stateful_vector_contract.rate_abuse.grading_target_per_keyid_cap_requests;
  // Fill the cap with cap distinct-nonce requests, then probe one more — that
  // (cap+1)th request is what the vector expects to be rejected.
  let durationMs = 0;
  for (let i = 0; i < cap; i++) {
    const nonce = randomBytes(16).toString('base64url');
    const signed = buildNegativeRequest(vector, loaded.keys, { nonce, ...buildOpts });
    const probe = await probeSignedRequest(signed, probeOpts);
    durationMs += probe.duration_ms;
  }
  const finalNonce = randomBytes(16).toString('base64url');
  const capPlusOne = buildNegativeRequest(vector, loaded.keys, { nonce: finalNonce, ...buildOpts });
  const probe = await probeSignedRequest(capPlusOne, probeOpts);
  durationMs += probe.duration_ms;
  return {
    vector_id: vector.id,
    kind: 'negative',
    passed: negativeAcceptedErrorCode(vector, probe),
    http_status: probe.status,
    expected_error_code: vector.expected_error_code,
    actual_error_code: probe.wwwAuthenticateErrorCode,
    diagnostic: buildNegativeDiagnostic(vector, probe),
    probe_duration_ms: durationMs,
  };
}

function buildPositiveRequestFromNegative(
  vector: NegativeVector,
  loaded: ReturnType<typeof loadRequestSigningVectors>,
  options: BuildOptions & { nonce: string }
): SignedHttpRequest {
  // Vector 016 is structurally identical to positive/001 — sign it as a positive.
  const pseudoPositive: PositiveVector = {
    kind: 'positive',
    id: vector.id,
    name: vector.name,
    reference_now: vector.reference_now,
    request: vector.request,
    verifier_capability: vector.verifier_capability,
    jwks_ref: vector.jwks_ref,
    jwks_override: vector.jwks_override,
  };
  return buildPositiveRequest(pseudoPositive, loaded.keys, options);
}

function negativeAcceptedErrorCode(vector: NegativeVector, probe: ProbeResult): boolean {
  return probe.status === 401 && probe.wwwAuthenticateErrorCode === vector.expected_error_code;
}

/**
 * Compare a vector's `verifier_capability` fixture against the agent's
 * declared capability profile. Returns a human-readable diagnostic when
 * the two can't coexist — the vector asserts a policy the agent didn't
 * advertise — or `undefined` when the vector is gradable under the
 * agent's profile.
 *
 * Rules (all three must hold for a graded run):
 *   - `covers_content_digest`: agent's `'either'` is permissive enough
 *     for any vector value. Otherwise, agent and vector must agree.
 *   - `required_for`: if the vector asserts a required_for operation,
 *     the agent's `required_for` must include it. The reverse is fine
 *     — an agent that requires MORE operations is still conformant
 *     against a vector that asserts fewer.
 *   - `supported`: must match. A vector with `supported: true` doesn't
 *     grade against an agent that declares `supported: false` (the
 *     conformance storyboard already skips such agents outright, but
 *     defense-in-depth).
 */
function capabilityMismatch(
  vectorCap: VerifierCapabilityFixture,
  agentCap: VerifierCapabilityFixture
): string | undefined {
  if (vectorCap.supported !== agentCap.supported) {
    return (
      `Vector asserts supported=${vectorCap.supported} but agent declares supported=${agentCap.supported}. ` +
      `Verify the agent's request_signing capability block.`
    );
  }
  if (
    vectorCap.covers_content_digest !== 'either' &&
    agentCap.covers_content_digest !== 'either' &&
    vectorCap.covers_content_digest !== agentCap.covers_content_digest
  ) {
    return (
      `Vector asserts covers_content_digest='${vectorCap.covers_content_digest}' but agent declares '${agentCap.covers_content_digest}'. ` +
      `The vector can't grade against this profile — its expected verifier behavior doesn't match what the agent implements.`
    );
  }
  // `required_for` on the vector: every op the vector expects to be
  // required must also be required by the agent. Otherwise a negative
  // vector (e.g., missing signature on `create_media_buy`) would test a
  // rejection path the agent didn't opt into.
  const vectorRequiredFor = vectorCap.required_for ?? [];
  const agentRequiredForSet = new Set(agentCap.required_for ?? []);
  const missingRequiredFor = vectorRequiredFor.filter(op => !agentRequiredForSet.has(op));
  if (missingRequiredFor.length > 0) {
    return (
      `Vector asserts required_for includes [${missingRequiredFor.join(', ')}] but agent's required_for does not. ` +
      `Either add the operation to the agent's request_signing.required_for, or accept the skip.`
    );
  }
  return undefined;
}

function buildNegativeDiagnostic(vector: NegativeVector, probe: ProbeResult): string | undefined {
  if (probe.error) return `probe error: ${probe.error}`;
  if (probe.status === 401 && probe.wwwAuthenticateErrorCode === vector.expected_error_code) {
    return undefined;
  }
  const actual = probe.wwwAuthenticateErrorCode ?? '(none)';
  if (probe.status !== 401) {
    return `expected 401 with error="${vector.expected_error_code}", got ${probe.status} (error="${actual}"). Vector: ${vector.name}`;
  }
  return `expected error="${vector.expected_error_code}", got error="${actual}". Check verifier step ordering — several vectors (015/017/020) depend on revocation/cap checks firing BEFORE crypto verify.`;
}
