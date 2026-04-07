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
  /** Platform types this storyboard applies to (for backwards compat with PlatformType) */
  platform_types?: string[];
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
}

export interface StoryboardStep {
  id: string;
  title: string;
  narrative?: string;
  /** AdCP task name (snake_case), e.g. "sync_accounts", "get_products" */
  task: string;
  schema_ref?: string;
  response_schema_ref?: string;
  doc_ref?: string;
  /** Maps to existing @adcp/client test scenario (legacy, partial coverage) */
  comply_scenario?: string;
  /** Whether this step depends on state from a previous step */
  stateful?: boolean;
  expected?: string;
  sample_request?: Record<string, unknown>;
  sample_response?: Record<string, unknown>;
  validations?: StoryboardValidation[];
}

export interface StoryboardValidation {
  check: 'response_schema' | 'field_present' | 'field_value' | 'status_code';
  /** JSON path for field checks, e.g. "accounts[0].account_id" */
  path?: string;
  /** Expected value for field_value checks */
  value?: unknown;
  description: string;
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
}

// ────────────────────────────────────────────────────────────
// Results
// ────────────────────────────────────────────────────────────

export interface ValidationResult {
  check: string;
  passed: boolean;
  description: string;
  path?: string;
  error?: string;
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
  step_id: string;
  phase_id: string;
  title: string;
  task: string;
  passed: boolean;
  duration_ms: number;
  response?: unknown;
  validations: ValidationResult[];
  /** Accumulated context after this step */
  context: StoryboardContext;
  error?: string;
  /** Preview of the next step (for LLM consumption) */
  next?: StoryboardStepPreview;
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
  agent_url: string;
  overall_passed: boolean;
  phases: StoryboardPhaseResult[];
  /** Final accumulated context */
  context: StoryboardContext;
  total_duration_ms: number;
  passed_count: number;
  failed_count: number;
  skipped_count: number;
  tested_at: string;
  dry_run: boolean;
}
