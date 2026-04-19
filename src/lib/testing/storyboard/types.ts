/**
 * Types for storyboard-driven testing.
 *
 * Storyboards are YAML-defined test workflows that walk through
 * AdCP agent interactions step by step. Each step maps to a
 * SingleAgentClient method and includes validations.
 */

import type { TestOptions } from '../types';

// ────────────────────────────────────────────────────────────
// Parsed storyboard structure (mirrors YAML schema)
// ────────────────────────────────────────────────────────────

export interface Storyboard {
  id: string;
  version: string;
  title: string;
  category: string;
  summary: string;
  narrative: string;
  /** Maps to a ComplianceTrack for comply() integration */
  track?: string;
  /**
   * AdCP spec version that introduced this storyboard, e.g. "3.1".
   * When set, the runner skips the storyboard for agents whose declared
   * `adcp.major_versions` does not include the major component — the
   * storyboard did not exist at the version the agent certified against.
   * Unset (the default) means the storyboard has always applied.
   */
  introduced_in?: string;
  /** Tools that make this storyboard applicable (at least one must be present) */
  required_tools?: string[];
  /** Scenario IDs that must pass alongside this storyboard (loaded from storyboards/scenarios/) */
  requires_scenarios?: string[];
  agent: {
    interaction_model: string;
    capabilities: string[];
    examples?: string[];
  };
  caller: {
    role: string;
    example?: string;
  };
  prerequisites?: {
    description: string;
    test_kit?: string;
  };
  phases: StoryboardPhase[];
}

export interface StoryboardPhase {
  id: string;
  title: string;
  narrative?: string;
  steps: StoryboardStep[];
  /** When true, the phase is allowed to be skipped without failing the storyboard. */
  optional?: boolean;
  /**
   * Skip expression evaluated against the runtime context. Current grammar:
   *   - `"!test_kit.auth.api_key"` — true when field is missing/falsy
   *   - `"test_kit.auth.api_key"`  — true when field is present/truthy
   * Other expressions are rejected (unknown → fail closed: phase runs).
   */
  skip_if?: string;
}

export interface ContextOutput {
  /** JSON path to extract from the response */
  path: string;
  /** Key to store the extracted value under in context */
  key: string;
}

export interface ContextInput {
  /** Key to look up in context */
  key: string;
  /** JSON path in the request to inject the value at */
  inject_at: string;
}

/**
 * Per-step authentication override. Lets a step probe the agent with
 * different credentials than the rest of the run — required for the
 * `security_baseline` storyboard's unauthenticated and invalid-key probes.
 */
export type StepAuthDirective =
  /** Strip transport credentials entirely. The step MUST hit the agent unauthenticated. */
  | 'none'
  | {
      type: 'api_key';
      /** Literal Bearer value sent as `Authorization: Bearer <value>`. */
      value?: string;
      /** Pull the value from the runtime `test_kit.auth.api_key` field. */
      from_test_kit?: boolean;
      /**
       * Runner-generated value. Current strategies:
       *   - `random_invalid` — `invalid-<32 hex bytes>`, fresh per run.
       */
      value_strategy?: 'random_invalid';
    }
  | {
      type: 'oauth_bearer';
      /** Literal Bearer value. */
      value?: string;
      /**
       * Runner-generated value. Current strategies:
       *   - `random_invalid_jwt` — three base64url segments; valid JSON header/payload, random signature.
       */
      value_strategy?: 'random_invalid_jwt';
    };

export interface StoryboardStep {
  id: string;
  title: string;
  narrative?: string;
  /**
   * AdCP task name (snake_case), e.g. "sync_accounts", "get_products".
   * May reference a test-kit field with `"$test_kit.<path>"` — the runner
   * resolves to the value at that path, or to `task_default` when the kit
   * doesn't supply the field.
   */
  task: string;
  /** Fallback task name when `task` is a `$test_kit.*` reference that resolves to null/undefined. */
  task_default?: string;
  schema_ref?: string;
  response_schema_ref?: string;
  doc_ref?: string;
  /** Maps to existing @adcp/client test scenario (legacy, partial coverage) */
  comply_scenario?: string;
  /** Whether this step depends on state from a previous step */
  stateful?: boolean;
  /** When true, the step passes if the task returns an error */
  expect_error?: boolean;
  /** Tool name required for this step to run. Skipped if agent lacks it. */
  requires_tool?: string;
  /** Explicit context extraction rules (supplements convention-based extractors) */
  context_outputs?: ContextOutput[];
  /** Explicit context injection rules (supplements $context.key placeholders) */
  context_inputs?: ContextInput[];
  expected?: string;
  sample_request?: Record<string, unknown>;
  sample_response?: Record<string, unknown>;
  validations?: StoryboardValidation[];
  /** Override auth for this step only (see `StepAuthDirective`). */
  auth?: StepAuthDirective;
  /** Contribute a flag to the run-level accumulator on success. Used with `any_of` validations downstream. */
  contributes_to?: string;
  /**
   * Conditional contribution expression. Current grammar:
   *   - `"prior_step.<step_id>.passed"` — contribution fires only if the named step passed.
   * Unknown expressions → the contribution does NOT fire (fail closed).
   */
  contributes_if?: string;
}

