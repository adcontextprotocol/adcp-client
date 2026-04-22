const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createComplyController, TestControllerError, createSeedFixtureCache } = require('../dist/lib/testing');

describe('createComplyController — list_scenarios', () => {
  it('advertises only the adapters that are registered (force/simulate, not seeds)', async () => {
    const controller = createComplyController({
      seed: { product: () => {} },
      force: {
        creative_status: () => ({ success: true, previous_state: 'pending', current_state: 'approved' }),
      },
      simulate: {
        delivery: () => ({ success: true, simulated: {} }),
      },
    });
    const result = await controller.handleRaw({ scenario: 'list_scenarios' });
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual([...result.scenarios].sort(), ['force_creative_status', 'simulate_delivery']);
  });

  it('returns empty scenarios when only seeds are configured (seeds are not advertised)', async () => {
    const controller = createComplyController({ seed: { product: () => {} } });
    const result = await controller.handleRaw({ scenario: 'list_scenarios' });
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.scenarios, []);
  });
});

describe('createComplyController — dispatch', () => {
  it('routes force.creative_status to the adapter with typed params', async () => {
    let captured;
    const controller = createComplyController({
      force: {
        creative_status: params => {
          captured = params;
          return { success: true, previous_state: 'pending_review', current_state: params.status };
        },
      },
    });
    const result = await controller.handleRaw({
      scenario: 'force_creative_status',
      params: { creative_id: 'cr-1', status: 'rejected', rejection_reason: 'Brand safety' },
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.current_state, 'rejected');
    assert.deepStrictEqual(captured, {
      creative_id: 'cr-1',
      status: 'rejected',
      rejection_reason: 'Brand safety',
    });
  });

  it('returns UNKNOWN_SCENARIO when an adapter is not registered', async () => {
    const controller = createComplyController({
      force: { creative_status: () => ({ success: true, previous_state: 'p', current_state: 'q' }) },
    });
    const result = await controller.handleRaw({
      scenario: 'force_account_status',
      params: { account_id: 'acct-1', status: 'active' },
    });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, 'UNKNOWN_SCENARIO');
  });

  it('surfaces TestControllerError thrown from adapter as typed response', async () => {
    const controller = createComplyController({
      force: {
        media_buy_status: () => {
          throw new TestControllerError('INVALID_TRANSITION', 'Cannot pause completed buy', 'completed');
        },
      },
    });
    const result = await controller.handleRaw({
      scenario: 'force_media_buy_status',
      params: { media_buy_id: 'mb-1', status: 'paused' },
    });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, 'INVALID_TRANSITION');
    assert.strictEqual(result.current_state, 'completed');
  });

  it('accepts sync adapter return values', async () => {
    const controller = createComplyController({
      simulate: {
        budget_spend: params => ({
          success: true,
          simulated: { spend_percentage: params.spend_percentage },
        }),
      },
    });
    const result = await controller.handleRaw({
      scenario: 'simulate_budget_spend',
      params: { media_buy_id: 'mb-1', spend_percentage: 95 },
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.simulated.spend_percentage, 95);
  });

  it('passes the raw input to adapters via ctx', async () => {
    let capturedCtx;
    const controller = createComplyController({
      force: {
        account_status: (_, ctx) => {
          capturedCtx = ctx;
          return { success: true, previous_state: 'active', current_state: 'suspended' };
        },
      },
    });
    const input = {
      scenario: 'force_account_status',
      params: { account_id: 'acct-1', status: 'suspended' },
      context: { session_id: 'sess-7' },
    };
    await controller.handleRaw(input);
    assert.strictEqual(capturedCtx.input.context.session_id, 'sess-7');
  });
});

