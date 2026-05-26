/**
 * Types for AdCP Agent Compliance Assessment
 */

import type { AgentProfile, TestResult, TestScenario } from '../types';
import type { AdcpErrorInfo } from '../../core/ConversationTypes';
import type { RunnerNotice, RunnerSelectionReason, RunnerSkipReason } from '../storyboard/types';

// ============================================================
// COMPLY: Capability Tracks
// ============================================================

/**
 * Capability tracks are independent areas of protocol compliance.
 * An agent can be strong in creative but skip media buy — tracks
 * are assessed independently, not as linear levels.
 */
export type ComplianceTrack =
  | 'core' // Reachable, discoverable, capabilities declared
  | 'products' // Product discovery works, schema-valid responses
  | 'media_buy' // Create, update, status management
  | 'creative' // Sync, approve/reject, format management
  | 'reporting' // Delivery data, reporting mechanisms
  | 'governance' // Property lists, content standards
  | 'campaign_governance' // Campaign governance lifecycle: sync, check, report, audit
  | 'signals' // Signal discovery, activation
  | 'si' // Sponsored intelligence sessions
  | 'audiences' // CRM audience sync
  | 'error_handling' // Error response structure and transport compliance
  | 'brand'; // Brand identity, rights licensing, creative approval

/**
 * Per-track compliance verdict.
 *
 * - `pass` — every observation-based assertion observed at least one
 *   resource and nothing failed.
 * - `silent` — every observation-based assertion ran with zero
 *   observations and nothing failed. The track is wired but its
 *   lifecycle protections were not exercised this run, so it has
 *   nothing to attest. Distinct from `pass` (real protection was
 *   validated) and `skip` (the track did not run). Companion to
 *   adcontextprotocol/adcp#2834 on the grader side.
 * - `fail` / `partial` / `skip` — unchanged.
 */
export type TrackStatus = 'pass' | 'fail' | 'skip' | 'partial' | 'silent';

export type OverallStatus = 'passing' | 'failing' | 'partial' | 'auth_required' | 'unreachable';

export interface TrackResult {
  track: ComplianceTrack;
  status: TrackStatus;
  /** Human-readable label for this track */
  label: string;
  /** Scenarios that were run for this track */
  scenarios: TestResult[];
  /** Scenarios skipped (agent doesn't support required tools) */
  skipped_scenarios: TestScenario[];
  /** Advisory observations collected during this track */
  observations: AdvisoryObservation[];
  /** Total time for this track */
  duration_ms: number;
  /** Compliance testing mode: observational (default) or deterministic (test controller available) */
  mode?: 'observational' | 'deterministic';
  /**
   * View marker disambiguating the same `TrackResult` appearing in
   * both `ComplianceResult.tracks` (canonical source of truth) and
   * `ComplianceResult.tested_tracks` (the filtered subset of passing/
   * failing/partial/silent tracks). Because `tested_tracks` is built
   * by filtering `tracks`, every passing track appears in both arrays.
   * JSON output of a `ComplianceResult` therefore serializes each
   * scenario twice — triagers grepping the output without this marker
   * saw spurious "duplicate execution" signals (adcp-client#1674).
   *
   * - `'canonical'` — entry appears in `tracks` (the source of truth).
   * - `'reference'` — entry appears in `tested_tracks` (a filtered view).
   *
   * Consumers that want a deduplicated view should iterate `tracks`
   * and ignore `tested_tracks`, or filter on `_view === 'canonical'`.
   * CI pipelines that pin on a stable, dedupe-by-design surface should
   * read `buildComplianceSummary()` / `--summary-output` instead.
   *
   * The breaking type-split that fully removes the duplication is
   * tracked at adcp-client#1791.
   */
  _view?: 'canonical' | 'reference';
}

/**
 * A single failed step from a compliance assessment.
 * Designed for agent consumption — includes everything needed to
 * diagnose the failure and re-run the step.
 */
