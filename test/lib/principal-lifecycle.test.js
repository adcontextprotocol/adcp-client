const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  AgentClient,
  PrincipalLifecycleError,
  PrincipalLifecycleTimeoutError,
  ProtocolClient,
  TaskTimeoutError,
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
            configuration: { pattern: 'warehouse_materialization', destination_id: 'warehouse', active: true },
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

function reportingConfiguration() {
  return { reporting_destinations: [{ destination_id: 'warehouse', active: true }] };
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

    const result = await syncPrincipalLifecycle(client, reportingConfiguration(), {
      pollIntervalMs: 1,
      createIdempotencyKey: () => 'principal-operation-0001',
    });

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

  test('requires a fresh valid idempotency key for every conflict retry', async () => {
    const reads = [current('v1'), current('v2')];
    let syncCalls = 0;
    const client = {
      getPrincipal: async () => completed(reads.shift()),
      syncPrincipal: async () => {
        syncCalls += 1;
        return failed({
          status: 'rejected',
          result: {
            kind: 'failed',
            errors: [{ code: 'CONFLICT', message: 'stale configuration', recovery: 'correctable' }],
          },
        });
      },
    };

    await assert.rejects(
      syncPrincipalLifecycle(client, { notification_configs: [] }, { createIdempotencyKey: () => 'same-key-0000001' }),
      /fresh key/
    );
    assert.equal(syncCalls, 1);
    await assert.rejects(
      syncPrincipalLifecycle(
        {
          getPrincipal: async () => completed(current('v1')),
          syncPrincipal: async () => completed(applied('v2')),
        },
        { notification_configs: [] },
        { createIdempotencyKey: () => 'short' }
      ),
      /valid AdCP idempotency key/
    );
  });

  test('bootstraps unconfigured and recognized principals with the appropriate fences', async () => {
    const observed = [];
    for (const prior of [
      { status: 'completed', result: { kind: 'unconfigured' } },
      {
        status: 'completed',
        result: { kind: 'recognized', principal_id: 'principal-1', principal_kind: 'buyer_agent' },
      },
    ]) {
      const client = {
        getPrincipal: async () => completed(prior),
        syncPrincipal: async request => {
          observed.push(request);
          return completed(applied('v1'));
        },
      };
      await syncPrincipalLifecycle(client, { notification_configs: [] });
    }

    assert.equal(observed[0].expected_configuration_version, undefined);
    assert.equal(observed[0].expected_principal_kind, undefined);
    assert.equal(observed[1].expected_configuration_version, undefined);
    assert.equal(observed[1].expected_principal_kind, 'buyer_agent');
  });

  test('fails closed when authenticated principal identity changes during conflict recovery', async () => {
    const changed = current('v2');
    changed.result.principal_id = 'principal-2';
    const reads = [current('v1'), changed];
    let syncCalls = 0;
    const client = {
      getPrincipal: async () => completed(reads.shift()),
      syncPrincipal: async () => {
        syncCalls += 1;
        return failed({
          status: 'rejected',
          result: {
            kind: 'failed',
            errors: [{ code: 'CONFLICT', message: 'stale configuration', recovery: 'correctable' }],
          },
        });
      },
    };

    await assert.rejects(
      syncPrincipalLifecycle(client, { notification_configs: [] }),
      /Authenticated principal changed/
    );
    assert.equal(syncCalls, 1);
  });

  test('fails closed when the applied response changes principal identity or violates the caller kind assertion', async () => {
    const changed = applied('v2');
    changed.result.principal_id = 'principal-2';
    const changedClient = {
      getPrincipal: async () => completed(current('v1')),
      syncPrincipal: async () => completed(changed),
    };
    await assert.rejects(
      syncPrincipalLifecycle(changedClient, { notification_configs: [] }),
      /Authenticated principal changed/
    );

    let syncCalls = 0;
    const wrongKindClient = {
      getPrincipal: async () => completed(current('v1')),
      syncPrincipal: async () => {
        syncCalls += 1;
        return completed(applied('v2'));
      },
    };
    await assert.rejects(
      syncPrincipalLifecycle(wrongKindClient, { notification_configs: [] }, { expectedPrincipalKind: 'operator' }),
      /did not match the caller's operator assertion/
    );
    assert.equal(syncCalls, 0);
  });

  test('does not retry an unconfigured principal conflict without an identity fence', async () => {
    let syncCalls = 0;
    const client = {
      getPrincipal: async () => completed({ status: 'completed', result: { kind: 'unconfigured' } }),
      syncPrincipal: async () => {
        syncCalls += 1;
        return failed({
          status: 'rejected',
          result: {
            kind: 'failed',
            errors: [{ code: 'CONFLICT', message: 'concurrent setup', recovery: 'correctable' }],
          },
        });
      },
    };

    await assert.rejects(
      syncPrincipalLifecycle(client, { notification_configs: [] }),
      /did not expose an identity continuity fence/
    );
    assert.equal(syncCalls, 1);
  });

  test('returns terminal destination setup without claiming readiness', async () => {
    const client = {
      getPrincipal: async () => completed(current('v1')),
      syncPrincipal: async () => completed(applied('v2', 'action_required')),
    };

    const result = await syncPrincipalLifecycle(client, reportingConfiguration());
    assert.equal(result.destinationsReady, false);
    assert.equal(result.current.configuration.reporting_destinations[0].state, 'action_required');
  });

  test('excludes suspended destinations while continuing to poll active setup', async () => {
    const destinations = (state, suspendedState = 'inactive') => [
      {
        destination_id: 'live',
        destination_ref: 'destination-live',
        state,
        configuration: { pattern: 'warehouse_materialization', destination_id: 'live', active: true },
      },
      {
        destination_id: 'archive',
        destination_ref: 'destination-archive',
        state: suspendedState,
        configuration: { pattern: 'warehouse_materialization', destination_id: 'archive', active: false },
      },
    ];
    const withDestinations = (version, state) => {
      const response = current(version, 'ready');
      response.result.configuration.reporting_destinations = destinations(state);
      return response;
    };
    const reads = [current('v1'), withDestinations('v2', 'ready')];
    const client = {
      getPrincipal: async () => completed(reads.shift()),
      syncPrincipal: async () => {
        const response = applied('v2', 'ready');
        response.result.configuration.reporting_destinations = destinations('validating');
        return completed(response);
      },
    };

    const result = await syncPrincipalLifecycle(
      client,
      {
        reporting_destinations: [
          { destination_id: 'live', active: true },
          { destination_id: 'archive', active: false },
        ],
      },
      { pollIntervalMs: 1 }
    );

    assert.equal(result.destinationsReady, true);
    assert.equal(result.current.configuration.reporting_destinations[1].state, 'inactive');

    const rejectedReads = [current('v1'), withDestinations('v2', 'ready')];
    const rejectedClient = {
      getPrincipal: async () => completed(rejectedReads.shift()),
      syncPrincipal: async () => {
        const response = applied('v2', 'ready');
        response.result.configuration.reporting_destinations = destinations('validating', 'rejected');
        return completed(response);
      },
    };
    const rejectedResult = await syncPrincipalLifecycle(
      rejectedClient,
      {
        reporting_destinations: [
          { destination_id: 'live', active: true },
          { destination_id: 'archive', active: false },
        ],
      },
      { pollIntervalMs: 1 }
    );
    assert.equal(rejectedResult.destinationsReady, true);
  });

  test('scopes readiness to submitted active destinations and fails closed on malformed active echoes', async () => {
    let reads = 0;
    const sectionOmittedClient = {
      getPrincipal: async () => {
        reads += 1;
        return completed(current('v1'));
      },
      syncPrincipal: async () => completed(applied('v2', 'validating')),
    };
    const sectionOmitted = await syncPrincipalLifecycle(sectionOmittedClient, { notification_configs: [] });
    assert.equal(sectionOmitted.destinationsReady, true);
    assert.equal(reads, 1);

    const malformed = applied('v2', 'validating');
    delete malformed.result.configuration.reporting_destinations[0].configuration.active;
    const malformedClient = {
      getPrincipal: async () => completed(current('v1')),
      syncPrincipal: async () => completed(malformed),
    };
    const malformedResult = await syncPrincipalLifecycle(malformedClient, {
      reporting_destinations: [{ destination_id: 'warehouse', active: true }],
    });
    assert.equal(malformedResult.destinationsReady, false);
  });

  test('surfaces intermediate and non-schema failure task results without accepting their data', async () => {
    const submitted = {
      success: true,
      status: 'submitted',
      data: { status: 'submitted' },
      metadata: { status: 'submitted', taskName: 'sync_principal' },
      conversation: [],
      debug_logs: [],
    };
    const submittedClient = {
      getPrincipal: async () => completed(current('v1')),
      syncPrincipal: async () => submitted,
    };
    await assert.rejects(
      syncPrincipalLifecycle(submittedClient, { notification_configs: [] }),
      error =>
        error instanceof PrincipalLifecycleError &&
        error.taskResult === submitted &&
        !Object.keys(error).includes('taskResult')
    );

    const invalid = failed({
      status: 'completed',
      result: {
        kind: 'applied',
        principal_id: 'principal-attacker',
        principal_kind: 'invalid-kind',
        configuration: {},
      },
    });
    const invalidClient = {
      getPrincipal: async () => completed(current('v1')),
      syncPrincipal: async () => invalid,
    };
    await assert.rejects(
      syncPrincipalLifecycle(invalidClient, { notification_configs: [] }),
      error => error instanceof PrincipalLifecycleError && error.taskResult === invalid
    );

    const readFailure = failed({
      status: 'rejected',
      result: {
        kind: 'failed',
        errors: [{ code: 'AUTHENTICATION_REQUIRED', message: 'refresh auth', recovery: 'correctable' }],
      },
    });
    await assert.rejects(
      syncPrincipalLifecycle(
        { getPrincipal: async () => readFailure, syncPrincipal: async () => completed(applied('v1')) },
        { notification_configs: [] }
      ),
      error => error instanceof PrincipalLifecycleError && error.protocolErrors?.[0]?.code === 'AUTHENTICATION_REQUIRED'
    );
  });

  test('preserves a non-enumerable exact request for lost-response replay', async () => {
    const client = {
      getPrincipal: async () => completed(current('v1')),
      syncPrincipal: async () => {
        throw new TaskTimeoutError('principal-write', 10);
      },
    };
    await assert.rejects(
      syncPrincipalLifecycle(
        client,
        {
          notification_configs: [
            {
              subscriber_id: 'buyer-events',
              url: 'https://buyer.example/webhook',
              event_types: ['principal.changed'],
              active: true,
              authentication: { schemes: ['HMAC-SHA256'], credentials: 'secret-value-that-must-not-be-logged' },
            },
          ],
        },
        { createIdempotencyKey: () => 'principal-operation-0001' }
      ),
      error =>
        error instanceof PrincipalLifecycleError &&
        error.attemptedRequest?.expected_configuration_version === 'v1' &&
        error.attemptedRequest?.idempotency_key === 'principal-operation-0001' &&
        !Object.keys(error).includes('attemptedRequest') &&
        !JSON.stringify(error).includes('secret-value-that-must-not-be-logged')
    );
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
      syncPrincipalLifecycle(client, reportingConfiguration(), { pollIntervalMs: 1 }),
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
      syncPrincipalLifecycle(timeoutClient, reportingConfiguration(), { setupTimeoutMs: 5, pollIntervalMs: 1 }),
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
      syncPrincipalLifecycle(abortClient, reportingConfiguration(), {
        signal: controller.signal,
        setupTimeoutMs: 100,
        pollIntervalMs: 20,
      }),
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

    await syncPrincipalLifecycle(client, reportingConfiguration(), {
      taskOptions: { timeout: 0 },
      setupTimeoutMs: 100,
      pollIntervalMs: 1,
    });

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
      syncPrincipalLifecycle(client, reportingConfiguration(), { setupTimeoutMs: 5, pollIntervalMs: 100 }),
      PrincipalLifecycleTimeoutError
    );
    assert.equal(reads, 1);
  });

  test('normalizes lifecycle-bounded read timeouts while preserving shorter task timeouts', async () => {
    const lifecycleTimeoutClient = {
      getPrincipal: async () => {
        if (!lifecycleTimeoutClient.read) {
          lifecycleTimeoutClient.read = true;
          return completed(current('v1'));
        }
        throw new TaskTimeoutError('principal-read', 99);
      },
      syncPrincipal: async () => completed(applied('v2', 'validating')),
      read: false,
    };
    await assert.rejects(
      syncPrincipalLifecycle(lifecycleTimeoutClient, reportingConfiguration(), {
        setupTimeoutMs: 100,
        pollIntervalMs: 1,
      }),
      error => error instanceof PrincipalLifecycleTimeoutError && error.applied?.configuration_version === 'v2'
    );

    const taskTimeoutClient = {
      getPrincipal: async () => {
        if (!taskTimeoutClient.read) {
          taskTimeoutClient.read = true;
          return completed(current('v1'));
        }
        throw new TaskTimeoutError('principal-read', 1);
      },
      syncPrincipal: async () => completed(applied('v2', 'validating')),
      read: false,
    };
    await assert.rejects(
      syncPrincipalLifecycle(taskTimeoutClient, reportingConfiguration(), {
        setupTimeoutMs: 100,
        pollIntervalMs: 1,
        taskOptions: { timeout: 1 },
      }),
      TaskTimeoutError
    );
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

  test('refuses caller-supplied principal identity before transport dispatch', async () => {
    const originalCallTool = ProtocolClient.callTool;
    let dispatches = 0;
    ProtocolClient.callTool = async () => {
      dispatches += 1;
      return { status: 'completed', result: { kind: 'unconfigured' } };
    };
    try {
      const client = new AgentClient(
        {
          id: 'principal-safety',
          name: 'Principal safety',
          agent_uri: 'https://seller.example/mcp',
          protocol: 'mcp',
        },
        { validateFeatures: false, validation: { requests: 'off', responses: 'off' } }
      );
      client.client.normalizedAgent._needsDiscovery = false;
      client.client.normalizedAgent._needsCanonicalUrl = false;
      client.client.detectServerVersion = async () => 'v3';

      await assert.rejects(
        client.getPrincipal({ principal_id: 'self-asserted' }),
        /refuses caller-supplied principal_id/
      );
      await assert.rejects(
        client.syncPrincipal({
          idempotency_key: 'principal-operation-0001',
          configuration: { notification_configs: [] },
          buyer_agent_url: 'https://attacker.example',
        }),
        /refuses caller-supplied buyer_agent_url/
      );
      await assert.rejects(
        client.executeTask('get_principal', { connection_id: 'self-asserted' }),
        /refuses caller-supplied connection_id/
      );
      await assert.rejects(
        client.client.executeTask('sync_principal', {
          idempotency_key: 'principal-operation-0002',
          configuration: { notification_configs: [] },
          agent_url: 'https://attacker.example',
        }),
        /refuses caller-supplied agent_url/
      );
      const legacyResult = await client.client.executeTaskLegacy('get_principal', {
        principal_id: 'self-asserted',
      });
      assert.equal(legacyResult.success, false);
      assert.match(legacyResult.error, /refuses caller-supplied principal_id/);
      assert.equal(dispatches, 0);
    } finally {
      ProtocolClient.callTool = originalCallTool;
    }
  });
});
