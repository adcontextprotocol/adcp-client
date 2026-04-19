/**
 * RFC 9421 request-signing conformance grader.
 *
 * Tests any agent advertising `request_signing.supported: true` against the
 * 28 conformance vectors shipped under
 * `compliance/cache/{version}/test-vectors/request-signing/`. Grading is
 * black-box and observable-behavior only — we construct signed HTTP requests
 * (dynamically, using the test keypairs in keys.json) and compare the
 * agent's responses to each vector's `expected_outcome`.
 *
 * @example
 * ```ts
 * import { gradeRequestSigning } from '@adcp/client/testing/storyboard/request-signing';
 *
 * const report = await gradeRequestSigning('https://sandbox.seller.com/adcp', {
 *   skipRateAbuse: true, // skip the 101-request flood in routine runs
 * });
 * if (!report.passed) {
 *   for (const r of [...report.positive, ...report.negative]) {
 *     if (!r.passed && !r.skipped) console.log(`${r.vector_id}: ${r.diagnostic}`);
 *   }
 * }
 * ```
 *
 * For storyboard-runner integration (synthesized per-vector steps dispatched
 * through `runStoryboard` / `runStoryboardStep`), see
 * `StoryboardRunOptions.request_signing` on the runner options.
 */

// ── Public API ────────────────────────────────────────────────────
// These are what 95% of consumers need. Start here.

export {
  gradeRequestSigning,
  gradeOneVector,
  type GradeOptions,
  type GradeReport,
  type VectorGradeResult,
} from './grader';

// ── Storyboard-runner hooks ───────────────────────────────────────
// Surfaces used internally by the runner; exported so external runners and
// custom harnesses can wire them the same way.

export {
  synthesizeRequestSigningSteps,
  parseRequestSigningStepId,
  REQUEST_SIGNING_PROBE_TASK,
  POSITIVE_STEP_PREFIX,
  NEGATIVE_STEP_PREFIX,
  type SynthesizeOptions,
} from './synthesize';

export { probeRequestSigningVector } from './probe-dispatch';

// ── Advanced: custom harness building blocks ──────────────────────
// Escape hatches for constructing custom graders (alternate probe transports,
// pre-flight staging, etc.). Most consumers should not need these.

export type {
  NegativeVector,
  PositiveVector,
  TestKeypair,
  TestKeyset,
  VectorRequest,
  VerifierCapabilityFixture,
  Vector,
  ContractId,
} from './types';

export { CONTRACT_IDS } from './types';

export { loadRequestSigningVectors, findKey, type LoadVectorsOptions, type LoadedVectors } from './vector-loader';

export {
  buildPositiveRequest,
  buildNegativeRequest,
  listSupportedNegativeVectors,
  type BuildOptions,
  type SignedHttpRequest,
} from './builder';

export {
  loadSignedRequestsRunnerContract,
  type LoadTestKitOptions,
  type RateAbuseContract,
  type ReplayWindowContract,
  type RevocationContract,
  type RunnerSigningKey,
  type SignedRequestsRunnerContract,
} from './test-kit';

export { probeSignedRequest, extractSignatureErrorCode, type ProbeOptions, type ProbeResult } from './probe';