export interface ComplianceFailure {
  track: ComplianceTrack;
  storyboard_id: string;
  step_id: string;
  step_title: string;
  task: string;
  error?: string;
  /**
   * Structured AdCP error from the transport layer. Present when the agent
   * returned a structured `adcp_error` envelope (code, field, details).
   * Complements the human-readable `error` string — use this field for
   * machine-readable self-correction (the `field` and `details.validation_errors`
   * sub-fields identify the exact fault address without re-running the step).
   */
  adcp_error?: AdcpErrorInfo;
  /** Human-readable expected behavior (from storyboard YAML). */
  expected?: string;
  /** CLI command to re-run just this step for debugging */
  fix_command: string;
  /**
   * Structured failure details from the first failed validation, per the
   * runner-output contract. `undefined` when the step itself failed before
   * any validation ran.
   */
  validation?: {
    check: string;
    description: string;
    json_pointer?: string | null;
    expected?: unknown;
    actual?: unknown;
    schema_id?: string | null;
    schema_url?: string | null;
  };
}

export interface ComplianceResult {
  agent_url: string;
  /** AdCP compliance cache version used for this assessment. */
  adcp_version?: string;
  agent_profile: AgentProfile;
  /** Machine-readable overall status */
  overall_status: OverallStatus;
  /** Per-track results — every applicable track is run */
  tracks: TrackResult[];
  /** Only tracks that were actually tested (status is pass/fail/partial) */
  tested_tracks: TrackResult[];
  /** Tracks skipped because no storyboards produced results */
  skipped_tracks: Array<{ track: ComplianceTrack; label: string; reason: string }>;
  /** Quick summary: how many tracks pass/fail/skip */
  summary: ComplianceSummary;
  /** Advisory observations across all tracks */
  observations: AdvisoryObservation[];
  /** Flat list of all failed steps for quick agent iteration */
  failures?: ComplianceFailure[];
  /** Storyboard IDs that were resolved and executed */
  storyboards_executed?: string[];
  /** Storyboard IDs graded not-applicable because the agent's declared major version predates the storyboard */
  storyboards_not_applicable?: string[];
  /**
   * Storyboard IDs graded not-applicable because the agent declared the protocol
   * but a required tool was absent from the discovered toolset.
   *
   * Contains only storyboard IDs. For the per-storyboard list of which tools were
   * missing, see `ComplianceSummaryArtifact.skip_causes`.
   *
   * **Gap detection**: the total coverage gap is
   * `[...storyboards_not_applicable, ...storyboards_missing_tools]`. Consumers
   * previously relying on `storyboards_not_applicable.length === 0` to assert
   * zero gaps must also check this field.
   */
  storyboards_missing_tools?: string[];
  /** Whether the seller exposes comply_test_controller */
  controller_detected?: boolean;
  /** Scenarios the seller's test controller supports */
  controller_scenarios?: string[];
  tested_at: string;
  total_duration_ms: number;
  /**
   * Protocol-compliance advisories aggregated across all storyboard runs,
   * deduplicated by `code`. Always present (default `[]`) — mirrors the
   * always-present invariant on `StoryboardResult.notices` so adopters
   * can iterate `for (const n of result.notices)` at either level without
   * a defensive `?.`. For per-storyboard notices see `StoryboardResult.notices`.
   *
   * Spec: adcp-client#1704.
   */
  notices: RunnerNotice[];
}

export interface ComplianceSummary {
  tracks_passed: number;
  tracks_failed: number;
  tracks_skipped: number;
  tracks_partial: number;
  /**
   * Tracks where every observation-based invariant ran but observed
   * zero lifecycle resources — wired but not exercised. Counted
   * separately from `tracks_passed` so dashboards can avoid
   * over-crediting silent tracks as real protection.
   */
  tracks_silent: number;
  /** One-line status */
  headline: string;
  /** Total storyboard steps executed (per the runner-output contract). */
  total_steps?: number;
  /** Storyboard steps that passed. */
  steps_passed?: number;
  /** Storyboard steps that failed. */
  steps_failed?: number;
  /** Storyboard steps that were skipped. */
  steps_skipped?: number;
  /** Storyboard steps excluded before execution by run selection. */
  steps_not_selected?: number;
  /** Machine-readable selection exclusions, one record per excluded step/item. */
  not_selected?: ComplianceNotSelectedRecord[];
  /** Aggregate counts by selection-exclusion reason. */
  not_selected_by_reason?: Partial<Record<RunnerSelectionReason, number>>;
  /** Aggregate counts by canonical selected-but-skipped reason. */
  skipped_by_reason?: Partial<Record<RunnerSkipReason | string, number>>;
  /**
   * Validation results graded `not_applicable` because the runner did not
   * implement the storyboard's authored `check` kind (forward-compat
   * default). Surfaces "runner is older than the storyboard" as a distinct
   * signal from clean passes. Per runner-output-contract.yaml v2.0.0
   * run_summary optional field.
   */
  validations_not_applicable?: number;
  /**
   * Schemas applied across all storyboards. Implementors can re-validate
   * locally against the same artifacts the runner used.
   */
  schemas_used?: Array<{ schema_id: string; schema_url: string }>;
}

