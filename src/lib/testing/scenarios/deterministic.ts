/**
 * Deterministic Compliance Scenarios
 *
 * These scenarios use the comply_test_controller to force seller-side
 * state transitions, enabling full state machine verification.
 * Only run when the controller is detected.
 */

import { getOrCreateClient, runStep } from '../client';
import { forceStatus, simulate, supportsScenario } from '../test-controller';
import type { ControllerDetection } from '../test-controller';
import type { TestOptions, TestStepResult, AgentProfile, TaskResult } from '../types';
import type { StateTransitionSuccess, ControllerError } from '../../types/tools.generated';
import { testCreateMediaBuy, testCreativeSync } from './media-buy';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getController(options: TestOptions): ControllerDetection | undefined {
  return (options as any)._controllerCapabilities as ControllerDetection | undefined;
}

function transitionStep(
  label: string,
  response: StateTransitionSuccess | ControllerError,
  expectedSuccess: boolean
): TestStepResult {
  const passed = response.success === expectedSuccess;
  if (response.success) {
    return {
      step: label,
      task: 'comply_test_controller',
      passed,
      duration_ms: 0,
      details: `${response.previous_state} → ${response.current_state}`,
      response_preview: JSON.stringify(
        { previous_state: response.previous_state, current_state: response.current_state },
        null,
        2
      ),
      ...(!passed && { error: `Expected failure but got success: ${response.previous_state} → ${response.current_state}` }),
    };
  } else {
    return {
      step: label,
      task: 'comply_test_controller',
      passed,
      duration_ms: 0,
      details: `Error: ${response.error} — ${response.error_detail || ''}`,
      response_preview: JSON.stringify(
        { error: response.error, current_state: response.current_state },
        null,
        2
      ),
      ...(!passed && { error: `Expected success but got ${response.error}: ${response.error_detail || ''}` }),
    };
  }
}

// ---------------------------------------------------------------------------
// Creative State Machine
// ---------------------------------------------------------------------------

