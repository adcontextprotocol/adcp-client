/**
 * Grading of the A2A operation-resolution vectors (adcp#7945, GHSA-frxv-c96c-4vqw).
 *
 * `request_signing.required_for` matches the AdCP operation a verifier resolves
 * from the request. Over A2A that operation is the `skill` of the Message's sole
 * DataPart, not the JSON-RPC method (`SendMessage`, `message/send`, ...). A
 * verifier that matched only `tools/call` waved unsigned `create_media_buy`
 * through. These vectors grade that rule black-box, against a live agent.
 *
 * ## Why this is not routed through the official-client capture
 *
 * The root vectors are framed by `@a2a-js/sdk` (`a2a-dispatch.ts`) because the
 * request must be one a real buyer emits. These vectors are the opposite: the
 * defect under test lives IN the bytes (a duplicate DataPart, a case-variant
 * method, a batch array, a lone `Signature` header), and a well-behaved client
 * refuses to emit most of them. So each vector's body and headers go out
 * verbatim. Only the destination changes: the vector's URL is a placeholder, so
 * the request is retargeted at the agent's real JSON-RPC endpoint, discovered
 * from the agent card the same way the official-client path does. The four
 * signed vectors are re-signed against that real URL with the shared test key
 * (their recorded signatures are bound to the placeholder URL and cannot be
 * replayed).
 */

import { buildPositiveRequest, type SignedHttpRequest } from './builder';
import { probeSignedRequest, type ProbeOptions, type ProbeResult } from './probe';
import { resolveA2aDispatchTarget, resolveA2aHttpJsonEndpoint, type A2aDispatchOptions } from './a2a-dispatch';
import {
  A2A_VECTORS_UNAVAILABLE_MESSAGE,
  loadA2aOperationResolutionVectors,
  type A2aVectorSource,
} from './vector-loader';
import type { SignedRequestsRunnerContract } from './test-kit';
import type { GradeOptions, VectorGradeResult } from './grader';
import type {
  A2aNegativeVector,
  A2aPositiveVector,
  A2aVector,
  A2aVectorTier,
  PositiveVector,
  TestKeyset,
} from './types';

/** Id of the synthetic skipped row reported when no A2A vectors are available. */
export const A2A_UNAVAILABLE_ROW_ID = 'a2a/operation-resolution-vectors';

export interface A2aTierSummary {
  passed: number;
  failed: number;
  skipped: number;
  /** Ids of failed vectors in this tier. */
  failed_vectors: string[];
}

export interface A2aOperationResolutionSummary {
  /** `false` when the compliance bundle (and any override) carried no A2A vectors. */
  vectors_available: boolean;
  source: A2aVectorSource;
  source_dir?: string;
  /** Set when `vectors_available` is `false`: why nothing was graded. */
  message?: string;
  /**
   * Per-tier counts. `contradiction-resolution` is MUST for a 3.2 verifier;
   * `hardening` is SHOULD in 3.2.x and MUST from 3.3. Both count toward the
   * report's pass/fail; the split tells an operator which one failed.
   */
  tiers: Record<A2aVectorTier, A2aTierSummary>;
}

export interface A2aGradeOutcome {
  positive: VectorGradeResult[];
  negative: VectorGradeResult[];
  summary: A2aOperationResolutionSummary;
}

/**
 * Vectors whose comment names more than one conformant outcome. `negative/023`
 * (a JSON-RPC batch): a verifier without batch support rejects with
 * `request_body_malformed`; one that supports batches MUST resolve every element
 * and so demands a signature for the `create_media_buy` element.
 */
const ALTERNATE_ACCEPTED_CODES: Record<string, readonly string[]> = {
  'a2a/negative/023-batch-body': ['request_signature_required'],
};

function emptyTiers(): Record<A2aVectorTier, A2aTierSummary> {
  return {
    'contradiction-resolution': { passed: 0, failed: 0, skipped: 0, failed_vectors: [] },
    hardening: { passed: 0, failed: 0, skipped: 0, failed_vectors: [] },
  };
}

/**
 * Grade every A2A operation-resolution vector against *agentUrl*. Returns
 * `undefined` when the caller restricted the run (`onlyVectors`) to ids outside
 * this corpus, so a single-vector regression run is not buried in skip rows.
 */
