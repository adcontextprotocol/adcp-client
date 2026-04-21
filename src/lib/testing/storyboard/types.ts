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
  /**
   * First-class branch-set declaration (see adcp#2633 / adcp#2646). When
   * present, contributing steps inside this phase MAY use the boolean
   * shorthand `contributes: true` in lieu of repeating `contributes_to: <id>`.
   * The loader resolves the shorthand to `branch_set.id` at parse time, so
   * downstream runner code continues to read `step.contributes_to`.
   */
  branch_set?: BranchSetSpec;
}

export interface BranchSetSpec {
  /** Aggregation flag shared by every contributing step in this phase. */
  id: string;
  /**
   * Grading semantics for the branch set. `any_of` (the only value defined
   * today) means: at most one peer branch is expected to contribute; failures
   * in non-contributing peers grade as `peer_branch_taken` rather than
   * `failed`. Kept as a string so future semantics (`all_of`, `one_of`) do
   * not require a type change.
   */
  semantics: string;
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
  /**
   * When true, suppress the runner's `idempotency_key` auto-injection on a
   * mutating step so the storyboard can exercise the server's missing-key
   * rejection path. The runner also disables the SDK's client-side
   * auto-inject for this step so the request reaches the wire without a key.
   *
   * Default (false) matches buyer-agent behavior: every mutating request
   * carries a fresh UUID v4 so handlers under test run against the actual
   * error path the storyboard names (GOVERNANCE_DENIED, UNAUTHORIZED, etc.)
   * rather than short-circuiting on `INVALID_REQUEST: idempotency_key`.
   */
  omit_idempotency_key?: boolean;
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
   * Boolean shorthand for `contributes_to: <enclosing phase's branch_set.id>`.
   * Only legal inside a phase that declares `branch_set:`. The loader
   * resolves `contributes: true` to the phase's `branch_set.id` and clears
   * this field, so runner code reads `contributes_to` exclusively.
   * `contributes: false` (or absent) marks a non-contributing step.
   * Declaring both `contributes` and `contributes_to` on the same step is a
   * parse-time authoring error.
   */
  contributes?: boolean;
  /**
   * Conditional contribution expression. Current grammar:
   *   - `"prior_step.<step_id>.passed"` — contribution fires only if the named step passed.
   * Unknown expressions → the contribution does NOT fire (fail closed).
   */
  contributes_if?: string;
  // ──────────────────────────────────────────────────────────
  // Webhook-assertion step fields (only used when task is one
  // of `expect_webhook`, `expect_webhook_retry_keys_stable`,
  // `expect_webhook_signature_valid`). The runner interprets
  // these pseudo-tasks as receiver observations, not agent calls.
  // ──────────────────────────────────────────────────────────
  /**
   * Step id of the earlier step whose task triggered the webhook under
   * observation. Used by compliance reports for attribution and (when the
   * trigger step failed / skipped) to gate the assertion skip.
   */
  triggered_by?: string;
  /** Match predicate scoped to the per-step URL and/or body fields. */
  filter?: WebhookFilterSpec;
  /** Seconds to wait for the first matching delivery. Default 30. */
  timeout_seconds?: number;
  /** When true (default) assert `idempotency_key` is present and pattern-valid. */
  expect_idempotency_key?: boolean;
  /** Optional webhook schema reference; validates the parsed body. */
  response_schema_webhook_ref?: string;
  /**
   * Cap on the number of distinct logical webhook events (grouped by
   * idempotency_key) delivered within the timeout window. Typical use:
   * `1` on the replay-side-effect invariant to catch publishers that
   * re-execute on replay and emit a second webhook under a fresh key.
   */
  expect_max_deliveries_per_logical_event?: number;
  /**
   * Test-kit contract id this assertion depends on. When the contract is
   * not in scope the step grades `not_applicable` rather than failing —
   * lets cross-cutting storyboards (idempotency, governance) reference
   * webhook assertions without forcing every runner to host a receiver.
   */
  requires_contract?: string;
  /** Retry-replay config for `expect_webhook_retry_keys_stable`. */
  retry_trigger?: WebhookRetryTriggerSpec;
  /** Min deliveries to observe for `expect_webhook_retry_keys_stable`. Default 2. */
  expect_min_deliveries?: number;
  /** Signature-tag sanity check for `expect_webhook_signature_valid`. Default `adcp/webhook-signing/v1`. */
  require_tag?: string;
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
  | 'any_of'
  // Cross-step checks
  | 'refs_resolve';

/**
 * Set of references for `refs_resolve`. `from` picks the root object —
 * `current_step` reads the step's task-result `data`; `context` reads the
 * accumulated `StoryboardContext`. `path` supports `[*]` wildcard segments
 * that flatten into the aggregated result (so `products[*].format_ids[*]`
 * walks every product and flattens every `format_ids` array).
 */
export interface RefsResolveSet {
  from: 'current_step' | 'context';
  path: string;
}

/**
 * Scope filter for `refs_resolve`. Only source refs whose `key` equals
 * (after `$agent_url` substitution + `normalizeAgentUrl` normalization)
 * are in scope. Out-of-scope refs are graded by `on_out_of_scope`.
 */
export interface RefsResolveScope {
  key: string;
  /** String to compare against. `$agent_url` expands to the runner target URL. */
  equals: string;
}

export interface StoryboardValidation {
  check: StoryboardValidationCheck;
  /** JSON path for field checks, e.g. "accounts[0].account_id" */
  path?: string;
  /** Expected value for exact-match checks. */
  value?: unknown;
  /** Accepted values for list-match checks (passes if actual matches any). */
  allowed_values?: unknown[];
  description: string;
  // ─── refs_resolve fields ───────────────────────────────────
  /** Source refs (the refs being checked). */
  source?: RefsResolveSet;
  /** Target refs (the set the source refs must resolve into). */
  target?: RefsResolveSet;
  /** Keys to compare between each source ref and each target ref. */
  match_keys?: string[];
  /** Only enforce integrity for refs matching this scope. */
  scope?: RefsResolveScope;
  /**
   * How to grade source refs that fall outside `scope`.
   *  - `warn` (default) — attach observations, pass the check
   *  - `ignore` — silent, pass the check
   *  - `fail` — treat as missing
   */
  on_out_of_scope?: 'warn' | 'ignore' | 'fail';
}

// ────────────────────────────────────────────────────────────
// Webhook-assertion step types
//
// The three `expect_webhook*` tasks are pseudo-tasks: they do not drive the
// agent over MCP. Instead the runner uses them to observe / assert on the
// webhook deliveries a prior step triggered. Graded only when the storyboard
// declares the `webhook_receiver_runner` contract and the runner hosts a
// receiver. Spec: adcontextprotocol/adcp#2431.
// ────────────────────────────────────────────────────────────

/** Webhook-body match predicate. Dotted paths, deep equality. */
export interface WebhookFilterSpec {
  /** Match by `operation_id` echoed in the per-step URL path. */
  operation_id?: string;
  /** Match by dotted-path → value deep equality against the parsed body. */
  body?: Record<string, unknown>;
}

/** Receiver behavior that forces the sender to retry so retry-stability can be graded. */
export interface WebhookRetryTriggerSpec {
  /** How many deliveries to reject before accepting. Default 3. */
  count?: number;
  /** HTTP status code to return for the rejected deliveries. Default 503. */
  http_status?: number;
}

/**
 * Error codes per spec (webhook-emission universal, storyboard-schema.yaml).
 *
 * Signature-path codes track the verifier's `webhook_signature_*` taxonomy
 * 1:1 so compliance reports distinguish remediation paths: a revoked key
 * needs rotation; a rate-abuse hit signals a compromised key; a
 * window-invalid is a signer clock/config bug. Spec folds every window
 * failure into a single `signature_window_invalid` — there is no
 * `signature_expired`.
 */
export type WebhookAssertionErrorCode =
  // expect_webhook
  | 'no_webhook_received'
  | 'schema_violation'
  | 'missing_idempotency_key'
  | 'invalid_idempotency_key_format'
  | 'duplicate_webhook_on_replay'
  // expect_webhook_retry_keys_stable
  | 'insufficient_retries'
  | 'idempotency_key_rotated'
  | 'idempotency_key_format_changed'
  // expect_webhook_signature_valid
  | 'signature_invalid'
  | 'signature_window_invalid'
  | 'signature_alg_not_allowed'
  | 'signature_components_incomplete'
  | 'signature_header_malformed'
  | 'signature_params_incomplete'
  | 'signature_key_unknown'
  | 'signature_key_purpose_invalid'
  | 'signature_mode_mismatch'
  | 'signature_target_uri_malformed'
  | 'signature_key_revoked'
  | 'signature_revocation_stale'
  | 'signature_rate_abuse'
  | 'signature_digest_mismatch'
  | 'signature_tag_invalid'
  | 'signature_replayed';

/**
 * Spec pattern for webhook `idempotency_key`: 16–255 chars of base64url-safe
 * punctuation. Shared by all three assertion step types; exported so callers
 * (tests, tooling) can reproduce the grader's exact validation.
 */
export const WEBHOOK_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{16,255}$/;

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
    /**
     * How the grader dispatches each vector to the agent.
     *
     *   - `raw` (default) — POSTs each vector body directly to a per-
     *     operation AdCP endpoint (e.g. `<baseUrl>/create_media_buy`).
     *     Works for agents that expose AdCP tools as discrete HTTP
     *     operations.
     *   - `mcp` — wraps each vector body in a JSON-RPC `tools/call`
     *     envelope and POSTs to the agent's single `/mcp` mount. Required
     *     for MCP-only agents that don't expose per-operation endpoints.
     *     The operation name is derived from the last path segment of the
     *     vector's target URL.
     *
     * Matches the `adcp grade request-signing --transport <mode>` CLI flag.
     * Agents that only speak MCP JSON-RPC can't grade under `raw`; use
     * `mcp` to let the runner round-trip every vector through `tools/call`.
     */
    transport?: 'raw' | 'mcp';
  };
  /**
   * Distribution strategy across agent URLs in multi-instance mode.
   * Only consulted when the runner is given 2+ URLs. Defaults to 'round-robin'.
   *
   *  - `round-robin` (default): step N hits `urls[N % urls.length]`. One pass.
   *  - `multi-pass` (narrow use case): runs the storyboard `urls.length`
   *    times, each pass starting the dispatcher at a different replica.
   *    Surfaces single-replica bugs (stale config, divergent version,
   *    local-cache miss) that single-pass round-robin may not catch when
   *    the buggy replica happens to serve only passive steps. N-multiplies
   *    run time. NOT a full cross-replica state-persistence test at N=2:
   *    offset-shift preserves pair parity, so write→read pairs with even
   *    dispatch-index distance (e.g., the property_lists case: write at 0,
   *    read at 2) land same-replica in every pass. Use single-pass
   *    round-robin (adjacent pairs) + follow-up dependency-aware dispatch
   *    (non-adjacent pairs, #607 option 2) for the spec's horizontal-
   *    scaling requirement. See docs/guides/MULTI-INSTANCE-TESTING.md.
   */
  multi_instance_strategy?: 'round-robin' | 'multi-pass';
  /**
   * Host an ephemeral webhook receiver during the run so `expect_webhook*`
   * pseudo-steps can observe outbound webhooks from the agent under test.
   * Enables the `webhook_receiver_runner` contract referenced by the
   * `webhook-emission` universal (adcontextprotocol/adcp#2431).
   *
   * When enabled, storyboards can substitute `{{runner.webhook_base}}` and
   * `{{runner.webhook_url:<step_id>}}` into `push_notification_config.url`
   * and downstream `expect_webhook*` steps observe the deliveries.
   *
   * Mode selection matches the spec's `endpoint_modes`:
   *   - `loopback_mock` (default): bind an HTTP listener on loopback; URLs
   *     point at `http://127.0.0.1:<port>`. Zero external network setup.
   *     Suitable for CI lint gates, SDK self-tests, and local dev.
   *   - `proxy_url`: operator-supplied public URL (tunnel / ingress) routes
   *     to a local HTTP listener on the configured port. Suitable for AdCP
   *     Verified grading where the agent under test is remote.
   */
  webhook_receiver?: {
    /** Endpoint mode (default: `loopback_mock`). */
    mode?: 'loopback_mock' | 'proxy_url';
    /** Bind host for the local listener. Defaults to `127.0.0.1`. */
    host?: string;
    /** Bind port. `0` (default) lets the kernel assign one. */
    port?: number;
    /**
     * Public URL to advertise when `mode: 'proxy_url'`. Must terminate at
     * the local listener on `port`. Stored verbatim; the runner does not
     * validate reachability.
     */
    public_url?: string;
  };
  /**
   * Test-kit contract ids that are in scope for this run. A step with
   * `requires_contract: <id>` grades `not_applicable` when the id is not
   * listed here. Storyboards that assert webhook behavior typically declare
   * `webhook_receiver_runner`.
   */
  contracts?: string[];
  /**
   * Dependencies for `expect_webhook_signature_valid`. When omitted the step
   * grades `not_applicable` — matches the spec's "pending" gate. Supply the
   * publisher's JWKS resolver (typically fetched via `brand.json`
   * `agents[]` `jwks_uri`) to turn the step on. The two optional stores
   * default to process-local in-memory implementations; override when the
   * runner needs durable state across runs.
   */
  webhook_signing?: {
    jwks: import('../../signing/jwks').JwksResolver;
    replayStore?: import('../../signing/replay').ReplayStore;
    revocationStore?: import('../../signing/revocation').RevocationStore;
    /** Override the required tag. Defaults to `adcp/webhook-signing/v1`. */
    required_tag?: string;
  };
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
 * Populated by the response unwrapper (normal SDK path) and by the raw MCP
 * probe (auth-override path); the runner falls back to inference when the
 * provenance tag is missing.
 *
 *   - `structured_content` — parsed from `result.structuredContent`.
 *   - `text_fallback` — parsed from `result.content[].text` JSON.
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
  | 'unsatisfied_contract'
  /**
   * A peer optional phase in the same `branch_set` already contributed the
   * aggregation flag, so this non-chosen branch's failing steps are moot
   * (see storyboard-schema.yaml > "Per-step grading in any_of branch
   * patterns" and runner-output-contract.yaml). Kept distinct from
   * `not_applicable` (coverage gap) and raw `failed` (agent misbehavior).
   */
  | 'peer_branch_taken';

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
  | 'grader_skipped'
  /** Request-signing grader's MCP-transport mode collapses URL-edge vectors (#617). */
  | 'mcp_mode_flattens_url_edges'
  /** RFC 9728 protected-resource metadata returned 404 → agent is not advertising OAuth, cascade-skip oauth_discovery (#677). */
  | 'oauth_not_advertised';

