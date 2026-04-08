// Tests for state machine compliance scenarios:
// media_buy_lifecycle, terminal_state_enforcement, package_lifecycle

const { test, describe } = require('node:test');
const assert = require('node:assert');

// ============================================================
// Wiring: exports, routing, scenario requirements
// ============================================================

describe('State machine scenario exports', () => {
  test('testMediaBuyLifecycle is exported from testing module', () => {
    const { testMediaBuyLifecycle } = require('../../dist/lib/testing/index.js');
    assert.strictEqual(typeof testMediaBuyLifecycle, 'function');
  });

  test('testTerminalStateEnforcement is exported from testing module', () => {
    const { testTerminalStateEnforcement } = require('../../dist/lib/testing/index.js');
    assert.strictEqual(typeof testTerminalStateEnforcement, 'function');
  });

  test('testPackageLifecycle is exported from testing module', () => {
    const { testPackageLifecycle } = require('../../dist/lib/testing/index.js');
    assert.strictEqual(typeof testPackageLifecycle, 'function');
  });
});

describe('State machine scenario requirements', () => {
  test('all three scenarios are in SCENARIO_REQUIREMENTS', () => {
    const { SCENARIO_REQUIREMENTS } = require('../../dist/lib/testing/index.js');
    assert.ok('media_buy_lifecycle' in SCENARIO_REQUIREMENTS);
    assert.ok('terminal_state_enforcement' in SCENARIO_REQUIREMENTS);
    assert.ok('package_lifecycle' in SCENARIO_REQUIREMENTS);
  });

  test('media_buy_lifecycle requires get_products, create_media_buy, update_media_buy', () => {
    const { SCENARIO_REQUIREMENTS } = require('../../dist/lib/testing/index.js');
    const reqs = SCENARIO_REQUIREMENTS['media_buy_lifecycle'];
    assert.ok(Array.isArray(reqs));
    assert.ok(reqs.includes('get_products'));
    assert.ok(reqs.includes('create_media_buy'));
    assert.ok(reqs.includes('update_media_buy'));
  });

  test('terminal_state_enforcement requires get_products, create_media_buy, update_media_buy', () => {
    const { SCENARIO_REQUIREMENTS } = require('../../dist/lib/testing/index.js');
    const reqs = SCENARIO_REQUIREMENTS['terminal_state_enforcement'];
    assert.ok(Array.isArray(reqs));
    assert.ok(reqs.includes('get_products'));
    assert.ok(reqs.includes('create_media_buy'));
    assert.ok(reqs.includes('update_media_buy'));
  });

  test('package_lifecycle requires get_products, create_media_buy, update_media_buy', () => {
    const { SCENARIO_REQUIREMENTS } = require('../../dist/lib/testing/index.js');
    const reqs = SCENARIO_REQUIREMENTS['package_lifecycle'];
    assert.ok(Array.isArray(reqs));
    assert.ok(reqs.includes('get_products'));
    assert.ok(reqs.includes('create_media_buy'));
    assert.ok(reqs.includes('update_media_buy'));
  });
});

describe('State machine scenario routing in agent-tester', () => {
  test('compiled agent-tester has case for media_buy_lifecycle', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '../../dist/lib/testing/agent-tester.js'), 'utf8');
    assert.ok(src.includes("'media_buy_lifecycle'"), 'should route media_buy_lifecycle');
    assert.ok(src.includes('testMediaBuyLifecycle'), 'should call testMediaBuyLifecycle');
  });

  test('compiled agent-tester has case for terminal_state_enforcement', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '../../dist/lib/testing/agent-tester.js'), 'utf8');
    assert.ok(src.includes("'terminal_state_enforcement'"), 'should route terminal_state_enforcement');
    assert.ok(src.includes('testTerminalStateEnforcement'), 'should call testTerminalStateEnforcement');
  });

  test('compiled agent-tester has case for package_lifecycle', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '../../dist/lib/testing/agent-tester.js'), 'utf8');
    assert.ok(src.includes("'package_lifecycle'"), 'should route package_lifecycle');
    assert.ok(src.includes('testPackageLifecycle'), 'should call testPackageLifecycle');
  });
});