describe('createComplyController — seed idempotency', () => {
  it('seeds a fresh fixture and returns previous_state: "none"', async () => {
    const persisted = new Map();
    const controller = createComplyController({
      seed: {
        product: params => {
          persisted.set(params.product_id, params.fixture);
        },
      },
    });
    const result = await controller.handleRaw({
      scenario: 'seed_product',
      params: { product_id: 'p1', fixture: { delivery_type: 'non_guaranteed' } },
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.previous_state, 'none');
    assert.strictEqual(result.current_state, 'seeded');
    assert.ok(persisted.has('p1'));
  });

  it('re-seeds with equivalent fixture returns previous_state: "existing" and still invokes adapter', async () => {
    let adapterCalls = 0;
    const controller = createComplyController({
      seed: {
        product: () => {
          adapterCalls++;
        },
      },
    });
    const first = await controller.handleRaw({
      scenario: 'seed_product',
      params: { product_id: 'p1', fixture: { delivery_type: 'non_guaranteed', channels: ['display'] } },
    });
    assert.strictEqual(first.previous_state, 'none');
    // Reordered keys — canonical JSON should treat this as equivalent.
    const second = await controller.handleRaw({
      scenario: 'seed_product',
      params: { product_id: 'p1', fixture: { channels: ['display'], delivery_type: 'non_guaranteed' } },
    });
    assert.strictEqual(second.success, true);
    assert.strictEqual(second.previous_state, 'existing');
    assert.strictEqual(second.current_state, 'existing');
    assert.strictEqual(adapterCalls, 2, 'adapter invoked on each call so its storage stays idempotent');
  });

  it('re-seeds with divergent fixture returns INVALID_PARAMS without invoking adapter', async () => {
    let adapterCalls = 0;
    const controller = createComplyController({
      seed: {
        creative: () => {
          adapterCalls++;
        },
      },
    });
    await controller.handleRaw({
      scenario: 'seed_creative',
      params: { creative_id: 'cr-1', fixture: { status: 'approved' } },
    });
    const second = await controller.handleRaw({
      scenario: 'seed_creative',
      params: { creative_id: 'cr-1', fixture: { status: 'rejected' } },
    });
    assert.strictEqual(second.success, false);
    assert.strictEqual(second.error, 'INVALID_PARAMS');
    assert.match(second.error_detail, /diverges/);
    assert.strictEqual(adapterCalls, 1, 'divergent fixture must not hit the adapter');
  });

  it('distinguishes cache keys across scenario kinds so id collisions do not false-match', async () => {
    const controller = createComplyController({
      seed: {
        product: () => {},
        creative: () => {},
      },
    });
    await controller.handleRaw({
      scenario: 'seed_product',
      params: { product_id: 'same-id', fixture: { delivery_type: 'guaranteed' } },
    });
    const creativeResult = await controller.handleRaw({
      scenario: 'seed_creative',
      params: { creative_id: 'same-id', fixture: { status: 'approved' } },
    });
    assert.strictEqual(creativeResult.success, true);
    assert.strictEqual(creativeResult.previous_state, 'none', 'creative with same id must be fresh');
  });

  it('honors a caller-supplied seedCache for external scoping', async () => {
    const cache = createSeedFixtureCache();
    const controllerA = createComplyController({
      seed: { product: () => {} },
      seedCache: cache,
    });
    const controllerB = createComplyController({
      seed: { product: () => {} },
      seedCache: cache,
    });
    await controllerA.handleRaw({
      scenario: 'seed_product',
      params: { product_id: 'p1', fixture: { v: 1 } },
    });
    // Second controller sharing the same cache sees 'p1' as existing.
    const result = await controllerB.handleRaw({
      scenario: 'seed_product',
      params: { product_id: 'p1', fixture: { v: 1 } },
    });
    assert.strictEqual(result.previous_state, 'existing');
  });

  it('returns INVALID_PARAMS when a seed is missing its required id', async () => {
    const controller = createComplyController({ seed: { product: () => {} } });
    const result = await controller.handleRaw({
      scenario: 'seed_product',
      params: { fixture: { delivery_type: 'guaranteed' } },
    });
    assert.strictEqual(result.error, 'INVALID_PARAMS');
    assert.match(result.error_detail, /product_id/);
  });

  it('returns UNKNOWN_SCENARIO when a seed adapter is not registered', async () => {
    const controller = createComplyController({});
    const result = await controller.handleRaw({
      scenario: 'seed_creative',
      params: { creative_id: 'cr-1', fixture: {} },
    });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, 'UNKNOWN_SCENARIO');
  });

  it('returns INVALID_PARAMS when fixture is not a plain object', async () => {
    const controller = createComplyController({ seed: { product: () => {} } });
    for (const bad of ['string-fixture', 42, true, ['array']]) {
      const result = await controller.handleRaw({
        scenario: 'seed_product',
        params: { product_id: 'p1', fixture: bad },
      });
      assert.strictEqual(result.success, false, `fixture=${JSON.stringify(bad)} should be rejected`);
      assert.strictEqual(result.error, 'INVALID_PARAMS');
      assert.match(result.error_detail, /fixture/);
    }
  });

  it('accepts an omitted fixture (defaults to empty object) and still tracks idempotency', async () => {
    const controller = createComplyController({ seed: { product: () => {} } });
    const first = await controller.handleRaw({
      scenario: 'seed_product',
      params: { product_id: 'p1' },
    });
    assert.strictEqual(first.previous_state, 'none');
    const second = await controller.handleRaw({
      scenario: 'seed_product',
      params: { product_id: 'p1', fixture: {} },
    });
    assert.strictEqual(second.previous_state, 'existing', 'omitted fixture and {} should be equivalent');
  });

  it('treats a cache that evicted between has() and get() as fresh', async () => {
    // Simulate a TTL cache: has() true, get() undefined. The handler should
    // recover rather than crash or mis-classify.
    let hasCalled = false;
    const flakyCache = {
      has: () => {
        hasCalled = true;
        return true;
      },
      get: () => undefined,
      set: () => {},
    };
    const controller = createComplyController({
      seed: { product: () => {} },
      seedCache: flakyCache,
    });
    const result = await controller.handleRaw({
      scenario: 'seed_product',
      params: { product_id: 'p1', fixture: { v: 1 } },
    });
    assert.ok(hasCalled);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.previous_state, 'none', 'evicted entry should seed fresh, not crash');
  });
});