export async function gradeA2aOperationResolution(
  agentUrl: string,
  keys: TestKeyset,
  contract: SignedRequestsRunnerContract | undefined,
  options: GradeOptions
): Promise<A2aGradeOutcome | undefined> {
  if (options.onlyVectors && !options.onlyVectors.some(id => id.startsWith('a2a/'))) return undefined;

  const loaded = loadA2aOperationResolutionVectors(options);
  const tiers = emptyTiers();
  if (loaded.source === 'none') {
    return {
      positive: [],
      negative: [
        {
          vector_id: A2A_UNAVAILABLE_ROW_ID,
          kind: 'negative',
          passed: true,
          skipped: true,
          skip_reason: 'a2a_vectors_unavailable',
          diagnostic: A2A_VECTORS_UNAVAILABLE_MESSAGE,
          http_status: 0,
          probe_duration_ms: 0,
        },
      ],
      summary: {
        vectors_available: false,
        source: 'none',
        message: A2A_VECTORS_UNAVAILABLE_MESSAGE,
        tiers,
      },
    };
  }

  const dispatchOptions: A2aDispatchOptions = {
    allowPrivateIp: options.allowPrivateIp === true,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.cardFetch ? { cardFetch: options.cardFetch } : {}),
  };
  const probeOptions: ProbeOptions = {
    allowPrivateIp: options.allowPrivateIp === true,
    timeoutMs: options.timeoutMs,
  };

  // Resolved lazily and once: only a vector that survives pre-flight needs the
  // card, and a run that skips everything never touches the network.
  let jsonRpcEndpoint: Promise<string> | undefined;
  const jsonRpc = () =>
    (jsonRpcEndpoint ??= resolveA2aDispatchTarget(agentUrl, dispatchOptions).then(target => target.endpoint));
  let httpJsonEndpoint: Promise<string | undefined> | undefined;
  const httpJson = () => (httpJsonEndpoint ??= resolveA2aHttpJsonEndpoint(agentUrl, dispatchOptions));

  const requiredFor = options.agentCapability?.required_for ?? options.agentRequiredFor;
  const protocolMethodsRequiredFor =
    options.agentCapability !== undefined
      ? (options.agentCapability.protocol_methods_required_for ?? [])
      : options.agentProtocolMethodsRequiredFor;
  const contentDigestPolicy = options.agentCapability?.covers_content_digest ?? options.agentContentDigestPolicy;

  const results: VectorGradeResult[] = [];
  const grade = async (vector: A2aVector): Promise<VectorGradeResult> => {
    const skip = preflightSkip(vector, {
      options,
      contract,
      requiredFor,
      protocolMethodsRequiredFor,
      contentDigestPolicy,
    });
    if (skip) return skip;

    let url: string;
    if (isHttpJsonBinding(vector)) {
      const base = await httpJson();
      if (!base) {
        return skipped(
          vector,
          'transport_ungradable',
          `Vector ${vector.id} grades the A2A HTTP+JSON binding (POST …/message:send), but the agent card declares no ` +
            `HTTP+JSON interface. An agent that does not serve that binding cannot be bypassed through it.`
        );
      }
      url = `${base.replace(/\/+$/, '')}/${lastPathSegment(vector.request.url)}`;
    } else {
      url = await jsonRpc();
    }

    const request = buildRequest(vector, url, keys);
    const probe = await probeSignedRequest(request, probeOptions);
    return vector.kind === 'positive' ? gradePositive(vector, probe) : gradeNegative(vector, probe);
  };

  for (const vector of [...loaded.positive, ...loaded.negative]) {
    const result = await grade(vector);
    results.push(result);
    const tier = tiers[vector.tier];
    if (result.skipped) tier.skipped++;
    else if (result.passed) tier.passed++;
    else {
      tier.failed++;
      tier.failed_vectors.push(vector.id);
    }
  }

  return {
    positive: results.filter(r => r.kind === 'positive'),
    negative: results.filter(r => r.kind === 'negative'),
    summary: {
      vectors_available: true,
      source: loaded.source,
      ...(loaded.sourceDir ? { source_dir: loaded.sourceDir } : {}),
      tiers,
    },
  };
}

// ── Pre-flight ────────────────────────────────────────────────

interface PreflightContext {
  options: GradeOptions;
  contract: SignedRequestsRunnerContract | undefined;
  requiredFor: readonly string[] | undefined;
  protocolMethodsRequiredFor: readonly string[] | undefined;
  contentDigestPolicy: 'required' | 'forbidden' | 'either' | undefined;
}

function skipped(vector: A2aVector, skip_reason: string, diagnostic?: string): VectorGradeResult {
  return {
    vector_id: vector.id,
    kind: vector.kind,
    tier: vector.tier,
    passed: true, // skipped is not failed; overall pass/fail excludes skipped
    skipped: true,
    skip_reason,
    ...(vector.kind === 'negative' && vector.expected_outcome.error_code
      ? { expected_error_code: vector.expected_outcome.error_code }
      : {}),
    ...(diagnostic ? { diagnostic } : {}),
    http_status: 0,
    probe_duration_ms: 0,
  };
}