export async function testCreativeStateMachine(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = getOrCreateClient(agentUrl, options);
  const controller = getController(options);

  if (!controller?.detected || !supportsScenario(controller, 'force_creative_status')) {
    steps.push({
      step: 'Controller check',
      task: 'comply_test_controller',
      passed: true,
      duration_ms: 0,
      details: 'force_creative_status not supported — skipping',
    });
    return { steps };
  }

  // Step 1: Sync a creative to get an entity to work with
  const { steps: syncSteps, profile } = await testCreativeSync(agentUrl, options);
  steps.push(...syncSteps);

  // Find a creative_id from sync results
  let creativeId: string | undefined;
  for (const step of syncSteps) {
    if (step.created_id) {
      creativeId = step.created_id;
      break;
    }
    if (step.response_preview) {
      try {
        const preview = JSON.parse(step.response_preview);
        if (preview.creative_id) {
          creativeId = preview.creative_id;
          break;
        }
      } catch { /* skip */ }
    }
  }

  if (!creativeId) {
    steps.push({
      step: 'Find creative for state machine test',
      passed: false,
      duration_ms: 0,
      error: 'No creative_id found from sync_creatives — cannot test state machine',
    });
    return { steps, profile };
  }

  // Step 2: Force to approved
  const approveResult = await forceStatus(client, 'force_creative_status', {
    creative_id: creativeId,
    status: 'approved',
  });
  steps.push(transitionStep('Force creative → approved', approveResult, true));

  // Step 3: Verify via list_creatives
  if (approveResult.success && profile?.tools.includes('list_creatives')) {
    const { result: listResult, step: listStep } = await runStep<TaskResult>(
      'Verify creative status via list_creatives',
      'list_creatives',
      async () => (client as any).listCreatives({}) as Promise<TaskResult>
    );
    if (listResult?.success && listResult?.data) {
      const creatives = ((listResult.data as any).creatives || []) as any[];
      const found = creatives.find((c: any) => c.creative_id === creativeId);
      if (found) {
        listStep.details = `Creative ${creativeId} status: ${found.status}`;
        if (found.status !== 'approved') {
          listStep.passed = false;
          listStep.error = `Expected status 'approved', got '${found.status}'`;
        }
      }
    }
    steps.push(listStep);
  }

  // Step 4: Force to archived
  const archiveResult = await forceStatus(client, 'force_creative_status', {
    creative_id: creativeId,
    status: 'archived',
  });
  steps.push(transitionStep('Force creative → archived', archiveResult, true));

  // Step 5: Invalid transition — archived is terminal, can't go back to processing
  const invalidResult = await forceStatus(client, 'force_creative_status', {
    creative_id: creativeId,
    status: 'processing',
  });
  steps.push(transitionStep('Invalid: archived → processing (expect INVALID_TRANSITION)', invalidResult, false));

  if (!invalidResult.success && invalidResult.error !== 'INVALID_TRANSITION') {
    steps.push({
      step: 'Validate error code for invalid transition',
      task: 'comply_test_controller',
      passed: false,
      duration_ms: 0,
      error: `Expected error code INVALID_TRANSITION, got ${invalidResult.error}`,
    });
  }

  // Step 6: Force to rejected with reason
  // First re-sync a fresh creative since archived may be terminal
  const { steps: resyncSteps } = await testCreativeSync(agentUrl, options);
  let freshCreativeId: string | undefined;
  for (const step of resyncSteps) {
    if (step.created_id) {
      freshCreativeId = step.created_id;
      break;
    }
    if (step.response_preview) {
      try {
        const preview = JSON.parse(step.response_preview);
        if (preview.creative_id) {
          freshCreativeId = preview.creative_id;
          break;
        }
      } catch { /* skip */ }
    }
  }

  if (freshCreativeId) {
    const rejectResult = await forceStatus(client, 'force_creative_status', {
      creative_id: freshCreativeId,
      status: 'rejected',
      rejection_reason: 'Brand safety policy violation (comply test)',
    });
    steps.push(transitionStep('Force creative → rejected with reason', rejectResult, true));
  }

  return { steps, profile };
}

// ---------------------------------------------------------------------------
// Media Buy State Machine
// ---------------------------------------------------------------------------

export async function testMediaBuyStateMachine(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = getOrCreateClient(agentUrl, options);
  const controller = getController(options);

  if (!controller?.detected || !supportsScenario(controller, 'force_media_buy_status')) {
    steps.push({
      step: 'Controller check',
      task: 'comply_test_controller',
      passed: true,
      duration_ms: 0,
      details: 'force_media_buy_status not supported — skipping',
    });
    return { steps };
  }

  // Create a media buy
  const { steps: createSteps, profile, mediaBuyId } = await testCreateMediaBuy(agentUrl, options);
  steps.push(...createSteps);

  if (!mediaBuyId) {
    steps.push({
      step: 'Find media buy for state machine test',
      passed: false,
      duration_ms: 0,
      error: 'No media_buy_id from create_media_buy — cannot test state machine',
    });
    return { steps, profile };
  }

  // Force to active
  const activateResult = await forceStatus(client, 'force_media_buy_status', {
    media_buy_id: mediaBuyId,
    status: 'active',
  });
  steps.push(transitionStep('Force media buy → active', activateResult, true));

  // Verify via get_media_buys
  if (activateResult.success && profile?.tools.includes('get_media_buys')) {
    const { result: getResult, step: getStep } = await runStep<TaskResult>(
      'Verify media buy status via get_media_buys',
      'get_media_buys',
      async () => (client as any).getMediaBuys({ media_buy_id: mediaBuyId }) as Promise<TaskResult>
    );
    if (getResult?.success && getResult?.data) {
      const data = getResult.data as any;
      const buys = data.media_buys || [data];
      const found = buys.find((b: any) => b.media_buy_id === mediaBuyId);
      if (found) {
        getStep.details = `Media buy ${mediaBuyId} status: ${found.status}`;
        if (found.status !== 'active') {
          getStep.passed = false;
          getStep.error = `Expected status 'active', got '${found.status}'`;
        }
      }
    }
    steps.push(getStep);
  }

  // Force to completed (terminal)
  const completeResult = await forceStatus(client, 'force_media_buy_status', {
    media_buy_id: mediaBuyId,
    status: 'completed',
  });
  steps.push(transitionStep('Force media buy → completed', completeResult, true));

  // Invalid: completed → active (terminal)
  const invalidResult = await forceStatus(client, 'force_media_buy_status', {
    media_buy_id: mediaBuyId,
    status: 'active',
  });
  steps.push(transitionStep('Invalid: completed → active (expect INVALID_TRANSITION)', invalidResult, false));

  // Test rejection from pending_activation
  const { steps: create2Steps, mediaBuyId: mediaBuyId2 } = await testCreateMediaBuy(agentUrl, options);
  steps.push(...create2Steps);

  if (mediaBuyId2) {
    const rejectResult = await forceStatus(client, 'force_media_buy_status', {
      media_buy_id: mediaBuyId2,
      status: 'rejected',
      rejection_reason: 'Policy violation (comply test)',
    });
    steps.push(transitionStep('Force media buy → rejected from pending_activation', rejectResult, true));
  }

  return { steps, profile };
}