describe('createComplyController — fixture hardening', () => {
  it('rejects fixtures with __proto__ keys to prevent prototype pollution', async () => {
    const controller = createComplyController({ seed: { product: () => {} } });
    const result = await controller.handleRaw({
      scenario: 'seed_product',
      params: { product_id: 'p1', fixture: { ['__proto__']: { polluted: true } } },
    });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, 'INVALID_PARAMS');
    assert.match(result.error_detail, /prototype pollution/);
  });

  it('rejects fixtures with constructor/prototype keys', async () => {
    const controller = createComplyController({ seed: { product: () => {} } });
    for (const key of ['constructor', 'prototype']) {
      const result = await controller.handleRaw({
        scenario: 'seed_product',
        params: { product_id: 'p1', fixture: { [key]: 'bad' } },
      });
      assert.strictEqual(result.error, 'INVALID_PARAMS', `key=${key} must be rejected`);
    }
  });
});

describe('createComplyController — seed cache cap', () => {
  it('returns INVALID_STATE when the cache exceeds its cap', async () => {
    const { createSeedFixtureCache } = require('../dist/lib/testing');
    const cache = createSeedFixtureCache(2);
    const controller = createComplyController({
      seed: { product: () => {} },
      seedCache: cache,
    });
    // Fill the cache.
    await controller.handleRaw({
      scenario: 'seed_product',
      params: { product_id: 'p1', fixture: { v: 1 } },
    });
    await controller.handleRaw({
      scenario: 'seed_product',
      params: { product_id: 'p2', fixture: { v: 2 } },
    });
    // Net-new key at cap should be rejected.
    const rejected = await controller.handleRaw({
      scenario: 'seed_product',
      params: { product_id: 'p3', fixture: { v: 3 } },
    });
    assert.strictEqual(rejected.success, false);
    assert.strictEqual(rejected.error, 'INVALID_STATE');
    assert.match(rejected.error_detail, /limit 2/);
    // Re-seeding an existing key must still work at the cap.
    const replay = await controller.handleRaw({
      scenario: 'seed_product',
      params: { product_id: 'p1', fixture: { v: 1 } },
    });
    assert.strictEqual(replay.success, true);
    assert.strictEqual(replay.previous_state, 'existing');
  });
});