export type StoryboardValidationCheck =
  | 'response_schema'
  | 'field_present'
  | 'field_value'
  | 'status_code'
  | 'error_code'
  // HTTP-probe checks (for raw_probe tasks)
  | 'http_status'
  | 'http_status_in'
  | 'on_401_require_header'
  // Cross-cutting
  | 'resource_equals_agent_url'
  | 'any_of';

export interface StoryboardValidation {
  check: StoryboardValidationCheck;
  /** JSON path for field checks, e.g. "accounts[0].account_id" */
  path?: string;
  /** Expected value for exact-match checks. */
  value?: unknown;
  /** Accepted values for list-match checks (passes if actual matches any). */
  allowed_values?: unknown[];
  description: string;
}

/**
 * Raw HTTP probe result for tasks like `protected_resource_metadata` that
 * bypass the MCP transport. Carried through the runner alongside
 * `TaskResult` so validations like `http_status` and `on_401_require_header`
 * can introspect the response.
 */
export interface HttpProbeResult {
  url: string;
  status: number;
  /** Lowercased header names. */
  headers: Record<string, string>;
  /** Parsed JSON body when the response declared application/json; raw text otherwise. */
  body: unknown;
  /** Optional error — set when the fetch failed (network, SSRF guard, etc.). */
  error?: string;
  /**
   * Probe was intentionally skipped (e.g. operator opted out of a vector,
   * capability profile mismatch, or test-kit contract not in scope). When
   * set, the runner marks the step `skipped: true` and does NOT run
   * validations — skipped probes neither pass nor fail.
   */
  skipped?: boolean;
  skip_reason?: string;
}

// ────────────────────────────────────────────────────────────
// Context: accumulated state passed between steps
// ────────────────────────────────────────────────────────────

export type StoryboardContext = Record<string, unknown>;

// ────────────────────────────────────────────────────────────
// Options
// ────────────────────────────────────────────────────────────

export interface StoryboardRunOptions extends TestOptions {
  /** Initial context (e.g., from a previous step invocation) */
  context?: StoryboardContext;
  /** Override the step's sample_request with a custom request */
  request?: Record<string, unknown>;
  /** Agent's available tools (for requires_tool filtering) */
  agentTools?: string[];
  /**
   * Allow plain-http agent URLs during compliance runs. Normally rejected
   * because production agents MUST terminate TLS. Intended for local dev
   * loops (docker compose, localhost harnesses). Emits an advisory banner
   * in the report when used.
   */
  allow_http?: boolean;
  /**
   * Request-signing grader knobs (applied when the runner encounters
   * synthesized `request_signing_probe` steps from the signed-requests
   * specialism).
   */
  request_signing?: {
    /** Skip the rate-abuse vector — it sends cap+1 requests and is slow. */
    skipRateAbuse?: boolean;
    /** Override the per-keyid cap the grader targets. */
    rateAbuseCap?: number;
    /**
     * Vector IDs to skip (e.g., capability-profile mismatches for vectors
     * 007/018 when the agent's `covers_content_digest` policy differs).
     */
    skipVectors?: string[];
    /**
     * Run only the named vector ids — all others auto-skip. Takes precedence
     * over `skipVectors`.
     */
    onlyVectors?: string[];
    /**
     * Opt in to running vectors that produce live agent-side effects
     * (016 replay, 020 rate-abuse). Required unless the test-kit declares
     * `endpoint_scope: sandbox`.
     */
    allowLiveSideEffects?: boolean;
  };
  /**
   * Distribution strategy across agent URLs in multi-instance mode (#608).
   * Only consulted when the runner is given 2+ URLs. Defaults to 'round-robin'.
   * Reserved enum; additional strategies may land without a signature change.
   */
  multi_instance_strategy?: 'round-robin';
}

