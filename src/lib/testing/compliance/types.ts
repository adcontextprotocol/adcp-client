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

export type TrackStatus = 'pass' | 'fail' | 'skip' | 'partial' | 'expected';

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
  /** Tracks skipped because the agent lacks the relevant tools */
  skipped_tracks: Array<{ track: ComplianceTrack; label: string; reason: string }>;
  /** Tracks expected by the declared platform type but not supported */
  expected_tracks: Array<{ track: ComplianceTrack; label: string; reason: string }>;
  /** Quick summary: how many tracks pass/fail/skip */
  summary: ComplianceSummary;
  /** Advisory observations across all tracks */
  observations: AdvisoryObservation[];
  /** Flat list of all failed steps for quick agent iteration */
  failures?: ComplianceFailure[];
  /** Platform coherence assessment (only when platform_type provided) */
  platform_coherence?: PlatformCoherenceResult;
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
  tracks_expected: number;
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
  | 'coherence'
  | 'error_compliance'
  | 'tool_discovery';

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
// PLATFORM TYPES: Agent Declaration Taxonomy
// ============================================================

/**
 * Sales platform types — agents that sell advertising inventory.
 * All sales agents support the core media buy tools; the platform type
 * determines what coherence checks apply to inputs, outputs, and features.
 */
export type SalesPlatformType =
  | 'display_ad_server'
  | 'video_ad_server'
  | 'social_platform'
  | 'pmax_platform'
  | 'dsp'
  | 'retail_media'
  | 'search_platform'
  | 'audio_platform'
  | 'linear_tv_platform';

/**
 * Creative agent types — differ in statefulness and tool surface.
 */
export type CreativeAgentType = 'creative_transformer' | 'creative_library' | 'creative_ad_server';

/**
 * Sponsored intelligence agent types — AI chat/conversational monetization.
 */
export type SponsoredIntelligenceType = 'si_platform';

/**
 * AI-native platform types — platforms with AI at the core.
 */
export type AINativePlatformType = 'ai_ad_network' | 'ai_platform' | 'generative_dsp';

export type PlatformType = SalesPlatformType | CreativeAgentType | SponsoredIntelligenceType | AINativePlatformType;

// ============================================================
// PLATFORM BEHAVIORAL CHARACTERISTICS
// ============================================================

/** How inventory is allocated to buyers */
export type InventoryModel = 'reserved' | 'auction' | 'guaranteed' | 'hybrid';

/** Pricing models the platform supports — visible in get_products responses */
export type PricingModel = 'cpm' | 'cpc' | 'cpp' | 'flat' | 'auction';

/**
 * A coherence finding: something expected by the platform type
 * that is missing or inconsistent in the agent's actual capabilities.
 */
export interface CoherenceFinding {
  /** What was expected based on the platform type */
  expected: string;
  /** What was actually found (or not found) */
  actual: string;
  /** Actionable guidance for the developer */
  guidance: string;
  severity: 'error' | 'warning' | 'suggestion';
}

/**
 * Platform-type-aware section of the compliance result.
 * Only present when platform_type was provided in options.
 */
export interface PlatformCoherenceResult {
  platform_type: PlatformType;
  /** Human-readable label for the platform type */
  label: string;
  /** Tracks that this platform type expects the agent to support */
  expected_tracks: ComplianceTrack[];
  /** Tracks that are expected but the agent doesn't support */
  missing_tracks: ComplianceTrack[];
  /** Specific coherence findings */
  findings: CoherenceFinding[];
  /** Overall coherence: does the agent match what it claims to be? */
  coherent: boolean;
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
