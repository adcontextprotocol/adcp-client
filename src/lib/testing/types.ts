/**
 * Types for AdCP Agent E2E Testing
 */

// Test scenarios that can be run
export type TestScenario =
  | 'health_check' // Just check if agent responds
  | 'discovery' // get_products, list_creative_formats, list_authorized_properties
  | 'create_media_buy' // Discovery + create a test media buy
  | 'full_sales_flow' // Full lifecycle: discovery -> create -> update -> delivery
  | 'creative_sync' // Test sync_creatives flow
  | 'creative_inline' // Test inline creatives in create_media_buy
  | 'creative_reference' // Test reference creatives (creative_ids)
  | 'pricing_models' // Test different pricing models the agent supports
  | 'creative_flow' // Creative agent: list_formats -> build -> preview
  | 'signals_flow' // Signals agent: get_signals -> activate
  // Edge case testing scenarios
  | 'error_handling' // Test agent returns proper error responses
  | 'validation' // Test schema validation (invalid inputs should be rejected)
  | 'pricing_edge_cases' // Test auction vs fixed pricing, min spend, bid_price requirements
  | 'temporal_validation' // Test date/time ordering and format validation
  // Behavioral analysis scenarios
  | 'behavior_analysis' // Analyze agent behavior: auth requirements, brief relevance, filtering
  // Response consistency scenarios
  | 'response_consistency'; // Check for schema errors, pagination bugs, data mismatches

export interface TestOptions {
  // Custom brief for product discovery
  brief?: string;
  // Budget for test media buy (default: 1000)
  budget?: number;
  // Specific format IDs to test
  format_ids?: string[];
  // Test session ID for isolation
  test_session_id?: string;
  // Whether to use dry-run mode (default: true for safety)
  dry_run?: boolean;
  // Channels to focus on (if not specified, tests all agent supports)
  channels?: string[];
  // Specific pricing models to test
  pricing_models?: string[];
  // Authentication for agents that require it
  auth?: {
    type: 'bearer';
    token: string;
  };
  // Brand manifest for creative testing
  brand_manifest?: {
    name: string;
    url?: string;
    tagline?: string;
    logos?: Array<{ url: string; tags?: string[] }>;
    colors?: Record<string, string>;
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
}

export interface TestStepResult {
  step: string;
  task?: string;
  passed: boolean;
  duration_ms: number;
  details?: string;
  error?: string;
  response_preview?: string;
  // For tracking what was created (for cleanup or follow-up)
  created_id?: string;
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
    format_id: string;
    name?: string;
    type?: string;
    required_assets?: string[];
    optional_assets?: string[];
  }>;
  // For signals agents
  supported_signals?: Array<{
    signal_id: string;
    name?: string;
    type?: string;
  }>;
}

export interface TestResult {
  agent_url: string;
  scenario: TestScenario;
  overall_passed: boolean;
  steps: TestStepResult[];
  summary: string;
  total_duration_ms: number;
  tested_at: string;
  // Agent profile discovered during testing
  agent_profile?: AgentProfile;
  // Was this run in dry-run mode?
  dry_run: boolean;
}

// Generic task result from executeTask
export interface TaskResult {
  success: boolean;
  data?: any;
  error?: string;
}

// Logger interface for library use
export interface Logger {
  info: (context: object, message: string) => void;
  error: (context: object, message: string) => void;
  warn: (context: object, message: string) => void;
  debug: (context: object, message: string) => void;
}
