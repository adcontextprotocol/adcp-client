/**
 * Sponsored Intelligence (SI) Protocol Testing Scenarios (v3)
 *
 * Tests SI agent capabilities including:
 * - Session lifecycle (initiate -> messages -> terminate)
 * - Offering availability checks
 * - Message exchange patterns
 * - Handoff flows
 */

import type { TestOptions, TestStepResult, AgentProfile, TaskResult } from '../types';
import { getOrCreateClient, runStep, getOrDiscoverProfile } from '../client';
import { SPONSORED_INTELLIGENCE_TOOLS } from '../../utils/capabilities';
import type {
  SIGetOfferingRequest,
  SIGetOfferingResponse,
  SIInitiateSessionRequest,
  SIInitiateSessionResponse,
  SISendMessageRequest,
  SISendMessageResponse,
  SITerminateSessionRequest,
  SITerminateSessionResponse,
} from '../../types/tools.generated';

/**
 * Test: SI Session Lifecycle
 *
 * Flow: si_get_offering -> si_initiate_session -> si_send_message (x2-3)
 *       -> si_terminate_session -> verify terminated
 */
export async function testSISessionLifecycle(
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

  // Check if agent supports any SI tools
  const hasSITools = SPONSORED_INTELLIGENCE_TOOLS.some(t => profile.tools.includes(t));
  if (!hasSITools) {
    steps.push({
      step: 'SI support check',
      passed: false,
      duration_ms: 0,
      error: 'Agent does not support Sponsored Intelligence tools',
      details: `Required tools: ${SPONSORED_INTELLIGENCE_TOOLS.join(', ')}. Available: ${profile.tools.join(', ')}`,
    });
    return { steps, profile };
  }

  profile.supports_si = true;
  let sessionId: string | undefined;
  let offeringToken: string | undefined;
  let offeringAvailable = false;
  const collectedUIElements: unknown[][] = [];

  // Test: si_get_offering
  if (profile.tools.includes('si_get_offering')) {
    const offeringId = options.si_offering_id || 'e2e-test-offering';
    const { result, step } = await runStep<TaskResult>(
      'Get SI offering',
      'si_get_offering',
      async () =>
        client.siGetOffering({
          offering_id: offeringId,
          intent: options.si_context || 'E2E testing - checking SI offering availability',
        } as unknown as SIGetOfferingRequest) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as SIGetOfferingResponse;
      const dataRecord = result.data as unknown as Record<string, unknown>;
      offeringAvailable = data.available === true;
      offeringToken = data.offering_token ?? undefined;
      step.details = offeringAvailable
        ? `Offering available${offeringToken ? ' (token received)' : ''}`
        : `Offering unavailable: ${data.unavailable_reason || 'no reason provided'}`;
      step.response_preview = JSON.stringify(
        {
          available: data.available,
          offering_token: offeringToken ? '***' : undefined,
          title: dataRecord.title,
          description: dataRecord.description,
          capabilities: dataRecord.capabilities,
          unavailable_reason: data.unavailable_reason,
        },
        null,
        2
      );
    } else if (result && !result.success) {
      const error = result.error || '';
      if (error.includes('not supported') || error.includes('not implemented')) {
        step.passed = true;
        step.details = 'SI not supported by this agent (expected for some agents)';
      } else {
        step.passed = false;
        step.error = result.error || 'si_get_offering failed';
      }
    }
    steps.push(step);
  }

  // Test: si_initiate_session
  if (profile.tools.includes('si_initiate_session')) {
    const { result, step } = await runStep<TaskResult>(
      'Initiate SI session',
      'si_initiate_session',
      async () =>
        client.siInitiateSession({
          offering_id: options.si_offering_id || 'e2e-test-offering',
          offering_token: offeringToken,
          intent: options.si_context || 'E2E testing - initiating conversation about products',
          identity: {
            consent_granted: false,
            anonymous_session_id: `e2e-anon-${Date.now()}`,
          },
          placement: 'e2e-test-placement',
          supported_capabilities: {
            modalities: {
              conversational: true,
              rich_media: true,
            },
          },
        } as unknown as SIInitiateSessionRequest) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as SIInitiateSessionResponse;
      sessionId = data.session_id;
      step.created_id = sessionId;
      if (Array.isArray(data.response?.ui_elements) && data.response.ui_elements.length > 0) {
        collectedUIElements.push(data.response.ui_elements);
      }
      step.details = sessionId
        ? `Session created: ${sessionId}`
        : 'Session initiation completed (no session_id returned)';
      step.response_preview = JSON.stringify(
        {
          session_id: sessionId,
          response_message: data.response?.message?.substring(0, 100),
          has_ui_elements: !!data.response?.ui_elements?.length,
          negotiated_capabilities: data.negotiated_capabilities,
        },
        null,
        2
      );
    } else if (result && !result.success) {
      const error = result.error || '';
      if (error.includes('not supported') || error.includes('not implemented')) {
        step.passed = true;
        step.details = 'SI session initiation not supported by this agent';
      } else {
        step.passed = false;
        step.error = result.error || 'si_initiate_session failed';
      }
    }
    steps.push(step);
  }

  // Test: si_send_message (if we have a session)
  if (profile.tools.includes('si_send_message') && sessionId) {
    const testMessages = [
      'What products do you have available?',
      'Can you tell me more about your best seller?',
      'What is the price range?',
    ];

    for (let i = 0; i < Math.min(testMessages.length, 3); i++) {
      const message = testMessages[i]!;
      const { result, step } = await runStep<TaskResult>(
        `Send message ${i + 1}: "${message.substring(0, 30)}..."`,
        'si_send_message',
        async () =>
          client.siSendMessage({
            session_id: sessionId,
            message,
            metadata: {
              test_iteration: i + 1,
            },
          } as unknown as SISendMessageRequest) as Promise<TaskResult>
      );

      let sessionEnded = false;
      if (result?.success && result?.data) {
        const data = result.data as SISendMessageResponse;
        if (Array.isArray(data.response?.ui_elements) && data.response.ui_elements.length > 0) {
          collectedUIElements.push(data.response.ui_elements);
        }
        step.details = `Session status: ${data.session_status || 'active'}`;
        step.response_preview = JSON.stringify(
          {
            session_id: data.session_id,
            session_status: data.session_status,
            response_message: data.response?.message?.substring(0, 100),
            has_ui_elements: !!data.response?.ui_elements?.length,
          },
          null,
          2
        );
        const status = data.session_status as string;
        sessionEnded = status === 'complete' || status === 'terminated';
      } else if (result && !result.success) {
        step.passed = false;
        step.error = result.error || 'si_send_message failed';
      }
      steps.push(step);
      // If session is no longer active, stop sending messages
      if (sessionEnded) {
        break;
      }
    }

    // Validate UI element schemas only when elements were actually returned
    if (collectedUIElements.length > 0) {
      steps.push(validateUIElements(collectedUIElements));
    }
  }

  // Test: si_terminate_session (if we have a session)
  if (profile.tools.includes('si_terminate_session') && sessionId) {
    const { result, step } = await runStep<TaskResult>(
      'Terminate SI session',
      'si_terminate_session',
      async () =>
        client.siTerminateSession({
          session_id: sessionId,
          reason: 'user_exit',
          termination_context: {
            summary: 'E2E test session completed successfully',
          },
        } as unknown as SITerminateSessionRequest) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as SITerminateSessionResponse;
      step.details = data.terminated ? 'Session terminated' : 'Termination not confirmed';
      step.response_preview = JSON.stringify(
        {
          session_id: data.session_id,
          terminated: data.terminated,
          has_acp_handoff: !!data.acp_handoff,
        },
        null,
        2
      );
    } else if (result && !result.success) {
      step.passed = false;
      step.error = result.error || 'si_terminate_session failed';
    }
    steps.push(step);

    // Test: send message to terminated session (should fail)
    if (profile.tools.includes('si_send_message')) {
      const { result: errorResult, step: errorStep } = await runStep<TaskResult>(
        'Send message to terminated session (error expected)',
        'si_send_message',
        async () =>
          client.siSendMessage({
            session_id: sessionId,
            message: 'This should fail',
          } as unknown as SISendMessageRequest) as Promise<TaskResult>
      );

      if (errorResult?.success) {
        // Check if session_status indicates terminated
        const data = errorResult.data as SISendMessageResponse;
        const status = data.session_status as string;
        if (status === 'complete' || status === 'terminated') {
          errorStep.passed = true;
          errorStep.details = 'Session correctly reports terminated status';
        } else {
          errorStep.passed = false;
          errorStep.error = 'Expected error for terminated session but message was accepted';
        }
      } else {
        errorStep.passed = true;
        errorStep.details = 'Correctly rejected message to terminated session';
      }
      steps.push(errorStep);
    }
  }

  return { steps, profile };
}

