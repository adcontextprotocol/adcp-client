const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  AgentClient,
  PrincipalLifecycleTimeoutError,
  ProtocolClient,
  syncPrincipalLifecycle,
} = require('../../dist/lib/index.js');

function completed(data) {
  return {
    success: true,
    status: 'completed',
    data,
    metadata: { status: 'completed', taskName: 'principal-test' },
    conversation: [],
    debug_logs: [],
  };
}

function failed(data) {
  return {
    success: false,
    status: 'failed',
    data,
    error: 'Task rejected',
    metadata: { status: 'failed', taskName: 'principal-test' },
    conversation: [],
    debug_logs: [],
  };
}

function current(version, state = 'ready', declarations) {
  return {
    status: 'completed',
    result: {
      kind: 'current',
      principal_id: 'principal-1',
      principal_kind: 'buyer_agent',
      configuration_version: version,
      configuration: {
        reporting_destinations: [
          {
            destination_id: 'warehouse',
            destination_ref: 'destination-1',
            state,
            configuration: { pattern: 'warehouse_materialization', destination_id: 'warehouse' },
          },
        ],
        ...(declarations === undefined ? {} : { declarations }),
      },
    },
  };
}

function applied(version, state = 'ready') {
  const readback = current(version, state).result;
  return {
    status: 'completed',
    result: {
      kind: 'applied',
      action: 'updated',
      dry_run: false,
      principal_id: readback.principal_id,
      principal_kind: readback.principal_kind,
      configuration_version: readback.configuration_version,
      configuration: readback.configuration,
    },
  };
}

describe('principal lifecycle', () => {
  test('uses guarded replacement, polls setup, and returns declaration negotiation readback', async () => {
    const declarations = {
      declared: { async_adcp_versions: ['3.2'] },
      accepted: { async_adcp_versions: ['3.2'] },
      selected_async_adcp_version: '3.2',
      exclusions: [],
    };
    const reads = [current('v1'), current('v2', 'validating'), current('v2', 'ready', declarations)];
    const syncRequests = [];
    const client = {
      getPrincipal: async () => completed(reads.shift()),
      syncPrincipal: async request => {
        syncRequests.push(request);
        return completed(applied('v2', 'validating'));
      },
    };

    const result = await syncPrincipalLifecycle(
      client,
      { reporting_destinations: [] },
      { pollIntervalMs: 1, createIdempotencyKey: () => 'principal-operation-0001' }
    );

    assert.equal(syncRequests.length, 1);
    assert.equal(syncRequests[0].expected_configuration_version, 'v1');
    assert.equal(syncRequests[0].expected_principal_kind, 'buyer_agent');
    assert.equal(syncRequests[0].idempotency_key, 'principal-operation-0001');
    assert.equal(result.destinationsReady, true);
    assert.deepEqual(result.declarations, declarations);
  });

  test('rereads and starts a fresh logical operation after a structured conflict', async () => {
    const reads = [current('v1'), current('v2')];
    const requests = [];
    const keys = ['principal-operation-0001', 'principal-operation-0002'];
    const client = {
      getPrincipal: async () => completed(reads.shift()),
      syncPrincipal: async request => {
        requests.push(request);
        if (requests.length === 1) {
          return failed({
            status: 'rejected',
            result: {
              kind: 'failed',
              errors: [{ code: 'CONFLICT', message: 'stale configuration', recovery: 'correctable' }],
            },
          });
        }
        return completed(applied('v3'));
      },
    };

    await syncPrincipalLifecycle(client, { notification_configs: [] }, { createIdempotencyKey: () => keys.shift() });

    assert.deepEqual(
      requests.map(request => [request.idempotency_key, request.expected_configuration_version]),
      [
        ['principal-operation-0001', 'v1'],
        ['principal-operation-0002', 'v2'],
      ]
    );
  });

  test('returns terminal destination setup without claiming readiness', async () => {
    const client = {
      getPrincipal: async () => completed(current('v1')),
      syncPrincipal: async () => completed(applied('v2', 'action_required')),
    };

    const result = await syncPrincipalLifecycle(client, { reporting_destinations: [] });
    assert.equal(result.destinationsReady, false);
    assert.equal(result.current.configuration.reporting_destinations[0].state, 'action_required');
  });

  test('fails closed when identity or configuration changes during setup polling', async () => {
    const changed = current('v3', 'ready');
    changed.result.principal_id = 'principal-2';
    const reads = [current('v1'), changed];
    const client = {
      getPrincipal: async () => completed(reads.shift()),
      syncPrincipal: async () => completed(applied('v2', 'validating')),
    };

    await assert.rejects(
      syncPrincipalLifecycle(client, { reporting_destinations: [] }, { pollIntervalMs: 1 }),
      /configuration changed/
    );
  });

  test('bounds setup polling and honors caller cancellation', async () => {
    let timeoutReads = 0;
    const timeoutClient = {
      getPrincipal: async () => completed(current(timeoutReads++ === 0 ? 'v1' : 'v2', 'validating')),
      syncPrincipal: async () => completed(applied('v2', 'validating')),
    };
    await assert.rejects(
      syncPrincipalLifecycle(timeoutClient, { reporting_destinations: [] }, { setupTimeoutMs: 5, pollIntervalMs: 1 }),
      PrincipalLifecycleTimeoutError
    );

    const controller = new AbortController();
    let abortReads = 0;
    const abortClient = {
      getPrincipal: async () => completed(current(abortReads++ === 0 ? 'v1' : 'v2', 'validating')),
      syncPrincipal: async () => completed(applied('v2', 'validating')),
    };
    setTimeout(() => controller.abort(new Error('stop polling')), 1);
    await assert.rejects(
      syncPrincipalLifecycle(
        abortClient,
        { reporting_destinations: [] },
        { signal: controller.signal, setupTimeoutMs: 100, pollIntervalMs: 20 }
      ),
      /stop polling/
    );

    await assert.rejects(
      syncPrincipalLifecycle(abortClient, { notification_configs: [] }, { maxAttempts: 11 }),
      /maxAttempts must be at most 10/
    );
  });

  test('preserves a disabled task timeout while bounding setup reads by the lifecycle deadline', async () => {
    const observedTimeouts = [];
    let reads = 0;
    const client = {
      getPrincipal: async (_params, _inputHandler, taskOptions) => {
        observedTimeouts.push(taskOptions.timeout);
        return completed(current(reads++ === 0 ? 'v1' : 'v2', 'ready'));
      },
      syncPrincipal: async (_request, _inputHandler, taskOptions) => {
        observedTimeouts.push(taskOptions.timeout);
        return completed(applied('v2', 'validating'));
      },
    };

    await syncPrincipalLifecycle(
      client,
      { reporting_destinations: [] },
      { taskOptions: { timeout: 0 }, setupTimeoutMs: 100, pollIntervalMs: 1 }
    );

    assert.deepEqual(observedTimeouts.slice(0, 2), [0, 0]);
    assert.ok(observedTimeouts[2] > 1 && observedTimeouts[2] <= 100);
  });

  test('does not dispatch a setup read after the lifecycle deadline', async () => {
    let reads = 0;
    const client = {
      getPrincipal: async () => completed(current(reads++ === 0 ? 'v1' : 'v2', 'validating')),
      syncPrincipal: async () => completed(applied('v2', 'validating')),
    };

    await assert.rejects(
      syncPrincipalLifecycle(client, { reporting_destinations: [] }, { setupTimeoutMs: 5, pollIntervalMs: 100 }),
      PrincipalLifecycleTimeoutError
    );
    assert.equal(reads, 1);
  });
});