describe('createComplyController — sandboxGate', () => {
  it('allows requests when the gate returns true', async () => {
    const controller = createComplyController({
      sandboxGate: input => input.context?.sandbox === true,
      force: {
        account_status: () => ({ success: true, previous_state: 'active', current_state: 'suspended' }),
      },
    });
    const result = await controller.handleRaw({
      scenario: 'force_account_status',
      params: { account_id: 'acct-1', status: 'suspended' },
      context: { sandbox: true },
    });
    assert.strictEqual(result.success, true);
  });

  it('rejects requests with FORBIDDEN when the gate returns false', async () => {
    const controller = createComplyController({
      sandboxGate: () => false,
      force: {
        account_status: () => ({ success: true, previous_state: 'active', current_state: 'suspended' }),
      },
    });
    const result = await controller.handleRaw({
      scenario: 'force_account_status',
      params: { account_id: 'acct-1', status: 'suspended' },
    });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, 'FORBIDDEN');
  });

  it('lets list_scenarios bypass the gate so capability probes always work', async () => {
    // A locked controller must still advertise its scenarios so buyer
    // tooling can distinguish "controller exists but locked" from "no
    // controller". State-mutating scenarios still get denied below.
    let gateCalls = 0;
    const controller = createComplyController({
      sandboxGate: () => {
        gateCalls++;
        return false;
      },
      force: { account_status: () => ({ success: true, previous_state: 'a', current_state: 'b' }) },
    });
    const probe = await controller.handleRaw({ scenario: 'list_scenarios' });
    assert.strictEqual(probe.success, true);
    assert.deepStrictEqual(probe.scenarios, ['force_account_status']);
    assert.strictEqual(gateCalls, 0, 'gate must not fire on capability probe');

    // State-mutating calls are still denied.
    const denied = await controller.handleRaw({
      scenario: 'force_account_status',
      params: { account_id: 'acct-1', status: 'suspended' },
    });
    assert.strictEqual(denied.error, 'FORBIDDEN');
    assert.strictEqual(gateCalls, 1);
  });

  it('fails closed when the gate throws', async () => {
    const controller = createComplyController({
      sandboxGate: () => {
        throw new Error('auth layer exploded');
      },
      force: { account_status: () => ({ success: true, previous_state: 'a', current_state: 'b' }) },
    });
    const result = await controller.handleRaw({
      scenario: 'force_account_status',
      params: { account_id: 'acct-1', status: 'suspended' },
    });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, 'FORBIDDEN');
    // Gate-internal errors must not leak.
    assert.ok(!result.error_detail.includes('auth layer exploded'));
  });

  it('denies when the gate returns a truthy non-boolean (must be strictly true)', async () => {
    const controller = createComplyController({
      // A gate author returning a "reason string" would otherwise bypass.
      sandboxGate: () => 'allowed',
      force: { account_status: () => ({ success: true, previous_state: 'a', current_state: 'b' }) },
    });
    const result = await controller.handleRaw({
      scenario: 'force_account_status',
      params: { account_id: 'acct-1', status: 'suspended' },
    });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, 'FORBIDDEN');
  });

  it('does NOT invoke adapters when the gate denies', async () => {
    let adapterCalls = 0;
    const controller = createComplyController({
      sandboxGate: () => false,
      seed: {
        product: () => {
          adapterCalls++;
        },
      },
    });
    await controller.handleRaw({
      scenario: 'seed_product',
      params: { product_id: 'p1', fixture: {} },
    });
    assert.strictEqual(adapterCalls, 0);
  });
});

describe('createComplyController — MCP envelope', () => {
  it('handle() produces structuredContent and no isError on success', async () => {
    const controller = createComplyController({
      force: { account_status: () => ({ success: true, previous_state: 'active', current_state: 'suspended' }) },
    });
    const env = await controller.handle({
      scenario: 'force_account_status',
      params: { account_id: 'acct-1', status: 'suspended' },
    });
    assert.strictEqual(env.isError, undefined);
    assert.strictEqual(env.structuredContent.current_state, 'suspended');
  });

  it('handle() sets isError: true on ControllerError responses', async () => {
    const controller = createComplyController({});
    const env = await controller.handle({
      scenario: 'force_account_status',
      params: { account_id: 'acct-1', status: 'suspended' },
    });
    assert.strictEqual(env.isError, true);
    assert.match(env.content[0].text, /UNKNOWN_SCENARIO/);
  });

  it('exposes a protocol-compliant toolDefinition', () => {
    const controller = createComplyController({});
    assert.strictEqual(controller.toolDefinition.name, 'comply_test_controller');
    assert.match(controller.toolDefinition.description, /Sandbox only/);
    assert.ok('scenario' in controller.toolDefinition.inputSchema);
    assert.ok('params' in controller.toolDefinition.inputSchema);
  });

  it('returns an isolated inputSchema so controllers do not share mutable state', () => {
    const a = createComplyController({});
    const b = createComplyController({});
    assert.notStrictEqual(a.toolDefinition.inputSchema, b.toolDefinition.inputSchema);
    // toolDefinition itself is frozen against reassignment of the shape ref.
    assert.ok(Object.isFrozen(a.toolDefinition));
  });
});