// Valid UI element types per si-ui-element.json schema
const SI_UI_ELEMENT_TYPES = [
  'text',
  'link',
  'image',
  'product_card',
  'carousel',
  'action_button',
  'app_handoff',
  'integration_actions',
] as const;

// Required data fields per element type (per si-ui-element.json schema)
const SI_UI_ELEMENT_REQUIRED_FIELDS: Record<string, string[]> = {
  text: ['message'],
  link: ['url', 'label'],
  image: ['url', 'alt'],
  product_card: ['title', 'price'],
  carousel: ['items'],
  action_button: ['label', 'action'],
  app_handoff: [], // no required data fields in si-ui-element.json (uses top-level apps object)
  integration_actions: ['actions'],
};

/**
 * Validate UI elements collected from SI session responses.
 * Returns a single TestStepResult summarizing all found types and any violations.
 */
function validateUIElements(elementArrays: unknown[][]): TestStepResult {
  const foundTypes = new Set<string>();
  const invalidElements: string[] = [];

  for (const elements of elementArrays) {
    for (const el of elements) {
      if (!el || typeof el !== 'object') {
        invalidElements.push('non-object element');
        continue;
      }
      const element = el as Record<string, unknown>;
      const type = element.type as string | undefined;

      if (!type) {
        invalidElements.push('element missing required "type" field');
        continue;
      }

      if (!SI_UI_ELEMENT_TYPES.includes(type as (typeof SI_UI_ELEMENT_TYPES)[number])) {
        invalidElements.push(`unknown type "${type}"`);
        continue;
      }

      foundTypes.add(type);

      // Check type-specific required fields in data
      const requiredFields = SI_UI_ELEMENT_REQUIRED_FIELDS[type];
      if (requiredFields && requiredFields.length > 0) {
        if (!element.data || typeof element.data !== 'object') {
          invalidElements.push(`${type} element missing required "data" object`);
        } else {
          const data = element.data as Record<string, unknown>;
          for (const field of requiredFields) {
            if (!(field in data)) {
              invalidElements.push(`${type} element missing required data.${field}`);
            }
          }
        }
      }
    }
  }

  const typesFound = Array.from(foundTypes);
  const passed = invalidElements.length === 0;

  return {
    step: 'Validate SI UI element schemas',
    passed,
    duration_ms: 0,
    details:
      typesFound.length > 0
        ? `Found ${typesFound.length} element type(s): ${typesFound.join(', ')}${invalidElements.length > 0 ? `. Violations: ${invalidElements.join('; ')}` : ''}`
        : 'No UI elements returned (agent may not support rich media)',
    error: passed ? undefined : `UI element schema violations: ${invalidElements.join('; ')}`,
    response_preview: JSON.stringify({ found_types: typesFound, invalid_elements: invalidElements }, null, 2),
    warnings: typesFound.length === 0 ? ['Agent returned no UI elements in this session'] : undefined,
  };
}