// ---------------------------------------------------------------------------
// Account State Machine
// ---------------------------------------------------------------------------

export async function testAccountStateMachine(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = getOrCreateClient(agentUrl, options);
  const controller = getController(options);

  if (!controller?.detected || !supportsScenario(controller, 'force_account_status')) {
    steps.push({
      step: 'Controller check',
      task: 'comply_test_controller',
      passed: true,
      duration_ms: 0,
      details: 'force_account_status not supported — skipping',
    });
    return { steps };
  }

  // Discover an account to work with
  const profile = options._profile;
  let accountId: string | undefined;

  if (profile?.tools.includes('list_accounts')) {
    const { result: listResult, step: listStep } = await runStep<TaskResult>(
      'List accounts for state machine test',
      'list_accounts',
      async () => (client as any).listAccounts({}) as Promise<TaskResult>
    );
    if (listResult?.success && listResult?.data) {
      const accounts = ((listResult.data as any).accounts || []) as any[];
      const active = accounts.find((a: any) => a.status === 'active');
      accountId = active?.account_id || accounts[0]?.account_id;
      listStep.details = `Found ${accounts.length} account(s), using ${accountId || 'none'}`;
    }
    steps.push(listStep);
  }

  if (!accountId) {
    steps.push({
      step: 'Find account for state machine test',
      passed: true,
      duration_ms: 0,
      details: 'No account found — skipping account state machine test',
    });
    return { steps, profile };
  }

  // Force to suspended
  const suspendResult = await forceStatus(client, 'force_account_status', {
    account_id: accountId,
    status: 'suspended',
  });
  steps.push(transitionStep('Force account → suspended', suspendResult, true));

  // Verify operations are gated: create_media_buy should fail
  if (suspendResult.success && profile?.tools.includes('create_media_buy') && profile?.tools.includes('get_products')) {
    const { result: createResult, step: createStep } = await runStep<TaskResult>(
      'Verify create_media_buy blocked when suspended',
      'create_media_buy',
      async () =>
        (client as any).createMediaBuy({
          brief: 'comply test — should be blocked by suspension',
          budget: { amount: 100, currency: 'USD' },
        }) as Promise<TaskResult>
    );
    // We expect this to fail
    if (createResult?.success) {
      createStep.passed = false;
      createStep.error = 'create_media_buy succeeded but account is suspended — operation gate not enforced';
    } else {
      createStep.passed = true;
      createStep.details = 'create_media_buy correctly blocked when account is suspended';
    }
    steps.push(createStep);
  }

  // Reactivate
  const reactivateResult = await forceStatus(client, 'force_account_status', {
    account_id: accountId,
    status: 'active',
  });
  steps.push(transitionStep('Force account → active (reactivate)', reactivateResult, true));

  // Force to payment_required
  const paymentResult = await forceStatus(client, 'force_account_status', {
    account_id: accountId,
    status: 'payment_required',
  });
  steps.push(transitionStep('Force account → payment_required', paymentResult, true));

  // Restore to active
  const restoreResult = await forceStatus(client, 'force_account_status', {
    account_id: accountId,
    status: 'active',
  });
  steps.push(transitionStep('Force account → active (restore)', restoreResult, true));

  return { steps, profile };
}

