/**
 * AdCP Agent E2E Tester
 *
 * Provides comprehensive end-to-end testing of AdCP agents (sales, creative, signals).
 *
 * Features:
 * - Channel-aware testing (only tests features the agent supports)
 * - Optional dry-run mode (real testing requires actual media buys)
 * - Comprehensive scenario coverage based on AdCP spec
 * - Schema validation via @adcp/client
 *
 * @example
 * ```typescript
 * import { testAgent, formatTestResults } from '@adcp/client/testing';
 *
 * const result = await testAgent(
 *   'https://test-agent.adcontextprotocol.org/mcp',
 *   'discovery',
 *   { auth: { type: 'bearer', token: 'your-token' } }
 * );
 * console.log(formatTestResults(result));
 * ```
 */

// Re-export types
export type {
  TestScenario,
  TestOptions,
  TestStepResult,
  AgentProfile,
  TestResult,
  TaskResult,
  Logger,
} from './types';

// Re-export client utilities
export { setAgentTesterLogger, getLogger, createTestClient, runStep } from './client';

// Re-export formatter
export { formatTestResults, formatTestResultsJSON, formatTestResultsSummary } from './formatter';

// Import scenarios
import {
  testHealthCheck,
  testDiscovery,
  testCreateMediaBuy,
  testFullSalesFlow,
  testCreativeSync,
  testCreativeInline,
  testCreativeFlow,
  testSignalsFlow,
  testErrorHandling,
  testValidation,
  testPricingEdgeCases,
  testTemporalValidation,
  testBehaviorAnalysis,
  testResponseConsistency,
} from './scenarios';

// Import types
import type { TestScenario, TestOptions, TestResult, TestStepResult, AgentProfile } from './types';
import { getLogger } from './client';

/**
 * Main entry point: Run a test scenario against an agent
 */
export async function testAgent(
  agentUrl: string,
  scenario: TestScenario,
  options: TestOptions = {}
): Promise<TestResult> {
  const startTime = Date.now();
  let steps: TestStepResult[] = [];
  let profile: AgentProfile | undefined;
  const logger = getLogger();

  // Default dry_run to true for safety
  const effectiveOptions: TestOptions = {
    ...options,
    dry_run: options.dry_run !== false,
    test_session_id: options.test_session_id || `addie-test-${Date.now()}`,
  };

  logger.info({ agentUrl, scenario, options: effectiveOptions }, 'Starting agent test');

  try {
    let result: { steps: TestStepResult[]; profile?: AgentProfile };

    switch (scenario) {
      case 'health_check':
        steps = await testHealthCheck(agentUrl, effectiveOptions);
        break;

      case 'discovery':
        result = await testDiscovery(agentUrl, effectiveOptions);
        steps = result.steps;
        profile = result.profile;
        break;

      case 'create_media_buy':
        result = await testCreateMediaBuy(agentUrl, effectiveOptions);
        steps = result.steps;
        profile = result.profile;
        break;

      case 'full_sales_flow':
        result = await testFullSalesFlow(agentUrl, effectiveOptions);
        steps = result.steps;
        profile = result.profile;
        break;

      case 'creative_sync':
        result = await testCreativeSync(agentUrl, effectiveOptions);
        steps = result.steps;
        profile = result.profile;
        break;

      case 'creative_inline':
        result = await testCreativeInline(agentUrl, effectiveOptions);
        steps = result.steps;
        profile = result.profile;
        break;

      case 'creative_reference':
        // TODO: Implement reference creative testing
        steps = [
          {
            step: 'Test reference creatives',
            passed: false,
            duration_ms: 0,
            error: 'creative_reference scenario not yet implemented',
          },
        ];
        break;

      case 'pricing_models':
        // Re-use pricing edge cases for now
        result = await testPricingEdgeCases(agentUrl, effectiveOptions);
        steps = result.steps;
        profile = result.profile;
        break;

      case 'creative_flow':
        result = await testCreativeFlow(agentUrl, effectiveOptions);
        steps = result.steps;
        profile = result.profile;
        break;

      case 'signals_flow':
        result = await testSignalsFlow(agentUrl, effectiveOptions);
        steps = result.steps;
        profile = result.profile;
        break;

      case 'error_handling':
        result = await testErrorHandling(agentUrl, effectiveOptions);
        steps = result.steps;
        profile = result.profile;
        break;

      case 'validation':
        result = await testValidation(agentUrl, effectiveOptions);
        steps = result.steps;
        profile = result.profile;
        break;

      case 'pricing_edge_cases':
        result = await testPricingEdgeCases(agentUrl, effectiveOptions);
        steps = result.steps;
        profile = result.profile;
        break;

      case 'temporal_validation':
        result = await testTemporalValidation(agentUrl, effectiveOptions);
        steps = result.steps;
        profile = result.profile;
        break;

      case 'behavior_analysis':
        result = await testBehaviorAnalysis(agentUrl, effectiveOptions);
        steps = result.steps;
        profile = result.profile;
        break;

      case 'response_consistency':
        result = await testResponseConsistency(agentUrl, effectiveOptions);
        steps = result.steps;
        profile = result.profile;
        break;

      default:
        steps = [
          {
            step: 'Unknown scenario',
            passed: false,
            duration_ms: 0,
            error: `Unknown test scenario: ${scenario}`,
          },
        ];
    }
  } catch (error) {
    logger.error({ error, agentUrl, scenario }, 'Agent test failed with exception');
    steps.push({
      step: 'Test execution',
      passed: false,
      duration_ms: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const totalDuration = Date.now() - startTime;
  const passedCount = steps.filter(s => s.passed).length;
  const failedCount = steps.filter(s => !s.passed).length;
  const overallPassed = failedCount === 0 && passedCount > 0;

  // Generate summary
  let summary: string;
  if (overallPassed) {
    summary = `All ${passedCount} test step(s) passed in ${totalDuration}ms`;
  } else if (passedCount === 0) {
    summary = `All ${failedCount} test step(s) failed`;
  } else {
    summary = `${passedCount} passed, ${failedCount} failed out of ${steps.length} step(s)`;
  }

  const testResult: TestResult = {
    agent_url: agentUrl,
    scenario,
    overall_passed: overallPassed,
    steps,
    summary,
    total_duration_ms: totalDuration,
    tested_at: new Date().toISOString(),
    agent_profile: profile,
    dry_run: effectiveOptions.dry_run !== false,
  };

  logger.info(
    { agentUrl, scenario, overallPassed, passedCount, failedCount, totalDuration },
    'Agent test completed'
  );

  return testResult;
}

// Re-export individual scenarios for direct use
export {
  testHealthCheck,
  testDiscovery,
  testCreateMediaBuy,
  testFullSalesFlow,
  testCreativeSync,
  testCreativeInline,
  testCreativeFlow,
  testSignalsFlow,
  testErrorHandling,
  testValidation,
  testPricingEdgeCases,
  testTemporalValidation,
  testBehaviorAnalysis,
  testResponseConsistency,
} from './scenarios';
