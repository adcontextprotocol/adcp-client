/**
 * Types for AdCP Agent Compliance Assessment
 *
 * comply  → "Your agent works"  (deterministic, pass/fail)
 * convince → "Your agent sells"  (AI-assessed, advisory)
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
  | 'signals' // Signal discovery, activation
  | 'si' // Sponsored intelligence sessions
  | 'audiences'; // CRM audience sync

export type TrackStatus = 'pass' | 'fail' | 'skip' | 'partial';

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
}

export interface ComplianceResult {
  agent_url: string;
  agent_profile: AgentProfile;
  /** Per-track results — every applicable track is run */
  tracks: TrackResult[];
  /** Quick summary: how many tracks pass/fail/skip */
  summary: ComplianceSummary;
  /** Advisory observations across all tracks */
  observations: AdvisoryObservation[];
  tested_at: string;
  total_duration_ms: number;
  dry_run: boolean;
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
// ADVISORY: Observations (used by both comply and convince)
// ============================================================

export type ObservationCategory =
  | 'completeness'
  | 'quality'
  | 'performance'
  | 'best_practice'
  | 'merchandising'
  | 'pricing'
  | 'relevance'
  | 'auth';

export type ObservationSeverity = 'info' | 'suggestion' | 'warning' | 'error';

export interface AdvisoryObservation {
  category: ObservationCategory;
  severity: ObservationSeverity;
  track?: ComplianceTrack;
  message: string;
  /** Concrete data backing this observation */
  evidence?: Record<string, unknown>;
}

// ============================================================
// CONVINCE: AI-Assessed Merchandising Quality
// ============================================================

export interface SampleBrief {
  id: string;
  name: string;
  vertical: string;
  brief: string;
  /** What a strong response looks like — guides AI evaluation */
  evaluation_hints: string;
  /** Budget context for the AI evaluator */
  budget_context?: string;
  /** Expected channels */
  expected_channels?: string[];
}

export type ConvinceDimension = 'relevance' | 'specificity' | 'completeness' | 'pricing' | 'merchandising';

export type ConvinceRating = 'strong' | 'moderate' | 'weak';

export interface DimensionScore {
  dimension: ConvinceDimension;
  rating: ConvinceRating;
  observation: string;
  evidence?: Record<string, unknown>;
}

export interface ScenarioAssessment {
  brief: SampleBrief;
  /** Raw products returned by the agent */
  products_returned: number;
  /** Per-dimension AI evaluation */
  dimensions: DimensionScore[];
  /** LLM-generated narrative summary */
  summary: string;
  /** Top 3 actionable improvements */
  top_actions: string[];
  /** Raw agent response for reference */
  raw_response?: unknown;
}

export interface ConvinceResult {
  agent_url: string;
  agent_profile: AgentProfile;
  /** Per-brief assessments */
  assessments: ScenarioAssessment[];
  /** Aggregated patterns across all briefs */
  patterns: ConvincePattern[];
  /** Overall narrative */
  overall_summary: string;
  tested_at: string;
  total_duration_ms: number;
  /** Which LLM provider was used */
  evaluator: string;
  dry_run: boolean;
}

export interface ConvincePattern {
  pattern: string;
  frequency: string;
  impact: string;
}

export interface ConvinceOptions {
  /** Anthropic API key */
  anthropic_api_key?: string;
  /** Google Gemini API key */
  gemini_api_key?: string;
  /** Which briefs to run (default: all) */
  brief_ids?: string[];
  /** Model to use (default: auto-select based on available key) */
  model?: string;
}