// ---------------------------------------------------------------------------
// SI Session State Machine
// ---------------------------------------------------------------------------

export async function testSessionStateMachine(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = getOrCreateClient(agentUrl, options);
  const controller = getController(options);
  const profile = options._profile;

  if (!controller?.detected || !supportsScenario(controller, 'force_session_status')) {
    steps.push({
      step: 'Controller check',
      task: 'comply_test_controller',
      passed: true,
      duration_ms: 0,
      details: 'force_session_status not supported — skipping',
    });
    return { steps };
  }

  if (!profile?.tools.includes('si_initiate_session')) {
    steps.push({
      step: 'SI tools check',
      passed: true,
      duration_ms: 0,
      details: 'si_initiate_session not available — skipping',
    });
    return { steps };
  }

  // Initiate a session
  const { result: initResult, step: initStep } = await runStep<TaskResult>(
    'Initiate SI session for state machine test',
    'si_initiate_session',
    async () =>
      (client as any).siInitiateSession({
        identity: { user_type: 'consumer' },
        supported_capabilities: { response_formats: ['text'] },
      }) as Promise<TaskResult>
  );
  steps.push(initStep);

  const sessionId = (initResult?.data as any)?.session_id;
  if (!sessionId) {
    steps.push({
      step: 'Extract session ID',
      passed: false,
      duration_ms: 0,
      error: 'No session_id in initiate response',
    });
    return { steps, profile };
  }

  // Force session timeout
  const timeoutResult = await forceStatus(client, 'force_session_status', {
    session_id: sessionId,
    status: 'terminated',
    termination_reason: 'session_timeout',
  });
  steps.push(transitionStep('Force session → terminated (timeout)', timeoutResult, true));

  // Verify: si_send_message should fail with SESSION_NOT_FOUND or similar
  if (timeoutResult.success && profile.tools.includes('si_send_message')) {
    const { result: msgResult, step: msgStep } = await runStep<TaskResult>(
      'Verify si_send_message fails after forced termination',
      'si_send_message',
      async () =>
        (client as any).siSendMessage({
          session_id: sessionId,
          message: 'comply test — session should be terminated',
        }) as Promise<TaskResult>
    );

    if (msgResult?.success) {
      // Check if it returned an error in the data
      const data = msgResult.data as any;
      if (data?.errors?.length > 0 || data?.session_status === 'terminated') {
        msgStep.passed = true;
        msgStep.details = 'Agent correctly returned error/terminated status for expired session';
      } else {
        msgStep.passed = false;
        msgStep.error = 'si_send_message succeeded on terminated session — session state not enforced';
      }
    } else {
      msgStep.passed = true;
      msgStep.details = 'si_send_message correctly failed on terminated session';
    }
    steps.push(msgStep);
  }

  return { steps, profile };
}

// ---------------------------------------------------------------------------
// Delivery Simulation
// ---------------------------------------------------------------------------