function preflightSkip(vector: A2aVector, ctx: PreflightContext): VectorGradeResult | undefined {
  const { options } = ctx;
  if (options.onlyVectors && !options.onlyVectors.includes(vector.id)) {
    return skipped(vector, 'not_in_only_vectors');
  }
  if (options.skipVectors?.includes(vector.id)) return skipped(vector, 'operator_skip');

  const mismatch = capabilityMismatch(vector, ctx.requiredFor, ctx.protocolMethodsRequiredFor);
  if (mismatch) return skipped(vector, 'capability_profile_mismatch', mismatch);

  // A signed vector covers `content-digest`; a verifier that forbids it rejects
  // with `request_signature_components_unexpected` before the vector's own
  // assertion can fire.
  if (vector.kind === 'positive' && isSigned(vector) && ctx.contentDigestPolicy === 'forbidden') {
    return skipped(
      vector,
      'capability_profile_mismatch',
      `Vector ${vector.id} is signed with content-digest covered, but the agent declares covers_content_digest='forbidden'.`
    );
  }

  // A `verified` positive carries a valid signature over a real operation
  // (`create_media_buy`), so a correct agent runs it. Same sandbox contract as
  // vector 016 (replay_window).
  if (
    vector.kind === 'positive' &&
    vector.expected_outcome.status === 'verified' &&
    !options.allowLiveSideEffects &&
    ctx.contract?.endpoint_scope !== 'sandbox'
  ) {
    return skipped(
      vector,
      'live_side_effect_opt_in_required',
      `Vector ${vector.id} sends a validly signed ${vector.expected_outcome.resolved_operation ?? 'operation'} ` +
        `request the agent will accept and run. Pass allowLiveSideEffects: true (or point the grader at an endpoint ` +
        `whose signed-requests-runner contract declares endpoint_scope: sandbox) to run it.`
    );
  }
  return undefined;
}

/**
 * Skip a vector whose expected outcome depends on a `required_for` /
 * `protocol_methods_required_for` entry the agent did not advertise.
 *
 * - Negative expecting `request_signature_required`: it grades the operation
 *   (or, for `protocol_methods_required_for` vectors, the JSON-RPC method)
 *   being required. An agent that never opted in cannot be graded on it.
 * - Positive `unsigned`: asserts the operation is NOT required; against an
 *   agent that does require it, the 401 is correct behavior.
 * - Anything expecting `request_body_malformed` is always gradable: resolution
 *   rejects before any capability list is consulted.
 *
 * `undefined` capability lists mean "not declared by the caller": nothing is
 * excluded, matching the root grader.
 */
function capabilityMismatch(
  vector: A2aVector,
  requiredFor: readonly string[] | undefined,
  protocolMethodsRequiredFor: readonly string[] | undefined
): string | undefined {
  if (vector.kind === 'negative') {
    if (vector.expected_outcome.error_code !== 'request_signature_required') return undefined;
    const methods = vector.verifier_capability.protocol_methods_required_for ?? [];
    if (methods.length > 0) {
      if (!protocolMethodsRequiredFor) return undefined;
      const missing = methods.filter(m => !protocolMethodsRequiredFor.includes(m));
      return missing.length === 0
        ? undefined
        : `Vector asserts protocol_methods_required_for includes [${missing.join(', ')}] but the agent declares ` +
            `[${protocolMethodsRequiredFor.join(', ')}]. Add the method to request_signing.protocol_methods_required_for to grade it.`;
    }
    const operation = vector.expected_outcome.resolved_operation;
    if (!requiredFor || typeof operation !== 'string' || requiredFor.includes(operation)) return undefined;
    return (
      `Vector asserts ${operation} is in required_for but the agent declares required_for [${requiredFor.join(', ')}]. ` +
      `The vector tests a rejection path the agent has not opted into; add the operation to request_signing.required_for to grade it.`
    );
  }

  if (vector.expected_outcome.status !== 'unsigned') return undefined;
  const operation = vector.expected_outcome.resolved_operation;
  if (requiredFor && typeof operation === 'string' && requiredFor.includes(operation)) {
    return `Vector asserts ${operation} needs no signature, but the agent declares it in required_for.`;
  }
  const method = jsonRpcMethodOf(vector.request.body);
  if (protocolMethodsRequiredFor && method !== undefined && protocolMethodsRequiredFor.includes(method)) {
    return `Vector asserts an unsigned ${method} is accepted, but the agent declares ${method} in protocol_methods_required_for.`;
  }
  return undefined;
}

// ── Request construction ──────────────────────────────────────

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some(key => key.toLowerCase() === name);
}

/** A vector is signed when it carries a `Signature-Input` (018 has a lone `Signature` and is not). */
function isSigned(vector: A2aVector): boolean {
  return hasHeader(vector.request.headers, 'signature-input');
}

