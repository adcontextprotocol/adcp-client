/**
 * Types for storyboard-driven testing.
 *
 * Storyboards are YAML-defined test workflows that walk through
 * AdCP agent interactions step by step. Each step maps to a
 * SingleAgentClient method and includes validations.
 */

import type { TestOptions } from '../types';
import type { BuyerAgent, BuyerAgentBillingMode, BuyerAgentStatus } from '../../server/decisioning/buyer-agent';
import type { WebhookConformanceSigningOptions } from '../../conformance/types';

// ────────────────────────────────────────────────────────────
// Parsed storyboard structure (mirrors YAML schema)
// ────────────────────────────────────────────────────────────

export type RequiresCapabilityPredicate =
  | { path: string; equals: boolean | string | number | null }
  | { path: string; present: boolean }
  | { path: string; contains: boolean | string | number };

export interface Storyboard {
  id: string;
  version: string;
  /**
   * AdCP compliance cache version this storyboard was loaded from, e.g.
   * "3.0.12" or "3.1.0-beta.7". Injected by the local cache loader; not
   * authored in storyboard YAML.
   */
  adcp_version?: string;
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
  /**
   * Strict tool-family advertisement gates. Each family is satisfied when
   * the agent advertises at least one listed tool; missing a family skips
   * the whole storyboard with `requirement_unmet` and a
   * `missing_required_tool_family:` detail prefix. The standard `comply()`
   * path populates `agentTools` before this gate runs; direct callers that
   * reuse a client should provide `agentTools` or `_profile.tools` so the
   * runner can enforce it without discovery ambiguity.
   */
  required_any_of_tools?: RequiredToolFamily[];
  /**
   * Runtime requirements this storyboard depends on. Each name describes
   * something the runner detects from the agent or from operator-supplied
   * options; an unmet requirement skips the whole storyboard with
   * `skip_reason: 'requirement_unmet'` rather than producing a cascade of
   * misleading per-step `missing_test_controller` skips.
   *
   * Recognised names:
   *   - `controller` — the agent must advertise `comply_test_controller`.
   *     Detected from `options.agentTools`, `_profile.tools`, or discovery
   *     on reused clients. Direct callers that deliberately provide none of
   *     those surfaces bypass this check; their storyboard runs into the
   *     per-step `missing_test_controller` cascade instead.
   *   - `seeded_state` — the operator must pass `--asserts-seeded-state`
   *     (or set `assertsSeededState: true`) declaring that initial state
   *     has been provisioned out-of-band (HTTP admin, pre-test script,
   *     staging fixture). The runner does not verify the assertion;
   *     scenarios that need state still fail naturally if the seed is
   *     not actually present.
   *   - `real_wire` — always available. Tag scenarios that observe
   *     production behavior with this when you want them excluded from
   *     a future `--mock-only` mode; today the tag is a no-op gate.
   *   - `webhook_receiver` — the runner must be configured with a
   *     webhook receiver (`StoryboardRunOptions.webhook_receiver`).
   *     Autodetected from token presence: any step whose
   *     `sample_request` (or nested fields) references
   *     `{{runner.webhook_url:<step_id>}}` or `{{runner.webhook_base}}`
   *     declares this requirement implicitly. Authors do not need to
   *     write `requires: [webhook_receiver]` — the tokens are
   *     self-describing.
   *   - `request_signer` — the agent under test MUST advertise
   *     `request_signing.supported: true` in `get_adcp_capabilities`.
   *     Autodetected: any storyboard whose `id === 'signed_requests'`
   *     or contains a `request_signing_probe` step implicitly requires
   *     this. Skipped (storyboard not applicable) when the agent omits
   *     the capability claim — absence is a declaration that the agent
   *     does not offer verified signed requests, per
   *     `compliance/{version}/universal/signed-requests.yaml` gating
   *     ("Agents that do not advertise support are not tested against
   *     this storyboard — absence of advertisement is not a failure").
   *     Spec: adcp-client#1702.
   *
   * Default when the field is absent: `[real_wire]` (storyboard runs
   * everywhere — matches existing pre-tagging behavior). Tagging is
   * additive opt-in; loader rejects unknown requirement names and an
   * empty array (`requires: []`) so authoring mistakes fail loud.
   *
   * Spec: adcp-client#1626. The schema may be proposed upstream to
   * `adcontextprotocol/adcp` once it has bedded in across SDK
   * storyboards.
   */
  requires?: RequirementName[];
  /**
   * Predicate evaluated against the agent's declared capabilities before any
   * phase runs. When the predicate is false, the runner emits a single
   * `{ skipped: true, skip_reason: 'capability_unsupported' }` storyboard
   * result instead of running phases — avoiding misleading per-phase failures
   * when the storyboard tests behavior the agent explicitly opted out of.
   *
   * `path` is a dotted key path into the raw `get_adcp_capabilities` response
   * (e.g. `"adcp.idempotency.supported"`).
   *
   * Two matcher forms — mutually exclusive on a single gate:
   *
   * - `equals: V` — scalar equality. The path's resolved value must be
   *   declared and must equal `V` for the storyboard to run. When the path
   *   resolves to `undefined` (field absent), the storyboard is skipped as
   *   `capability_unsupported`; omitting a capability means the agent has not
   *   opted into that behavior or variant.
   *
   * - `present: true|false` — presence-only matcher for spec capabilities whose
   *   contract is "presence of this object indicates support" (e.g.
   *   `media_buy.conversion_tracking`). `present: true` requires the value at
   *   `path` to exist (non-null, non-undefined); empty object `{}` counts as
   *   present. `present: false` requires the value to be absent — useful for
   *   scenarios that only apply to agents that explicitly do NOT advertise a
   *   capability. Unlike `equals`, absence is the load-bearing signal: when
   *   `present: true` and the field is missing, the storyboard is skipped
   *   (not_applicable) rather than run, because the seller's silence is the
   *   spec-defined opt-out.
   *
   * - `contains: V` — array-membership matcher for capabilities whose
   *   declaration shape is an array of allowed values (e.g.
   *   `media_buy.conversion_tracking.supported_targets: ["cost_per",
   *   "per_ad_spend"]`). The value at `path` MUST be an array and MUST include
   *   `V` (strict equality, no coercion). Empty arrays fail; paths resolving
   *   to undefined or non-array values fail (treated as "capability not
   *   declared", skip the storyboard as not_applicable). Like `present:`,
   *   absence is the load-bearing signal — a seller that doesn't advertise
   *   the array hasn't opted into the variant this storyboard tests.
   *
   * When `raw_capabilities` is not available and the discovered profile does
   * not expose `get_adcp_capabilities`, `equals` gates are treated as
   * unsupported because there is no declaration proving the agent opted into
   * the behavior. Other matcher forms remain a no-op without raw
   * capabilities because their authored paths cannot be inspected.
   */
  requires_capability?: RequiresCapabilityPredicate;
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
  /**
   * Initial context values declared by the storyboard YAML. Runner callers may
   * override these defaults with `StoryboardRunOptions.context`.
   */
  context?: StoryboardContext;
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

export interface RequiredToolFamily {
  tools: [string, string, ...string[]];
  rationale?: string;
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
 *   - `creative_formats[]` → `seed_creative_format` — requires `format_id`
 *   - `creatives[]`     → `seed_creative`        — requires `creative_id`
 *   - `plans[]`         → `seed_plan`            — requires `plan_id`
 *   - `media_buys[]`    → `seed_media_buy`       — requires `media_buy_id`
 *   - `buyer_agents[]`  → `seed_buyer_agent`     — requires `agent_url`
 *
 * For entity fixtures, every other field on the entry is forwarded verbatim
 * as `params.fixture`. For `buyer_agents[]`, every other field is forwarded
 * as a direct `params` field because the controller scenario models the
 * buyer-agent record itself (`billing_capabilities`, `status`, etc.).
 * Entries without their required id field produce a pre-flight error so the
 * authoring mistake is surfaced before any real step runs.
 */
export interface StoryboardFixtures {
  products?: Array<Record<string, unknown> & { product_id?: string }>;
  pricing_options?: Array<Record<string, unknown> & { product_id?: string; pricing_option_id?: string }>;
  creative_formats?: Array<Record<string, unknown> & { format_id?: string; fixture?: unknown }>;
  creatives?: Array<Record<string, unknown> & { creative_id?: string }>;
  plans?: Array<Record<string, unknown> & { plan_id?: string }>;
  media_buys?: Array<Record<string, unknown> & { media_buy_id?: string }>;
  buyer_agents?: StoryboardBuyerAgentFixture[];
}

export interface StoryboardBuyerAgentFixture {
  agent_url?: string;
  display_name?: string;
  status?: BuyerAgentStatus;
  billing_capabilities?: BuyerAgentBillingMode[];
  default_account_terms?: BuyerAgent['default_account_terms'];
  allowed_brands?: string[];
  aliases?: string[];
  sandbox_only?: boolean;
  [key: string]: unknown;
}

export interface StoryboardPhase {
  id: string;
  title: string;
  narrative?: string;
  steps: StoryboardStep[];
  /** When true, the phase is allowed to be skipped without failing the storyboard. */
  optional?: boolean;
  /**
   * Predicate evaluated against the agent's declared capabilities before this
   * phase is set up or any of its steps are dispatched. Uses the same matcher
   * dialect as `Storyboard.requires_capability` (`equals`, `present`,
   * `contains`). When false, every step in the phase is emitted as a
   * `not_applicable` skip and the runner continues with later phases.
   */
  requires_capability?: RequiresCapabilityPredicate;
  /**
   * Phases this phase depends on for stateful cascade purposes (#1161).
   *
   * When ANY listed phase tripped its stateful cascade (a stateful step
   * failed or skipped for a missing-state reason), every stateful step in
   * THIS phase cascade-skips with `prerequisite_failed`. When all listed
   * phases passed their stateful steps, this phase runs normally even if
   * other unrelated phases tripped — the runner treats independent phases
   * independently.
   *
   * **Default semantics (field absent or undefined): "all prior phases."**
   * Backward-compatible with the storyboard-scope cascade behavior that
   * predates #1161 — every phase implicitly depends on every prior phase.
   * The F6 round-2 cross-phase pattern (e.g. `signal_marketplace/
   * governance_denied`: setup in phases 1-2, consumption in phase 3) is
   * preserved without YAML changes.
   *
   * **Independent phase: `depends_on: []`** — explicitly declares this
   * phase has no upstream dependencies and will run even if every prior
   * phase tripped its cascade. Use for phases whose state derives from
   * the request body alone (e.g., `audience_sync` carrying its own
   * account ref via brand+operator) rather than from prior phase state.
   *
   * **Targeted dependency: `depends_on: ['phase_id', ...]`** — only the
   * named phases gate this phase's cascade. Other phases tripping is
   * irrelevant.
   *
   * Listed phase IDs MUST exist in the same storyboard and MUST be
   * declared earlier in the `phases[]` array (forward references and
   * self-references are rejected at parse time). Empty list is legal and
   * means "no dependencies."
   */
  depends_on?: string[];
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
  /**
   * JSON path to extract from the response. Mutually exclusive with
   * `generate` — exactly one of `path` or `generate` must be set.
   */
  path?: string;
  /**
   * Generator name. When set, the runner mints a fresh opaque value
   * once per run (or reuses a value already minted for the same `key`
   * alias via an inline `$generate:…#<alias>` substitution in the same
   * step's `sample_request`). Mutually exclusive with `path`. The loader
   * rejects unknown values at storyboard-load time so typos fail loud
   * before the first run.
   */
  generate?: 'uuid_v4' | 'opaque_id';
  /** Key to store the extracted or generated value under in context */
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
    }
  | {
      type: 'basic';
      /** Pull the Basic credential object from the runtime test kit, e.g. `auth.basic`. */
      from_test_kit?: string | boolean;
      /** Explicit username. Mutually exclusive with `credentials`. */
      username?: string;
      /** Explicit password. Mutually exclusive with `credentials`. */
      password?: string;
      /** Unencoded `username:password` pair. Mutually exclusive with `username`/`password`. */
      credentials?: string;
      /** Nested Basic credential shape accepted for authoring parity with test kits. */
      basic?: {
        username?: string;
        password?: string;
        credentials?: string;
      };
      /**
       * Runner-generated value. Current strategies:
       *   - `random_invalid` — random username/password pair.
       */
      value_strategy?: 'random_invalid';
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
  /**
   * Explicit per-step routing for multi-agent runs
   * (`StoryboardRunOptions.agents`). Must reference a key in the agents
   * map; the runner sends this step to that agent regardless of
   * `TASK_FEATURE_MAP` resolution.
   *
   * This is the canonical primitive for cross-specialism storyboards —
   * NOT just an escape hatch. A `signal_marketplace/governance_denied`
   * storyboard NEEDS `agent: governance` on its `sync_governance` step
   * and `agent: signals` on its `activate_signal` step because those
   * tools are owned by different specialisms; protocol-based routing
   * resolves them automatically when the agents map has unique
   * claimants, but explicit `agent:` is the documentation-friendly form
   * for storyboard authors who want the routing intent visible at the
   * step level.
   *
   * Also used to disambiguate cross-domain tools (`sync_creatives`,
   * `list_creative_formats`) when the agents map has multiple claimants
   * for the same specialism and the runner's protocol-index can't pick
   * one. Ignored when `agents` is unset. Adcp-client#1066.
   */
  agent?: string;
  schema_ref?: string;
  response_schema_ref?: string;
  doc_ref?: string;
  /** Maps to existing @adcp/sdk test scenario (legacy, partial coverage) */
  comply_scenario?: string;
  /** Whether this step depends on state from a previous step */
  stateful?: boolean;
  /**
   * Declares that this step's pass establishes equivalent state for one or
   * more peer steps in the same phase. When a target peer skips with
   * `missing_tool` or `missing_test_controller` (no advertised tool),
   * the runner defers the cascade and waives it iff this substitute step
   * passes. Same-phase only; cross-phase substitution is not supported.
   *
   * Canonical case: `list_accounts` declares `provides_state_for:
   * sync_accounts` on explicit-mode social platforms where the buyer never
   * calls `sync_accounts` because accounts are pre-provisioned out-of-band.
   *
   * Without this declaration, a `missing_tool` skip on a stateful step
   * trips the cascade immediately (state genuinely never materialized).
   * With it, the runner gives a declared substitute a chance to establish
   * equivalent state before tripping. When the rescue fires, the target
   * peer is graded with `skip_reason: 'peer_substituted'` and detail
   * `"<target_step_id> state provided by <phase_id>.<substitute_step_id>"`
   * per `runner-output-contract.yaml`.
   *
   * Use `string[]` for the bulk case (`provides_state_for: [A, B]` is
   * ALL-OF — one substitute pass establishes state for both A and B).
   *
   * Spec source: `compliance/cache/{version}/universal/storyboard-schema.yaml`
   * (adcp#3734, AdCP 3.0.3+).
   */
  provides_state_for?: string | string[];

  /**
   * @deprecated Renamed to `provides_state_for` to align with the AdCP 3.0.3
   * spec field (adcp#3734). The old name is still accepted at parse time for
   * one minor cycle. New storyboards SHOULD use `provides_state_for`. Slated
   * for removal in the next major.
   */
  peer_substitutes_for?: string | string[];
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
  /**
   * When true, suppress the runner's `account` auto-injection on a
   * `create_media_buy` step so the storyboard can exercise the server's
   * missing-account rejection path. Without this flag the runner's
   * `applyBrandInvariant` synthesises an `account` field before the wire
   * call (both the natural-key-merge branch and the synthetic-construction
   * branch), and the SDK's client-side normalizer also throws before the
   * wire call — both layers are suppressed so the seller sees the request
   * exactly as authored in `sample_request`.
   *
   * Only applicable to `create_media_buy` (the sole tool where `account` is
   * required by `normalizeRequestParams`). Setting it on any other task type
   * has no effect and is ignored.
   *
   * **Caveat:** this flag does not suppress `account` enrichment performed by
   * `request-builder.ts` for tasks such as `update_media_buy`. If a future
   * storyboard step needs to test missing-account rejection on a
   * request-builder-enriched task, the builder will also need updating.
   *
   * Must be paired with `expect_error: true` — the loader rejects steps that
   * set `omit_account: true` without the flag, because an accountless
   * `create_media_buy` will always fail and a missing `expect_error` produces
   * a misleading compliance result.
   *
   * Default (false) matches buyer-agent behavior: every `create_media_buy`
   * request carries an `account` so handlers under test run against the
   * actual error path the storyboard names rather than short-circuiting on
   * `INVALID_REQUEST: account`.
   *
   * @internal Do not set in production buyer code.
   */
  omit_account?: boolean;
  /** Tool name required for this step to run. Skipped if agent lacks it. */
  requires_tool?: string;
  /** Explicit context extraction rules (supplements convention-based extractors) */
  context_outputs?: ContextOutput[];
  /** Explicit context injection rules (supplements $context.key placeholders) */
  context_inputs?: ContextInput[];
  expected?: string;
  sample_request?: Record<string, unknown>;
  sample_response?: Record<string, unknown>;
  /**
   * Response-derived gates evaluated after the step's request completes but
   * before validations/context captures run. Use when applicability is only
   * knowable from the observed response, not from static capabilities.
   *
   * Current gate kind:
   *   - `terminal_page`: if the response proves the requested page is terminal,
   *     grade the step `not_applicable` instead of failing continuation-only
   *     assertions. This supports pagination-walk storyboards for sellers whose
   *     full result set fits in one page.
   */
  not_applicable_if?: ResponseNotApplicableGate | ResponseNotApplicableGate[];
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
  webhook_payload_schema_ref?: string;
  /** Back-compat alias for older local storyboards. Prefer `webhook_payload_schema_ref`. */
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
  // ──────────────────────────────────────────────────────────
  // Webhook receiver replay step fields (only used when task is
  // `replay_webhook_vector`). The runner sends a canonical webhook POST to
  // a buyer/orchestrator receiver under test; it does not call the seller.
  // ──────────────────────────────────────────────────────────
  /** Compliance vector reference, e.g. `static/test-vectors/webhook-receiver-envelope.json#positive/foo`. */
  vector_ref?: string;
  /** Earlier step id that represents the same logical event retry. */
  same_event_as?: string;
  /** Expected receiver error label from the vector metadata, when present. */
  expected_error?: string;
  /**
   * Fan-out spec for parallel-dispatch steps. When set, the runner fires
   * `count` concurrent dispatches of this step (single-process,
   * `Promise.all`) against the same agent, then aggregates per-response
   * checks across the resolved set and grades the `cross_response_*`
   * checks declared in `validations`. Requires the
   * `parallel_dispatch_runner` test-kit contract to be in scope — runners
   * (or runs) without it grade the step `not_applicable`. See
   * {@link ParallelDispatchSpec}.
   */
  parallel_dispatch?: ParallelDispatchSpec;
  /**
   * Sequential rate-limit trip/replay probe config. When set on
   * `expect_rate_limit_not_replayed`, the runner sends fresh-key requests
   * until the seller returns `RATE_LIMITED`, waits the response
   * `retry_after`, then replays the same idempotency key to assert the
   * transient rate-limit response was not cached as the canonical replay.
   * Requires the `rate_limit_trip_runner` test-kit contract.
   */
  rate_limit_trip?: RateLimitTripSpec;
}

/**
 * Contract payload for `test-kits/rate-limit-trip-runner.yaml`.
 */
export interface RateLimitTripSpec {
  /** Mutating AdCP task to burst, e.g. `create_media_buy`. */
  trip_target_task: string;
  /** Base request payload; the observer rewrites only idempotency_key and correlation_id. */
  trip_target_sample_request: Record<string, unknown>;
  /** Sequential fresh-key attempts before grading the probe `rate_limit_not_triggered`; must be in [50, 500]. */
  max_attempts: number;
  /** Maximum retry_after wait the runner will honor. Defaults to 30 seconds. */
  replay_max_wait_seconds?: number;
}

export type StoryboardValidationCheck =
  | 'response_schema'
  | 'field_present'
  | 'field_absent'
  // Envelope-scoped variants — the asserted path lives on the v3 protocol
  // envelope (`status`, `task_id`, `message`, `replayed`, `governance_context`,
  // `timestamp`, `context_id`, `push_notification_config`) rather than the
  // inner response. Runtime semantics are identical to the un-prefixed checks
  // (TaskResult merges envelope fields onto its surface); the distinction is
  // for static drift detection, which walks `protocol-envelope.json` instead
  // of the per-tool response schema. Added per adcp#3429.
  | 'envelope_field_present'
  | 'envelope_field_absent'
  | 'envelope_field_value'
  | 'envelope_field_value_or_absent'
  | 'field_value'
  | 'field_value_or_absent'
  /**
   * Assert that a string field in the task payload matches a JavaScript
   * regular expression source declared in `pattern`. Fails when the path is
   * missing, the value is not a string, the pattern is invalid, or the regex
   * does not match. Failure output carries `expected: { pattern }` and
   * `actual` as the observed value (or null when missing). Added for
   * runner-output-contract v2.5.0.
   */
  | 'field_pattern'
  /**
   * Envelope-scoped `field_pattern`. The path resolves against the union of
   * protocol-envelope fields (`status`, `task_id`, etc.) and string-valued
   * version-envelope fields such as `adcp_version`. Runtime matching is the
   * same as `field_pattern`; the distinct kind lets static linting validate
   * against the envelope schemas instead of the task payload schema. Numeric
   * envelope fields such as `adcp_major_version` should use
   * `envelope_field_value`.
   */
  | 'envelope_field_pattern'
  // Wildcard-aware membership check. `path` may include `[*]` or `[]`
  // segments that expand to every array element via `resolvePathAll`.
  // Passes when ANY resolved value matches `value` (or any of
  // `allowed_values`). Object and array expectations are matched as deep
  // subsets, so storyboards can assert keyed entries inside unordered arrays
  // without hardcoding positions — e.g.,
  // `creatives[0].errors[*].code = PROVENANCE_DISCLOSURE_MISSING` or
  // `products[0].allowed_actions[]` with
  // `{ action: "increase_budget", modes: ["self_serve"] }`.
  // When the path has no wildcard segments this reduces to scalar equality
  // / array membership depending on what the path resolves to.
  | 'field_contains'
  | 'status_code'
  | 'error_code'
  // HTTP-probe checks (for raw_probe tasks)
  | 'http_status'
  | 'http_status_in'
  | 'on_401_require_header'
  // Cross-cutting
  | 'resource_equals_agent_url'
  | 'any_of'
  // A2A wire-shape checks (transport-specific; skipped on non-A2A runs)
  | 'a2a_submitted_artifact'
  | 'a2a_context_continuity'
  // Cross-step checks
  | 'refs_resolve'
  /**
   * Assert a numeric field in the current step's response is strictly less than
   * a comparand. The comparand is either a context-captured runtime value
   * (`context_key` on `StoryboardValidation`) or a literal number (`value`).
   * Fails with a type error when either operand is non-numeric or absent.
   * When `context_key` is specified but the key is absent from `storyboardContext`,
   * the check passes with a `context_key_absent` observation (prior step may have
   * been legitimately skipped on a branch-set path).
   * Added for adcp#2642 cross-step comparison primitives.
   */
  | 'field_less_than'
  /**
   * Assert a numeric field in the current step's response is strictly greater
   * than a comparand. Mirror of `field_less_than` — completes the four-quadrant
   * numeric comparison vocabulary (`<`, `<=`, `>=`, `>`). Same operand and
   * `context_key_absent` semantics as `field_less_than`. Added for
   * adcp-client#1839 four-quadrant symmetry.
   */
  | 'field_greater_than'
  /**
   * Assert a numeric field in the current step's response is at most (≤) a
   * comparand. Semantically symmetric with `field_less_than` but with
   * non-strict comparison — pairs cleanly with cap-style assertions like
   * "observed frequency stays at or below the requested cap of 3".
   * The comparand is either a context-captured runtime value (`context_key`)
   * or a literal number (`value`). Fails with a type error when either
   * operand is non-numeric or absent. When `context_key` is specified but
   * absent from `storyboardContext`, passes with a `context_key_absent`
   * observation. Added for adcp-client#1839.
   */
  | 'field_at_most'
  /**
   * Assert a numeric field in the current step's response is at least (≥) a
   * comparand. Mirror of `field_at_most` — pairs with floor-style assertions
   * like "delivered reach ≥ promised reach". Same operand and
   * context_key_absent semantics as `field_at_most`. Added for
   * adcp-client#1839.
   */
  | 'field_at_least'
  /**
   * Assert a field in the current step's response deep-equals a value captured
   * from an earlier step via `context_key`. Unlike `field_value` + `$context.key`
   * substitution (which resolves the comparand at YAML authoring time), this
   * check compares against a runtime-captured value — suitable for asserting that
   * a response echoes back an id or token that was only known at run time.
   * When `context_key` is absent from `storyboardContext`, passes with a
   * `context_key_absent` observation.
   * Added for adcp#2642 cross-step comparison primitives.
   */
  | 'field_equals_context'
  /**
   * Asserts upstream side-effects against the adopter's
   * `comply_test_controller`'s `query_upstream_traffic` scenario. The
   * load-bearing anti-façade contract: a fully-conformant adapter and a
   * façade returning shape-valid AdCP responses with synthetic data are
   * indistinguishable on the AdCP wire — only what the adapter caused
   * upstream tells them apart. Adopters who do not advertise
   * `query_upstream_traffic` in `list_scenarios` grade the check
   * `not_applicable`. Adopters who do but return zero recorded calls in
   * the assertion window grade `failed` (the façade signal). Spec:
   * runner-output-contract.yaml v2.0.0, storyboard-schema.yaml >
   * "upstream_traffic".
   */
  | 'upstream_traffic'
  /** Contract check for `rate_limit_trip_runner`: RATE_LIMITED must not replay from the idempotency cache. */
  | 'replay_not_cached_rate_limit'
  /**
   * Cross-response: every resolved response from a `parallel_dispatch` step
   * carries the same value at the named `path`. Used to assert
   * first-insert-wins on a concurrent retry — two parallel `create_media_buy`
   * calls with the same `idempotency_key` must resolve to the same
   * `media_buy_id`. Fails when any two resolved responses disagree, or when
   * fewer than 2 dispatches resolved successfully. Spec:
   * test-kits/parallel-dispatch-runner.yaml; adcp#4435 (rule 9 / rule 10).
   */
  | 'cross_response_field_equal'
  /**
   * Cross-response: the cardinality of distinct values at `path` across all
   * resolved responses from a `parallel_dispatch` step is in
   * `allowed_values`. Used to assert "exactly one resource was created" —
   * `allowed_values: [1]` with `path: media_buy_id` catches a seller that
   * raced the INSERT and created two resources from one logical create.
   * Fails when the distinct count is outside `allowed_values`, or when no
   * dispatch resolved successfully. Spec:
   * test-kits/parallel-dispatch-runner.yaml.
   */
  | 'cross_response_count_distinct'
  /**
   * Assert that the `create_media_buy` package format selector outcome matches
   * canonical product capability satisfaction rules. `value: true` means the
   * request should be accepted because its selector satisfies the product's
   * `format_options[]`; `value: false` means the request should be rejected
   * because the selector does not satisfy those constraints.
   *
   * The validator uses the actual runner request plus prior `get_products`
   * context. It normalizes legacy `format_ids[]` through product
   * `v1_format_ref[]` / the v1→canonical projection path, resolves canonical
   * `format_option_refs[]`, and checks directional containment for dimensions,
   * sizes, duration declarations, and remaining canonical params. Negative
   * cases only pass on a format-specific rejection, so unrelated auth or tenant
   * failures do not mask selector bugs. Failure output names the likely bug
   * class: normalization, directionality, or range containment. Added for
   * adcp-client#2060.
   */
  | 'canonical_format_satisfaction'
  /**
   * Assert the cardinality of the array at `path`. Two configurations are
   * supported: exact-count via `value: N` (passes only when the resolved
   * array has exactly N entries) and range via `min` / `max` (either bound
   * is optional; both inclusive). Specifying both `value` and `min`/`max` is
   * rejected as a misconfigured check; so are non-integer, negative, NaN,
   * or impossible (`min > max`) operands. Fails with a type error when the
   * resolved path is absent or not an array — `field_present` paired with
   * `field_value_or_absent value: null` is unsound for cardinality because
   * it passes when a seller emits a literal-null pad at `arr[N]`.
   *
   * **Non-optional by design.** This check has no tolerant arm — an absent
   * path fails. Use `field_value_or_absent` (or omit the check) when the
   * field itself is spec-optional; `array_length` is for asserting the
   * cardinality of an array that MUST be present.
   *
   * Spec: adcp#4685 (cardinality assertions); SDK adcp-client#1830.
   */
  | 'array_length';

/**
 * Configuration for a step that fans out to N concurrent dispatches against
 * the same agent, returning the cross-response set for assertion. Drives the
 * `concurrent_retry` phase of the idempotency storyboard (rule 9 /
 * first-insert-wins), where two `create_media_buy` calls with the same
 * `idempotency_key` race the seller's INSERT and must resolve to one
 * resource.
 *
 * Modes:
 *   - `process_local` (default): fire all dispatches via `Promise.all`
 *     through the SDK's batch primitive before awaiting any response.
 *     Single-process, event-loop concurrent — sufficient to exercise the
 *     seller's INSERT race per the contract YAML's
 *     `not_required_to_synthesize_packet_schedule` note.
 *   - `distributed` (future): barrier-synced workers across processes for
 *     true network-level concurrency. Defers to a later spec phase; runners
 *     that do not implement it grade the step `not_applicable`.
 *
 * Spec source: `test-kits/parallel-dispatch-runner.yaml`.
 */
export interface ParallelDispatchSpec {
  /**
   * How many parallel dispatches to fire. Per spec, `count_min: 2`,
   * `count_max: 10`. Values outside that range are rejected at run time as a
   * `parallel_dispatch_misconfigured` step error rather than silently clamped.
   */
  count: number;
  /**
   * When `true` (default), every dispatch shares the same fresh
   * `idempotency_key` (the runner mints one UUID and reuses it across the
   * fan-out). When `false`, every dispatch gets its own fresh key — useful
   * for soak tests that need parallelism without the race semantics.
   */
  same_idempotency_key?: boolean;
  /**
   * Maximum total wall-clock time, in milliseconds, the runner waits for all
   * dispatches to resolve (including any IDEMPOTENCY_IN_FLIGHT retries).
   * Defaults to `5000`. A dispatch that doesn't terminate within the budget
   * is marked timed-out; the step grades the surviving set and reports
   * `parallel_dispatch_barrier_timeout` for the missing arms.
   */
  barrier_timeout_ms?: number;
  /**
   * Dispatch coordination mode (see interface JSDoc). Defaults to
   * `'process_local'`.
   */
  mode?: 'process_local' | 'distributed';
}

/**
 * A response-derived step-level not-applicable gate. Kept data-driven so new
 * storyboards can opt in without runner-specific hardcoding.
 */
export type ResponseNotApplicableGate = TerminalPageNotApplicableGate;

export interface TerminalPageNotApplicableGate {
  kind: 'terminal_page';
  /**
   * Array path in the response whose length is compared to the request page
   * size, e.g. `accounts`, `creatives`, or `formats`.
   */
  items_path: string;
  /**
   * Path in the request that carries the requested page size. Defaults to
   * `pagination.max_results`.
   */
  request_max_results_path?: string;
  /**
   * Optional label prefixed onto skip.detail. Defaults to
   * `single_page_result`.
   */
  reason?: string;
  /** Optional human-readable detail override for skip.detail. */
  detail?: string;
  /**
   * Context keys whose missing captures should cause downstream consumer
   * steps to skip as `not_applicable` instead of `prerequisite_failed`.
   * When omitted, the runner infers keys from context_outputs whose paths
   * read `pagination.cursor`.
   */
  context_keys?: string[];
}

/**
 * Path/value match predicate for `upstream_traffic.payload_must_contain`.
 * Each entry asserts a JSONPath (`$.users[*].hashed_email`) and a match
 * mode against the recorded call's payload.
 */
export interface UpstreamTrafficPayloadMatch {
  /** JSONPath into recorded_calls[].payload. */
  path: string;
  /** Match mode: `present` checks the path resolves; `equals` compares; `contains_any` checks list membership. */
  match: 'present' | 'equals' | 'contains_any';
  /** Expected value when `match: equals`. */
  value?: unknown;
  /** Allowed values when `match: contains_any`. */
  allowed_values?: unknown[];
}

/**
 * Captured A2A wire shape from a `message/send` JSON-RPC response. The
 * runner records this when the protocol is `a2a` and a step's tool
 * dispatch went through the SDK client; A2A wire-shape validations
 * (`a2a_submitted_artifact`) consume it. Absent on MCP runs and on A2A
 * runs where the capture didn't fire (raw probe path, fetch error).
 *
 * The `result` field is typed as `unknown` because the JSON-RPC
 * envelope is observed at the wire — the validation engine narrows it
 * (e.g. asserting `kind === 'task'`) and reports specific failures
 * when the shape doesn't match. Doing the narrowing in the type would
 * lock callers into a specific A2A SDK version; doing it in the
 * validator preserves the runner's "report what you saw" contract.
 *
 * **Redaction posture.** The runner runs `redactSecrets` over `result`
 * and `envelope` before populating this struct, matching the
 * redaction the runner applies to `RunnerResponseRecord.payload` on
 * the success path. AdCP-style secret-shaped fields inside the
 * DataPart payload (`api_key`, `client_secret`, `access_token`, etc.)
 * are replaced with `[redacted]`; bearer-token substrings in raw
 * bodies were already redacted at fetch-capture time. Custom
 * validators reading this field don't need to re-redact, but SHOULD
 * avoid logging it through other channels (LLM context, debug sinks,
 * third-party telemetry) without confirming the same redaction
 * posture is acceptable for that channel.
 */
export interface A2ATaskEnvelope {
  /**
   * Parsed JSON-RPC `result` field — typically an A2A `Task`
   * (`{ kind: 'task', id, status: { state }, artifacts: [...] }`) on
   * success. Absent (set to `null`) when the JSON-RPC response was an
   * error envelope; consumers should also inspect `envelope.error`.
   */
  result: unknown;
  /**
   * Full JSON-RPC envelope (`{ jsonrpc, id, result?, error? }`).
   * Useful for assertions that need to distinguish a JSON-RPC error
   * from a success-with-failure-task (e.g. `Task.state === 'failed'`
   * is success-with-failure; `error.code === -32602` is a JSON-RPC
   * error).
   */
  envelope: { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: unknown };
  /** HTTP status of the captured response (200 on JSON-RPC success). */
  http_status: number;
}

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
  /** Stable authored validation identifier echoed into runner results when present. */
  id?: string;
  check: StoryboardValidationCheck;
  /** JSON path for field checks, e.g. "accounts[0].account_id" */
  path?: string;
  /** Expected value for exact-match checks. */
  value?: unknown;
  /** Accepted values for list-match checks (passes if actual matches any). */
  allowed_values?: unknown[];
  /** JavaScript regular expression source for field_pattern checks. */
  pattern?: string;
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
  // ─── field_less_than / field_equals_context fields ────────
  /**
   * Key to look up in the accumulated `storyboardContext` for cross-step
   * comparison checks (`field_less_than`, `field_greater_than`,
   * `field_at_most`, `field_at_least`, `field_equals_context`).
   * Only consumed by those check types — ignored on all others.
   * When set and the key is absent from context, the check passes with a
   * `context_key_absent` observation rather than failing — the prior step
   * that was supposed to populate the key may have been legitimately skipped.
   */
  context_key?: string;
  // ─── upstream_traffic fields ──────────────────────────────
  /**
   * Minimum number of recorded calls (matching `endpoint_pattern` if set)
   * the runner MUST observe in the assertion window. Default 1. Use 0 only
   * for negative assertions ("step MUST NOT cause upstream traffic").
   * Spec: storyboard-schema.yaml > "upstream_traffic".
   */
  min_count?: number;
  /**
   * Glob/path pattern matched against `recorded_calls[].endpoint`
   * (`<METHOD> <URL>`). Examples: `POST <star>/audience/upload`,
   * `POST <star>` (where `<star>` is a literal asterisk). When omitted,
   * every recorded call in the window matches.
   */
  endpoint_pattern?: string;
  /**
   * Each entry asserts a path/value pair that MUST appear in at least one
   * matching call's payload. See `UpstreamTrafficPayloadMatch`.
   */
  payload_must_contain?: UpstreamTrafficPayloadMatch[];
  /**
   * Raw payload introspection requirement. When set to `raw`, controllers
   * that downgrade the response to digest-only attestations cause this
   * validation to grade `not_applicable` instead of failed.
   */
  attestation_mode_required?: 'raw';
  /**
   * Advisory request-mode preference for the runner's
   * `query_upstream_traffic` prefetch. When omitted, the runner preserves
   * its legacy inference: digest for identifier-only checks with digestable
   * vectors, raw otherwise. Raw-required validations and payload
   * introspection always take precedence over this preference.
   */
  preferred_attestation_mode?: 'raw' | 'digest';
  /**
   * Paths into the effective request payload that name the load-bearing
   * identifiers the adapter MUST forward upstream. When the runner has the
   * actual request payload after context substitution, that payload is the
   * source of truth; otherwise it falls back to the storyboard's
   * `sample_request`.
   *
   * The runner extracts the values at these paths and asserts each resolved
   * value appears in at least one matching `recorded_call`'s payload at any
   * depth. Each path MAY resolve to a single value or an array; ALL resolved
   * values MUST be present in the recorded payload — single-placeholder
   * fabrication is the threat model. Portable path syntax is a request-rooted
   * dotted grammar with optional `[*]` wildcard selectors on segments, for
   * example `audiences[*].add[*].hashed_email`. Explicit roots (`$.foo`),
   * reserved roots (`request.*`, `response.*`, `context.*`), bracket-quoted
   * keys, recursive descent (`$..foo`), numeric indexes, and empty segments
   * are storyboard authoring errors so controllers do not silently resolve
   * zero vectors. The runner caps portable digest proofs at 64 unique
   * identifier values; overflow is graded `not_applicable` because the bound
   * is runner-side, not a spec value. Per spec PR adcontextprotocol/adcp#3816,
   * replaces the earlier
   * `buyer_identifier_echo: boolean` shorthand.
   */
  identifier_paths?: string[];
  /**
   * Bound the lookup window to traffic recorded since this step's request
   * timestamp (default) or since the request timestamp of `prior_step_id`
   * for cumulative-effect assertions.
   */
  since?: string;
  // ─── array_length fields ──────────────────────────────────
  /**
   * Inclusive lower bound for `array_length`. Mutually exclusive with
   * `value`. Pass with `max` omitted to assert "at least N entries."
   */
  min?: number;
  /**
   * Inclusive upper bound for `array_length`. Mutually exclusive with
   * `value`. Pass with `min` omitted to assert "at most N entries."
   */
  max?: number;
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

/**
 * One agent in a per-specialism routing map. Used by `runStoryboard()` when
 * a storyboard spans tools that live on different tenants (e.g. signals at
 * `/signals`, governance at `/governance`).
 *
 * `auth` is an optional per-tenant override. The canonical multi-tenant
 * deployment (the prod test-agent's six tenants) uses one shared bearer
 * across every URL — set `StoryboardRunOptions.auth` once at the run
 * level and leave entries' `auth` empty. Set `auth` on an entry only
 * when that tenant uses different credentials (e.g., a publisher whose
 * signals tenant is fronted by a partner like LiveRamp with separate
 * auth from the sales tenant). Adcp-client#1066.
 */
export interface AgentEntry {
  /** MCP or A2A endpoint URL for this agent. */
  url: string;
  /** Per-tenant auth override; falls back to `StoryboardRunOptions.auth` when absent. */
  auth?: TestOptions['auth'];
  /** Per-tenant transport override; defaults to `StoryboardRunOptions.protocol`. */
  transport?: 'mcp' | 'a2a';
}

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
  /**
   * Context keys whose producer step was skipped as response-derived
   * `not_applicable`, typically threaded from a prior `runStoryboardStep`
   * invocation's `StoryboardStepResult.response_derived_not_applicable_context_keys`.
   * Lets stateless step-by-step callers preserve the same cursor-consumer skip
   * semantics as full `runStoryboard` runs.
   */
  response_derived_not_applicable_context_keys?: Record<string, string>;
  /**
   * Contribution flags accumulated by prior `runStoryboardStep` invocations.
   * Thread this from `StoryboardStepResult.contributions` so synthetic
   * aggregate steps such as `assert_contribution` see the same branch-set
   * state they would see inside a full `runStoryboard` execution.
   */
  contributions?: string[];
  /** Override the step's sample_request with a custom request */
  request?: Record<string, unknown>;
  /** Agent's available tools for storyboard/step-level tool gates. */
  agentTools?: string[];
  /**
   * Allow plain-http agent URLs during compliance runs. Normally rejected
   * because production agents MUST terminate TLS. Intended for local dev
   * loops (docker compose, localhost harnesses). Emits an advisory banner
   * in the report when used.
   */
  allow_http?: boolean;
  /**
   * Operator assertion that initial state has been provisioned out-of-band
   * (HTTP admin, pre-test script, staging fixture) — flips the
   * `seeded_state` requirement to available so storyboards declaring
   * `requires: [seeded_state]` run instead of skipping with
   * `requirement_unmet`. Default false. The runner does NOT verify the
   * assertion; if state isn't actually seeded the scenario fails
   * naturally on its first stateful step, which is the right signal.
   * CLI: `--asserts-seeded-state`. Spec: adcp-client#1626.
   */
  assertsSeededState?: boolean;
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
   * Per-specialism agent routing map. When set, each step's tool name
   * (`StoryboardStep.task`) is resolved to the agent that claims its
   * specialism via `TASK_FEATURE_MAP` × per-agent `get_adcp_capabilities`.
   * An optional explicit `StoryboardStep.agent` override takes precedence.
   *
   * Mutually exclusive with `multi_instance_strategy` (which is replica
   * round-robin, a different concept) and with the legacy `_client`
   * override (single client cannot serve multiple agents). Both
   * combinations throw at `runStoryboard()` entry.
   *
   * Discovery is parallel across all agents at storyboard start; any agent
   * whose discovery fails causes the whole storyboard to fail (not skip),
   * because a topology with one broken tenant is a hard misconfiguration,
   * not a per-step skip condition.
   *
   * Multi-claim conflicts (two agents claim the same specialism) fail-fast
   * at discovery time for affected steps that lack an explicit `step.agent`
   * override. Steps WITH an override route per the override and never see
   * the conflict — the override is the disambiguator, not just an escape
   * hatch. To resolve a conflict: either remove one of the conflicting
   * agents from the map, or add `agent: <key>` to each affected step.
   *
   * Adcp-client#1066.
   */
  agents?: Record<string, AgentEntry>;
  /**
   * Fallback agent key (must be present in `agents`) for tasks with no entry
   * in `TASK_FEATURE_MAP` — e.g., `comply_test_controller`, future tasks
   * shipped before the SDK adds them to the map. When omitted, unmapped
   * tasks fail-fast with `unroutable_task`.
   */
  default_agent?: string;
  /**
   * Opt into resilient discovery (#1367). When `false` (default), any agent
   * whose `get_adcp_capabilities` probe fails causes the whole storyboard
   * to fail — correct for production multi-tenant flows where every tenant
   * in the map is load-bearing.
   *
   * When `true`:
   *   - Discovery failures are logged but not fatal.
   *   - Failed agents are excluded from the protocol-claim index.
   *   - Routing throws `RoutingError` only if a step's protocol resolves
   *     to a failed agent — surfaces as a per-step failure, not a
   *     storyboard-wide hard failure.
   *   - A `discovery_failures[]` summary on `StoryboardResult` lists which
   *     agents failed, so the operator still sees the topology breakage.
   *
   * Intended for hello-cluster CI and exploratory runs where one flaky
   * tenant shouldn't gate a 6-tenant smoke. Production runs should NEVER
   * set this — a topology with one broken tenant is a hard misconfig.
   *
   * Only consulted when `agents` is set (multi-agent routing); single-URL
   * runs have no roster to be resilient about.
   */
  discovery_resilient?: boolean;
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
   *
   * **Multi-agent topology** (`options.agents` set): the receiver is **shared**
   * across all tenants in the routing map — one HTTP server, one base URL,
   * bound once at storyboard start. This works correctly for cross-specialism
   * flows because delivery correlation is by **step-keyed URL** (the receiver
   * mints `/step/<step_id>/<operation_id>` paths), not by source agent. If a
   * `sync_governance` step on the governance tenant and an `activate_signal`
   * step on the signals tenant both emit webhooks, the runner disambiguates by
   * step ID, not tenant identity. Per-tenant receivers are not supported and
   * are not needed for any current cross-specialism storyboard in the corpus.
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
   * Target receiver for `replay_webhook_vector` storyboards. This is separate
   * from `webhook_receiver`: that option hosts a local receiver so the runner
   * can observe seller-emitted webhooks, while this option points at the
   * buyer/orchestrator receiver the runner should POST canonical vectors to.
   */
  webhook_replay_receiver?: {
    /** Absolute URL of the receiver endpoint under test. */
    url: string;
    /** Extra headers to send on every replay. */
    headers?: Record<string, string>;
    /** Optional signing profile for raw-body verification tests. */
    signing?: WebhookConformanceSigningOptions;
    /** Request timeout in milliseconds. Defaults to 10000. */
    timeoutMs?: number;
    /** Optional root directory for resolving vector_ref file paths. */
    vectorsRoot?: string;
    /** Override fetch for tests or custom runtimes. */
    fetchImpl?: typeof fetch;
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
  /**
   * Cancel the run when this signal aborts. Threaded down to the per-phase
   * and per-step loops inside `executeStoryboardPass` so an abort fires
   * between any two steps, not only between storyboards. Without it,
   * `comply()`'s timeout would only bound the *next* storyboard's start —
   * a single in-flight storyboard could exhaust its full timeout budget
   * inside one fan-out of sequential MCP/A2A calls. (adcp-client#1612)
   */
  signal?: AbortSignal;
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
   * A storyboard-level `requires:` tag named a requirement that is not
   * available on the current run (e.g. `controller` when the agent doesn't
   * advertise `comply_test_controller`, or `seeded_state` when the operator
   * didn't pass `--asserts-seeded-state`). Distinct from `missing_tool` /
   * `missing_test_controller` (per-step tool gates) and `unsatisfied_contract`
   * (capability predicate). The `RunnerSkipResult.requirement` field carries
   * the unmet requirement name. Spec: adcp-client#1626.
   */
  | 'requirement_unmet'
  /**
   * A peer optional phase in the same `branch_set` already contributed the
   * aggregation flag, so this non-chosen branch's failing steps are moot
   * (see storyboard-schema.yaml > "Per-step grading in any_of branch
   * patterns" and runner-output-contract.yaml). Kept distinct from
   * `not_applicable` (coverage gap) and raw `failed` (agent misbehavior).
   */
  | 'peer_branch_taken'
  /**
   * A same-phase peer step declared `provides_state_for: <this_step_id>`
   * and passed, establishing equivalent state. This step would have graded
   * `missing_tool` or `missing_test_controller`; the substitute rescued it
   * so downstream stateful steps can still run. Detail format per
   * `runner-output-contract.yaml`:
   * `"<this_step_id> state provided by <phase_id>.<substitute_step_id>"`.
   * Kept distinct from `peer_branch_taken` (branch-set routing) and
   * `not_applicable` (coverage gap). Spec source: adcp#3734 (AdCP 3.0.3+).
   */
  | 'peer_substituted';

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
  /** Request-signing vector is outside the agent's declared signing capability profile. */
  | 'capability_profile_mismatch'
  /** Request-signing vector cannot be graded faithfully by the selected transport. */
  | 'transport_ungradable'
  /** Request-signing grader's MCP-transport mode collapses URL-edge vectors (#617). */
  | 'mcp_mode_flattens_url_edges'
  /** RFC 9728 protected-resource metadata returned 404 → agent is not advertising OAuth, cascade-skip oauth_discovery (#677). */
  | 'oauth_not_advertised'
  /** rate_limit_trip_runner did not observe RATE_LIMITED within max_attempts. */
  | 'rate_limit_not_triggered'
  /**
   * Pre-flight `comply_test_controller` seeding failed (adcp-client#778), so
   * every real phase cascade-skipped rather than run against an unseeded
   * agent. The structured `skip.reason` resolves to the canonical
   * `prerequisite_failed` per `DETAILED_SKIP_TO_CANONICAL` — the detailed
   * form stays on the legacy `skip_reason` field so report consumers can
   * still distinguish setup breaks from stateful-chain breaks within a
   * phase.
   */
  | 'controller_seeding_failed'
  /**
   * A generated pre-flight seed_* call targeted a scenario that the agent's
   * comply_test_controller does not implement. Maps to canonical
   * `not_applicable`: the seller cannot accept this storyboard's fixture
   * setup, so the storyboard is out of scope rather than failed.
   */
  | 'fixture_seed_unsupported'
  /**
   * A `requires_capability` predicate on the storyboard evaluated to false —
   * the agent explicitly declared it does not support the capability this
   * storyboard tests (e.g. `adcp.idempotency.supported: false`). The whole
   * storyboard is skipped before any phase runs. Maps to canonical
   * `unsatisfied_contract`: the agent's self-declared capability profile
   * does not satisfy the storyboard's preconditions — consistent with peer
   * skip reasons `rate_abuse_opt_out` and `missing_test_kit_contract`.
   */
  | 'capability_unsupported'
  /**
   * A `comply_test_controller` step targeted a `force_*` scenario that the
   * agent advertised the controller for but did not implement. Detected by
   * the tuple (step.task === 'comply_test_controller', resolved
   * `scenario` parameter starts with `force_`, response `success: false,
   * error: UNKNOWN_SCENARIO`). Runners MUST grade the step `not_applicable`
   * with detail `force_scenario_unsupported` instead of failing the step's
   * authored validations. Maps to canonical `not_applicable`. AdCP 3.0.12
   * runner-output-contract: `universal/runner-output-contract.yaml` >
   * `skip_result.reasons.force_scenario_unsupported`.
   */
  | 'force_scenario_unsupported';

/**
 * Map detailed grader skip reasons onto the six canonical spec values so
 * consumers reading `skip.reason` get a stable enum regardless of which
 * subsystem produced the skip.
 */
export const DETAILED_SKIP_TO_CANONICAL: Record<RunnerDetailedSkipReason, RunnerSkipReason> = {
  probe_skipped: 'not_applicable',
  not_in_only_vectors: 'not_applicable',
  grader_skipped: 'not_applicable',
  capability_profile_mismatch: 'not_applicable',
  transport_ungradable: 'not_applicable',
  mcp_mode_flattens_url_edges: 'not_applicable',
  oauth_not_advertised: 'not_applicable',
  rate_limit_not_triggered: 'not_applicable',
  force_scenario_unsupported: 'not_applicable',
  fixture_seed_unsupported: 'not_applicable',
  capability_unsupported: 'unsatisfied_contract',
  rate_abuse_opt_out: 'unsatisfied_contract',
  missing_test_kit_contract: 'unsatisfied_contract',
  live_side_effect_opt_in_required: 'unsatisfied_contract',
  operator_skip: 'unsatisfied_contract',
  controller_seeding_failed: 'prerequisite_failed',
};

export interface RunnerSkipResult {
  reason: RunnerSkipReason;
  detail: string;
  /**
   * Set when `reason === 'requirement_unmet'` to name the storyboard-level
   * requirement that was not available on this run. Carries the same value
   * authored in `Storyboard.requires`. Consumers (skip-cause aggregation,
   * dashboards) key on this field to group not-applicable scenarios by
   * cause. Absent for every other skip reason. Spec: adcp-client#1626.
   */
  requirement?: RequirementName;
}

export type RunnerSelectionReason =
  | 'run_mode_excluded'
  | 'explicit_scope_excluded'
  | 'version_excluded'
  | 'profile_excluded';

export interface RunnerSelectionResult {
  reason: RunnerSelectionReason;
  detail: string;
}

/**
 * Recognised values for `Storyboard.requires`. See `Storyboard.requires`
 * for what each name detects from. Adding a new value here is a wire
 * surface change; coordinate with the upstream spec proposal before
 * extending.
 *
 * Spec: adcp-client#1626.
 */
export type RequirementName = 'controller' | 'seeded_state' | 'real_wire' | 'webhook_receiver' | 'request_signer';

/**
 * Closed enumeration of every known requirement. Used by the loader to
 * reject typos in `Storyboard.requires` (`requires: [contoller]` fails
 * load rather than silently dropping coverage) and by the runner to
 * compute available requirements for the gate. Keep in sync with
 * `RequirementName`.
 */
export const KNOWN_REQUIREMENTS: ReadonlySet<RequirementName> = new Set([
  'controller',
  'seeded_state',
  'real_wire',
  'webhook_receiver',
  'request_signer',
] as const satisfies readonly RequirementName[]);

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
// Runner notices
// ────────────────────────────────────────────────────────────

/**
 * Closed literal union of every notice code the runner can emit.
 *
 * Adopters who narrow on `code` get exhaustiveness checks: when a new
 * code lands in a future SDK release, their switch / discriminated
 * union surfaces the gap at compile time. That's the right signal —
 * a deprecation or future-required advisory is the kind of thing a CI
 * gate or dashboard SHOULD have explicit handling for.
 *
 * Code naming generally follows the dot-namespaced convention `<topic>.<event>`
 * (e.g. `request_signing.required`, `webhook_signing.legacy_hmac_fallback.removed`);
 * prefer the upstream runner-output contract's canonical code when it
 * registers a different spelling. The *when* lives in the `effective_version`
 * field, never in the code. This keeps the surface stable across spec versions
 * — codes don't proliferate `_in_4_0` / `_in_5_0` siblings as the spec evolves.
 *
 * Adding a new code is a wire-surface change AND a TypeScript breaking
 * change for adopters who narrowed on `code`. Coordinate with the upstream
 * spec (adcp#4418) before extending.
 *
 * Spec: adcp-client#1704.
 */
export type NoticeCode =
  /** Agent advertises deprecated `specialisms: ['signed-requests']`. Removed in
   *  AdCP 4.0 per `effective_version`. */
  | 'signed_requests_specialism_deprecated'
  /** Agent lacks `request_signing.supported: true`. Required for spend-committing
   *  operations in AdCP 4.0 per `effective_version`. */
  | 'request_signing.required'
  /** Agent advertises `webhook_signing.legacy_hmac_fallback: true`. Removed in
   *  AdCP 4.0 per `effective_version`. */
  | 'webhook_signing.legacy_hmac_fallback.removed'
  /** Runner stripped request fields missing from the agent's advertised tool input schema. */
  | 'input_schema_field_stripped';

/**
 * Severity of a runner notice. Deliberately separate from `ObservationSeverity`
 * (which grades behavioral quality). Notices describe the agent's _protocol
 * compliance trajectory_ — a different axis: something is fine today but the
 * spec already signals a future state change.
 *
 * - `info` — purely informational; no action required now.
 * - `deprecation` — SHOULD migrate; the field/claim is deprecated in the current
 *   spec version.
 * - `future_required` — behavior is optional today but will be mandatory in a
 *   named future AdCP version (see `effective_version`).
 */
export type NoticeSeverity = 'info' | 'deprecation' | 'future_required';

/**
 * A structured advisory produced by the runner for a specific storyboard run.
 * Notices describe protocol compliance trajectory (deprecations, upcoming
 * requirements) rather than behavioral quality (which is `AdvisoryObservation`'s
 * domain). Intended for CI gates and dashboards that need machine-readable badges
 * like "DEPRECATION" or "FUTURE-REQUIRED" without parsing prose strings.
 *
 * `ComplianceResult.notices` aggregates these across all storyboard runs,
 * deduplicated by `code`.
 *
 * Spec: adcp-client#1704.
 */
export interface RunnerNotice {
  severity: NoticeSeverity;
  /** Stable machine-readable identifier. Dashboards key on this for badge routing. */
  code: NoticeCode;
  /** Human-readable explanation; first 200 chars suitable for tabular rendering. */
  message: string;
  /**
   * AdCP protocol version at which the behavior becomes mandatory (for
   * `future_required`) or was formally removed (for `deprecation`).
   * e.g. `'4.0'`. Absent when not version-bounded. Field name matches
   * upstream spec issue adcontextprotocol/adcp#4418.
   */
  effective_version?: string;
  /**
   * Dot-path into the agent's capability response that motivated the notice
   * (e.g. `request_signing.supported`). Use as a human-readable pointer only;
   * not guaranteed to resolve via JSON Pointer.
   */
  capability_path?: string;
  /**
   * Click-through URL for adopters to read the underlying spec section,
   * migration guide, or AdCP issue. Optional; consumers that surface
   * notices in dashboards or CI output use this to deep-link the
   * remediation context. Stable across runs for the same `code`.
   */
  docs_url?: string;
  /**
   * Storyboard ids that triggered this notice. On `StoryboardResult.notices`
   * this is always a single-element array (the storyboard the notice came
   * from). On `ComplianceResult.notices` (the deduplicated cross-storyboard
   * rollup) this aggregates every storyboard that emitted the same `code`,
   * so auditors can see "how widespread" a deprecation or future-required
   * signal is without re-walking the per-storyboard arrays. Order is stable
   * across runs (insertion order across the storyboard execution order).
   */
  storyboard_ids: string[];
}

// ────────────────────────────────────────────────────────────
// Results
// ────────────────────────────────────────────────────────────

export interface ValidationResult {
  /** Stable authored validation identifier, echoed unchanged when provided by the storyboard. */
  id?: string;
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
   * Forward-compat marker: set when the runner did not implement the
   * authored check kind and graded it as `not_applicable` (passed: true)
   * to preserve forward compatibility with future spec additions. The
   * companion `note` describes the coverage gap. Per
   * runner-output-contract.yaml v2.0.0 these contribute to the run
   * summary's `validations_not_applicable` counter so consumers can
   * distinguish "runner is older than the storyboard" from clean passes.
   */
  not_applicable?: boolean;
  /**
   * Human-readable note attached to a passing-but-not-applicable result
   * (forward-compat path) or other informational annotations. Distinct
   * from `warning` which signals a soft issue on a successful check.
   */
  note?: string;
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
  /**
   * Structured selection result for steps that were outside the caller's
   * requested run before execution. Kept separate from `skip`: skipped means
   * selected-but-not-executed, selection means not selected for this run.
   */
  selection_result?: RunnerSelectionResult;
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
  /**
   * Accumulated response-derived `not_applicable` context-key map after this
   * step. Thread back into `StoryboardRunOptions.response_derived_not_applicable_context_keys`
   * on the next `runStoryboardStep` invocation so cursor consumers skip as
   * `not_applicable` rather than `prerequisite_failed`.
   */
  response_derived_not_applicable_context_keys?: Record<string, string>;
  /**
   * Contribution flags accumulated after this step. Thread back into
   * `StoryboardRunOptions.contributions` on the next `runStoryboardStep`
   * invocation when orchestrating a storyboard step-by-step.
   */
  contributions?: string[];
  error?: string;
  /**
   * Structured AdCP error forwarded from the transport layer when the step failed.
   * Carries `code`, `field`, and `details.validation_errors` so dashboards and
   * LLM self-correction loops can identify the exact fault address without
   * re-running the step. Present only when the underlying task returned a
   * structured `adcp_error` envelope; absent for transport-level failures.
   */
  adcp_error?: import('../../core/ConversationTypes').AdcpErrorInfo;
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
   * Informational notices scoped to this step. These do not affect pass/fail.
   * Storyboard-level `notices` aggregates step notices by code.
   */
  notices?: RunnerNotice[];
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
   * `generator`: runner-minted value (no response path involved).
   */
  source_kind: 'context_outputs' | 'convention' | 'generator';
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
  /** Discriminator. Each concrete hint kind sets its own literal value.
   * @provenance runner
   */
  kind: string;
  /**
   * Pre-formatted human-readable message suitable for a console line.
   * @provenance seller
   * Contains pre-interpolated seller-derived bytes for
   * `context_value_rejected` (rejected value, accepted values, request field
   * pointer) and `monotonic_violation` (resource id, prior and current status)
   * hint kinds. Treat as untrusted when rendering into LLM context or any
   * prompt-injection-sensitive surface; build safe output from the structured
   * `@provenance runner` / `@provenance storyboard` fields instead, or
   * sanitize at the boundary.
   *
   * `shape_drift` and `missing_required_field` messages are composed entirely
   * from runner-derived tokens and are safe to render without sanitization.
   * `format_mismatch` messages are safe under the current AJV configuration
   * (no custom error-message plugins); if `ajv-errors` or a custom AJV
   * keyword message factory is added, audit whether it embeds seller data
   * values before treating `format_mismatch` messages as trusted.
   */
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
  | MonotonicViolationHint
  | ImpairmentCoherenceHint
  | ImpairmentCoherenceNotApplicableHint;

/**
 * A seller rejected a request value that the runner traced back to a
 * `$context.*` substitution (or a request-builder field populated from the
 * same context key). Without this hint, the rejection in logs looks
 * identical to an SDK bug; with it, the caller can see the substitution
 * chain (step → context key → response path) and go talk to the seller.
 */
export interface ContextValueRejectedHint extends StoryboardStepHintBase {
  kind: 'context_value_rejected';
  /**
   * Context key whose value matched the rejected request field.
   * @provenance storyboard
   */
  context_key: string;
  /**
   * Step id that wrote the context key.
   * @provenance runner
   */
  source_step_id: string;
  /**
   * How the context key was written (`context_outputs` vs convention vs generator).
   * @provenance runner
   */
  source_kind: 'context_outputs' | 'convention' | 'generator';
  /**
   * YAML response path set for `context_outputs`; absent for convention extractors and generators.
   * @provenance storyboard
   */
  response_path?: string;
  /**
   * Task whose response the value was extracted from.
   * @provenance storyboard
   */
  source_task?: string;
  /**
   * The value the seller rejected. Copied verbatim from context (which was
   * itself extracted from a prior seller response); already embedded in
   * `message` via string interpolation — sanitize before rendering into LLM
   * context.
   * @provenance seller
   */
  rejected_value: unknown;
  /**
   * Dotted path to the rejected field in the runner's request (when the
   * seller's error carried an explicit `field` pointer). Absent when the
   * match was resolved by scanning the request for a context-sourced value
   * in the rejection set. Sourced from the seller's `errors[].field` pointer
   * and normalized by `normalizeFieldPath()` (RFC 6901 → dotted form);
   * already embedded in `message` — sanitize before LLM rendering.
   * @provenance seller
   */
  request_field?: string;
  /**
   * The accepted values the seller reported (`available` / `allowed` /
   * `accepted_values`). Elements are unconstrained seller strings embedded
   * verbatim in `message`; sanitize before rendering into LLM context or
   * any prompt-injection-sensitive surface.
   * @provenance seller
   */
  accepted_values: unknown[];
  /**
   * Error code from the seller's error (if present).
   * @provenance seller
   */
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
  /**
   * AdCP tool name (snake_case) that produced the drift.
   * @provenance runner
   */
  tool: string;
  /**
   * Short token describing the observed (wrong) shape variant. Always a
   * runner-hardcoded string (`bare_array`, `platform_native_fields`, etc.)
   * derived from pattern-matching the seller's response shape — not the
   * seller's payload bytes directly.
   * @provenance runner
   */
  observed_variant: string;
  /**
   * Short token or schema fragment describing the expected shape.
   * @provenance runner
   */
  expected_variant: string;
  /**
   * RFC 6901 pointer to the drift site; `""` for root-level. Hardcoded by
   * the runner's shape-detector; not derived from seller response content.
   * @provenance runner
   */
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
  /**
   * AdCP tool name (snake_case) the response was validated under.
   * @provenance runner
   */
  tool: string;
  /**
   * RFC 6901 pointer to the parent object missing the field. `""` for root.
   * Generated by AJV from the JSON schema evaluation result.
   * @provenance runner
   */
  instance_path: string;
  /**
   * Pointer into the JSON schema that named the requirement.
   * @provenance runner
   */
  schema_path: string;
  /**
   * Field name(s) the parent object was required to carry. Every entry is a
   * bare identifier extracted from the AJV error message (via the pattern
   * `required property 'X'`). AJV issues whose message does not match that
   * pattern — e.g. a reworded or locale-variant message from a future AJV
   * major or a custom AJV instance — are omitted rather than included
   * verbatim. Callers can rely on every entry being a plain field name.
   * The raw AJV issue message may still appear in `ValidationResult.warning`
   * prose for human readers.
   * @provenance runner
   */
  missing_fields: string[];
  /**
   * Resolvable schema URL (when the runner could attribute one).
   * @provenance runner
   */
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
  /**
   * AdCP tool name (snake_case).
   * @provenance runner
   */
  tool: string;
  /**
   * RFC 6901 pointer to the failing field. Generated by AJV; identifies a
   * location in the seller's response but the pointer string itself is
   * runner-derived.
   * @provenance runner
   */
  instance_path: string;
  /**
   * Pointer into the JSON schema that named the constraint.
   * @provenance runner
   */
  schema_path: string;
  /**
   * AJV keyword that rejected (`format`, `pattern`, `enum`, `minLength`, ...).
   * Runner-internal pseudo-keyword `truncated` is used when the hint count
   * is capped.
   * @provenance runner
   */
  keyword: string;
  /**
   * Resolvable schema URL (when the runner could attribute one).
   * @provenance runner
   */
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
  /**
   * Resource family (`media_buy`, `creative`, `account`, ...). Hardcoded by
   * the runner's per-resource-type extractors.
   * @provenance runner
   */
  resource_type: string;
  /**
   * Resource id observed transitioning. Extracted from the seller's response
   * (e.g. `media_buy_id`, `creative_id`) and embedded in `message` —
   * sanitize before rendering into LLM context.
   * @provenance seller
   */
  resource_id: string;
  /**
   * Status the resource was in at the anchor step. Recorded by the runner
   * from a prior step's seller response and stored in the assertion's state
   * map; embedded in `message` — sanitize before LLM rendering.
   * @provenance seller
   */
  from_status: string;
  /**
   * Status the resource transitioned to at the current step. Read directly
   * from the seller's current response; embedded in `message` — sanitize
   * before LLM rendering.
   * @provenance seller
   */
  to_status: string;
  /**
   * Step id that recorded the previous status. Runner-tracked internal ID.
   * @provenance runner
   */
  from_step_id: string;
  /**
   * Legal next-state set per the lifecycle graph. Empty array means the
   * `from_status` is terminal — the violation is "any forward transition
   * from a terminal state". Derived from the runner's hardcoded transition
   * tables in `default-invariants.ts`.
   * @provenance runner
   */
  legal_next_states: string[];
  /**
   * Canonical enum schema URL for the lifecycle graph. Runner-constructed
   * from `ADCP_VERSION` and the per-resource enum filename.
   * @provenance runner
   */
  enum_url: string;
}

/**
 * The `impairment.coherence` invariant observed a mismatch between a media
 * buy's `impairments[]` array and the underlying resource state. Three
 * violation shapes share this hint:
 *   - `forward`: an entry in `impairments[]` references a resource whose
 *     last observed status is NOT an offline value.
 *   - `inverse`: a resource was observed transitioning to an offline state
 *     and is referenced by a non-terminal buy, but is missing from that
 *     buy's `impairments[]`.
 *   - `health`: the buy's `health` field disagrees with `impairments[]`
 *     emptiness — `impaired` iff non-empty (and vice versa).
 *
 * See adcontextprotocol/adcp#2859 for the originating spec issue.
 */
export interface ImpairmentCoherenceHint extends StoryboardStepHintBase {
  kind: 'impairment_coherence_violation';
  /**
   * Discriminator for the violation shape (see the union of `forward`,
   * `inverse`, `health` documented on the type). Renderers can branch on
   * `violation` to pick a per-shape template.
   * @provenance runner
   */
  violation: 'forward' | 'inverse' | 'health';
  /**
   * Media-buy id whose `impairments[]` snapshot the violation was detected
   * on. Read from `media_buy_id` on the buy response.
   * @provenance seller
   */
  media_buy_id: string;
  /**
   * Step id that returned the offending media-buy snapshot.
   * @provenance runner
   */
  buy_step_id: string;
  /**
   * Resource family (`creative`, `audience`, `catalog_item`, `event_source`)
   * the entry references. Present on `forward` and `inverse`.
   * @provenance seller (forward) / runner (inverse)
   */
  resource_type?: string;
  /**
   * Resource id the entry references. Present on `forward` and `inverse`.
   * @provenance seller (forward) / runner (inverse)
   */
  resource_id?: string;
  /**
   * Status the runner has on file for the referenced resource. Present on
   * `forward` and `inverse`. On `forward` it is the non-offline status that
   * makes the impairment a false positive; on `inverse` it is the offline
   * status the seller failed to propagate.
   * @provenance seller
   */
  resource_status?: string;
  /**
   * Step id that recorded `resource_status`.
   * @provenance runner
   */
  resource_step_id?: string;
  /**
   * Health value present on the buy snapshot when the violation is `health`.
   * The literal seller-returned value, undefined when the field is absent.
   * @provenance seller
   */
  buy_health?: string;
  /**
   * `impairments[].length` on the buy snapshot. Present on all three shapes.
   * @provenance seller
   */
  impairments_count: number;
}

/**
 * The `impairment.coherence` invariant observed an offline-state transition
 * for a resource family whose buy → resource reverse-traversal isn't yet
 * implemented (audience / catalog_item / event_source). The forward rule
 * still grades these families; the inverse rule cannot, so the runner
 * surfaces the deferred coverage at the transition step instead of skipping
 * silently. Tracked in adcontextprotocol/adcp#2860.
 */
export interface ImpairmentCoherenceNotApplicableHint extends StoryboardStepHintBase {
  kind: 'impairment_coherence_not_applicable';
  /**
   * Always `'inverse'` for this hint — the rule that can't grade.
   * @provenance runner
   */
  violation: 'inverse';
  /**
   * Machine-readable reason code. Consumers can filter on this without
   * matching prose.
   * @provenance runner
   */
  reason: 'resource_traversal_deferred';
  /**
   * Resource family the transition was observed on. One of the three
   * deferred families.
   * @provenance runner
   */
  resource_type: 'audience' | 'catalog_item' | 'event_source';
  /**
   * Resource id the transition was observed on.
   * @provenance seller
   */
  resource_id: string;
  /**
   * Offline status the resource transitioned to (`suspended` / `withdrawn`
   * / `insufficient`).
   * @provenance seller
   */
  resource_status: string;
  /**
   * Step id that recorded the offline transition.
   * @provenance runner
   */
  resource_step_id: string;
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
  /**
   * Per-specialism routing map (#1066). Echoes `StoryboardRunOptions.agents`
   * resolved to `{ key: url }` so JUnit/CI consumers and bug reports show
   * the topology this run executed against. Absent when not in routed mode.
   * Each `StoryboardStepResult.agent_url` echoes the URL of the routed
   * agent for that step.
   */
  agent_map?: Record<string, string>;
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
  /**
   * Validation results graded `not_applicable` because the runner did not
   * implement the authored `check` kind (forward-compat default). Surfaces
   * "runner is older than the storyboard" as a distinct signal from clean
   * passes. Per runner-output-contract.yaml v2.0.0 run_summary.
   */
  validations_not_applicable?: number;
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
  /**
   * Structured protocol-compliance advisories produced for this storyboard
   * run. Each notice carries a stable `code` (machine-readable, suitable for
   * CI badge routing) and a `severity` (`deprecation` | `future_required`).
   * Always present; empty array when no notices were triggered.
   *
   * `ComplianceResult.notices` aggregates across all storyboard runs,
   * deduplicated by `code`. Spec: adcp-client#1704.
   */
  notices: RunnerNotice[];
  /**
   * Agents in the routing map whose `get_adcp_capabilities` probe failed
   * when `StoryboardRunOptions.discovery_resilient: true` was set. Absent
   * when resilient mode is off (because failures throw before result
   * construction) and absent when no failures occurred. Each entry carries
   * the agent key, URL, and the scrubbed underlying error so operators
   * see the topology breakage without correlating across log lines.
   *
   * **Read together with `overall_passed`.** A passing storyboard with a
   * non-empty `discovery_failures` means the storyboard did NOT touch any
   * tools that needed the failed agents — it does NOT mean the topology
   * was healthy. Dashboards and procurement reports should surface both
   * fields; a green check next to a populated `discovery_failures` is
   * legitimate but misleading without the second-axis signal.
   *
   * **Buyer-controlled untrusted content.** The `error` string is
   * upstream-agent-derived and may contain attacker-influenced text from
   * a malicious or compromised agent. The runner bounds the string
   * (~512 chars) and runs the existing auth-secret scrub, but the
   * remaining content is untrusted — validate / fence before templating
   * into LLM prompts. The `url` field is scrubbed of userinfo
   * (`//user:pass@host` → `//[REDACTED]@host`) so operator-encoded
   * credentials don't leak to dashboards.
   *
   * Spec: adcp-client#1367.
   */
  discovery_failures?: Array<{ agent_key: string; url: string; error: string }>;
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
  /**
   * Lifecycle resources or transitions an observation-based invariant
   * saw over the run. Set only by invariants whose verdict is meaningful
   * exclusively when something was observed (`status.monotonic` today),
   * emitted on the `onEnd` summary record. The track-level rollup
   * demotes a passing track to `TrackStatus: 'silent'` when every record
   * carrying this field reports `0`.
   *
   * This MUST count actual lifecycle resources or transitions observed
   * — never "the assertion was applicable" or "the assertion ran." A
   * future invariant that emits `observation_count` with skip-style
   * semantics would cause silent demotion for the wrong reason.
   *
   * Absent on assertions that don't model observation counts. Companion
   * to adcontextprotocol/adcp#2834.
   */
  observation_count?: number;
  /**
   * Distinguishes `'silent'` (wired but no observations) from `'pass'`
   * (wired and exercised). Per-assertion analog of the track-level
   * `TrackStatus: 'silent'` rollup — consumers (graders, dashboards) that
   * render per-assertion results need a direct enum here so the
   * "wired-but-not-observed" outcome doesn't render identically to a real
   * pass.
   *
   * Set by observation-based invariants on their `onEnd` summary record:
   * `'silent'` when `observation_count === 0` AND `passed === true`,
   * `'pass'` when `observation_count > 0` AND `passed === true`,
   * `'fail'` when `passed === false`. Absent on assertions that don't
   * model observation counts (their `passed` flag is sufficient).
   *
   * `'not_applicable'` is emitted at step scope by an invariant that
   * recognises an observation it could grade in principle but whose
   * grading path isn't yet implemented in the runner (e.g.
   * `impairment.coherence` inverse rule for audience / catalog_item /
   * event_source — tracked in adcontextprotocol/adcp#2860). The
   * accompanying `hint` carries the deferral reason and resource family
   * so renderers can distinguish a deferred coverage hint from a clean
   * pass. Companion to adcontextprotocol/adcp#2834.
   */
  status?: 'pass' | 'silent' | 'fail' | 'not_applicable';
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
  /** Validations graded `not_applicable` (forward-compat default). */
  validations_not_applicable?: number;
  duration_ms: number;
}