export async function testDeliverySimulation(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = getOrCreateClient(agentUrl, options);
  const controller = getController(options);
  const profile = options._profile;

  if (!controller?.detected || !supportsScenario(controller, 'simulate_delivery')) {
    steps.push({
      step: 'Controller check',
      task: 'comply_test_controller',
      passed: true,
      duration_ms: 0,
      details: 'simulate_delivery not supported — skipping',
    });
    return { steps };
  }

  // Create a media buy to simulate delivery on
  const { steps: createSteps, mediaBuyId } = await testCreateMediaBuy(agentUrl, options);
  steps.push(...createSteps);

  if (!mediaBuyId) {
    steps.push({
      step: 'Find media buy for delivery simulation',
      passed: false,
      duration_ms: 0,
      error: 'No media_buy_id — cannot test delivery simulation',
    });
    return { steps, profile };
  }

  // Simulate delivery
  const simResult = await simulate(client, 'simulate_delivery', {
    media_buy_id: mediaBuyId,
    impressions: 10000,
    clicks: 150,
    reported_spend: { amount: 150.0, currency: 'USD' },
  });

  if (simResult.success) {
    steps.push({
      step: 'Simulate delivery data',
      task: 'comply_test_controller',
      passed: true,
      duration_ms: 0,
      details: simResult.message || 'Delivery simulated',
      response_preview: JSON.stringify(simResult.simulated, null, 2),
    });
  } else {
    steps.push({
      step: 'Simulate delivery data',
      task: 'comply_test_controller',
      passed: false,
      duration_ms: 0,
      error: `${simResult.error}: ${simResult.error_detail || ''}`,
    });
    return { steps, profile };
  }

  // Verify via get_media_buy_delivery
  if (profile?.tools.includes('get_media_buy_delivery')) {
    const { result: deliveryResult, step: deliveryStep } = await runStep<TaskResult>(
      'Verify delivery data via get_media_buy_delivery',
      'get_media_buy_delivery',
      async () => (client as any).getMediaBuyDelivery({ media_buy_id: mediaBuyId }) as Promise<TaskResult>
    );

    if (deliveryResult?.success && deliveryResult?.data) {
      const data = deliveryResult.data as any;
      const impressions = data.impressions ?? data.total_impressions ?? data.summary?.impressions;
      if (impressions !== undefined && impressions >= 10000) {
        deliveryStep.details = `Delivery reflects simulated data: ${impressions} impressions`;
      } else {
        deliveryStep.passed = false;
        deliveryStep.error = `Expected ≥10000 impressions in delivery report, got ${impressions}`;
      }
      deliveryStep.response_preview = JSON.stringify(
        { impressions, raw_keys: Object.keys(data) },
        null,
        2
      );
    }
    steps.push(deliveryStep);
  }

  return { steps, profile };
}

// ---------------------------------------------------------------------------
// Budget Simulation
// ---------------------------------------------------------------------------

export async function testBudgetSimulation(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = getOrCreateClient(agentUrl, options);
  const controller = getController(options);
  const profile = options._profile;

  if (!controller?.detected || !supportsScenario(controller, 'simulate_budget_spend')) {
    steps.push({
      step: 'Controller check',
      task: 'comply_test_controller',
      passed: true,
      duration_ms: 0,
      details: 'simulate_budget_spend not supported — skipping',
    });
    return { steps };
  }

  // Create a media buy with a known budget
  const { steps: createSteps, mediaBuyId } = await testCreateMediaBuy(agentUrl, options);
  steps.push(...createSteps);

  if (!mediaBuyId) {
    steps.push({
      step: 'Find media buy for budget simulation',
      passed: false,
      duration_ms: 0,
      error: 'No media_buy_id — cannot test budget simulation',
    });
    return { steps, profile };
  }

  // Simulate 95% spend
  const simResult = await simulate(client, 'simulate_budget_spend', {
    media_buy_id: mediaBuyId,
    spend_percentage: 95,
  });

  if (simResult.success) {
    steps.push({
      step: 'Simulate budget spend to 95%',
      task: 'comply_test_controller',
      passed: true,
      duration_ms: 0,
      details: simResult.message || 'Budget spend simulated to 95%',
      response_preview: JSON.stringify(simResult.simulated, null, 2),
    });
  } else {
    steps.push({
      step: 'Simulate budget spend to 95%',
      task: 'comply_test_controller',
      passed: false,
      duration_ms: 0,
      error: `${simResult.error}: ${simResult.error_detail || ''}`,
    });
    return { steps, profile };
  }

  // Simulate 100% spend
  const depletedResult = await simulate(client, 'simulate_budget_spend', {
    media_buy_id: mediaBuyId,
    spend_percentage: 100,
  });

  if (depletedResult.success) {
    steps.push({
      step: 'Simulate budget fully depleted (100%)',
      task: 'comply_test_controller',
      passed: true,
      duration_ms: 0,
      details: depletedResult.message || 'Budget fully depleted',
      response_preview: JSON.stringify(depletedResult.simulated, null, 2),
    });
  } else {
    steps.push({
      step: 'Simulate budget fully depleted (100%)',
      task: 'comply_test_controller',
      passed: false,
      duration_ms: 0,
      error: `${depletedResult.error}: ${depletedResult.error_detail || ''}`,
    });
  }

  return { steps, profile };
}