/**
 * Map detailed grader skip reasons onto the six canonical spec values so
 * consumers reading `skip.reason` get a stable enum regardless of which
 * subsystem produced the skip.
 */
export const DETAILED_SKIP_TO_CANONICAL: Record<RunnerDetailedSkipReason, RunnerSkipReason> = {
  probe_skipped: 'not_applicable',
  not_in_only_vectors: 'not_applicable',
  grader_skipped: 'not_applicable',
  mcp_mode_flattens_url_edges: 'not_applicable',
  oauth_not_advertised: 'not_applicable',
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
  /**
   * Non-fatal notes emitted by the check — e.g. `refs_resolve` records the
   * out-of-scope refs it skipped when `on_out_of_scope: warn`. Present only
   * when the check has something to report; absent otherwise.
   */
  observations?: unknown[];
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
   * by the RFC 9421 request-signing grader (#585, #617). The structured
   * `skip` field below always carries the canonical spec reason so consumers
   * of the runner-output contract don't need to know the grader vocabulary.
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
  multi_instance_strategy?: 'round-robin' | 'multi-pass';
  overall_passed: boolean;
  /**
   * Phases from the first pass. In `multi-pass` mode see `passes` for the full
   * per-pass detail; `passed_count`/`failed_count`/`skipped_count` and
   * `overall_passed` aggregate across all passes.
   */
  phases: StoryboardPhaseResult[];
  /**
   * Per-pass detail in `multi-pass` mode — one entry per starting replica so
   * each step is served by each replica at least once across passes. Absent
   * in single-pass modes. Per-pair cross-replica coverage depends on
   * dispatch-index distance modulo `agent_urls.length` (see
   * `multi_instance_strategy` on `StoryboardRunOptions`).
   */
  passes?: StoryboardPassResult[];
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

/**
 * Single pass in `multi-pass` multi-instance mode. Each pass re-runs the
 * whole storyboard with a different round-robin starting offset so each
 * step is served by each replica at least once across passes. See
 * `multi_instance_strategy` on `StoryboardRunOptions` for the N=2
 * per-pair coverage caveat.
 */
export interface StoryboardPassResult {
  /** 1-based pass index. */
  pass_index: number;
  /** 0-based starting replica for this pass's round-robin dispatch. */
  dispatch_offset: number;
  overall_passed: boolean;
  phases: StoryboardPhaseResult[];
  passed_count: number;
  failed_count: number;
  skipped_count: number;
  duration_ms: number;
}
