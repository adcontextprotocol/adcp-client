// Tests for deterministic state machine compliance scenarios
// (comply_test_controller integration)

const { test, describe } = require('node:test');
const assert = require('node:assert');

// ============================================================
// Wiring: exports, routing, scenario requirements
// ============================================================

describe('Deterministic scenario exports', () => {
  test('testCreativeStateMachine is exported', () => {
    const { testCreativeStateMachine } = require('../../dist/lib/testing/index.js');
    assert.strictEqual(typeof testCreativeStateMachine, 'function');
  });

  test('testMediaBuyStateMachine is exported', () => {
    const { testMediaBuyStateMachine } = require('../../dist/lib/testing/index.js');
    assert.strictEqual(typeof testMediaBuyStateMachine, 'function');
  });

  test('testAccountStateMachine is exported', () => {
    const { testAccountStateMachine } = require('../../dist/lib/testing/index.js');
    assert.strictEqual(typeof testAccountStateMachine, 'function');
  });

  test('testSessionStateMachine is exported', () => {
    const { testSessionStateMachine } = require('../../dist/lib/testing/index.js');
    assert.strictEqual(typeof testSessionStateMachine, 'function');
  });

  test('testDeliverySimulation is exported', () => {
    const { testDeliverySimulation } = require('../../dist/lib/testing/index.js');
    assert.strictEqual(typeof testDeliverySimulation, 'function');
  });

  test('testBudgetSimulation is exported', () => {
    const { testBudgetSimulation } = require('../../dist/lib/testing/index.js');
    assert.strictEqual(typeof testBudgetSimulation, 'function');
  });

  test('testControllerValidation is exported', () => {
    const { testControllerValidation } = require('../../dist/lib/testing/index.js');
    assert.strictEqual(typeof testControllerValidation, 'function');
  });
});

describe('Deterministic scenario requirements', () => {
  test('all deterministic scenarios are in SCENARIO_REQUIREMENTS', () => {
    const { SCENARIO_REQUIREMENTS } = require('../../dist/lib/testing/index.js');
    assert.ok('deterministic_creative' in SCENARIO_REQUIREMENTS);
    assert.ok('deterministic_media_buy' in SCENARIO_REQUIREMENTS);
    assert.ok('deterministic_account' in SCENARIO_REQUIREMENTS);
    assert.ok('deterministic_session' in SCENARIO_REQUIREMENTS);
    assert.ok('deterministic_delivery' in SCENARIO_REQUIREMENTS);
    assert.ok('deterministic_budget' in SCENARIO_REQUIREMENTS);
    assert.ok('controller_validation' in SCENARIO_REQUIREMENTS);
  });

  test('all deterministic scenarios require comply_test_controller', () => {
    const { SCENARIO_REQUIREMENTS } = require('../../dist/lib/testing/index.js');
    const deterministicScenarios = [
      'deterministic_creative',
      'deterministic_media_buy',
      'deterministic_account',
      'deterministic_session',
      'deterministic_delivery',
      'deterministic_budget',
      'controller_validation',
    ];
    for (const scenario of deterministicScenarios) {
      const reqs = SCENARIO_REQUIREMENTS[scenario];
      assert.ok(Array.isArray(reqs), `${scenario} requirements should be an array`);
      assert.ok(
        reqs.includes('comply_test_controller'),
        `${scenario} should require comply_test_controller, got: ${reqs.join(', ')}`
      );
    }
  });

  test('deterministic_creative requires sync_creatives', () => {
    const { SCENARIO_REQUIREMENTS } = require('../../dist/lib/testing/index.js');
    const reqs = SCENARIO_REQUIREMENTS['deterministic_creative'];
    assert.ok(reqs.includes('sync_creatives'));
  });

  test('deterministic_media_buy requires get_products and create_media_buy', () => {
    const { SCENARIO_REQUIREMENTS } = require('../../dist/lib/testing/index.js');
    const reqs = SCENARIO_REQUIREMENTS['deterministic_media_buy'];
    assert.ok(reqs.includes('get_products'));
    assert.ok(reqs.includes('create_media_buy'));
  });

  test('deterministic_account requires list_accounts', () => {
    const { SCENARIO_REQUIREMENTS } = require('../../dist/lib/testing/index.js');
    const reqs = SCENARIO_REQUIREMENTS['deterministic_account'];
    assert.ok(reqs.includes('list_accounts'));
  });

  test('deterministic_session requires si_initiate_session', () => {
    const { SCENARIO_REQUIREMENTS } = require('../../dist/lib/testing/index.js');
    const reqs = SCENARIO_REQUIREMENTS['deterministic_session'];
    assert.ok(reqs.includes('si_initiate_session'));
  });

  test('deterministic_delivery requires get_media_buy_delivery', () => {
    const { SCENARIO_REQUIREMENTS } = require('../../dist/lib/testing/index.js');
    const reqs = SCENARIO_REQUIREMENTS['deterministic_delivery'];
    assert.ok(reqs.includes('get_media_buy_delivery'));
  });
});