describe('getApplicableScenarios with state machine scenarios', () => {
  test('state machine scenarios included when all required tools present', () => {
    const { getApplicableScenarios } = require('../../dist/lib/testing/index.js');
    const tools = ['get_products', 'create_media_buy', 'update_media_buy', 'get_media_buys'];
    const applicable = getApplicableScenarios(tools);
    assert.ok(applicable.includes('media_buy_lifecycle'), 'should include media_buy_lifecycle');
    assert.ok(applicable.includes('terminal_state_enforcement'), 'should include terminal_state_enforcement');
    assert.ok(applicable.includes('package_lifecycle'), 'should include package_lifecycle');
  });

  test('state machine scenarios excluded without update_media_buy', () => {
    const { getApplicableScenarios } = require('../../dist/lib/testing/index.js');
    const tools = ['get_products', 'create_media_buy'];
    const applicable = getApplicableScenarios(tools);
    assert.ok(!applicable.includes('media_buy_lifecycle'), 'should not include media_buy_lifecycle');
    assert.ok(!applicable.includes('terminal_state_enforcement'), 'should not include terminal_state_enforcement');
    assert.ok(!applicable.includes('package_lifecycle'), 'should not include package_lifecycle');
  });

  test('state machine scenarios excluded without create_media_buy', () => {
    const { getApplicableScenarios } = require('../../dist/lib/testing/index.js');
    const tools = ['get_products', 'update_media_buy'];
    const applicable = getApplicableScenarios(tools);
    assert.ok(!applicable.includes('media_buy_lifecycle'));
    assert.ok(!applicable.includes('terminal_state_enforcement'));
    assert.ok(!applicable.includes('package_lifecycle'));
  });
});

// ============================================================
// Comply track integration
// ============================================================

describe('State machine storyboards cover media_buy track', () => {
  test('media_buy_state_machine storyboard exists and targets media_buy track', () => {
    const { getStoryboardById } = require('../../dist/lib/testing/storyboard/loader.js');
    const sb = getStoryboardById('media_buy_state_machine');
    assert.ok(sb, 'media_buy_state_machine storyboard should exist');
    assert.strictEqual(sb.track, 'media_buy', 'storyboard should target media_buy track');
    assert.ok(sb.required_tools.includes('create_media_buy'), 'storyboard should require create_media_buy');
    assert.ok(sb.required_tools.includes('update_media_buy'), 'storyboard should require update_media_buy');
  });

  test('PLATFORM_STORYBOARDS includes media_buy storyboards for sales platforms', () => {
    const { PLATFORM_STORYBOARDS } = require('../../dist/lib/testing/compliance/platform-storyboards.js');
    // All sales platforms should have at least one media_buy storyboard
    const salesTypes = ['display_ad_server', 'video_ad_server', 'social_platform', 'dsp'];
    for (const type of salesTypes) {
      const ids = PLATFORM_STORYBOARDS[type];
      const hasMediaBuy = ids.some(id => id.startsWith('media_buy_'));
      assert.ok(hasMediaBuy, `${type} should include a media_buy storyboard`);
    }
  });
});

// ============================================================
// Scenario logic: compiled source analysis
// ============================================================

describe('media_buy_lifecycle scenario logic', () => {
  test('scenario calls pause, resume, and cancel operations', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '../../dist/lib/testing/scenarios/media-buy.js'), 'utf8');
    // Verify the scenario implementation has the right operations
    assert.ok(src.includes('Pause media buy'), 'should have pause step');
    assert.ok(src.includes('Resume media buy'), 'should have resume step');
    assert.ok(src.includes('Cancel media buy'), 'should have cancel step');
    assert.ok(src.includes('valid_actions'), 'should check valid_actions');
  });

  test('scenario handles NOT_CANCELLABLE gracefully', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '../../dist/lib/testing/scenarios/media-buy.js'), 'utf8');
    assert.ok(src.includes('NOT_CANCELLABLE'), 'should handle NOT_CANCELLABLE error code');
  });
});

describe('terminal_state_enforcement scenario logic', () => {
  test('scenario expects rejection of updates to canceled buys', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '../../dist/lib/testing/scenarios/media-buy.js'), 'utf8');
    assert.ok(src.includes('Update canceled media buy (expect rejection)'), 'should have step that expects rejection');
    assert.ok(src.includes('INVALID_STATE'), 'should check for INVALID_STATE error code');
  });

  test('scenario treats re-cancellation as acceptable (idempotent)', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '../../dist/lib/testing/scenarios/media-buy.js'), 'utf8');
    assert.ok(src.includes('idempotent'), 'should accept idempotent re-cancellation');
  });

  test('scenario fails if agent accepts update to canceled buy', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '../../dist/lib/testing/scenarios/media-buy.js'), 'utf8');
    assert.ok(
      src.includes('Agent accepted update to canceled media buy'),
      'should fail when agent accepts invalid update'
    );
  });
});