/**
 * Test: SI Handoff
 *
 * Tests the ACP handoff mechanism in si_terminate_session.
 * Flow: si_get_offering -> si_initiate_session -> si_send_message (purchase intent)
 *       -> si_terminate_session (reason: handoff_transaction) -> validate acp_handoff structure
 */
export async function testSIHandoff(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = getOrCreateClient(agentUrl, options);

  const { profile, step: profileStep } = await getOrDiscoverProfile(client, options);
  steps.push(profileStep);

  if (!profileStep.passed) {
    return { steps, profile };
  }

  const hasRequiredTools =
    profile.tools.includes('si_initiate_session') && profile.tools.includes('si_terminate_session');
  if (!hasRequiredTools) {
    steps.push({
      step: 'SI handoff support check',
      passed: false,
      duration_ms: 0,
      error: 'Agent does not support si_initiate_session + si_terminate_session (required for handoff testing)',
    });
    return { steps, profile };
  }

  profile.supports_si = true;
  let sessionId: string | undefined;
  let offeringToken: string | undefined;

  // Get offering token if available
  if (profile.tools.includes('si_get_offering')) {
    const { result, step } = await runStep<TaskResult>(
      'Get SI offering (handoff)',
      'si_get_offering',
      async () =>
        client.siGetOffering({
          offering_id: options.si_offering_id || 'e2e-test-offering',
          intent: 'E2E testing - preparing for handoff flow',
        } as unknown as SIGetOfferingRequest) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      offeringToken = (result.data as SIGetOfferingResponse).offering_token ?? undefined;
      step.details = 'Offering retrieved for handoff test';
    }
    steps.push(step);
  }

  // Initiate session
  const { result: initResult, step: initStep } = await runStep<TaskResult>(
    'Initiate SI session (handoff)',
    'si_initiate_session',
    async () =>
      client.siInitiateSession({
        offering_id: options.si_offering_id || 'e2e-test-offering',
        offering_token: offeringToken,
        intent: options.si_context || 'E2E testing - initiating session for handoff test',
        identity: {
          consent_granted: false,
          anonymous_session_id: `e2e-anon-${Date.now()}`,
        },
        placement: 'e2e-test-placement',
        supported_capabilities: {
          modalities: { conversational: true },
        },
      } as unknown as SIInitiateSessionRequest) as Promise<TaskResult>
  );

  if (initResult?.success && initResult?.data) {
    sessionId = (initResult.data as SIInitiateSessionResponse).session_id;
    initStep.details = sessionId ? `Session created: ${sessionId}` : 'Session created (no session_id)';
  } else if (initResult && !initResult.success) {
    const error = initResult.error || '';
    if (error.includes('not supported') || error.includes('not implemented')) {
      initStep.passed = true;
      initStep.details = 'SI not supported by this agent';
    } else {
      initStep.passed = false;
      initStep.error = initResult.error || 'si_initiate_session failed';
    }
  }
  steps.push(initStep);

  if (!sessionId) {
    return { steps, profile };
  }

  // Send a purchase-intent message to set up the handoff
  if (profile.tools.includes('si_send_message')) {
    const { result, step } = await runStep<TaskResult>(
      'Send purchase intent message',
      'si_send_message',
      async () =>
        client.siSendMessage({
          session_id: sessionId,
          message: "I'd like to purchase this product. Can you set up a transaction?",
        } as unknown as SISendMessageRequest) as Promise<TaskResult>
    );

    if (result?.success) {
      step.details = 'Purchase intent sent';
    } else if (result && !result.success) {
      step.passed = false;
      step.error = result.error || 'si_send_message failed';
    }
    steps.push(step);
  }

  // Terminate with handoff_transaction reason
  const { result: termResult, step: termStep } = await runStep<TaskResult>(
    'Terminate SI session (handoff_transaction)',
    'si_terminate_session',
    async () =>
      client.siTerminateSession({
        session_id: sessionId,
        reason: 'handoff_transaction',
        termination_context: {
          summary: 'E2E test - terminating for handoff validation',
          transaction_intent: {
            intent: 'purchase',
          },
        },
      } as unknown as SITerminateSessionRequest) as Promise<TaskResult>
  );

  let termData: SITerminateSessionResponse | undefined;
  if (termResult?.success && termResult?.data) {
    termData = termResult.data as SITerminateSessionResponse;
    termStep.details = termData.terminated
      ? `Terminated with${termData.acp_handoff ? '' : 'out'} ACP handoff`
      : 'Termination not confirmed';
    termStep.response_preview = JSON.stringify(
      {
        session_id: termData.session_id,
        terminated: termData.terminated,
        acp_handoff: termData.acp_handoff ? '(present)' : undefined,
      },
      null,
      2
    );
  } else if (termResult && !termResult.success) {
    termStep.passed = false;
    termStep.error = termResult.error || 'si_terminate_session failed';
  }
  steps.push(termStep);

  // Validate acp_handoff structure (only when termination succeeded)
  if (termData) {
    if (termData.acp_handoff) {
      const handoff = termData.acp_handoff;
      const hasCheckoutUrl = typeof handoff.checkout_url === 'string';
      const hasCheckoutToken = typeof handoff.checkout_token === 'string';
      const hasAnyHandoffField = hasCheckoutUrl || hasCheckoutToken;

      steps.push({
        step: 'Validate ACP handoff structure',
        passed: hasAnyHandoffField,
        duration_ms: 0,
        details: hasAnyHandoffField
          ? `Handoff has ${[hasCheckoutUrl && 'checkout_url', hasCheckoutToken && 'checkout_token'].filter(Boolean).join(', ')}`
          : 'acp_handoff returned but missing both checkout_url and checkout_token',
        error: hasAnyHandoffField
          ? undefined
          : 'acp_handoff object present but has no checkout_url or checkout_token — at least one is required',
        response_preview: JSON.stringify(
          {
            has_checkout_url: hasCheckoutUrl,
            has_checkout_token: hasCheckoutToken,
            has_payload: !!handoff.payload,
            has_expires_at: !!handoff.expires_at,
          },
          null,
          2
        ),
      });
    } else {
      steps.push({
        step: 'Validate ACP handoff structure',
        passed: true,
        duration_ms: 0,
        details: 'No acp_handoff in response (agent may not support transaction handoff)',
        warnings: ['Agent terminated with handoff_transaction reason but returned no acp_handoff object'],
      });
    }
  }

  return { steps, profile };
}