describe('createComplyController — register()', () => {
  const makeFakeServer = () => {
    const calls = [];
    return {
      calls,
      registerTool: (name, config, handler) => {
        calls.push({
          name,
          description: config?.description,
          schemaKeys: Object.keys(config?.inputSchema ?? {}),
          handlerType: typeof handler,
        });
      },
    };
  };

  // Capture console.warn without polluting test output.
  const withCapturedWarn = fn => {
    const warnings = [];
    const original = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      fn(warnings);
    } finally {
      console.warn = original;
    }
  };

  it('registers the tool on a raw McpServer via server.registerTool()', () => {
    const fake = makeFakeServer();
    const controller = createComplyController({
      sandboxGate: () => true,
      force: { account_status: () => ({ success: true, previous_state: 'a', current_state: 'b' }) },
    });
    controller.register(fake);
    assert.strictEqual(fake.calls.length, 1);
    assert.strictEqual(fake.calls[0].name, 'comply_test_controller');
    assert.deepStrictEqual(fake.calls[0].schemaKeys.sort(), ['context', 'ext', 'params', 'scenario']);
    assert.strictEqual(fake.calls[0].handlerType, 'function');
  });

  it('warns on register() when no sandboxGate and no ADCP_SANDBOX env flag', () => {
    const originalSandbox = process.env.ADCP_SANDBOX;
    const originalUngated = process.env.ADCP_COMPLY_CONTROLLER_UNGATED;
    delete process.env.ADCP_SANDBOX;
    delete process.env.ADCP_COMPLY_CONTROLLER_UNGATED;
    try {
      withCapturedWarn(warnings => {
        const controller = createComplyController({});
        controller.register(makeFakeServer());
        assert.strictEqual(warnings.length, 1);
        assert.match(warnings[0], /no sandboxGate/i);
        assert.match(warnings[0], /ADCP_SANDBOX/);
      });
    } finally {
      if (originalSandbox !== undefined) process.env.ADCP_SANDBOX = originalSandbox;
      if (originalUngated !== undefined) process.env.ADCP_COMPLY_CONTROLLER_UNGATED = originalUngated;
    }
  });

  it('stays silent on register() when sandboxGate is configured', () => {
    withCapturedWarn(warnings => {
      const controller = createComplyController({ sandboxGate: () => true });
      controller.register(makeFakeServer());
      assert.strictEqual(warnings.length, 0);
    });
  });

  it('warns once per controller even when register() is called per-request (serve() pattern)', () => {
    const originalSandbox = process.env.ADCP_SANDBOX;
    const originalUngated = process.env.ADCP_COMPLY_CONTROLLER_UNGATED;
    delete process.env.ADCP_SANDBOX;
    delete process.env.ADCP_COMPLY_CONTROLLER_UNGATED;
    try {
      withCapturedWarn(warnings => {
        const controller = createComplyController({});
        // serve() invokes the factory per request → register fires repeatedly.
        controller.register(makeFakeServer());
        controller.register(makeFakeServer());
        controller.register(makeFakeServer());
        assert.strictEqual(warnings.length, 1, 'warning must de-dupe per controller instance');
      });
    } finally {
      if (originalSandbox !== undefined) process.env.ADCP_SANDBOX = originalSandbox;
      if (originalUngated !== undefined) process.env.ADCP_COMPLY_CONTROLLER_UNGATED = originalUngated;
    }
  });

  it('stays silent when ADCP_SANDBOX=1 is set (deployment-level gating opt-out)', () => {
    const original = process.env.ADCP_SANDBOX;
    process.env.ADCP_SANDBOX = '1';
    try {
      withCapturedWarn(warnings => {
        const controller = createComplyController({});
        controller.register(makeFakeServer());
        assert.strictEqual(warnings.length, 0);
      });
    } finally {
      if (original === undefined) delete process.env.ADCP_SANDBOX;
      else process.env.ADCP_SANDBOX = original;
    }
  });

  it('stays silent when ADCP_COMPLY_CONTROLLER_UNGATED=1 (explicit opt-out)', () => {
    const original = process.env.ADCP_COMPLY_CONTROLLER_UNGATED;
    process.env.ADCP_COMPLY_CONTROLLER_UNGATED = '1';
    try {
      withCapturedWarn(warnings => {
        const controller = createComplyController({});
        controller.register(makeFakeServer());
        assert.strictEqual(warnings.length, 0);
      });
    } finally {
      if (original === undefined) delete process.env.ADCP_COMPLY_CONTROLLER_UNGATED;
      else process.env.ADCP_COMPLY_CONTROLLER_UNGATED = original;
    }
  });
});
