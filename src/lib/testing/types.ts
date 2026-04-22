/**
 * Types for AdCP Agent E2E Testing
 */

import type { FormatID } from '../types/core.generated';
import type { ControllerDetection } from './test-controller';

// Test scenarios that can be run
export type TestScenario =
  | 'health_check' // Just check if agent responds
  | 'discovery' // get_products, list_creative_formats, list_authorized_properties
  | 'create_media_buy' // Discovery + create a test media buy
  | 'full_sales_flow' // Full lifecycle: discovery -> create -> update -> delivery
  | 'reporting_flow' // Dedicated: create media buy -> get_media_buy_delivery validation
  | 'creative_sync' // Test sync_creatives flow
  | 'creative_inline' // Test inline creatives in create_media_buy
  | 'creative_reference' // Build -> sync -> reference a creative via creative_ids
  | 'pricing_models' // Test different pricing models the agent supports
  | 'creative_flow' // Creative agent: list_formats -> build -> preview
  | 'creative_lifecycle' // Creative agent: formats -> sync multiple -> list with/without snapshot -> build/preview
  | 'signals_flow' // Signals agent: get_signals -> activate
  // Edge case testing scenarios
  | 'error_handling' // Test agent returns proper error responses
  | 'validation' // Test schema validation (invalid inputs should be rejected)
  | 'pricing_edge_cases' // Test auction vs fixed pricing, min spend, bid_price requirements
  | 'temporal_validation' // Test date/time ordering and format validation
  // Behavioral analysis scenarios
  | 'behavior_analysis' // Analyze agent behavior: auth requirements, brief relevance, filtering
  // Response consistency scenarios
  | 'response_consistency' // Check for schema errors, pagination bugs, data mismatches
  // v3 Governance protocol scenarios
  | 'governance_property_lists' // Property list CRUD operations
  | 'governance_content_standards' // Content standards lifecycle
  | 'property_list_filters' // Property list filter round-trip: GARM, MFA, custom_tags, feature_requirements
  // v3 Campaign governance scenarios
  | 'campaign_governance' // Full lifecycle: sync_plans -> check -> execute -> report outcome
  | 'campaign_governance_denied' // Denied flow: over-budget, unauthorized market
  | 'campaign_governance_conditions' // Conditions flow: apply conditions -> re-check
  | 'campaign_governance_delivery' // Delivery monitoring with drift detection
  | 'seller_governance_context' // Seller persistence of governance_context
  // v3 SI (Sponsored Intelligence) protocol scenarios
  | 'si_session_lifecycle' // Full SI session: initiate -> messages -> terminate
  | 'si_availability' // Check SI offering availability
  | 'si_handoff' // ACP handoff flow: initiate -> purchase intent -> terminate with handoff_transaction
  // v3 Capability discovery
  | 'capability_discovery' // Verify get_adcp_capabilities response
  // Schema compliance
  | 'schema_compliance' // Validate v3 channel enum, pricing field names, format assets structure
  // Audience management
  | 'sync_audiences' // Test CRM audience sync flow
  // State machine compliance
  | 'media_buy_lifecycle' // Pause -> resume -> cancel state transitions
  | 'terminal_state_enforcement' // Verify agents reject updates to terminal-state media buys
  | 'package_lifecycle' // Package-level pause/resume independent of media buy status
  // Error compliance (transport error mapping spec)
  | 'error_codes' // Validate standard AdCP error codes in responses
  | 'error_structure' // Validate error JSON structure against error.json schema
  | 'error_transport' // Validate transport binding (structuredContent, text fallback)
  // Deterministic state machine scenarios (require comply_test_controller)
  | 'deterministic_creative' // Force creative status transitions via test controller
  | 'deterministic_media_buy' // Force media buy status transitions via test controller
  | 'deterministic_account' // Force account status transitions + operation gates
  | 'deterministic_session' // Force SI session timeout/termination
  | 'deterministic_delivery' // Simulate delivery data and verify reporting
  | 'deterministic_budget' // Simulate budget spend and verify financials
  | 'controller_validation' // Validate the test controller itself (error codes, edge cases)
  // Brand rights protocol scenarios
  | 'brand_identity' // Brand identity discovery (public and authorized access tiers)
  | 'brand_rights_flow' // Brand rights: get_rights -> acquire_rights lifecycle
  | 'creative_approval'; // Creative approval workflow for brand compliance

