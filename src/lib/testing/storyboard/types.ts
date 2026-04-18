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
  };
  phases: StoryboardPhase[];
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
      /** Literal Bearer value sent as `Authorization: Bearer <value>`. */
      type: 'api_key';
      value?: string;
      /** Pull the value from the runtime `test_kit.auth.api_key` field. */
      from_test_kit?: boolean;
    };

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
  /** When true, the step passes if the task returns an error */
  expect_error?: boolean;
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
   * Conditional contribution expression. Current grammar:
   *   - `"prior_step.<step_id>.passed"` — contribution fires only if the named step passed.
   * Unknown expressions → the contribution does NOT fire (fail closed).
   */
  contributes_if?: string;
}

export type StoryboardValidationCheck =
  | 'response_schema'
  | 'field_present'
  | 'field_value'
  | 'status_code'
  | 'error_code'
  // HTTP-probe checks (for raw_probe tasks)
  | 'http_status'
  | 'http_status_in'
  | 'on_401_require_header'
  // Cross-cutting
  | 'resource_equals_agent_url'
  | 'any_of';

export interface StoryboardValidation {
  check: StoryboardValidationCheck;
  /** JSON path for field checks, e.g. "accounts[0].account_id" */
  path?: string;
  /** Expected value for exact-match checks. */
  value?: unknown;
  /** Accepted values for list-match checks (passes if actual matches any). */
  allowed_values?: unknown[];
  description: string;
}

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
  /** Agent's available tools (for requires_tool filtering) */
  agentTools?: string[];
  /**
   * Allow plain-http agent URLs during compliance runs. Normally rejected
   * because production agents MUST terminate TLS. Intended for local dev
   * loops (docker compose, localhost harnesses). Emits an advisory banner
   * in the report when used.
   */
  allow_http?: boolean;
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
  /** True when the step was not executed */
  skipped?: boolean;
  /** Why the step was skipped */
  skip_reason?: 'not_testable' | 'dependency_failed' | 'missing_test_harness' | 'missing_tool';
  /** True when the step expected an error (inverted pass/fail) */
  expect_error?: boolean;
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
}
