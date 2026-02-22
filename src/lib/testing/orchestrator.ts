/**
 * Test Suite Orchestrator for AdCP Agents
 *
 * Discovers agent capabilities and runs all applicable test scenarios,
 * aggregating results into a single suite report.
 */

import { testAgent } from './agent-tester';
import { createTestClient, discoverAgentProfile } from './client';
import type { TestScenario, TestOptions, TestResult, AgentProfile, SuiteResult } from './types';

/**
 * Minimum tools required for each scenario to be applicable.
 * ALL listed tools must be present in the agent's tool list.
 * Scenarios with an empty array are always applicable.
 *
 * Scenarios omitted from this map are not orchestrated:
 * - creative_reference: not yet implemented
 * - sync_audiences: not yet wired into testAgent()
 */
export const SCENARIO_REQUIREMENTS: Partial<Record<TestScenario, string[]>> = {
  // Always applicable
  health_check: [],
  discovery: [],
  capability_discovery: [],

  // Requires media buy core tools
  create_media_buy: ['get_products', 'create_media_buy'],
  full_sales_flow: ['get_products', 'create_media_buy'],
  creative_inline: ['get_products', 'create_media_buy'],
  temporal_validation: ['get_products', 'create_media_buy'],
  creative_sync: ['get_products', 'create_media_buy', 'sync_creatives'],

  // Requires get_products
  pricing_edge_cases: ['get_products'],
  pricing_models: ['get_products'],
  error_handling: ['get_products'],
  validation: ['get_products'],
  behavior_analysis: ['get_products'],
  response_consistency: ['get_products'],

  // Requires creative agent tools
  creative_flow: ['build_creative'],

  // Requires signals tools
  signals_flow: ['get_signals'],

  // Requires governance tools
  governance_property_lists: ['create_property_list'],
  governance_content_standards: ['list_content_standards'],

  // Requires SI tools
  si_session_lifecycle: ['si_initiate_session'],
  si_availability: ['si_get_offering'],
};

/**
 * Default set of scenarios the orchestrator will attempt.
 * Excludes unimplemented scenarios and deduplicates coverage
 * (pricing_models is omitted since pricing_edge_cases covers the same ground).
 */
export const DEFAULT_SCENARIOS: readonly TestScenario[] = [
  'health_check',
  'discovery',
  'capability_discovery',
  'create_media_buy',
  'full_sales_flow',
  'creative_sync',
  'creative_inline',
  'pricing_edge_cases',
  'error_handling',
  'validation',
  'temporal_validation',
  'behavior_analysis',
  'response_consistency',
  'creative_flow',
  'signals_flow',
  'governance_property_lists',
  'governance_content_standards',
  'si_session_lifecycle',
  'si_availability',
] as const;

/**
 * Options for testAllScenarios(), extending single-scenario TestOptions
 * with an optional scenario filter.
 */
export interface OrchestratorOptions extends TestOptions {
  /** Limit which scenarios to attempt (defaults to DEFAULT_SCENARIOS) */
  scenarios?: TestScenario[];
}

function isApplicable(scenario: TestScenario, tools: string[]): boolean {
  if (!(scenario in SCENARIO_REQUIREMENTS)) return false;
  const requirements = SCENARIO_REQUIREMENTS[scenario]!;
  return requirements.every(tool => tools.includes(tool));
}

/**
 * Return the subset of candidate scenarios that are applicable for an agent
 * with the given tool list.
 *
 * @param tools - Tool names from getAgentInfo()
 * @param filter - Scenarios to consider; defaults to DEFAULT_SCENARIOS
 */
export function getApplicableScenarios(tools: string[], filter?: readonly TestScenario[]): TestScenario[] {
  const candidates = filter ?? DEFAULT_SCENARIOS;
  return (candidates as TestScenario[]).filter(s => isApplicable(s, tools));
}