describe('principal task transport dispatch', () => {
  for (const protocol of ['mcp', 'a2a']) {
    test(`getPrincipal and syncPrincipal dispatch over ${protocol.toUpperCase()}`, async () => {
      const originalCallTool = ProtocolClient.callTool;
      const calls = [];
      ProtocolClient.callTool = async (agent, taskName, params) => {
        calls.push([agent.protocol, taskName, params]);
        return taskName === 'get_principal' ? { status: 'completed', result: { kind: 'unconfigured' } } : applied('v1');
      };
      try {
        const client = new AgentClient(
          {
            id: `principal-${protocol}`,
            name: `Principal ${protocol}`,
            agent_uri: `https://seller.example/${protocol}`,
            protocol,
          },
          { validateFeatures: false, validation: { requests: 'off', responses: 'off' } }
        );
        // Protocol dispatch is under test, not HTTP discovery. Keep the
        // configured endpoint so the shared TaskExecutor reaches the stub.
        client.client.normalizedAgent._needsDiscovery = false;
        client.client.normalizedAgent._needsCanonicalUrl = false;
        client.client.detectServerVersion = async () => 'v3';
        assert.equal((await client.getPrincipal()).status, 'completed');
        assert.equal(
          (
            await client.syncPrincipal({
              idempotency_key: 'principal-operation-0001',
              configuration: { notification_configs: [] },
            })
          ).status,
          'completed'
        );
      } finally {
        ProtocolClient.callTool = originalCallTool;
      }

      assert.deepEqual(
        calls.map(([observedProtocol, taskName]) => [observedProtocol, taskName]),
        [
          [protocol, 'get_principal'],
          [protocol, 'sync_principal'],
        ]
      );
    });
  }
});