// ============================================================
// Test controller module
// ============================================================

describe('Test controller module', () => {
  test('hasTestController detects the tool', () => {
    const { hasTestController } = require('../../dist/lib/testing/test-controller.js');
    assert.strictEqual(hasTestController({ name: 'test', tools: ['comply_test_controller', 'get_products'] }), true);
    assert.strictEqual(hasTestController({ name: 'test', tools: ['get_products'] }), false);
    assert.strictEqual(hasTestController({ name: 'test', tools: [] }), false);
  });

  test('supportsScenario checks controller capabilities', () => {
    const { supportsScenario } = require('../../dist/lib/testing/test-controller.js');

    const controller = {
      detected: true,
      scenarios: ['force_creative_status', 'force_account_status'],
    };
    assert.strictEqual(supportsScenario(controller, 'force_creative_status'), true);
    assert.strictEqual(supportsScenario(controller, 'force_account_status'), true);
    assert.strictEqual(supportsScenario(controller, 'force_media_buy_status'), false);
    assert.strictEqual(supportsScenario(controller, 'simulate_delivery'), false);
  });

  test('supportsScenario returns false when controller not detected', () => {
    const { supportsScenario } = require('../../dist/lib/testing/test-controller.js');
    const noController = { detected: false };
    assert.strictEqual(supportsScenario(noController, 'force_creative_status'), false);
  });

  test('isSuccess and isControllerError type guards', () => {
    const { isSuccess, isControllerError } = require('../../dist/lib/testing/test-controller.js');

    const successResponse = { success: true, previous_state: 'processing', current_state: 'approved' };
    const errorResponse = { success: false, error: 'INVALID_TRANSITION', current_state: 'archived' };

    assert.strictEqual(isSuccess(successResponse), true);
    assert.strictEqual(isControllerError(successResponse), false);
    assert.strictEqual(isSuccess(errorResponse), false);
    assert.strictEqual(isControllerError(errorResponse), true);
  });
});

// ============================================================
// Compliance types
// ============================================================

describe('Compliance result types', () => {
  test('TrackResult mode field is optional', () => {
    // Just verify the types are importable and the module loads
    const compliance = require('../../dist/lib/testing/compliance/index.js');
    assert.ok(compliance.comply, 'comply function should be exported');
  });
});

// ============================================================
// Scenario applicability
// ============================================================

describe('Deterministic scenario applicability', () => {
  test('deterministic scenarios are not applicable without comply_test_controller', () => {
    const { getApplicableScenarios } = require('../../dist/lib/testing/index.js');

    // Agent with typical tools but no controller
    const tools = ['get_products', 'create_media_buy', 'sync_creatives', 'get_media_buys'];
    const scenarios = ['deterministic_creative', 'deterministic_media_buy', 'controller_validation'];

    const applicable = getApplicableScenarios(tools, scenarios);
    assert.strictEqual(applicable.length, 0, 'No deterministic scenarios should be applicable without controller');
  });

  test('deterministic scenarios are applicable with comply_test_controller', () => {
    const { getApplicableScenarios } = require('../../dist/lib/testing/index.js');

    // Agent with controller and required tools
    const tools = [
      'comply_test_controller',
      'get_products',
      'create_media_buy',
      'sync_creatives',
      'get_media_buy_delivery',
    ];
    const scenarios = [
      'deterministic_creative',
      'deterministic_media_buy',
      'deterministic_delivery',
      'controller_validation',
    ];

    const applicable = getApplicableScenarios(tools, scenarios);
    assert.ok(applicable.includes('deterministic_creative'));
    assert.ok(applicable.includes('deterministic_media_buy'));
    assert.ok(applicable.includes('deterministic_delivery'));
    assert.ok(applicable.includes('controller_validation'));
  });

  test('deterministic_account not applicable without list_accounts', () => {
    const { getApplicableScenarios } = require('../../dist/lib/testing/index.js');

    const tools = ['comply_test_controller', 'get_products'];
    const applicable = getApplicableScenarios(tools, ['deterministic_account']);
    assert.strictEqual(applicable.length, 0);
  });

  test('deterministic_session not applicable without si_initiate_session', () => {
    const { getApplicableScenarios } = require('../../dist/lib/testing/index.js');

    const tools = ['comply_test_controller', 'get_products'];
    const applicable = getApplicableScenarios(tools, ['deterministic_session']);
    assert.strictEqual(applicable.length, 0);
  });
});

