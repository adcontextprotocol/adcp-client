/**
 * Error Compliance Scenarios
 *
 * Tests that agents return properly structured AdCP errors
 * per the transport error mapping spec. Grades agents on
 * compliance level (L1/L2/L3) based on error response quality.
 */

import type { TestOptions, TestStepResult, AgentProfile } from '../types';
import { discoverAgentProfile } from '../client';
import { createTestClient } from '../client';
import { callMCPToolRaw } from '../../protocols/mcp';
import { extractAdcpErrorFromMcp, resolveRecovery } from '../../utils/error-extraction';
import type { ExtractedAdcpError } from '../../utils/error-extraction';
import { isStandardErrorCode } from '../../types/error-codes';

/** Provocation definition: what to send and what error to expect */
interface ErrorProvocation {
  name: string;
  tool: string;
  args: Record<string, unknown>;
  /** Expected standard error codes (any match counts) */
  expectedCodes: string[];
  /** Expected recovery classification */
  expectedRecovery: 'correctable' | 'transient' | 'terminal';
  /** Which field the error should point to */
  expectedField?: string;
}

/** Build fresh provocations per test run (avoids stale timestamps from module load) */
function createProvocations(): ErrorProvocation[] {
  const now = Date.now();
  return [
    {
      name: 'Nonexistent product_id',
      tool: 'create_media_buy',
      args: {
        buyer_ref: `error-compliance-${now}`,
        start_time: new Date(now + 86400000).toISOString(),
        end_time: new Date(now + 604800000).toISOString(),
        packages: [{
          buyer_ref: 'pkg-error-test',
          product_id: 'NONEXISTENT_PRODUCT_ID_12345',
          budget: 1000,
          pricing_option_id: 'nonexistent-pricing',
        }],
      },
      expectedCodes: ['PRODUCT_NOT_FOUND', 'INVALID_REQUEST'],
      expectedRecovery: 'correctable',
      expectedField: 'packages[0].product_id',
    },
    {
      name: 'Negative budget',
      tool: 'create_media_buy',
      args: {
        buyer_ref: `error-compliance-neg-${now}`,
        start_time: new Date(now + 86400000).toISOString(),
        end_time: new Date(now + 604800000).toISOString(),
        packages: [{
          buyer_ref: 'pkg-neg-budget',
          product_id: 'test-product',
          budget: -500,
          pricing_option_id: 'test-pricing',
        }],
      },
      expectedCodes: ['INVALID_REQUEST', 'BUDGET_TOO_LOW'],
      expectedRecovery: 'correctable',
      expectedField: 'packages[0].budget',
    },
    {
      name: 'End time before start time',
      tool: 'create_media_buy',
      args: {
        buyer_ref: `error-compliance-temporal-${now}`,
        start_time: new Date(now + 604800000).toISOString(),
        end_time: new Date(now + 86400000).toISOString(),
        packages: [{
          buyer_ref: 'pkg-temporal',
          product_id: 'test-product',
          budget: 1000,
          pricing_option_id: 'test-pricing',
        }],
      },
      expectedCodes: ['INVALID_REQUEST'],
      expectedRecovery: 'correctable',
      expectedField: 'end_time',
    },
  ];
}

/**
 * Test: Error Codes — validates standard AdCP error code usage
 */
