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
    /**
     * When true and the storyboard carries a top-level `fixtures:` block,
     * the runner fires `comply_test_controller` seed_* calls for each fixture
     * entry before phase 1. Spec: adcontextprotocol/adcp#2585 (fixtures block)
     * + adcontextprotocol/adcp#2584 (seed_* scenarios). Opts-out per run via
     * `StoryboardRunOptions.skip_controller_seeding` (for agents that seed via
     * tests or HTTP admin rather than the MCP controller).
     */
    controller_seeding?: boolean;
  };
  /**
   * Fixture entries consumed by the runner's pre-flight controller seeding
   * (see `prerequisites.controller_seeding`). Each entry is split into id
   * params + a `fixture` body before being issued as a `seed_*` scenario on
   * `comply_test_controller`. Entries are spec-shaped objects drawn from the
   * source storyboard YAML; the runner preserves every field besides the id
   * field(s) into `params.fixture` verbatim.
   */
  fixtures?: StoryboardFixtures;
  phases: StoryboardPhase[];
  /**
   * Cross-step assertions that apply to this storyboard. Every assertion
   * registered with `default: true` (the bundled set: `status.monotonic`,
   * `idempotency.conflict_no_payload_leak`, `context.no_secret_echo`,
   * `governance.denial_blocks_mutation`) runs by default — omit the field
   * entirely and the full default set applies. Per-step checks live inline
   * on steps; assertions encode specialism- or protocol-wide properties
   * that must hold across the full run.
   *
   * Three shapes are accepted:
   *   - `undefined` (or field omitted) — run every default-on assertion.
   *   - `string[]` — legacy additive form. Defaults still run; any ids in
   *     the list register on top for storyboards that want extra non-default
   *     assertions registered by the consumer. Every id MUST resolve.
   *   - `{ disable?: string[]; enable?: string[] }` — object form. `disable`
   *     removes default-on assertions by id (typo-guarded: unknown ids throw
   *     at runner start); `enable` adds non-default assertions registered by
   *     the consumer on top.
   *
   * See `./assertions.ts` for the registry API and `./default-invariants.ts`
   * for the bundled set.
   */
  invariants?: StoryboardInvariants;
}

/**
 * Storyboard-level invariants declaration. `undefined` / array / object
 * shapes all map onto the same "resolve to AssertionSpec[]" path in
 * `resolveAssertions(...)`. See `Storyboard.invariants` for the full
 * semantics (bundled defaults are always applied unless explicitly
 * disabled via the object form).
 */
export type StoryboardInvariants = string[] | StoryboardInvariantsObject;

export interface StoryboardInvariantsObject {
  /**
   * Default-on assertion ids to suppress for this storyboard. Each id MUST
   * match an assertion registered with `default: true` — an unknown or
   * non-default id is a typo and fails fast at runner start rather than
   * silently no-opping (which would mask genuine coverage gaps).
   */
  disable?: string[];
  /**
   * Additional (non-default) assertion ids to enable for this storyboard on
   * top of the default-on set. Consumers use this to attach custom
   * assertions they've registered via `registerAssertion(...)`. Every id
   * MUST resolve; unknown ids fail fast at runner start.
   */
  enable?: string[];
}

/**
 * Per-step invariant opt-out. Mirrors `StoryboardInvariantsObject.disable`
 * but scoped to a single step — the runner skips calling the named
 * assertions' `onStep` for that step only. Use when a step deliberately
 * models behavior a default invariant would otherwise flag (e.g. a
 * `check_governance` 200 `status: denied` setting up a buyer-recovery
 * sequence that the `governance.denial_blocks_mutation` invariant would
 * anchor).
 *
 * Step-level is narrower on purpose — there is no `enable`. Enabling an
 * assertion for a single step makes no sense at this scope (assertions
 * reason across steps), and disallowing it at the type level removes a
 * footgun. Only `disable` is accepted.
 *
 * Every id in `disable` MUST be in the assertion set resolved for this
 * run. An unknown id, or an id already suppressed storyboard-wide, is
 * dead code and fails fast at runner start rather than silently no-op.
 *
 * Semantics for stateful invariants: disable means the invariant does
 * not OBSERVE the step. Invariants that accumulate per-step state
 * (e.g. `status.monotonic`'s last-observed transition anchor) will
 * therefore miss any observation the disabling step would have
 * contributed. That's the point for `governance.denial_blocks_mutation`
 * (a deliberate setup is not an anchor); for accumulator-style
 * invariants, prefer disabling run-wide if the missed observation
 * would hide later violations.
 */