// ============================================================
// Response schema
// ============================================================

describe('Response schema registration', () => {
  test('comply_test_controller has a response schema', () => {
    const { TOOL_RESPONSE_SCHEMAS } = require('../../dist/lib/utils/response-schemas.js');
    assert.ok(
      TOOL_RESPONSE_SCHEMAS['comply_test_controller'],
      'comply_test_controller should have a registered response schema'
    );
  });
});

// ============================================================
// Generated types
// ============================================================

describe('Generated comply test controller types', () => {
  test('ComplyTestControllerRequest type exists', () => {
    const fs = require('fs');
    const path = require('path');
    const typesContent = fs.readFileSync(path.join(__dirname, '../../src/lib/types/tools.generated.ts'), 'utf8');
    assert.ok(typesContent.includes('export type ComplyTestControllerRequest'));
    assert.ok(typesContent.includes('export type ComplyTestControllerResponse'));
  });

  test('Request has all scenario variants', () => {
    const fs = require('fs');
    const path = require('path');
    const typesContent = fs.readFileSync(path.join(__dirname, '../../src/lib/types/tools.generated.ts'), 'utf8');
    // The comply test controller uses a single request type with a scenario discriminant
    assert.ok(typesContent.includes('ComplyTestControllerRequest'));
    assert.ok(typesContent.includes("'list_scenarios'"));
    assert.ok(typesContent.includes("'force_creative_status'"));
    assert.ok(typesContent.includes("'force_account_status'"));
    assert.ok(typesContent.includes("'force_media_buy_status'"));
    assert.ok(typesContent.includes("'force_session_status'"));
    assert.ok(typesContent.includes("'simulate_delivery'"));
    assert.ok(typesContent.includes("'simulate_budget_spend'"));
  });

  test('Response has all variant types', () => {
    const fs = require('fs');
    const path = require('path');
    const typesContent = fs.readFileSync(path.join(__dirname, '../../src/lib/types/tools.generated.ts'), 'utf8');
    assert.ok(typesContent.includes('interface ListScenariosSuccess'));
    assert.ok(typesContent.includes('interface StateTransitionSuccess'));
    assert.ok(typesContent.includes('interface SimulationSuccess'));
    assert.ok(typesContent.includes('interface ControllerError'));
  });

  test('ControllerError has correct error codes', () => {
    const fs = require('fs');
    const path = require('path');
    const typesContent = fs.readFileSync(path.join(__dirname, '../../src/lib/types/tools.generated.ts'), 'utf8');
    assert.ok(typesContent.includes("'INVALID_TRANSITION'"));
    assert.ok(typesContent.includes("'NOT_FOUND'"));
    assert.ok(typesContent.includes("'UNKNOWN_SCENARIO'"));
    assert.ok(typesContent.includes("'INVALID_PARAMS'"));
    assert.ok(typesContent.includes("'INTERNAL_ERROR'"));
  });

  test('Zod schemas exist for validation', () => {
    const fs = require('fs');
    const path = require('path');
    const schemasContent = fs.readFileSync(path.join(__dirname, '../../src/lib/types/schemas.generated.ts'), 'utf8');
    assert.ok(schemasContent.includes('ComplyTestControllerRequestSchema'));
    assert.ok(schemasContent.includes('ComplyTestControllerResponseSchema'));
  });
});