/**
 * Run all applicable test scenarios against an agent and return aggregated results.
 *
 * Scenarios are run sequentially. Each scenario re-uses the same TestOptions
 * (including auth, dry_run, brand, etc.). The total duration includes the
 * initial capability discovery call.
 *
 * Note: testAllScenarios creates a client for capability discovery, then each
 * testAgent call creates its own client internally. This is intentional — testAgent
 * is designed as a standalone function and sharing state between scenarios could
 * cause cross-scenario interference.
 */
export async function testAllScenarios(agentUrl: string, options: OrchestratorOptions = {}): Promise<SuiteResult> {
  const start = Date.now();
  const { scenarios: scenarioFilter, ...testOptions } = options;

  const effectiveOptions: TestOptions = {
    ...testOptions,
    dry_run: testOptions.dry_run !== false,
    test_session_id: testOptions.test_session_id || `addie-suite-${Date.now()}`,
  };

  // Discover the agent's tools to determine which scenarios apply.
  // If discovery fails (agent unreachable or rejects the request), return early
  // rather than attempting scenarios with no tool information.
  const client = createTestClient(agentUrl, effectiveOptions.protocol ?? 'mcp', effectiveOptions);
  const { profile, step: profileStep } = await discoverAgentProfile(client);

  if (!profileStep.passed) {
    return {
      agent_url: agentUrl,
      agent_profile: profile,
      scenarios_run: [],
      scenarios_skipped: [],
      results: [],
      overall_passed: false,
      passed_count: 0,
      failed_count: 0,
      total_duration_ms: Date.now() - start,
      tested_at: new Date().toISOString(),
      dry_run: effectiveOptions.dry_run !== false,
    };
  }

  const applicable = getApplicableScenarios(profile.tools, scenarioFilter);
  const candidates: readonly TestScenario[] = scenarioFilter ?? DEFAULT_SCENARIOS;
  const skipped = (candidates as TestScenario[]).filter(s => !applicable.includes(s));

  // Run each applicable scenario sequentially
  const results: TestResult[] = [];
  for (const scenario of applicable) {
    const result = await testAgent(agentUrl, scenario, effectiveOptions);
    results.push(result);
  }

  const passedCount = results.filter(r => r.overall_passed).length;
  const failedCount = results.filter(r => !r.overall_passed).length;

  return {
    agent_url: agentUrl,
    agent_profile: profile,
    scenarios_run: applicable,
    scenarios_skipped: skipped,
    results,
    overall_passed: failedCount === 0 && passedCount > 0,
    passed_count: passedCount,
    failed_count: failedCount,
    total_duration_ms: Date.now() - start,
    tested_at: new Date().toISOString(),
    dry_run: effectiveOptions.dry_run !== false,
  };
}

/**
 * Format suite results as markdown for display in Slack/chat
 */
export function formatSuiteResults(suite: SuiteResult): string {
  const statusEmoji = suite.overall_passed ? '✅' : '❌';
  let output = `## ${statusEmoji} Agent Test Suite Results\n\n`;
  output += `**Agent:** ${suite.agent_url}\n`;
  output += `**Agent Name:** ${suite.agent_profile.name}\n`;
  output += `**Duration:** ${suite.total_duration_ms}ms\n`;
  output += `**Mode:** ${suite.dry_run ? '🧪 Dry Run' : '🔴 Live'}\n`;
  if (suite.scenarios_run.length === 0) {
    output += `**Result:** No applicable scenarios found for this agent.\n\n`;
  } else {
    output += `**Result:** ${suite.passed_count} passed, ${suite.failed_count} failed out of ${suite.scenarios_run.length} scenario(s)\n\n`;
  }

  if (suite.scenarios_skipped.length > 0) {
    output += `**Skipped (agent does not advertise required tools):** ${suite.scenarios_skipped.join(', ')}\n\n`;
  }

  output += `### Scenario Results\n\n`;
  for (const result of suite.results) {
    const emoji = result.overall_passed ? '✅' : '❌';
    output += `${emoji} **${result.scenario}**: ${result.summary} (${result.total_duration_ms}ms)\n`;
  }

  return output;
}

/**
 * Format suite results as JSON
 */
export function formatSuiteResultsJSON(suite: SuiteResult): string {
  return JSON.stringify(suite, null, 2);
}