// ────────────────────────────────────────────────────────────
// Runner-output contract shapes
//
// See `static/compliance/source/universal/runner-output-contract.yaml`
// (adcontextprotocol/adcp PR #2364). The contract defines the minimum
// failure-result shape every AdCP compliance runner MUST emit so buyers
// can self-diagnose agent conformance failures. Optional fields stay
// `undefined` when they don't apply (e.g., schema_url on a non-schema
// check).
// ────────────────────────────────────────────────────────────

export type RunnerTransport = 'mcp' | 'a2a' | 'http';

export interface RunnerRequestRecord {
  transport: RunnerTransport;
  /** Task/tool/skill name actually invoked (after test-kit resolution). */
  operation: string;
  /** Fully-resolved JSON payload with secrets redacted as "[redacted]". */
  payload: unknown;
  /**
   * Observed request headers. Deliberately NOT populated today — the runner
   * builds `Authorization: Bearer <token>` headers in-flight and echoing them
   * into a shared compliance report would be a credential leak. The field is
   * kept in the type for future auth-override request captures that carry a
   * redacted form.
   */
  headers?: Record<string, string>;
  /** Full URL for http/a2a; omitted for stdio MCP. */
  url?: string;
}

export interface RunnerResponseRecord {
  transport: RunnerTransport;
  /** Exact response payload, per transport. */
  payload: unknown;
  /** HTTP status where applicable. */
  status?: number;
  /** Observed response headers. */
  headers?: Record<string, string>;
  /** Wall-clock time for the request. */
  duration_ms?: number;
}

/**
 * Which MCP extraction path produced the parsed response. Recording this
 * lets implementors distinguish runner extraction bugs from agent bugs.
 *
 *   - `structured_content` — the MCP SDK returned parsed structured data.
 *   - `text_fallback` — parsed from `result.content[].text` JSON. Reserved;
 *     the current SDK collapses structured vs text into a single
 *     `TaskResult.data` before the runner sees it, so this value is not
 *     yet emitted. Will be populated when extraction provenance is
 *     plumbed through `TaskResult`.
 *   - `error` — `result.isError` or transport-level failure; payload is the error.
 *   - `none` — no MCP response (HTTP-probe step, synthetic step, or skipped).
 */
export type RunnerExtractionPath = 'structured_content' | 'text_fallback' | 'error' | 'none';

export interface RunnerExtractionRecord {
  path: RunnerExtractionPath;
  /** Optional note, e.g. "structuredContent contained only adcp_error". */
  note?: string;
}

/**
 * Spec skip reasons. Runners MUST distinguish these so an implementor knows
 * whether a skip is informative (agent didn't claim the protocol) or masking
 * (runner couldn't apply the storyboard even though the agent claimed it).
 */
export type RunnerSkipReason =
  | 'not_applicable'
  | 'no_phases'
  | 'prerequisite_failed'
  | 'missing_tool'
  | 'missing_test_controller'
  | 'unsatisfied_contract';

/**
 * Grader-specific skip reasons. These are narrower than the six canonical
 * `RunnerSkipReason` values — they carry runner-local context (which probe,
 * which operator opt-out) that the contract neither requires nor forbids.
 * The runner records them on `skip_reason` for legacy consumers, and also
 * emits the structured `skip: RunnerSkipResult` block with the canonical
 * equivalent per `DETAILED_SKIP_TO_CANONICAL`.
 */
export type RunnerDetailedSkipReason =
  | 'probe_skipped'
  | 'rate_abuse_opt_out'
  | 'missing_test_kit_contract'
  | 'live_side_effect_opt_in_required'
  | 'operator_skip'
  | 'not_in_only_vectors'
  | 'grader_skipped';

/**
 * Map detailed grader skip reasons onto the six canonical spec values so
 * consumers reading `skip.reason` get a stable enum regardless of which
 * subsystem produced the skip.
 */
export const DETAILED_SKIP_TO_CANONICAL: Record<RunnerDetailedSkipReason, RunnerSkipReason> = {
  probe_skipped: 'not_applicable',
  not_in_only_vectors: 'not_applicable',
  grader_skipped: 'not_applicable',
  rate_abuse_opt_out: 'unsatisfied_contract',
  missing_test_kit_contract: 'unsatisfied_contract',
  live_side_effect_opt_in_required: 'unsatisfied_contract',
  operator_skip: 'unsatisfied_contract',
};

export interface RunnerSkipResult {
  reason: RunnerSkipReason;
  detail: string;
}

