/**
 * Signals Agent Testing Scenarios
 *
 * Tests signals agent capabilities including:
 * - get_signals
 * - activate_signal
 *
 * Discovers real signals from the agent, tests multiple signal types,
 * tests activation with various destination configurations,
 * and validates proper error handling for invalid signals.
 */

import { randomUUID } from 'crypto';

import type { TestOptions, TestStepResult, AgentProfile, TaskResult } from '../types';
import type { ActivateSignalSuccess, Destination } from '../../types/tools.generated';
import { getOrCreateClient, runStep, getOrDiscoverProfile, discoverSignals, validateResponseSchema } from '../client';

/**
 * Test: Signals Flow (for signals agents)
 *
 * Flow: get_signals -> activate_signal (with real signal IDs)
 */
export async function testSignalsFlow(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = getOrCreateClient(agentUrl, options);

  // Discover agent profile
  const { profile, step: profileStep } = await getOrDiscoverProfile(client, options);
  steps.push(profileStep);

  if (!profileStep.passed) {
    return { steps, profile };
  }

  // Discover available signals
  const {
    signals: discoveredSignals,
    rawSignals: rawDiscoveredSignals,
    step: signalsStep,
    schemaStep,
  } = await discoverSignals(client, profile, options);
  steps.push(signalsStep);
  if (schemaStep) steps.push(schemaStep);

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

  // Check for governance metadata on discovered signals (advisory)
  if (signalsStep.passed && rawDiscoveredSignals.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- restricted_attributes/policy_categories are governance extensions not in the core schema
    const withRestrictedAttrs = rawDiscoveredSignals.filter((s: any) => s.restricted_attributes?.length > 0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const withPolicyCategories = rawDiscoveredSignals.filter((s: any) => s.policy_categories?.length > 0);

    if (withRestrictedAttrs.length === 0 && withPolicyCategories.length === 0) {
      steps.push({
        step: 'Governance metadata on signals (advisory)',
        task: 'get_signals',
        passed: true,
        duration_ms: 0,
        details: `None of ${rawDiscoveredSignals.length} signal(s) declare restricted_attributes or policy_categories. Governance agents will fall back to semantic inference for these signals.`,
        warnings: [
          'Signals without declared governance metadata require LLM-based inference for compliance checking. Consider declaring restricted_attributes and policy_categories on sensitive signals.',
        ],
      });
    } else {
      steps.push({
        step: 'Governance metadata on signals (advisory)',
        task: 'get_signals',
        passed: true,
        duration_ms: 0,
        details: `${withRestrictedAttrs.length}/${rawDiscoveredSignals.length} signal(s) declare restricted_attributes, ${withPolicyCategories.length}/${rawDiscoveredSignals.length} declare policy_categories`,
      });
    }
  }

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
          `Activate signal: ${signal.name || signal.signal_id} -> ${'platform' in destination ? destination.platform : destination.agent_url}`,
          'activate_signal',
          async () =>
            client.activateSignal({
              signal_agent_segment_id: signal.signal_id,
              destinations: [destination],
              idempotency_key: randomUUID(),
            })
        );

        if (result?.success && result?.data) {
          steps.push(validateResponseSchema('activate_signal', result.data));
          const data = result.data as ActivateSignalSuccess;
          const firstDeployment = data.deployments?.[0];
          step.details = `Signal activation submitted`;
          step.response_preview = JSON.stringify(
            {
              deployments_count: data.deployments?.length,
              first_deployment: firstDeployment,
              destination: 'platform' in destination ? destination.platform : destination.agent_url,
            },
            null,
            2
          );
          step.created_id = firstDeployment
            ? 'platform' in firstDeployment
              ? firstDeployment.platform
              : firstDeployment.agent_url
            : undefined;
        } else if (result && !result.success) {
          // Check if this is an expected failure (e.g., destination not supported)
          const error = result.error || '';
          if (error.includes('not supported') || error.includes('invalid destination')) {
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
        client.activateSignal({
          signal_agent_segment_id: 'INVALID_SIGNAL_ID_DOES_NOT_EXIST_12345',
          destinations: [
            {
              type: 'platform',
              platform: 'test-platform',
              account: 'test-account',
            },
          ],
          idempotency_key: randomUUID(),
        })
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
    const filtered = signals.filter(s => s.type && options.signal_types!.includes(s.type));
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
function getTestDestinations(): Destination[] {
  return [
    {
      type: 'platform',
      platform: 'dv360',
      account: 'test-dv360-account',
    },
    {
      type: 'platform',
      platform: 'trade-desk',
      account: 'test-ttd-account',
    },
    {
      type: 'platform',
      platform: 'meta',
      account: 'test-meta-account',
    },
    {
      type: 'platform',
      platform: 'google-ads',
      account: 'test-google-account',
    },
  ];
}