export interface TestOptions {
  // Protocol to use for testing (default: 'mcp')
  protocol?: 'mcp' | 'a2a';
  /** Custom User-Agent string sent with all outbound requests */
  userAgent?: string;
  // Brand reference for product discovery (preferred over brand_manifest)
  brand?: { domain: string; brand_id?: string };
  // Custom brief for product discovery
  brief?: string;
  // Budget for test media buy (default: 1000)
  budget?: number;
  // Specific format IDs to test
  format_ids?: string[];
  // Test session ID for isolation
  test_session_id?: string;
  // Channels to focus on (if not specified, tests all agent supports)
  channels?: string[];
  // Specific pricing models to test
  pricing_models?: string[];
  /**
   * Authentication for agents that require it.
   *
   * - `bearer`: raw token sent as `Authorization: Bearer <token>`.
   * - `basic`: cleartext `username` and `password`, encoded internally.
   * - `oauth`: saved OAuth tokens (access_token + refresh_token). MCP only.
   *   The library auto-refreshes on 401. Obtain tokens interactively via
   *   `adcp --save-auth <alias> --oauth`, then pass the saved blob here for
   *   non-interactive reuse.
   * - `oauth_client_credentials`: RFC 6749 §4.4 machine-to-machine flow.
   *   The library exchanges the secret for a fresh access token before each
   *   call (cached while valid). Supply `tokens` to seed the cache; omit to
   *   exchange on first call.
   */
  auth?:
    | { type: 'bearer'; token: string }
    | { type: 'basic'; username: string; password: string }
    | {
        type: 'oauth';
        tokens: import('../types/adcp').AgentOAuthTokens;
        client?: import('../types/adcp').AgentOAuthClient;
      }
    | {
        type: 'oauth_client_credentials';
        credentials: import('../types/adcp').AgentOAuthClientCredentials;
        tokens?: import('../types/adcp').AgentOAuthTokens;
      };
  // Brand manifest for creative testing
  brand_manifest?: {
    name: string;
    url?: string;
    tagline?: string;
    logos?: Array<{
      url: string;
      orientation?: 'square' | 'horizontal' | 'vertical' | 'stacked';
      background?: 'dark-bg' | 'light-bg' | 'transparent-bg';
      variant?: 'primary' | 'secondary' | 'icon' | 'wordmark' | 'full-lockup';
      tags?: string[];
      usage?: string;
      width?: number;
      height?: number;
    }>;
    colors?: Record<string, string>;
    tone?: {
      voice?: string;
      attributes?: string[];
      dos?: string[];
      donts?: string[];
    };
    assets?: Array<{
      asset_id: string;
      asset_type: string;
      url: string;
      width?: number;
      height?: number;
      tags?: string[];
    }>;
  };
  // For creative testing: test multiple formats programmatically
  test_all_formats?: boolean;
  // For creative testing: max formats to test when test_all_formats is true
  max_formats_to_test?: number;
  // For signals testing: specific signal types to test
  signal_types?: string[];
  // For governance testing: name for test property list
  property_list_name?: string;
  // For governance testing: specific content standards to test
  content_standards_id?: string;
  // For SI testing: specific offering ID to test
  si_offering_id?: string;
  // For SI testing: initial conversation context
  si_context?: string;
  // For audience testing: account ID to use with sync_audiences
  audience_account_id?: string;
  // When true, use sandbox mode. For implicit accounts, uses the natural key with
  // sandbox: true. For explicit accounts, discovers sandbox accounts via list_accounts.
  sandbox?: boolean;
  /**
   * Fictional-entity test-kit data loaded from `test-kits/<name>.yaml`.
   * Storyboard phases may skip based on fields here (e.g. `skip_if: "!test_kit.auth.api_key"`).
   */
  test_kit?: {
    auth?: {
      /** API key the runner presents on API-key probes. */
      api_key?: string;
      /**
       * Auth-required, read-only tool the runner uses for unauth + invalid-key probes.
       * Required whenever `auth` is declared — no default is substituted. Must be one of
       * the values in `PROBE_TASK_ALLOWLIST`. Kits that miss this or pick a task outside
       * the allowlist fail at `comply()` / `runStoryboard()` entry with
       * `TestKitValidationError`.
       */
      probe_task: string;
    };
    [key: string]: unknown;
  };
  /** @internal Pre-created client from comply() — avoids per-scenario MCP reconnection */
  _client?: unknown;
  /** @internal Pre-discovered profile from comply() — skips per-scenario discovery */
  _profile?: AgentProfile;
  /** @internal Test controller capabilities from comply() — set when comply_test_controller detected */
  _controllerCapabilities?: ControllerDetection;
}

