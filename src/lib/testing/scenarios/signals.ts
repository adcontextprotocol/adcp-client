/**
 * Signals Agent Testing Scenarios
 *
 * Tests signals agent capabilities including:
 * - get_signals
 * - activate_signal
 * - get_signal_status (if available)
 * - deactivate_signal (if available)
 *
 * Enhanced to:
 * - Discover real signals from the agent before testing
 * - Test multiple signal types
 * - Test activation with various destination configurations
 * - Validate proper error handling for invalid signals
 */

import type { TestOptions, TestStepResult, AgentProfile, TaskResult } from '../types';
import { createTestClient, runStep, discoverAgentProfile, discoverSignals } from '../client';

/**
 * Test: Signals Flow (for signals agents)
 *
 * Flow: get_signals -> activate_signal (with real signal IDs) -> get_signal_status
 */
export async function testSignalsFlow(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = createTestClient(agentUrl, options.protocol || 'mcp', options);

  // Discover agent profile
  const { profile, step: profileStep } = await discoverAgentProfile(client);
  steps.push(profileStep);

  if (!profileStep.passed) {
    return { steps, profile };
  }

  // Discover available signals
  const { signals: discoveredSignals, step: signalsStep } = await discoverSignals(
    client,
    profile,
    options
  );
  steps.push(signalsStep);

  // Use mutable array to collect signals
  const allSignals: NonNullable<AgentProfile['supported_signals']> = discoveredSignals || [];

  if (!signalsStep.passed || allSignals.length === 0) {
    // If get_signals failed or returned empty, try with more specific briefs
    const fallbackBriefs = [
      'audience segments for technology enthusiasts',
      'demographic targeting options',
      'behavioral audience data',
      'first-party data segments',
    ];

    for (const brief of fallbackBriefs) {
      const { signals: retrySignals, step: retryStep } = await discoverSignals(client, profile, {
        ...options,
        brief,
      });

      retryStep.step = `Discover signals: "${brief.substring(0, 30)}..."`;
      steps.push(retryStep);

      if (retrySignals && retrySignals.length > 0) {
        allSignals.push(...retrySignals);
        break;
      }
    }
  }

  // Store discovered signals in profile
  profile.supported_signals = allSignals;

  // If we still have no signals, we can't continue
  if (allSignals.length === 0) {
    steps.push({
      step: 'Signal activation tests',
      task: undefined,
      passed: false,
      duration_ms: 0,
      error: 'No signals discovered from agent - cannot test activation',
    });
    return { steps, profile };
  }

  // Select signals to test
  const signalsToTest = selectSignalsToTest(allSignals, options);

  // Test activate_signal with real signal IDs
  if (profile.tools.includes('activate_signal')) {
    for (const signal of signalsToTest) {
      // Test activation with various destination configurations
      const destinations = getTestDestinations();

      for (const destination of destinations.slice(0, 2)) {
        // Test max 2 destinations per signal
        const { result, step } = await runStep<TaskResult>(
          `Activate signal: ${signal.name || signal.signal_id} -> ${destination.platform}`,
          'activate_signal',
          async () =>
            client.executeTask('activate_signal', {
              signal_id: signal.signal_id,
              destination,
              // Some agents support activation options
              options: {
                dry_run: options.dry_run !== false,
              },
            }) as Promise<TaskResult>
        );

        if (result?.success && result?.data) {
          const data = result.data as any;
          step.details = `Signal activation ${data.status || 'submitted'}`;
          step.response_preview = JSON.stringify(
            {
              status: data.status || data.deployment?.status,
              activation_id: data.activation_id || data.deployment?.id,
              destination: destination.platform,
            },
            null,
            2
          );
          step.created_id = data.activation_id || data.deployment?.id;
        } else if (result && !result.success) {
          // Check if this is an expected failure (e.g., destination not supported)
          const error = result.error || '';
          if (
            error.includes('not supported') ||
            error.includes('invalid destination') ||
            error.includes('dry_run')
          ) {
            step.passed = true;
            step.details = `Expected rejection: ${error}`;
          } else {
            step.passed = false;
            step.error = result.error || 'activate_signal failed';
          }
        }
        steps.push(step);
      }
    }

    // Test activation with invalid signal ID (error case)
    const { result: errorResult, step: errorStep } = await runStep<TaskResult>(
      'Activate signal: invalid ID (error expected)',
      'activate_signal',
      async () =>
        client.executeTask('activate_signal', {
          signal_id: 'INVALID_SIGNAL_ID_DOES_NOT_EXIST_12345',
          destination: {
            platform: 'test-platform',
            account_id: 'test-account',
          },
        }) as Promise<TaskResult>
    );

    // This should fail - if it succeeds with invalid signal, that's a bug
    if (errorResult?.success) {
      errorStep.passed = false;
      errorStep.error = 'Expected error for invalid signal_id but got success';
    } else {
      errorStep.passed = true;
      errorStep.details = 'Correctly rejected invalid signal_id';
    }
    steps.push(errorStep);
  }

  // Test get_signal_status if available
  if (profile.tools.includes('get_signal_status')) {
    // Use an activation_id from previous steps if available
    const activationId = steps.find(s => s.created_id)?.created_id;

    const { result, step } = await runStep<TaskResult>(
      'Get signal status',
      'get_signal_status',
      async () =>
        client.executeTask('get_signal_status', {
          activation_id: activationId || 'test-activation-id',
        }) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as any;
      step.details = `Status: ${data.status}`;
      step.response_preview = JSON.stringify(
        {
          status: data.status,
          last_updated: data.last_updated || data.updated_at,
          metrics: data.metrics
            ? {
                reach: data.metrics.reach,
                impressions: data.metrics.impressions,
              }
            : undefined,
        },
        null,
        2
      );
    } else if (result && !result.success) {
      step.passed = false;
      step.error = result.error || 'get_signal_status failed';
    }
    steps.push(step);
  }

  // Test deactivate_signal if available
  if (profile.tools.includes('deactivate_signal')) {
    const activationId = steps.find(s => s.created_id)?.created_id;

    if (activationId) {
      const { result, step } = await runStep<TaskResult>(
        'Deactivate signal',
        'deactivate_signal',
        async () =>
          client.executeTask('deactivate_signal', {
            activation_id: activationId,
          }) as Promise<TaskResult>
      );

      if (result?.success && result?.data) {
        const data = result.data as any;
        step.details = `Deactivation: ${data.status || 'submitted'}`;
      } else if (result && !result.success) {
        step.passed = false;
        step.error = result.error || 'deactivate_signal failed';
      }
      steps.push(step);
    }
  }

  return { steps, profile };
}

