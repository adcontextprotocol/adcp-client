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
  | 'preview_creative';

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

/** Tier 1 + Tier 2 combined. Default tool set for {@link runConformance}. */
export const DEFAULT_TOOLS: readonly ConformanceToolName[] = [
  ...STATELESS_TIER_TOOLS,
  ...REFERENTIAL_STATELESS_TOOLS,
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
  /** Pool for `list_id` properties on property-list / content-standards tools. */
  list_ids?: readonly string[];
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
  /** Arbitrary extension slot for future AdCP ID types. */
  [extensionKey: string]: readonly string[] | undefined;
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
  totalRuns: number;
  totalFailures: number;
  /** Count of failures dropped when `maxFailures` was hit. */
  droppedFailures: number;
  perTool: Record<string, ConformanceToolStats>;
  failures: ConformanceFailure[];
  startedAt: string;
  completedAt: string;
  durationMs: number;
}