export interface TestStepResult {
  step: string;
  task?: string;
  passed: boolean;
  duration_ms: number;
  details?: string;
  error?: string;
  response_preview?: string;
  // Structured data for collectObservations() — decoupled from response_preview display
  observation_data?: Record<string, unknown>;
  // For tracking what was created (for cleanup or follow-up)
  created_id?: string;
  // Deprecation or other warnings
  warnings?: string[];
  /** True when the step was skipped (including re-graded branch-set peers). */
  skipped?: boolean;
  /** Canonical skip reason when `skipped` is true; maps to `RunnerSkipReason`. */
  skip_reason?: string;
}

export interface AgentProfile {
  name: string;
  tools: string[];
  channels?: string[];
  pricing_models?: string[];
  format_ids?: string[];
  delivery_types?: string[];
  // For creative agents
  supported_formats?: Array<{
    format_id: FormatID;
    name?: string;
    required_assets?: string[];
    optional_assets?: string[];
  }>;
  // For signals agents
  supported_signals?: Array<{
    signal_id: string;
    name?: string;
    type?: string;
  }>;
  // v3 capabilities
  adcp_version?: 'v2' | 'v3';
  /**
   * AdCP major versions the agent declared in `get_adcp_capabilities.adcp.major_versions`.
   * Drives version-gated storyboard filtering so a v3.0 agent isn't failed against a
   * storyboard introduced in a later minor version.
   */
  adcp_major_versions?: number[];
  supported_protocols?: string[];
  /** Specialism claims from get_adcp_capabilities.specialisms */
  specialisms?: string[];
  supports_governance?: boolean;
  supports_si?: boolean;
  /**
   * Populated when the agent advertises `get_adcp_capabilities` but the call failed
   * or returned no data. Signals the compliance runner that the universal-only
   * result is due to a broken caps probe, not an agent that lacks v3 support.
   */
  capabilities_probe_error?: string;
}

export interface TestResult {
  agent_url: string;
  scenario: TestScenario;
  overall_passed: boolean;
  steps?: TestStepResult[];
  summary: string;
  total_duration_ms: number;
  tested_at: string;
  // Agent profile discovered during testing
  agent_profile?: AgentProfile;
}

export interface SuiteResult {
  agent_url: string;
  agent_profile: AgentProfile;
  /** Scenarios that were run */
  scenarios_run: TestScenario[];
  /** Scenarios skipped because the agent does not advertise the required tools */
  scenarios_skipped: TestScenario[];
  results: TestResult[];
  /**
   * True only when at least one scenario ran and none failed.
   * False for both "all failed" and "no applicable scenarios found".
   */
  overall_passed: boolean;
  passed_count: number;
  failed_count: number;
  /** Wall-clock time including capability discovery and all scenario runs */
  total_duration_ms: number;
  tested_at: string;
}

// Generic task result from executeTask
export interface TaskResult {
  success: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- response shape varies by tool; typed per-access in scenarios
  data?: any;
  error?: string;
  /**
   * Internal: which MCP extraction path produced `data`. Set by the response
   * unwrapper and the raw MCP probe so the storyboard runner can surface it
   * in its output contract. Consumers outside the runner should treat this
   * as implementation detail — it's NOT part of the public `AdCPResponse`.
   */
  _extraction_path?: 'structured_content' | 'text_fallback' | 'error' | 'none';
}

// Logger interface for library use
export interface Logger {
  info: (context: object, message: string) => void;
  error: (context: object, message: string) => void;
  warn: (context: object, message: string) => void;
  debug: (context: object, message: string) => void;
}