// ---------------------------------------------------------------------------
// Controller Self-Validation
// ---------------------------------------------------------------------------

export async function testControllerValidation(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = getOrCreateClient(agentUrl, options);
  const controller = getController(options);

  if (!controller?.detected) {
    steps.push({
      step: 'Controller check',
      task: 'comply_test_controller',
      passed: true,
      duration_ms: 0,
      details: 'No test controller — skipping validation',
    });
    return { steps };
  }

  // Test 1: Unknown scenario → expect UNKNOWN_SCENARIO
  const unknownResult = (await (client as any).executeTask('comply_test_controller', {
    scenario: 'nonexistent_scenario',
    params: {},
  })) as TaskResult;

  const unknownData = unknownResult.data as ControllerError | undefined;
  if (unknownData && !unknownData.success && unknownData.error === 'UNKNOWN_SCENARIO') {
    steps.push({
      step: 'Unknown scenario returns UNKNOWN_SCENARIO',
      task: 'comply_test_controller',
      passed: true,
      duration_ms: 0,
      details: `Correctly returned UNKNOWN_SCENARIO for nonexistent_scenario`,
    });
  } else {
    steps.push({
      step: 'Unknown scenario returns UNKNOWN_SCENARIO',
      task: 'comply_test_controller',
      passed: false,
      duration_ms: 0,
      error: `Expected UNKNOWN_SCENARIO error, got: ${JSON.stringify(unknownData)}`,
    });
  }

  // Test 2: Missing required params → expect INVALID_PARAMS
  if (supportsScenario(controller, 'force_creative_status')) {
    const missingResult = await forceStatus(client, 'force_creative_status', {
      // Missing creative_id and status
    });
    if (!missingResult.success && missingResult.error === 'INVALID_PARAMS') {
      steps.push({
        step: 'Missing params returns INVALID_PARAMS',
        task: 'comply_test_controller',
        passed: true,
        duration_ms: 0,
        details: 'Correctly returned INVALID_PARAMS for missing creative_id/status',
      });
    } else {
      steps.push({
        step: 'Missing params returns INVALID_PARAMS',
        task: 'comply_test_controller',
        passed: false,
        duration_ms: 0,
        error: `Expected INVALID_PARAMS, got: ${!missingResult.success ? missingResult.error : 'success'}`,
      });
    }
  }

  // Test 3: NOT_FOUND for nonexistent entity
  if (supportsScenario(controller, 'force_creative_status')) {
    const notFoundResult = await forceStatus(client, 'force_creative_status', {
      creative_id: 'comply-test-nonexistent-' + Date.now(),
      status: 'approved',
    });
    if (!notFoundResult.success && notFoundResult.error === 'NOT_FOUND') {
      steps.push({
        step: 'Nonexistent entity returns NOT_FOUND',
        task: 'comply_test_controller',
        passed: true,
        duration_ms: 0,
        details: 'Correctly returned NOT_FOUND for nonexistent creative',
      });
    } else {
      steps.push({
        step: 'Nonexistent entity returns NOT_FOUND',
        task: 'comply_test_controller',
        passed: false,
        duration_ms: 0,
        error: `Expected NOT_FOUND, got: ${!notFoundResult.success ? notFoundResult.error : 'success'}`,
      });
    }
  }

  return { steps };
}
