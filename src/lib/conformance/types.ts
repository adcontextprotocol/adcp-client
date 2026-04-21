import type { AgentConfig } from '../types';

export type ConformanceToolName =
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
  | 'get_creative_features';

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