/**
 * Machine-readable Zod/AJV-style validation error. Emitted in
 * `ValidationResult.actual` for `response_schema` failures.
 */
export interface SchemaValidationError {
  instance_path: string;
  schema_path: string;
  keyword: string;
  message: string;
}

// ────────────────────────────────────────────────────────────
// Results
// ────────────────────────────────────────────────────────────

export interface ValidationResult {
  check: string;
  passed: boolean;
  description: string;
  /** Dot/bracket JSON path (legacy). See `json_pointer` for the RFC 6901 form. */
  path?: string;
  /** Human-readable failure detail. */
  error?: string;
  /** RFC 6901 pointer to the failing field. Null when the failure is transport-level. */
  json_pointer?: string | null;
  /** Machine-readable expected value / schema $id / acceptable forms. */
  expected?: unknown;
  /** Machine-readable actual value / schema errors / observed non-object. */
  actual?: unknown;
  /** Schema $id applied; set only for `response_schema`. */
  schema_id?: string | null;
  /** Resolvable schema URL; set only for `response_schema`. */
  schema_url?: string | null;
  /** Exact request the runner sent (present on failure when available). */
  request?: RunnerRequestRecord;
  /** Exact response observed (present on failure when available). */
  response?: RunnerResponseRecord;
  /** Optional remediation hint. */
  remediation?: string;
}

export interface StoryboardStepPreview {
  step_id: string;
  phase_id: string;
  title: string;
  task: string;
  narrative?: string;
  expected?: string;
  /** sample_request with context already injected */
  sample_request?: Record<string, unknown>;
}

export interface StoryboardStepResult {
  /** Storyboard that produced this step result. */
  storyboard_id?: string;
  step_id: string;
  phase_id: string;
  title: string;
  task: string;
  passed: boolean;
  /** True when the step was not executed */
  skipped?: boolean;
  /**
   * Skip reason. Accepts either a canonical `RunnerSkipReason` (the six
   * spec-required values) or one of the grader-specific variants introduced
   * by the RFC 9421 request-signing grader (#585). The structured `skip`
   * field below always carries the canonical spec reason so consumers of the
   * runner-output contract don't need to know the grader vocabulary.
   */
  skip_reason?: RunnerSkipReason | RunnerDetailedSkipReason;
  /** Structured skip result with canonical spec reason + human-readable detail. */
  skip?: RunnerSkipResult;
  /** True when the step expected an error (inverted pass/fail) */
  expect_error?: boolean;
  duration_ms: number;
  /** Raw parsed response body (legacy field; new code reads `response_record`). */
  response?: unknown;
  validations: ValidationResult[];
  /** Accumulated context after this step */
  context: StoryboardContext;
  error?: string;
  /** Preview of the next step (for LLM consumption) */
  next?: StoryboardStepPreview;
  /** Agent URL that served this step (multi-instance mode). Absent in single-URL mode. */
  agent_url?: string;
  /** 1-based index of the agent instance (multi-instance mode). Absent in single-URL mode. */
  agent_index?: number;
  /** Exact request the runner sent (contract-required on failures). */
  request?: RunnerRequestRecord;
  /** Exact response observed, including transport, status, headers. */
  response_record?: RunnerResponseRecord;
  /** Which extraction path produced the parsed response (required per contract). */
  extraction: RunnerExtractionRecord;
}

export interface StoryboardPhaseResult {
  phase_id: string;
  phase_title: string;
  passed: boolean;
  steps: StoryboardStepResult[];
  duration_ms: number;
}

export interface StoryboardResult {
  storyboard_id: string;
  storyboard_title: string;
  /** Primary agent URL. In multi-instance mode this is the first URL — see agent_urls for the full list. */
  agent_url: string;
  /** All agent URLs used in multi-instance mode. Absent (or single-entry) in single-URL mode. */
  agent_urls?: string[];
  /** Distribution strategy used across agent_urls. Absent in single-URL mode. */
  multi_instance_strategy?: 'round-robin';
  overall_passed: boolean;
  phases: StoryboardPhaseResult[];
  /** Final accumulated context */
  context: StoryboardContext;
  total_duration_ms: number;
  passed_count: number;
  failed_count: number;
  skipped_count: number;
  tested_at: string;
  /**
   * Schemas applied during this run. Per the runner-output contract, runners
   * MUST surface the exact schema identities so implementors can re-validate
   * locally against the same artifacts.
   */
  schemas_used?: Array<{ schema_id: string; schema_url: string }>;
}
