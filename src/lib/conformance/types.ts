import type { AgentConfig } from '../types';

export type ConformanceToolName =
  // Tier 1: no required IDs, discovery-like
  | 'get_products'
  | 'list_creative_formats'
  | 'list_creatives'
  | 'get_media_buys'
  | 'get_signals'
  | 'si_get_offering'
  | 'get_adcp_capabilities'
  | 'tasks_list'
  | 'list_property_lists'
  | 'list_content_standards'
  | 'get_creative_features'
  // Tier 2: require an ID but no setup — random IDs exercise the
  // rejection surface (agents must return REFERENCE_NOT_FOUND, not 500).
  | 'get_media_buy_delivery'
  | 'get_property_list'
  | 'get_content_standards'
  | 'get_creative_delivery'
  | 'tasks_get'
  | 'preview_creative'
  // Tier 3: mutating updates. Only meaningful against real entity IDs —
  // either pre-seeded via `options.fixtures` or auto-seeded via
  // `autoSeed: true`. Excluded from DEFAULT_TOOLS when neither is active.
  | 'update_media_buy'
  | 'update_property_list'
  | 'update_content_standards';

export const STATELESS_TIER_TOOLS: readonly ConformanceToolName[] = [
  'get_products',
  'list_creative_formats',
  'list_creatives',
  'get_media_buys',
  'get_signals',
  'si_get_offering',
  'get_adcp_capabilities',
  'tasks_list',
  'list_property_lists',
  'list_content_standards',
  'get_creative_features',
] as const;

/**
 * Tools that take an ID but no setup state. Without fixtures the runner
 * exercises only the rejection surface (random IDs → REFERENCE_NOT_FOUND);
 * with fixtures, the arbitrary draws IDs from the supplied pools to
 * exercise the accepted path too. See {@link RunConformanceOptions.fixtures}.
 */
export const REFERENTIAL_STATELESS_TOOLS: readonly ConformanceToolName[] = [
  'get_media_buy_delivery',
  'get_property_list',
  'get_content_standards',
  'get_creative_delivery',
  'tasks_get',
  'preview_creative',
] as const;

/**
 * Tier-3 mutating updates. Only meaningful when the fuzzer has real
 * entity IDs to target — either pre-seeded via
 * {@link RunConformanceOptions.fixtures} or auto-seeded via
 * {@link RunConformanceOptions.autoSeed}. {@link runConformance}
 * excludes these from the default tool list when neither is active.
 *
 * WARNING: running these mutates agent state. Point the fuzzer at a
 * sandbox / test tenant.
 */
export const UPDATE_TIER_TOOLS: readonly ConformanceToolName[] = [
  'update_media_buy',
  'update_property_list',
  'update_content_standards',
] as const;

/** Tier 1 + Tier 2 combined. Default tool set for {@link runConformance}. */
export const DEFAULT_TOOLS: readonly ConformanceToolName[] = [
  ...STATELESS_TIER_TOOLS,
  ...REFERENTIAL_STATELESS_TOOLS,
] as const;

/** Tier 1 + Tier 2 + Tier 3. Used when `autoSeed` is true or fixtures were supplied. */
export const DEFAULT_TOOLS_WITH_UPDATES: readonly ConformanceToolName[] = [
  ...DEFAULT_TOOLS,
  ...UPDATE_TIER_TOOLS,
] as const;

export interface RunConformanceOptions {
  /** Seed for reproducible runs. Omit for a random seed. */
  seed?: number;
  /** Subset of tools to fuzz. Defaults to the full stateless tier. */
  tools?: readonly ConformanceToolName[];
  /** Iterations per tool. Default 50. */
  turnBudget?: number;
  /** Protocol to use. Default: auto-detect via SingleAgentClient. */
  protocol?: 'mcp' | 'a2a';
  /** Auth token to pass as Bearer. */
  authToken?: string;
  /** Additional AgentConfig overrides. `id` and `agent_uri` are filled in automatically. */
  agentConfig?: Partial<AgentConfig>;
  /** Skip runs where the agent returns UNSUPPORTED/NOT_IMPLEMENTED. Default true. */
  skipUnsupported?: boolean;
  /**
   * Cap the serialized size of `failure.input` and `failure.response` in the
   * returned report so a systematically broken agent can't OOM downstream
   * CI consumers. Default: 8192 bytes. Values < 256 are clamped.
   */
  maxFailurePayloadBytes?: number;
  /** Cap total failures collected. Default: 20. Excess are dropped with a marker. */
  maxFailures?: number;
  /**
   * Pre-seeded ID pools to inject into arbitraries. When a request schema
   * has a property whose name maps to one of these pools, the generator
   * draws from the pool with {@link https://fast-check.dev/api-reference/classes/Arbitrary.html `fc.constantFrom`}
   * instead of generating a random string. This is the Tier-2 accepted-path
   * hook — without it, random IDs only exercise the rejection surface.
   *
   * @example
   * ```ts
   * await runConformance(url, {
   *   fixtures: {
   *     creative_ids: ['cre_abc', 'cre_def'],
   *     media_buy_ids: ['mb_123'],
   *   },
   * });
   * ```
   */
  fixtures?: ConformanceFixtures;
  /**
   * When true, `runConformance` calls `seedFixtures` before fuzzing: it
   * creates a property list, a content-standards config, and (if the
   * agent returns at least one product from `get_products`) a media
   * buy. The returned IDs are merged into `fixtures` (explicit fixtures
   * win on conflict) and Tier-3 update tools are added to the default
   * tool list.
   *
   * WARNING: auto-seed mutates agent state. Point at a sandbox.
   *
   * @default false
   */
  autoSeed?: boolean;
  /**
   * Brand reference used by mutating seeders (currently `create_media_buy`
   * and `sync_creatives`). Sellers that enforce brand allowlists should
   * set this to a domain they're configured to accept. When omitted,
   * seeders fall back to `{ domain: 'conformance.example' }`, which will
   * warn-and-skip on allowlist-enforcing sellers.
   */
  seedBrand?: { domain: string; brand_id?: string };
  /**
   * Second auth token for the uniform-error paired probe. When set, the
   * seeder runs as `authToken` (tenant A) and the invariant probes as
   * `authTokenCrossTenant` (tenant B) against tenant A's seeded id —
   * the full "exists but inaccessible vs does not exist" MUST.
   *
   * When absent, the invariant runs in baseline mode (two fresh UUIDs
   * with a single token) — still catches id-echo, header divergence,
   * and state divergence. Cannot catch cross-tenant leaks.
   *
   * @see skills/build-seller-agent/SKILL.md § testing preparation
   */
  authTokenCrossTenant?: string;
}

