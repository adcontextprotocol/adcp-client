/**
 * Trusted Match Protocol (TMP) Testing Scenarios (v3)
 *
 * Tests TMP agent capabilities including:
 * - context_match — evaluates packages against content context (no user identity)
 * - identity_match — evaluates user eligibility for packages using an opaque identity token (no page context)
 */

import type { TestOptions, TestStepResult, AgentProfile, TaskResult } from '../types';
import { getOrCreateClient, runStep, getOrDiscoverProfile } from '../client';
import { TRUSTED_MATCH_TOOLS } from '../../utils/capabilities';

/**
 * Test: Trusted Match Flow
 *
 * Flow: discover profile -> check TMP tools -> context_match -> identity_match
 */
export async function testTrustedMatchFlow(
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

  // Check if agent supports any TMP tools
  const hasTMP = TRUSTED_MATCH_TOOLS.some(t => profile.tools.includes(t));
  if (!hasTMP) {
    steps.push({
      step: 'TMP support check',
      passed: false,
      duration_ms: 0,
      error: 'Agent does not support Trusted Match Protocol tools',
      details: `Required tools: ${TRUSTED_MATCH_TOOLS.join(', ')}. Available: ${profile.tools.join(', ')}`,
    });
    return { steps, profile };
  }

  // Test: context_match
  if (profile.tools.includes('context_match')) {
    const { result, step } = await runStep<TaskResult>(
      'Context match: evaluate packages against page context',
      'context_match',
      async () =>
        client.executeTask('context_match', {
          type: 'context_match_request',
          request_id: `e2e-ctx-${Date.now()}`,
          property_rid: '00000000-0000-7000-0000-000000000001',
          property_type: 'web',
          placement_id: 'e2e-test-placement',
          context_signals: {
            topics: ['632'],
            taxonomy_source: 'iab',
            taxonomy_id: 7,
            sentiment: 'positive',
            keywords: ['technology', 'innovation'],
            language: 'en',
          },
          geo: {
            country: 'US',
            region: 'US-CA',
          },
        }) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as Record<string, unknown>;
      const offers = Array.isArray(data['offers']) ? data['offers'] : [];
      step.details = `Context match returned ${offers.length} offer(s)`;
      step.response_preview = JSON.stringify(
        {
          request_id: data['request_id'],
          offers_count: offers.length,
          cache_ttl: data['cache_ttl'],
          has_signals: !!data['signals'],
        },
        null,
        2
      );
    } else if (result && !result.success) {
      const error = result.error || '';
      if (error.includes('not supported') || error.includes('not implemented')) {
        step.passed = true;
        step.details = 'Context match not supported by this agent (expected for some agents)';
      } else {
        step.passed = false;
        step.error = result.error || 'context_match failed';
      }
    }
    steps.push(step);
  }

  // Test: identity_match
  if (profile.tools.includes('identity_match')) {
    const { result, step } = await runStep<TaskResult>(
      'Identity match: evaluate user eligibility for packages',
      'identity_match',
      async () =>
        client.executeTask('identity_match', {
          type: 'identity_match_request',
          request_id: `e2e-id-${Date.now()}`,
          user_token: 'e2e-test-opaque-token',
          uid_type: 'publisher_first_party',
          package_ids: ['e2e-test-package-001', 'e2e-test-package-002'],
          consent: {
            gdpr: false,
          },
        }) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as Record<string, unknown>;
      const eligibleIds = Array.isArray(data['eligible_package_ids']) ? data['eligible_package_ids'] : [];
      step.details = `Identity match returned ${eligibleIds.length} eligible package(s)`;
      step.response_preview = JSON.stringify(
        {
          request_id: data['request_id'],
          eligible_package_ids: eligibleIds,
          ttl_sec: data['ttl_sec'],
        },
        null,
        2
      );
    } else if (result && !result.success) {
      const error = result.error || '';
      if (error.includes('not supported') || error.includes('not implemented')) {
        step.passed = true;
        step.details = 'Identity match not supported by this agent (expected for some agents)';
      } else {
        step.passed = false;
        step.error = result.error || 'identity_match failed';
      }
    }
    steps.push(step);
  }

  return { steps, profile };
}

/**
 * Check if agent has any TMP tools
 */
export function hasTrustedMatchTools(tools: string[]): boolean {
  return TRUSTED_MATCH_TOOLS.some(t => tools.includes(t));
}