/**
 * Select which signals to test based on options
 */
function selectSignalsToTest(
  signals: NonNullable<AgentProfile['supported_signals']>,
  options: TestOptions
): NonNullable<AgentProfile['supported_signals']> {
  // If specific signal types requested, filter to those
  if (options.signal_types?.length) {
    const filtered = signals.filter(
      s => s.type && options.signal_types!.includes(s.type)
    );
    if (filtered.length > 0) return filtered.slice(0, 3);
  }

  // Default: test one signal of each type, max 3 total
  const byType = new Map<string, NonNullable<AgentProfile['supported_signals']>[0]>();
  for (const signal of signals) {
    const type = signal.type || 'unknown';
    if (!byType.has(type)) {
      byType.set(type, signal);
    }
  }

  const selected = Array.from(byType.values()).slice(0, 3);
  return selected.length > 0 ? selected : signals.slice(0, 1);
}

/**
 * Get test destination configurations for signal activation
 */
function getTestDestinations(): Array<{
  platform: string;
  account_id: string;
  [key: string]: string;
}> {
  return [
    {
      platform: 'dv360',
      account_id: 'test-dv360-account',
    },
    {
      platform: 'trade-desk',
      account_id: 'test-ttd-account',
    },
    {
      platform: 'meta',
      account_id: 'test-meta-account',
      ad_account_id: 'act_12345',
    },
    {
      platform: 'google-ads',
      account_id: 'test-google-account',
      customer_id: '123-456-7890',
    },
  ];
}