/**
 * ID pools for Tier-2 fuzzing. Keys correspond to AdCP request-property
 * names; the generator injects them when the field name matches.
 */
export interface ConformanceFixtures {
  /** Pool for `creative_id` and `creative_ids[]` properties. */
  creative_ids?: readonly string[];
  /** Pool for `media_buy_id` and `media_buy_ids[]` properties. */
  media_buy_ids?: readonly string[];
  /** Pool for `list_id` properties on property-list tools. */
  list_ids?: readonly string[];
  /** Pool for `standards_id` properties on content-standards tools. */
  standards_ids?: readonly string[];
  /** Pool for `task_id` / `taskId` properties. */
  task_ids?: readonly string[];
  /** Pool for `plan_id` properties. */
  plan_ids?: readonly string[];
  /** Pool for `account_id` properties. */
  account_ids?: readonly string[];
  /** Pool for `package_id` / `package_ids[]` properties. */
  package_ids?: readonly string[];
  /** Pool for `format_id` / `format.id` properties. */
  format_ids?: readonly string[];
}

export type OracleVerdict = 'accepted' | 'rejected' | 'invalid';

export interface ConformanceFailure {
  /** Tool the failure was observed on. */
  tool: ConformanceToolName;
  /** Dot-path inside the request that fast-check's shrinker isolated (best-effort). */
  path?: string;
  /** Seed that reproduces this failure. */
  seed: number;
  /** Whether fast-check was able to shrink the input. */
  shrunk: boolean;
  /** Shrunk request payload that triggered the failure. */
  input: unknown;
  /** Agent's response (raw). */
  response: unknown;
  /** Oracle verdict that led to the failure. */
  verdict: OracleVerdict;
  /** Human-readable invariant messages (e.g., "reason code not in spec enum"). */
  invariantFailures: string[];
}

export type SkipReason = 'missing_schemas' | 'unresolvable_schema' | 'feature_unsupported' | 'runner_not_implemented';

export interface ConformanceToolStats {
  /** Fresh sample count. Shrinking replays are excluded. */
  runs: number;
  accepted: number;
  rejected: number;
  /** 0 or 1 — fast-check reports at most one shrunk counterexample per tool. */
  failed: 0 | 1;
  skipped: boolean;
  skipReason?: SkipReason;
}

export interface ConformanceReport {
  agentUrl: string;
  seed: number;
  /** Schema version the fuzzer loaded. Pinned so a report is replayable. */
  schemaVersion: string;
  /** Protocol used for the run. */
  protocol: 'mcp' | 'a2a';
  /** Iterations per tool that were requested. */
  turnBudget: number;
  /**
   * Snapshot of the fixture pools the run used. Empty object when
   * no fixtures were supplied. Recorded so a stored JSON report is
   * self-reproducible without the original invocation.
   */
  fixturesUsed: ConformanceFixtures;
  /**
   * Whether auto-seeding ran this cycle. When true, `seedWarnings`
   * carries any per-seeder reasons a pool ended up empty (e.g., the
   * agent rejected create_media_buy, or get_products returned no
   * products). Empty array means all requested seeders succeeded.
   */
  autoSeeded: boolean;
  seedWarnings: ReadonlyArray<{ seeder: string; reason: string }>;
  totalRuns: number;
  totalFailures: number;
  /** Count of failures dropped when `maxFailures` was hit. */
  droppedFailures: number;
  perTool: Record<string, ConformanceToolStats>;
  failures: ConformanceFailure[];
  /**
   * Uniform-error invariant results per T2 tool. Empty when no eligible
   * tool was probed (e.g., all T2 tools skipped). Each entry is the
   * byte-equivalence check for a paired probe against one tool.
   */
  uniformError: ReadonlyArray<import('./invariants/uniformError').UniformErrorReport>;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}