export interface StepInvariantsObject {
  disable?: string[];
}

/**
 * Fixture entries the runner seeds into the seller via `comply_test_controller`
 * pre-flight (adcp#2585, adcp#2743). Each array entry carries its id field(s)
 * alongside the body the runner forwards into `params.fixture` for the
 * corresponding `seed_*` scenario.
 *
 *   - `products[]`      → `seed_product`         — requires `product_id`
 *   - `pricing_options[]` → `seed_pricing_option` — requires `product_id` + `pricing_option_id`
 *   - `creatives[]`     → `seed_creative`        — requires `creative_id`
 *   - `plans[]`         → `seed_plan`            — requires `plan_id`
 *   - `media_buys[]`    → `seed_media_buy`       — requires `media_buy_id`
 *
 * Every other field on the entry is forwarded verbatim as `params.fixture`.
 * Entries without their required id field produce a pre-flight error so the
 * authoring mistake is surfaced before any real step runs.
 */
export interface StoryboardFixtures {
  products?: Array<Record<string, unknown> & { product_id?: string }>;
  pricing_options?: Array<Record<string, unknown> & { product_id?: string; pricing_option_id?: string }>;
  creatives?: Array<Record<string, unknown> & { creative_id?: string }>;
  plans?: Array<Record<string, unknown> & { plan_id?: string }>;
  media_buys?: Array<Record<string, unknown> & { media_buy_id?: string }>;
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
   * Per-step invariant opt-out. See `StepInvariantsObject`. Use when a
   * specific step deliberately trips a default invariant (e.g. a
   * `check_governance` 200 `status: denied` that is the setup for a
   * buyer-recovery sequence, which `governance.denial_blocks_mutation`
   * would otherwise anchor for the remainder of the run).
   */
  invariants?: StepInvariantsObject;
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
  | 'field_value_or_absent'
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
 * Scope filter for `refs_resolve`. Only source refs whose `key` matches
 * `equals` (after `$agent_url` substitution and, for URL-ending keys,
 * transport-suffix-stripping canonicalization) are in scope. Out-of-scope
 * refs are graded by `on_out_of_scope`.
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
  /**
   * Initial context-provenance map, typically threaded from a prior
   * `runStoryboardStep` invocation's `StoryboardStepResult.context_provenance`.
   * Lets LLM-orchestrated step-by-step runs accumulate the per-key write
   * history the runner needs to emit `context_value_rejected` hints when a
   * later step's seller rejects a value an earlier step extracted. Ignored by
   * `runStoryboard` (full run builds its own map internally). Closes
   * adcp-client#880.
   */
  context_provenance?: Record<string, ContextProvenanceEntry>;
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
   * Opt out of the runner's pre-flight `comply_test_controller` seeding
   * (adcp-client#778). When true, the runner skips the seed_* loop even if
   * the storyboard declares `prerequisites.controller_seeding: true` and a
   * `fixtures:` block. Intended for agents that load fixtures via a non-MCP
   * path (HTTP admin, test bootstrap, inline Node state) — set the flag so
   * the runner doesn't race the external seeding or fail against an agent
   * that doesn't host `comply_test_controller`.
   */
  skip_controller_seeding?: boolean;
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
  | 'oauth_not_advertised'
  /**
   * Pre-flight `comply_test_controller` seeding failed (adcp-client#778), so
   * every real phase cascade-skipped rather than run against an unseeded
   * agent. The structured `skip.reason` resolves to the canonical
   * `prerequisite_failed` per `DETAILED_SKIP_TO_CANONICAL` — the detailed
   * form stays on the legacy `skip_reason` field so report consumers can
   * still distinguish setup breaks from stateful-chain breaks within a
   * phase.
   */
  | 'controller_seeding_failed';

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
  controller_seeding_failed: 'prerequisite_failed',
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
  /**
   * Non-fatal human-readable warning attached when a check `passed` but
   * detected a softer issue the caller should still see — today used only
   * by `response_schema` to surface the top strict-AJV issue when Zod
   * accepts and AJV rejects (the "lenient-passes ∧ strict-fails" subset
   * of issue #820). LLM-driven self-correction and CI graphs that scan
   * `error`/`warning` fields can act on this without the runner flipping
   * step pass/fail and breaking existing tests.
   */
  warning?: string;
  /**
   * Issue #820 follow-up — strict JSON-schema (AJV) verdict for
   * `response_schema` checks. `passed` remains the lenient Zod outcome
   * (runner's historical pass/fail semantics); `strict` carries the
   * AJV-with-formats-and-additionalProperties verdict separately so
   * agent developers can see the strict/lenient delta without the
   * runner failing a step that the Zod path accepts. Absent on non-
   * response_schema checks or when no AJV schema is available.
   */
  strict?: StrictValidationVerdict;
}

/**
 * Strict (AJV JSON-schema) verdict attached to a response_schema
 * validation result. Informational — the step's pass/fail is driven by
 * the lenient Zod path. `valid: false` with `valid_lenient: true`
 * indicates the strict/lenient delta: the agent's response passes the
 * generated Zod shape but fails strict JSON-schema (typically a
 * `format` violation or an `additionalProperties: false` breach).
 */
export interface StrictValidationVerdict {
  valid: boolean;
  /** Response variant AJV ultimately validated against. After fallback: `"sync"`. */
  variant: string;
  /** Concrete AJV issues (RFC 6901 pointers) when `valid: false`. Absent when valid. */
  issues?: SchemaValidationError[];
  /**
   * True when the agent's response `status` field named an async variant
   * (`submitted` / `working` / `input-required`) but no compiled schema
   * existed for that variant, so validation fell back to the sync
   * response schema. Conformance signal: the agent advertised an async
   * shape this tool doesn't explicitly schema. Present only on fallback.
   */
  variant_fallback_applied?: boolean;
  /** Variant requested by payload shape before fallback. Set iff `variant_fallback_applied`. */
  requested_variant?: string;
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
  /**
   * Accumulated context-provenance after this step. Each entry records which
   * step wrote the matching context key and how (convention extractor vs
   * author-provided `context_outputs` path). Thread back into
   * `StoryboardRunOptions.context_provenance` on the next `runStoryboardStep`
   * invocation so hints fire across the stateless step-by-step surface the
   * same way they do inside `runStoryboard`. adcp-client#880.
   */
  context_provenance?: Record<string, ContextProvenanceEntry>;
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
  /**
   * Non-fatal diagnostic hints the runner emitted alongside this step —
   * currently surfaces `context_value_rejected` when a request value came
   * from a prior-step `$context.*` write and the seller's error response
   * lists the set of values it would have accepted. Pass/fail is unchanged;
   * hints help triage collapse from "SDK bug vs seller bug" to one line.
   */
  hints?: StoryboardStepHint[];
}

/**
 * Provenance entry for a context key: which step wrote it and how.
 * Populated by the runner as it applies `context_outputs` and convention-
 * based extractors after each successful step, and consumed when emitting
 * `context_value_rejected` hints.
 */
export interface ContextProvenanceEntry {
  /** Step id that produced this context value. */
  source_step_id: string;
  /**
   * `context_outputs`: author-authored extraction from the YAML.
   * `convention`: task-default extractor in CONTEXT_EXTRACTORS.
   */
  source_kind: 'context_outputs' | 'convention';
  /** Response path the value was extracted from (set for `context_outputs`). */
  response_path?: string;
  /** Task name whose response this value was extracted from. */
  source_task?: string;
}

/**
 * Common shape every `StoryboardStepHint` member shares: the discriminator
 * + a pre-formatted human-readable message. Renderers that don't know a
 * specific `kind` can still display `message` verbatim; renderers that do
 * know the `kind` can branch on it and read the structured fields each
 * member adds. Issue #935: "every runner-side diagnostic with structured
 * fields a renderer can consume" flows through this surface.
 */
export interface StoryboardStepHintBase {
  /** Discriminator. Each concrete hint kind sets its own literal value. */
  kind: string;
  /** Pre-formatted human-readable message suitable for a console line. */
  message: string;
}

/**
 * Non-fatal hint attached to a step result. The discriminator lives on
 * `kind` so consumers that only know how to render a subset can ignore
 * the rest without losing them; `message` is always present as a
 * human-readable fallback (see `StoryboardStepHintBase`). More kinds
 * may be added over time — issue #935 enumerated the canonical taxonomy.
 */
export type StoryboardStepHint =
  | ContextValueRejectedHint
  | ShapeDriftHint
  | MissingRequiredFieldHint
  | FormatMismatchHint
  | MonotonicViolationHint;

/**
 * A seller rejected a request value that the runner traced back to a
 * `$context.*` substitution (or a request-builder field populated from the
 * same context key). Without this hint, the rejection in logs looks
 * identical to an SDK bug; with it, the caller can see the substitution
 * chain (step → context key → response path) and go talk to the seller.
 */
export interface ContextValueRejectedHint extends StoryboardStepHintBase {
  kind: 'context_value_rejected';
  /** Context key whose value matched the rejected request field. */
  context_key: string;
  /** Step id that wrote the context key. */
  source_step_id: string;
  /** How the context key was written (`context_outputs` vs convention). */
  source_kind: 'context_outputs' | 'convention';
  /** YAML response path set for `context_outputs`; absent for convention extractors. */
  response_path?: string;
  /** Task whose response the value was extracted from. */
  source_task?: string;
  /** The value the seller rejected. */
  rejected_value: unknown;
  /**
   * Dotted path to the rejected field in the runner's request (when the
   * seller's error carried an explicit `field` pointer). Absent when the
   * match was resolved by scanning the request for a context-sourced value
   * in the rejection set.
   */
  request_field?: string;
  /** The accepted values the seller reported (`available` / `allowed` / `accepted_values`). */
  accepted_values: unknown[];
  /** Error code from the seller's error (if present). */
  error_code?: string;
}

/**
 * The runner detected that the agent's response payload diverged from the
 * expected shape for the tool — e.g. a list tool returned a bare array
 * instead of `{ <wrapper_key>: [...] }`, or `build_creative` returned
 * platform-native fields at the top level instead of `{ creative_manifest }`.
 *
 * Non-fatal: step pass/fail is unchanged. The runner emits this in place of
 * the legacy `ValidationResult.warning` prose so downstream renderers (CLI,
 * Addie, JUnit) can build per-case fix plans from the structured fields.
 *
 * `instance_path` uses RFC 6901 / `SchemaValidationError.instance_path`
 * conventions: `""` for root-level drift, leading-slash + tokens for nested.
 */
export interface ShapeDriftHint extends StoryboardStepHintBase {
  kind: 'shape_drift';
  /** AdCP tool name (snake_case) that produced the drift. */
  tool: string;
  /** Short token describing the observed (wrong) shape variant. */
  observed_variant: string;
  /** Short token or schema fragment describing the expected shape. */
  expected_variant: string;
  /** RFC 6901 pointer to the drift site; `""` for root-level. */
  instance_path: string;
}

/**
 * Strict (AJV) JSON-schema validation reports a missing required field that
 * the lenient Zod path didn't enforce. Mirrors the `SchemaValidationError`
 * shape so a renderer can drive directly off the structured fields without
 * re-parsing the prose `validation.warning`.
 */
export interface MissingRequiredFieldHint extends StoryboardStepHintBase {
  kind: 'missing_required_field';
  /** AdCP tool name (snake_case) the response was validated under. */
  tool: string;
  /** RFC 6901 pointer to the parent object missing the field. `""` for root. */
  instance_path: string;
  /** Pointer into the JSON schema that named the requirement. */
  schema_path: string;
  /** Field name(s) the parent object was required to carry. */
  missing_fields: string[];
  /** Resolvable schema URL (when the runner could attribute one). */
  schema_url?: string;
}

/**
 * Strict (AJV) JSON-schema validation rejected a value that the lenient Zod
 * path accepted — a `format` keyword breach (uri / date-time / uuid / ...)
 * or other strict-only delta the agent ships today that a strict dispatcher
 * would block (issue #820). Carries enough structured detail for a renderer
 * to write a verify-after-fix recipe.
 */
export interface FormatMismatchHint extends StoryboardStepHintBase {
  kind: 'format_mismatch';
  /** AdCP tool name (snake_case). */
  tool: string;
  /** RFC 6901 pointer to the failing field. */
  instance_path: string;
  /** Pointer into the JSON schema that named the constraint. */
  schema_path: string;
  /** AJV keyword that rejected (`format`, `pattern`, `enum`, `minLength`, ...). */
  keyword: string;
  /** Resolvable schema URL (when the runner could attribute one). */
  schema_url?: string;
}

/**
 * The `status.monotonic` invariant observed a resource transition that is
 * not on the spec lifecycle graph for its resource type. Carries the
 * structured fields a renderer needs to point the implementor at the
 * canonical enum schema and the prior step that set the anchor state.
 */
export interface MonotonicViolationHint extends StoryboardStepHintBase {
  kind: 'monotonic_violation';
  /** Resource family (`media_buy`, `creative`, `account`, ...). */
  resource_type: string;
  /** Resource id observed transitioning. */
  resource_id: string;
  /** Status the resource was in at the anchor step. */
  from_status: string;
  /** Status the resource transitioned to at the current step. */
  to_status: string;
  /** Step id that recorded the previous status. */
  from_step_id: string;
  /**
   * Legal next-state set per the lifecycle graph. Empty array means the
   * `from_status` is terminal — the violation is "any forward transition
   * from a terminal state".
   */
  legal_next_states: string[];
  /** Canonical enum schema URL for the lifecycle graph. */
  enum_url: string;
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
  /**
   * Results from cross-step assertions declared on the storyboard's
   * `invariants` field. Step-scoped failures also surface inside the owning
   * step's `validations[]` with `check: "assertion"`; storyboard-scoped
   * failures live only here. `overall_passed` is false when any assertion
   * failed.
   */
  assertions?: AssertionResult[];
  /**
   * Issue #820 follow-up — strict/lenient `response_schema` delta. Always
   * emitted by the runner; inspect `observable` first to distinguish
   * "observed zero strict-eligible checks" from "observed N and graded
   * them". Storyboards dominated by non-`response_schema` validations
   * (`field_present`, `error_code`, pure `assertion` runs) will have
   * `observable: false` and zeroed counters.
   */
  strict_validation_summary?: StrictValidationSummary;
}

export interface StrictValidationSummary {
  /**
   * True when at least one `response_schema` validation had an AJV
   * validator compiled (the strict path could actually grade something).
   * False means "unobservable": the run exercised only tasks whose JSON
   * schema isn't registered, or only non-`response_schema` validations —
   * NOT "strict-clean with zero findings". Downstream dashboards and
   * CI formatters MUST check this before rendering the counts.
   */
  observable: boolean;
  /** Response-schema checks that had an AJV validator compiled. */
  checked: number;
  /** Of `checked`, how many passed strict AJV. */
  passed: number;
  /** Of `checked`, how many failed strict AJV. Equals `checked - passed`. */
  failed: number;
  /**
   * Count of validations where lenient Zod accepted AND strict AJV
   * rejected — the "silent failures" the agent ships today that a strict
   * dispatcher would block. Subset of `failed`. This is the actionable
   * production-readiness signal for agent developers: a green lenient run
   * with `strict_only_failures > 0` is a migration trap.
   */
  strict_only_failures: number;
  /**
   * Count of validations where BOTH lenient Zod AND strict AJV rejected —
   * the step already failed under today's semantics, so strict rejection
   * isn't new signal. Equals `failed - strict_only_failures`. Useful for
   * dashboards that want to distinguish "already-failing" from
   * "silently-failing" in the same run.
   */
  lenient_also_failed: number;
}

/**
 * Single assertion outcome recorded by the runner. Mirrors the shape of
 * `ValidationResult` so existing consumers can render assertions with the
 * same code path, while adding scope + source fields that identify where
 * the failure originated.
 */
export interface AssertionResult {
  /** Id of the registered assertion that produced this result. */
  assertion_id: string;
  passed: boolean;
  /** Human-readable description of the property being asserted. */
  description: string;
  /** Whether this result was raised at a specific step or storyboard-wide. */
  scope: 'step' | 'storyboard';
  /** Step that produced the observation, when `scope === "step"`. */
  step_id?: string;
  /** Failure detail. Absent on pass. */
  error?: string;
  /**
   * Structured `StoryboardStepHint` the assertion can attach when it has
   * machine-readable fields a renderer can consume. The runner mirrors this
   * into the owning step's `hints[]` for `scope: "step"` results so the
   * hint surfaces alongside `context_value_rejected` / `shape_drift` /
   * strict-AJV hints under one taxonomy. Absent when the assertion only
   * has prose to report.
   */
  hint?: StoryboardStepHint;
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