function isHttpJsonBinding(vector: A2aVector): boolean {
  try {
    return /(?:^|\/)message:(?:send|stream)$/.test(new URL(vector.request.url).pathname);
  } catch {
    return false;
  }
}

function lastPathSegment(url: string): string {
  return new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
}

function jsonRpcMethodOf(body: string | undefined): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const method = (parsed as { method?: unknown }).method;
      return typeof method === 'string' ? method : undefined;
    }
  } catch {
    // unparseable bodies carry no method
  }
  return undefined;
}

/**
 * The request for *vector* aimed at *url*: the vector's bytes verbatim, except
 * that a signed vector is re-signed over the real URL. Unsigned vectors (and
 * 018's lone `Signature` header) keep their headers untouched, so the single
 * defect under test is the one the fixture carries. Re-signing keeps the vector's
 * own headers, body, `A2A-Version` / `A2A-Extensions` and 3.2 wire profile; only
 * the signature fields, nonce and timestamps are fresh.
 */
function buildRequest(vector: A2aVector, url: string, keys: TestKeyset): SignedHttpRequest {
  const request = { ...vector.request, url, headers: { ...vector.request.headers } };
  if (!isSigned(vector)) return request;
  const asPositive: PositiveVector = {
    kind: 'positive',
    id: vector.id,
    name: vector.name,
    signing_profile_version: vector.signing_profile_version,
    reference_now: vector.reference_now,
    request,
    verifier_capability: vector.verifier_capability,
    jwks_ref: vector.jwks_ref,
  };
  return buildPositiveRequest(asPositive, keys, { transport: 'raw' });
}

// ── Verdicts ──────────────────────────────────────────────────

/** A 401 carrying a `WWW-Authenticate: Signature` challenge (with or without an `error` param). */
function isSignatureChallenge(probe: ProbeResult): boolean {
  if (probe.status !== 401) return false;
  if (probe.wwwAuthenticateErrorCode !== undefined) return true;
  return /(?:^|,)\s*Signature\b/i.test(probe.headers['www-authenticate'] ?? '');
}

function gradePositive(vector: A2aPositiveVector, probe: ProbeResult): VectorGradeResult {
  const rejected = isSignatureChallenge(probe);
  const passed = !probe.error && !rejected;
  let diagnostic: string | undefined;
  if (probe.error) diagnostic = `probe error: ${probe.error}`;
  else if (rejected) {
    const code = probe.wwwAuthenticateErrorCode ?? '(none)';
    diagnostic =
      vector.expected_outcome.status === 'verified'
        ? `expected the signed request to be accepted past the signature layer, got 401 with error="${code}". ` +
          `Check the grader test key is registered with the agent. Vector: ${vector.name}`
        : `expected no signature rejection (the resolved operation does not require one), got 401 with error="${code}". ` +
          `Vector: ${vector.name}`;
  }
  return {
    vector_id: vector.id,
    kind: 'positive',
    tier: vector.tier,
    passed,
    http_status: probe.status,
    probe_url: probe.url,
    ...(probe.wwwAuthenticateErrorCode ? { actual_error_code: probe.wwwAuthenticateErrorCode } : {}),
    ...(diagnostic ? { diagnostic } : {}),
    ...(probe.error !== undefined && { transport_error: true }),
    probe_duration_ms: probe.duration_ms,
  };
}

function gradeNegative(vector: A2aNegativeVector, probe: ProbeResult): VectorGradeResult {
  const expected = vector.expected_error_code;
  const accepted = [expected, ...(ALTERNATE_ACCEPTED_CODES[vector.id] ?? [])];
  const actual = probe.wwwAuthenticateErrorCode;
  const passed = !probe.error && probe.status === 401 && actual !== undefined && accepted.includes(actual);
  let diagnostic: string | undefined;
  if (!passed) {
    const wanted = accepted.map(code => `"${code}"`).join(' or ');
    if (probe.error) diagnostic = `probe error: ${probe.error}`;
    else if (probe.status !== 401) {
      diagnostic =
        `expected 401 with error=${wanted}, got ${probe.status}. The request reached the agent's dispatcher: the ` +
        `verifier did not resolve the operation from the A2A DataPart skill (GHSA-frxv-c96c-4vqw). Vector: ${vector.name}`;
    } else {
      diagnostic = `expected error=${wanted}, got error="${actual ?? '(none)'}". Vector: ${vector.name}`;
    }
  }
  return {
    vector_id: vector.id,
    kind: 'negative',
    tier: vector.tier,
    passed,
    http_status: probe.status,
    probe_url: probe.url,
    expected_error_code: expected,
    ...(actual ? { actual_error_code: actual } : {}),
    ...(diagnostic ? { diagnostic } : {}),
    ...(probe.error !== undefined && { transport_error: true }),
    probe_duration_ms: probe.duration_ms,
  };
}
