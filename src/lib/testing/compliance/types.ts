/**
 * Types for AdCP Agent Compliance Assessment
 */

import type { AgentProfile, TestResult, TestScenario } from '../types';

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

export type TrackStatus = 'pass' | 'fail' | 'skip' | 'partial';

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
  /** What a correct response looks like (from storyboard YAML) */
  expected?: string;
  /** CLI command to re-run just this step for debugging */
  fix_command: string;
  /** Validation failures with runner-output-contract detail (json_pointer, expected, actual, schema_id/url). */
  validations?: Array<{
    check: string;
    description: string;
    json_pointer?: string;
    expected?: unknown;
    actual?: unknown;
    schema_id?: string;
    schema_url?: string;
    error?: string;
  }>;
  /** MCP/A2A extraction path the runner used — separates extraction bugs from agent bugs. */
  extraction?: { path: 'structured_content' | 'text_fallback' | 'error' | 'none'; note?: string };
  /** Exact request the runner sent (secrets redacted). */
  request?: { transport: 'mcp' | 'a2a' | 'http'; operation: string; payload: unknown; url?: string };
  /** Exact response observed. */
  response?: { transport: 'mcp' | 'a2a' | 'http'; payload: unknown; status?: number };
}

export interface ComplianceResult {
  agent_url: string;
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
  /** Whether the seller exposes comply_test_controller */
  controller_detected?: boolean;
  /** Scenarios the seller's test controller supports */
  controller_scenarios?: string[];
  tested_at: string;
  total_duration_ms: number;
}

export interface ComplianceSummary {
  tracks_passed: number;
  tracks_failed: number;
  tracks_skipped: number;
  tracks_partial: number;
  /** One-line status */
  headline: string;
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