export async function testErrorCodes(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = createTestClient(agentUrl, options.protocol || 'mcp', options);

  const { profile, step: profileStep } = await discoverAgentProfile(client);
  steps.push(profileStep);
  if (!profileStep.passed) return { steps, profile };

  const authToken = options.auth?.type === 'bearer' ? options.auth.token : undefined;
  const headers: Record<string, string> = {};
  if (options.dry_run !== false) headers['X-Dry-Run'] = 'true';

  let correctCodes = 0;
  let totalChecked = 0;

  const provocations = createProvocations();
  for (const provocation of provocations) {
    if (!profile.tools.includes(provocation.tool)) continue;

    const start = Date.now();
    totalChecked++;

    try {
      const rawResponse = await callMCPToolRaw(
        agentUrl, provocation.tool, provocation.args,
        authToken, [], headers
      );

      const extracted = extractAdcpErrorFromMcp(rawResponse);

      if (!rawResponse?.isError && !extracted) {
        // Agent accepted a bad request — that's a failure regardless of error structure
        steps.push({
          step: provocation.name,
          task: provocation.tool,
          passed: false,
          duration_ms: Date.now() - start,
          error: `Agent accepted invalid request (expected rejection with ${provocation.expectedCodes.join(' or ')})`,
        });
        continue;
      }

      if (!extracted) {
        steps.push({
          step: provocation.name,
          task: provocation.tool,
          passed: false,
          duration_ms: Date.now() - start,
          error: 'Agent rejected request but returned no structured AdCP error',
          details: 'L0: Unstructured error response',
        });
        continue;
      }

      const codeMatch = provocation.expectedCodes.includes(extracted.code);
      const recovery = resolveRecovery(extracted);
      const recoveryMatch = recovery === provocation.expectedRecovery;
      const passed = codeMatch && recoveryMatch;

      if (codeMatch) correctCodes++;

      const errors: string[] = [];
      if (!codeMatch) errors.push(`Expected code ${provocation.expectedCodes.join('|')}, got ${extracted.code}`);
      if (!recoveryMatch) errors.push(`Expected recovery ${provocation.expectedRecovery}, got ${recovery}`);

      steps.push({
        step: provocation.name,
        task: provocation.tool,
        passed,
        duration_ms: Date.now() - start,
        details: [
          `L${extracted.compliance_level}: ${extracted.code}`,
          `recovery=${recovery}`,
          extracted.field ? `field=${extracted.field}` : null,
          extracted.suggestion ? 'has suggestion' : null,
        ].filter(Boolean).join(', '),
        error: errors.length > 0 ? errors.join('; ') : undefined,
        response_preview: JSON.stringify({
          code: extracted.code,
          recovery: extracted.recovery,
          field: extracted.field,
          compliance_level: extracted.compliance_level,
          source: extracted.source,
        }, null, 2),
      });
    } catch (error) {
      steps.push({
        step: provocation.name,
        task: provocation.tool,
        passed: false,
        duration_ms: Date.now() - start,
        error: `Transport error: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  if (totalChecked === 0) {
    steps.push({
      step: 'Error code validation',
      passed: false,
      duration_ms: 0,
      error: 'No testable tools found (agent needs create_media_buy)',
    });
  }

  return { steps, profile };
}

/**
 * Test: Error Structure — validates error JSON matches error.json schema
 */
export async function testErrorStructure(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = createTestClient(agentUrl, options.protocol || 'mcp', options);

  const { profile, step: profileStep } = await discoverAgentProfile(client);
  steps.push(profileStep);
  if (!profileStep.passed) return { steps, profile };

  if (!profile.tools.includes('create_media_buy')) {
    steps.push({
      step: 'Error structure validation',
      passed: false,
      duration_ms: 0,
      error: 'Agent does not support create_media_buy (needed to provoke errors)',
    });
    return { steps, profile };
  }

  const authToken = options.auth?.type === 'bearer' ? options.auth.token : undefined;
  const headers: Record<string, string> = {};
  if (options.dry_run !== false) headers['X-Dry-Run'] = 'true';

  const start = Date.now();
  // Use first provocation to get an error response
  const provocation = createProvocations()[0];

  try {
    const rawResponse = await callMCPToolRaw(
      agentUrl, provocation.tool, provocation.args,
      authToken, [], headers
    );

    const extracted = extractAdcpErrorFromMcp(rawResponse);
    if (!extracted) {
      steps.push({
        step: 'Error structure validation',
        task: provocation.tool,
        passed: false,
        duration_ms: Date.now() - start,
        error: 'No structured error to validate',
      });
      return { steps, profile };
    }

    const issues: string[] = [];

    // Required fields
    if (typeof extracted.code !== 'string' || !extracted.code) {
      issues.push('code must be a non-empty string');
    }
    if (typeof extracted.message !== 'string') {
      issues.push('message must be a string');
    }

    // Optional field types
    if (extracted.recovery !== undefined &&
        !['transient', 'correctable', 'terminal'].includes(extracted.recovery)) {
      issues.push(`recovery must be transient|correctable|terminal, got '${extracted.recovery}'`);
    }
    if (extracted.retry_after !== undefined &&
        (typeof extracted.retry_after !== 'number' || extracted.retry_after < 0)) {
      issues.push('retry_after must be a non-negative number');
    }
    if (extracted.field !== undefined && typeof extracted.field !== 'string') {
      issues.push('field must be a string');
    }
    if (extracted.suggestion !== undefined && typeof extracted.suggestion !== 'string') {
      issues.push('suggestion must be a string');
    }

    // Code is standard?
    if (!isStandardErrorCode(extracted.code) && !extracted.code.startsWith('X_')) {
      issues.push(`Non-standard code '${extracted.code}' should use X_ vendor prefix`);
    }

    steps.push({
      step: 'Error structure validation',
      task: provocation.tool,
      passed: issues.length === 0,
      duration_ms: Date.now() - start,
      details: issues.length === 0
        ? `Valid error structure: code=${extracted.code}, L${extracted.compliance_level}`
        : undefined,
      error: issues.length > 0 ? issues.join('; ') : undefined,
    });
  } catch (error) {
    steps.push({
      step: 'Error structure validation',
      task: provocation.tool,
      passed: false,
      duration_ms: Date.now() - start,
      error: `Transport error: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  return { steps, profile };
}

/**
 * Test: Error Transport — validates transport binding compliance
 */
export async function testErrorTransport(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = createTestClient(agentUrl, options.protocol || 'mcp', options);

  const { profile, step: profileStep } = await discoverAgentProfile(client);
  steps.push(profileStep);
  if (!profileStep.passed) return { steps, profile };

  if (!profile.tools.includes('create_media_buy')) {
    steps.push({
      step: 'Error transport validation',
      passed: false,
      duration_ms: 0,
      error: 'Agent does not support create_media_buy (needed to provoke errors)',
    });
    return { steps, profile };
  }

  const authToken = options.auth?.type === 'bearer' ? options.auth.token : undefined;
  const headers: Record<string, string> = {};
  if (options.dry_run !== false) headers['X-Dry-Run'] = 'true';

  const start = Date.now();
  const provocation = createProvocations()[0];

  try {
    const rawResponse = await callMCPToolRaw(
      agentUrl, provocation.tool, provocation.args,
      authToken, [], headers
    );

    const hasIsError = rawResponse?.isError === true;
    const hasStructuredContent = !!rawResponse?.structuredContent?.adcp_error;

    // Check JSON text fallback
    let hasTextJson = false;
    if (Array.isArray(rawResponse?.content)) {
      for (const item of rawResponse.content) {
        if (item?.type === 'text' && typeof item.text === 'string') {
          try {
            const parsed = JSON.parse(item.text);
            if (parsed?.adcp_error) hasTextJson = true;
          } catch { /* not JSON */ }
        }
      }
    }

    // Check consistency between layers
    let consistent = true;
    if (hasStructuredContent && hasTextJson) {
      const structured = rawResponse.structuredContent.adcp_error;
      for (const item of rawResponse.content) {
        if (item?.type === 'text') {
          try {
            const parsed = JSON.parse(item.text);
            if (parsed?.adcp_error?.code !== structured.code) {
              consistent = false;
            }
          } catch { /* skip */ }
        }
      }
    }

    // Determine compliance level
    let level = 0;
    if (hasIsError) level = 1;
    if (hasTextJson) level = 2;
    if (hasStructuredContent) level = 3;

    const details: string[] = [];
    details.push(`isError: ${hasIsError}`);
    details.push(`structuredContent.adcp_error: ${hasStructuredContent}`);
    details.push(`JSON text fallback: ${hasTextJson}`);
    if (hasStructuredContent && hasTextJson) {
      details.push(`consistent: ${consistent}`);
    }
    details.push(`Compliance Level: L${level}`);

    // L3 is the expected default (agents using adcpError() get this for free)
    steps.push({
      step: 'Error transport validation',
      task: provocation.tool,
      passed: level >= 2,
      duration_ms: Date.now() - start,
      details: details.join(', '),
      error: level < 2
        ? 'Error response missing JSON text fallback. Use adcpError() from @adcp/client for L3 compliance.'
        : undefined,
      response_preview: JSON.stringify({
        isError: hasIsError,
        hasStructuredContent,
        hasTextJson,
        consistent,
        compliance_level: level,
      }, null, 2),
    });
  } catch (error) {
    steps.push({
      step: 'Error transport validation',
      task: provocation.tool,
      passed: false,
      duration_ms: Date.now() - start,
      error: `Transport error: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  return { steps, profile };
}