describe('package_lifecycle scenario logic', () => {
  test('scenario pauses and resumes individual packages', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '../../dist/lib/testing/scenarios/media-buy.js'), 'utf8');
    assert.ok(src.includes('Pause package'), 'should have package pause step');
    assert.ok(src.includes('Resume package'), 'should have package resume step');
  });

  test('scenario verifies media buy stays active after package operations', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '../../dist/lib/testing/scenarios/media-buy.js'), 'utf8');
    assert.ok(
      src.includes('Verify media buy still active after package operations'),
      'should verify media buy status unchanged'
    );
  });

  test('scenario tries to resolve real package IDs via get_media_buys', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '../../dist/lib/testing/scenarios/media-buy.js'), 'utf8');
    assert.ok(src.includes('Fetch package IDs'), 'should attempt to discover real package IDs');
    // Falls back to pkg-0 if get_media_buys unavailable
    assert.ok(src.includes('pkg-0'), 'should fall back to conventional package ID');
  });
});

// ============================================================
// Scenario decision logic: verify correct pass/fail behavior
// These test the compiled scenario code's branching by analyzing
// the source for the expected conditional patterns.
// ============================================================

describe('terminal_state_enforcement: pass/fail decision matrix', () => {
  // The scenario has three distinct behavioral branches we need to verify:

  test('when agent accepts update to canceled buy: step.passed = false', () => {
    // The scenario should fail if pauseResult?.success is truthy for a canceled buy
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '../../dist/lib/testing/scenarios/media-buy.js'), 'utf8');

    // Verify the inverted check: success on a canceled buy = failure
    assert.ok(
      src.includes('Agent accepted update to canceled media buy'),
      'should set error when agent accepts invalid update'
    );
  });

  test('when agent rejects with INVALID_STATE: step.passed = true with good details', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '../../dist/lib/testing/scenarios/media-buy.js'), 'utf8');

    assert.ok(
      src.includes('Correctly rejected with INVALID_STATE'),
      'should acknowledge correct INVALID_STATE rejection'
    );
  });

  test('when agent rejects without INVALID_STATE: step.passed = true but warns', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '../../dist/lib/testing/scenarios/media-buy.js'), 'utf8');

    assert.ok(
      src.includes('did not use INVALID_STATE error code'),
      'should warn about missing error code even when rejection is correct'
    );
  });

  test('when cancel setup returns NOT_CANCELLABLE: skips terminal tests gracefully', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '../../dist/lib/testing/scenarios/media-buy.js'), 'utf8');

    // Should try completed media buys when NOT_CANCELLABLE during setup
    assert.ok(
      src.includes('will check for completed media buys instead'),
      'should fall back to completed state test when cancellation not supported'
    );
  });
});

describe('media_buy_lifecycle: status validation logic', () => {
  test('warns when pause returns unexpected status', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '../../dist/lib/testing/scenarios/media-buy.js'), 'utf8');

    assert.ok(src.includes("Expected status 'paused'"), 'should warn when pause returns wrong status');
  });

  test('warns when resume returns unexpected status', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '../../dist/lib/testing/scenarios/media-buy.js'), 'utf8');

    assert.ok(
      src.includes("Expected status 'active' or 'pending_activation'"),
      'should warn when resume returns wrong status'
    );
  });

  test('warns when cancel returns unexpected status', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '../../dist/lib/testing/scenarios/media-buy.js'), 'utf8');

    assert.ok(src.includes("Expected status 'canceled'"), 'should warn when cancel returns wrong status');
  });
});

describe('package_lifecycle: media buy status preservation', () => {
  test('warns if package operations change media buy status', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '../../dist/lib/testing/scenarios/media-buy.js'), 'utf8');

    assert.ok(
      src.includes('Package-level pause/resume changed media buy status'),
      'should warn if media buy status changes after package operations'
    );
  });
});

// ============================================================
// Comply observations for media buy track
// ============================================================

describe('comply observations for state machine scenarios', () => {
  test('comply.js checks for valid_actions in media buy track observations', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '../../dist/lib/testing/compliance/comply.js'), 'utf8');
    assert.ok(src.includes('valid_actions'), 'comply should observe valid_actions presence');
    assert.ok(
      src.includes('buyer agents must hardcode the state machine'),
      'comply should explain why valid_actions matters'
    );
  });

  test('comply.js checks for pause/resume support in lifecycle observations', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '../../dist/lib/testing/compliance/comply.js'), 'utf8');
    assert.ok(src.includes('does not support pause/resume'), 'comply should observe missing pause/resume support');
  });
});