/**
 * Test: SI Availability Check
 *
 * Quick test to check SI offering availability without full session lifecycle
 */
export async function testSIAvailability(
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

  // Check if agent supports si_get_offering
  if (!profile.tools.includes('si_get_offering')) {
    steps.push({
      step: 'SI availability check support',
      passed: false,
      duration_ms: 0,
      error: 'Agent does not support si_get_offering tool',
    });
    return { steps, profile };
  }

  profile.supports_si = true;

  // Test: si_get_offering with provided or default offering ID
  const offeringId = options.si_offering_id || 'e2e-test-offering';
  const { result, step } = await runStep<TaskResult>(
    'Check SI offering availability',
    'si_get_offering',
    async () =>
      client.siGetOffering({
        offering_id: offeringId,
        intent: options.si_context || 'E2E testing - checking SI availability',
      } as unknown as SIGetOfferingRequest) as Promise<TaskResult>
  );

  if (result?.success && result?.data) {
    const data = result.data as SIGetOfferingResponse;
    const dataRecord = result.data as unknown as Record<string, unknown>;
    step.details = data.available
      ? 'SI offering is available'
      : `SI offering unavailable: ${data.unavailable_reason || 'no reason'}`;
    step.response_preview = JSON.stringify(
      {
        available: data.available,
        title: dataRecord.title,
        description: dataRecord.description,
        capabilities: dataRecord.capabilities,
        unavailable_reason: data.unavailable_reason,
      },
      null,
      2
    );
  } else if (result && !result.success) {
    const error = result.error || '';
    if (error.includes('not supported') || error.includes('not implemented')) {
      step.passed = true;
      step.details = 'SI not supported by this agent';
    } else {
      step.passed = false;
      step.error = result.error || 'si_get_offering failed';
    }
  }
  steps.push(step);

  // Test: si_get_offering with invalid offering ID (should return unavailable, not error)
  const { result: invalidResult, step: invalidStep } = await runStep<TaskResult>(
    'Check invalid offering availability',
    'si_get_offering',
    async () =>
      client.siGetOffering({
        offering_id: 'INVALID_OFFERING_ID_DOES_NOT_EXIST_12345',
        intent: 'E2E testing - checking unavailable offering',
      } as unknown as SIGetOfferingRequest) as Promise<TaskResult>
  );

  if (invalidResult?.success && invalidResult?.data) {
    const data = invalidResult.data as SIGetOfferingResponse;
    if (data.available === false) {
      invalidStep.passed = true;
      invalidStep.details = 'Correctly reports invalid offering as unavailable';
    } else {
      invalidStep.passed = false;
      invalidStep.error = 'Expected unavailable for invalid offering but got available';
    }
    invalidStep.response_preview = JSON.stringify(
      {
        available: data.available,
        unavailable_reason: data.unavailable_reason,
      },
      null,
      2
    );
  } else if (invalidResult && !invalidResult.success) {
    // Also acceptable to return an error for invalid offering
    invalidStep.passed = true;
    invalidStep.details = 'Correctly rejected invalid offering ID';
  }
  steps.push(invalidStep);

  return { steps, profile };
}

/**
 * Check if agent has any SI protocol tools
 */
export function hasSITools(tools: string[]): boolean {
  return SPONSORED_INTELLIGENCE_TOOLS.some(t => tools.includes(t));
}