export interface ComplianceNotSelectedRecord {
  reason: RunnerSelectionReason;
  detail: string;
  storyboard_id?: string;
  phase_id?: string;
  step_id?: string;
}

// ============================================================
// ADVISORY: Observations
// ============================================================

export type ObservationCategory =
  | 'completeness'
  | 'quality'
  | 'performance'
  | 'best_practice'
  | 'merchandising'
  | 'pricing'
  | 'relevance'
  | 'auth'
  | 'error_compliance'
  | 'tool_discovery';

export type ObservationSeverity = 'info' | 'suggestion' | 'warning' | 'error';

/**
 * Provenance for an `AdvisoryObservation`. Every observation must carry
 * a `source` so triagers can trace the finding back to the rule that
 * fired and the storyboard/step coordinates that produced it.
 *
 * The discriminated union distinguishes:
 *
 * - `storyboard_step` — observation came from inspecting a specific
 *   step in a storyboard run. Has both `storyboard_id` and `step_id`,
 *   so a triager can grep the storyboard YAML directly.
 * - `storyboard` — observation aggregates across a storyboard's
 *   scenarios (e.g. "lifecycle scenario revealed missing pause/resume").
 *   Has `storyboard_id` but no specific step.
 * - `profile` — observation derived from the agent's discovered
 *   capability profile, not from any storyboard step (e.g. "agent
 *   exposes only 2 tools"). No storyboard coordinates apply.
 * - `probe` — observation came from a network probe outside the
 *   storyboard pipeline (e.g. auth-failure detection on a 401
 *   discovery response). No storyboard coordinates apply.
 *
 * **`storyboard_id` shape note.** This field is sourced from
 * `TestResult.scenario`, which the storyboard runner constructs as
 * `${storyboard_id}/${phase_id}` (see `storyboard-tracks.ts`). So
 * `source.storyboard_id` is a composite "storyboard/phase" identifier,
 * not the bare storyboard ID. Greppable against the storyboard YAML
 * either way; the composite form gives extra phase-level specificity
 * even when `step_id` is also present.
 *
 * **`code` casing note.** `code` is intentionally kebab-case
 * (e.g. `slow-response`, `missing-valid-actions`) to match storyboard
 * step-id conventions in the compliance YAML cache, even though the
 * rest of the public SDK surface (`storyboard_id`, `step_id`,
 * `agent_url`, …) is snake_case. Adopters greppable-searching
 * compliance reports should expect the kebab form.
 *
 * adcp-client#1746.
 */
export type ObservationSource =
  | { kind: 'storyboard_step'; code: string; storyboard_id: string; step_id: string }
  | { kind: 'storyboard'; code: string; storyboard_id: string }
  | { kind: 'profile'; code: string }
  | { kind: 'probe'; code: string };

export interface AdvisoryObservation {
  category: ObservationCategory;
  severity: ObservationSeverity;
  track?: ComplianceTrack;
  /**
   * Human-readable message. Any agent-controlled substrings are fenced
   * with a random per-observation nonce; safe to pass to LLM summarizers
   * of a shared ComplianceResult.
   */
  message: string;
  /**
   * Concrete data backing this observation. May contain raw agent-controlled
   * text (e.g. `agent_reported_error`). Operator-only — MUST NOT be fed to
   * LLM summarizers, since it bypasses the fencing applied to `message`.
   */
  evidence?: Record<string, unknown>;
  /**
   * Required provenance. Every emission site populates this; the regression
   * test in `test/lib/comply-advisory-rule-source.test.js` fails the build
   * if any observation slips through without it. See `ObservationSource`.
   *
   * adcp-client#1746.
   */
  source: ObservationSource;
}

// ============================================================
// Sample Briefs (for use by platforms and testing tools)
// ============================================================

export interface SampleBrief {
  id: string;
  name: string;
  vertical: string;
  brief: string;
  /** What a strong response looks like */
  evaluation_hints: string;
  /** Budget context for evaluation */
  budget_context?: string;
  /** Expected channels */
  expected_channels?: string[];
}
