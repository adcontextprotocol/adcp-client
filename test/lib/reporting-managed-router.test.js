/**
 * The managed-delivery adapter router: dispatch by the immutable binding and by
 * the pattern/transport recorded on the authorization, typed refusal before any
 * I/O, install- and start-time admission, probes, and per-route counts.
 */
const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const ledger = require('../../dist/lib/reporting/ledger/index.js');

const NOW = '2026-08-27T04:00:00.000Z';

function binding(overrides = {}) {
  return ledger.reportingManagedDeliveryBindingV1({
    configurationId: 'config-1',
    account_id: 'account-1',
    delivery_config_id: 'files',
    delivery_config_version: 1,
    destination_ref: 'destination-generation-1',
    authorization_generation: 1,
    feed_purpose: 'analytics',
    method: 'file_transfer',
    transport: 'gcs',
    verification_profile: 'canonical_digest',
    reconciliation_mode: 'delivery_only',
    resource_retention_days: 30,
    created_at: NOW,
    ...overrides,
  });
}

function authorization(overrides = {}) {
  return {
    account_id: 'account-1',
    destination_ref: 'destination-generation-1',
    generation: 1,
    authorized_at: NOW,
    revoked_at: NOW,
    pattern: 'file_transfer',
    transport: 'gcs',
    ...overrides,
  };
}

/** A route adapter that records what it was asked to do and can be made to fail. */
function stubAdapter(name, overrides = {}) {
  const calls = [];
  return {
    calls,
    verificationProfiles: ['canonical_digest'],
    revocationFencesDeliveryGenerations: true,
    deliver: async input => {
      calls.push(['deliver', input.binding.transport]);
      return { delivered_by: name };
    },
    read: async input => {
      calls.push(['read', input.binding.transport]);
      return Buffer.from(name);
    },
    revoke: async input => {
      calls.push(['revoke', input.authorization.transport ?? null]);
    },
    ...overrides,
  };
}

function route(id, transport, adapter, pattern = 'file_transfer') {
  return { id, match: { pattern, transport }, adapter };
}

function deliveryInput(forBinding, extra = {}) {
  return {
    materialization: { reporting_materialization_id: 'materialization-1', method: 'file_transfer' },
    binding: forBinding,
    obligation: {},
    revision: {},
    maxBytes: 1024,
    ...extra,
  };
}

const signal = () => ({ signal: new AbortController().signal });

async function assertRoutingError(promise, code) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof ledger.ReportingManagedDeliveryRoutingErrorV1, `typed error, got ${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

describe('createReportingManagedDeliveryAdapterRouterV1', () => {
  describe('construction', () => {
    const gcs = () => route('gcs', 'gcs', stubAdapter('gcs'));
    const s3 = () => route('s3', 's3', stubAdapter('s3'));

    test('builds a router that is itself a managed-delivery adapter', () => {
      const router = ledger.createReportingManagedDeliveryAdapterRouterV1({
        routes: [
          route('gcs', 'gcs', stubAdapter('gcs', { verificationProfiles: ['canonical_digest', 'manifest_checksums'] })),
          route('s3', 's3', stubAdapter('s3', { verificationProfiles: ['manifest_checksums', 'native_commit'] })),
        ],
      });
      assert.equal(router.revocationFencesDeliveryGenerations, true);
      assert.deepEqual([...router.verificationProfiles], ['canonical_digest', 'manifest_checksums', 'native_commit']);
      assert.deepEqual(
        router.routes.map(value => [value.id, value.match.transport, [...value.verificationProfiles]]),
        [
          ['gcs', 'gcs', ['canonical_digest', 'manifest_checksums']],
          ['s3', 's3', ['manifest_checksums', 'native_commit']],
        ]
      );
      assert.equal(
        router.routes.some(value => 'adapter' in value),
        false,
        'the descriptions never expose an adapter'
      );
    });

    test('refuses duplicated route ids', () => {
      assert.throws(
        () =>
          ledger.createReportingManagedDeliveryAdapterRouterV1({
            routes: [gcs(), route('gcs', 's3', stubAdapter('x'))],
          }),
        /duplicated/
      );
    });

    test('refuses an ambiguous (pattern, transport) pair', () => {
      assert.throws(
        () =>
          ledger.createReportingManagedDeliveryAdapterRouterV1({
            routes: [gcs(), route('gcs-again', 'gcs', stubAdapter('x'))],
          }),
        /both match file_transfer\/gcs/
      );
      // The same transport under another pattern is a different pair.
      assert.doesNotThrow(() =>
        ledger.createReportingManagedDeliveryAdapterRouterV1({
          routes: [gcs(), route('gcs-share', 'gcs', stubAdapter('x'), 'dataset_share')],
        })
      );
    });

    test('refuses a route adapter that does not fence delivery generations', () => {
      for (const flag of [false, undefined, 'true']) {
        assert.throws(
          () =>
            ledger.createReportingManagedDeliveryAdapterRouterV1({
              routes: [gcs(), route('s3', 's3', stubAdapter('s3', { revocationFencesDeliveryGenerations: flag }))],
            }),
          /does not fence delivery generations/
        );
      }
    });

    test('refuses a route with no verification profile', () => {
      for (const verificationProfiles of [[], undefined]) {
        assert.throws(
          () =>
            ledger.createReportingManagedDeliveryAdapterRouterV1({
              routes: [route('s3', 's3', stubAdapter('s3', { verificationProfiles }))],
            }),
          /declares no verification profile/
        );
      }
    });

    test('refuses malformed routes and an unknown legacyDefault', () => {
      const build = routes => () => ledger.createReportingManagedDeliveryAdapterRouterV1(routes);
      assert.throws(build({ routes: [] }), /at least one route/);
      assert.throws(build({ routes: [route('GCS', 'gcs', stubAdapter('x'))] }), /route id must match/);
      assert.throws(build({ routes: [route('gcs', 'gcs', stubAdapter('x'), 'sftp')] }), /must match file_transfer/);
      assert.throws(build({ routes: [route('gcs', 'Not A Transport', stubAdapter('x'))] }), /invalid transport/);
      assert.throws(
        build({ routes: [route('gcs', 'gcs', { ...stubAdapter('x'), deliver: undefined })] }),
        /requires deliver/
      );
      assert.throws(build({ routes: [gcs()], legacyDefault: 'nope' }), /legacyDefault "nope" is not a route id/);
      assert.throws(build({ routes: [gcs()], probeTimeoutMilliseconds: 0 }), /probeTimeoutMilliseconds/);
      // At or above the runtime's own probe deadline the route id would be lost from the startup error.
      assert.throws(build({ routes: [gcs()], probeTimeoutMilliseconds: 30_000 }), /below the runtime's 30000 ms/);
      assert.doesNotThrow(build({ routes: [gcs()], probeTimeoutMilliseconds: 29_999 }));
      assert.doesNotThrow(build({ routes: [gcs(), s3()], legacyDefault: 's3' }));
    });
  });

  describe('deliver and read', () => {
    test('each binding is delivered and read only through its own route', async () => {
      const gcs = stubAdapter('gcs');
      const s3 = stubAdapter('s3');
      const router = ledger.createReportingManagedDeliveryAdapterRouterV1({
        routes: [route('gcs', 'gcs', gcs), route('s3', 's3', s3)],
      });
      const gcsBinding = binding({ transport: 'gcs' });
      const s3Binding = binding({ transport: 's3', configurationId: 'config-2', delivery_config_id: 'files-2' });

      assert.deepEqual(await router.deliver(deliveryInput(gcsBinding), signal()), { delivered_by: 'gcs' });
      assert.deepEqual(gcs.calls, [['deliver', 'gcs']]);
      assert.deepEqual(s3.calls, []);

      assert.deepEqual(await router.deliver(deliveryInput(s3Binding), signal()), { delivered_by: 's3' });
      assert.equal(
        Buffer.from(await router.read({ ...deliveryInput(s3Binding), resource: {} }, signal())).toString(),
        's3'
      );
      assert.equal(
        Buffer.from(await router.read({ ...deliveryInput(gcsBinding), resource: {} }, signal())).toString(),
        'gcs'
      );
      assert.deepEqual(gcs.calls, [
        ['deliver', 'gcs'],
        ['read', 'gcs'],
      ]);
      assert.deepEqual(s3.calls, [
        ['deliver', 's3'],
        ['read', 's3'],
      ]);
    });

    test('selects from the binding alone, never from request input, materialization or resource', async () => {
      const gcs = stubAdapter('gcs');
      const s3 = stubAdapter('s3');
      const router = ledger.createReportingManagedDeliveryAdapterRouterV1({
        routes: [route('gcs', 'gcs', gcs), route('s3', 's3', s3)],
      });
      const misleading = {
        materialization: {
          reporting_materialization_id: 'materialization-1',
          method: 'dataset_share',
          transport: 's3',
          resource: { location: 's3://other/bucket/manifest.json' },
        },
        resource: { location: 's3://other/bucket/manifest.json', transport: 's3' },
        transport: 's3',
        route: 's3',
      };
      await router.deliver(deliveryInput(binding({ transport: 'gcs' }), misleading), signal());
      await router.read(
        { ...deliveryInput(binding({ transport: 'gcs' }), misleading), resource: misleading.resource },
        signal()
      );
      assert.deepEqual(
        gcs.calls.map(call => call[0]),
        ['deliver', 'read']
      );
      assert.deepEqual(s3.calls, []);
    });

    test('an unknown transport fails with a typed error before any adapter is called', async () => {
      const gcs = stubAdapter('gcs');
      const s3 = stubAdapter('s3');
      const router = ledger.createReportingManagedDeliveryAdapterRouterV1({
        routes: [route('gcs', 'gcs', gcs), route('s3', 's3', s3)],
        legacyDefault: 'gcs',
      });
      const unknown = binding({ transport: 'azure_blob' });
      await assertRoutingError(router.deliver(deliveryInput(unknown), signal()), 'REPORTING_ROUTE_NOT_FOUND');
      await assertRoutingError(
        router.read({ ...deliveryInput(unknown), resource: {} }, signal()),
        'REPORTING_ROUTE_NOT_FOUND'
      );
      // The same transport under another pattern is not a match either, and
      // the legacy route does not catch a transport that was stated.
      await assertRoutingError(
        router.deliver(deliveryInput(binding({ method: 'dataset_share', transport: 'gcs' })), signal()),
        'REPORTING_ROUTE_NOT_FOUND'
      );
      assert.deepEqual(gcs.calls, []);
      assert.deepEqual(s3.calls, []);
    });

    test('a binding without a transport goes to legacyDefault, and errors without one', async () => {
      const gcs = stubAdapter('gcs');
      const s3 = stubAdapter('s3');
      const legacyBinding = binding({ transport: undefined });
      const withLegacy = ledger.createReportingManagedDeliveryAdapterRouterV1({
        routes: [route('gcs', 'gcs', gcs), route('s3', 's3', s3)],
        legacyDefault: 's3',
      });
      await withLegacy.deliver(deliveryInput(legacyBinding), signal());
      assert.deepEqual(s3.calls, [['deliver', undefined]]);
      assert.deepEqual(gcs.calls, []);
      // Only for the legacy route's own pattern.
      await assertRoutingError(
        withLegacy.deliver(deliveryInput(binding({ method: 'dataset_share', transport: undefined })), signal()),
        'REPORTING_ROUTE_TRANSPORT_REQUIRED'
      );

      const without = ledger.createReportingManagedDeliveryAdapterRouterV1({
        routes: [route('gcs', 'gcs', gcs), route('s3', 's3', s3)],
      });
      s3.calls.length = 0;
      await assertRoutingError(
        without.deliver(deliveryInput(legacyBinding), signal()),
        'REPORTING_ROUTE_TRANSPORT_REQUIRED'
      );
      await assertRoutingError(
        without.read({ ...deliveryInput(legacyBinding), resource: {} }, signal()),
        'REPORTING_ROUTE_TRANSPORT_REQUIRED'
      );
      assert.deepEqual([...gcs.calls, ...s3.calls], []);
    });

    test('refuses before I/O a binding whose profile its route cannot verify', async () => {
      const gcs = stubAdapter('gcs', { verificationProfiles: ['manifest_checksums'] });
      const router = ledger.createReportingManagedDeliveryAdapterRouterV1({ routes: [route('gcs', 'gcs', gcs)] });
      await assertRoutingError(
        router.deliver(deliveryInput(binding({ verification_profile: 'canonical_digest' })), signal()),
        'REPORTING_ROUTE_VERIFICATION_UNSUPPORTED'
      );
      assert.deepEqual(gcs.calls, []);
    });
  });

  describe('revoke', () => {
    test('routes on the recorded pattern and transport and calls exactly one adapter', async () => {
      const gcs = stubAdapter('gcs');
      const s3 = stubAdapter('s3');
      const router = ledger.createReportingManagedDeliveryAdapterRouterV1({
        routes: [route('gcs', 'gcs', gcs), route('s3', 's3', s3)],
        legacyDefault: 'gcs',
      });
      await router.revoke({ authorization: authorization({ transport: 's3' }) }, signal());
      assert.deepEqual(s3.calls, [['revoke', 's3']]);
      assert.deepEqual(gcs.calls, []);
      await router.revoke({ authorization: authorization({ transport: 'gcs' }) }, signal());
      assert.deepEqual(gcs.calls, [['revoke', 'gcs']]);
      assert.equal(s3.calls.length, 1);
    });

    test('a recorded transport with no route fails, even when a legacyDefault exists', async () => {
      const gcs = stubAdapter('gcs');
      const s3 = stubAdapter('s3');
      const router = ledger.createReportingManagedDeliveryAdapterRouterV1({
        routes: [route('gcs', 'gcs', gcs), route('s3', 's3', s3)],
        legacyDefault: 'gcs',
      });
      await assertRoutingError(
        router.revoke({ authorization: authorization({ transport: 'azure_blob' }) }, signal()),
        'REPORTING_ROUTE_NOT_FOUND'
      );
      assert.deepEqual([...gcs.calls, ...s3.calls], [], 'never fans out and never guesses');
    });

    test('a legacy authorization with no recorded contract goes to legacyDefault, and errors without one', async () => {
      const gcs = stubAdapter('gcs');
      const s3 = stubAdapter('s3');
      const legacy = authorization({ pattern: undefined, transport: undefined });
      const withLegacy = ledger.createReportingManagedDeliveryAdapterRouterV1({
        routes: [route('gcs', 'gcs', gcs), route('s3', 's3', s3)],
        legacyDefault: 's3',
      });
      await withLegacy.revoke({ authorization: legacy }, signal());
      assert.deepEqual(s3.calls, [['revoke', null]]);
      assert.deepEqual(gcs.calls, []);

      const without = ledger.createReportingManagedDeliveryAdapterRouterV1({
        routes: [route('gcs', 'gcs', gcs), route('s3', 's3', s3)],
      });
      await assertRoutingError(
        without.revoke({ authorization: legacy }, signal()),
        'REPORTING_ROUTE_CONTRACT_UNRECORDED'
      );
      assert.equal(s3.calls.length, 1);
      assert.deepEqual(gcs.calls, []);
    });

    test('a pattern recorded without a transport only reaches a legacy route of that pattern', async () => {
      const gcs = stubAdapter('gcs');
      const router = ledger.createReportingManagedDeliveryAdapterRouterV1({
        routes: [route('gcs', 'gcs', gcs)],
        legacyDefault: 'gcs',
      });
      await assertRoutingError(
        router.revoke({ authorization: authorization({ pattern: 'dataset_share', transport: undefined }) }, signal()),
        'REPORTING_ROUTE_CONTRACT_UNRECORDED'
      );
      await router.revoke(
        { authorization: authorization({ pattern: 'file_transfer', transport: undefined }) },
        signal()
      );
      assert.equal(gcs.calls.length, 1);
    });

    test('a late write under a revoked generation is fenced on both routes', async () => {
      // The contract a route adapter promises with revocationFencesDeliveryGenerations:
      // revoke installs a tombstone for the generation, and a later write under it is refused.
      function fencedAdapter(name) {
        const tombstones = new Set();
        const objects = [];
        const key = value =>
          `${value.account_id}:${value.destination_ref}:${value.authorization_generation ?? value.generation}`;
        return {
          objects,
          tombstones,
          verificationProfiles: ['canonical_digest'],
          revocationFencesDeliveryGenerations: true,
          deliver: async input => {
            if (tombstones.has(key(input.binding))) throw new Error(`${name}: generation is revoked`);
            objects.push(key(input.binding));
            return { delivered_by: name };
          },
          read: async () => Buffer.alloc(0),
          revoke: async input => {
            tombstones.add(key(input.authorization));
          },
        };
      }
      const gcs = fencedAdapter('gcs');
      const s3 = fencedAdapter('s3');
      const router = ledger.createReportingManagedDeliveryAdapterRouterV1({
        routes: [route('gcs', 'gcs', gcs), route('s3', 's3', s3)],
      });
      for (const transport of ['gcs', 's3']) {
        const forBinding = binding({ transport, destination_ref: `destination-${transport}` });
        const own = transport === 'gcs' ? gcs : s3;
        const other = transport === 'gcs' ? s3 : gcs;
        await router.deliver(deliveryInput(forBinding), signal());
        await router.revoke(
          { authorization: authorization({ transport, destination_ref: `destination-${transport}` }) },
          signal()
        );
        await assert.rejects(router.deliver(deliveryInput(forBinding), signal()), /generation is revoked/);
        assert.equal(own.objects.length, 1, `${transport}: the late write was refused, not stored`);
        assert.equal(own.tombstones.size, 1);
        assert.equal(
          other.tombstones.has(`account-1:destination-${transport}:1`),
          false,
          `${transport}: the other route never saw the revocation`
        );
      }
    });
  });

  describe('admission', () => {
    function twoRoutes() {
      return ledger.createReportingManagedDeliveryAdapterRouterV1({
        routes: [
          route('gcs', 'gcs', stubAdapter('gcs', { verificationProfiles: ['canonical_digest', 'manifest_checksums'] })),
          route('s3', 's3', stubAdapter('s3', { verificationProfiles: ['manifest_checksums'] })),
        ],
      });
    }

    test('admitBinding rejects a missing route and a profile its route does not support', () => {
      const router = twoRoutes();
      assert.doesNotThrow(() =>
        router.admitBinding(binding({ transport: 'gcs', verification_profile: 'canonical_digest' }))
      );
      assert.doesNotThrow(() =>
        router.admitBinding(binding({ transport: 's3', verification_profile: 'manifest_checksums' }))
      );
      assert.throws(
        () => router.admitBinding(binding({ transport: 's3', verification_profile: 'canonical_digest' })),
        error =>
          error.code === 'REPORTING_ROUTE_VERIFICATION_UNSUPPORTED' &&
          /cannot verify canonical_digest/.test(error.message)
      );
      assert.throws(
        () => router.admitBinding(binding({ transport: 'azure_blob' })),
        error => error.code === 'REPORTING_ROUTE_NOT_FOUND'
      );
      assert.throws(
        () => router.admitBinding(binding({ transport: undefined })),
        error => error.code === 'REPORTING_ROUTE_TRANSPORT_REQUIRED'
      );
    });

    test('the union of profiles never admits a binding on its own', () => {
      const router = twoRoutes();
      assert.ok(router.verificationProfiles.includes('canonical_digest'));
      assert.throws(() => router.admitBinding(binding({ transport: 's3', verification_profile: 'canonical_digest' })));
    });

    test('admitOffering needs a route for the offering method, and canonical_digest for a consumer-receipt one', () => {
      const router = twoRoutes();
      assert.doesNotThrow(() => router.admitOffering({ method: { pattern: 'file_transfer', transport: 'gcs' } }));
      assert.throws(
        () => router.admitOffering({ method: { pattern: 'file_transfer', transport: 'azure_blob' } }),
        error => error.code === 'REPORTING_ROUTE_NOT_FOUND'
      );
      assert.throws(
        () => router.admitOffering({ method: { pattern: 'dataset_share', transport: 'gcs' } }),
        error => error.code === 'REPORTING_ROUTE_NOT_FOUND'
      );
      assert.doesNotThrow(() =>
        router.admitOffering({
          method: { pattern: 'file_transfer', transport: 'gcs' },
          reconciliation_mode: 'consumer_receipt',
        })
      );
      assert.throws(
        () =>
          router.admitOffering({
            method: { pattern: 'file_transfer', transport: 's3' },
            reconciliation_mode: 'consumer_receipt',
          }),
        error => error.code === 'REPORTING_ROUTE_VERIFICATION_UNSUPPORTED'
      );
    });
  });

  describe('probe', () => {
    test('probes every route that defines one and names every failing route id', async () => {
      const probed = [];
      const router = ledger.createReportingManagedDeliveryAdapterRouterV1({
        routes: [
          route('gcs', 'gcs', stubAdapter('gcs', { probe: async () => void probed.push('gcs') })),
          route(
            's3',
            's3',
            stubAdapter('s3', {
              probe: async () => {
                probed.push('s3');
                throw new Error('bucket https://secret.example/token=abc is unreachable');
              },
            })
          ),
          route('azure', 'azure_blob', stubAdapter('azure')),
          route(
            'sftp',
            'sftp',
            stubAdapter('sftp', {
              probe: async () => {
                probed.push('sftp');
                throw new Error('down');
              },
            })
          ),
        ],
      });
      await assert.rejects(router.probe(signal()), error => {
        assert.ok(error instanceof ledger.ReportingManagedDeliveryProbeErrorV1);
        assert.deepEqual([...error.failedRouteIds], ['s3', 'sftp']);
        assert.doesNotMatch(error.message, /secret|token/, 'the provider message stays on cause');
        assert.ok(error.cause instanceof AggregateError);
        return true;
      });
      assert.deepEqual(
        probed.sort(),
        ['gcs', 's3', 'sftp'],
        'every probing route ran; the one with no probe was skipped'
      );
    });

    test('a route that hangs fails its own probe by id without blocking the others', async () => {
      const router = ledger.createReportingManagedDeliveryAdapterRouterV1({
        probeTimeoutMilliseconds: 20,
        routes: [
          route('gcs', 'gcs', stubAdapter('gcs', { probe: async () => {} })),
          route('s3', 's3', stubAdapter('s3', { probe: () => new Promise(() => {}) })),
        ],
      });
      await assert.rejects(router.probe(signal()), error => {
        assert.deepEqual([...error.failedRouteIds], ['s3']);
        return true;
      });
    });

    test('resolves when no route defines a probe', async () => {
      const router = ledger.createReportingManagedDeliveryAdapterRouterV1({
        routes: [route('gcs', 'gcs', stubAdapter('gcs'))],
      });
      await router.probe(signal());
    });
  });

  describe('routeIdFor', () => {
    test('names the route for a binding or authorization and never throws', () => {
      const router = ledger.createReportingManagedDeliveryAdapterRouterV1({
        routes: [route('gcs', 'gcs', stubAdapter('gcs')), route('s3', 's3', stubAdapter('s3'))],
      });
      assert.equal(router.routeIdFor({ binding: binding({ transport: 's3' }) }), 's3');
      assert.equal(router.routeIdFor({ authorization: authorization({ transport: 'gcs' }) }), 'gcs');
      assert.equal(router.routeIdFor({ binding: binding({ transport: 'azure_blob' }) }), undefined);
      assert.equal(
        router.routeIdFor({ authorization: authorization({ transport: undefined, pattern: undefined }) }),
        undefined
      );
    });
  });
});

describe('managed-delivery worker with a router', () => {
  function revocationLease(overrides = {}) {
    return {
      authorization: authorization(overrides),
      owner: 'worker-1',
      generation: 1,
      expires_at: '2026-08-27T04:01:05.000Z',
    };
  }

  function revocationStore(leases) {
    const completed = [];
    const released = [];
    return {
      completed,
      released,
      planMaterializations: async () => 0,
      claimRevocation: async () => leases.shift() ?? null,
      releaseRevocation: async ({ lease }) => {
        released.push(lease.authorization.destination_ref);
        return true;
      },
      completeRevocation: async ({ lease }) => {
        completed.push(lease.authorization.destination_ref);
        return true;
      },
      claimMaterialization: async () => null,
    };
  }

  const workerOptions = { maxIterations: 4, deliveryDeadlineMilliseconds: 50, leaseMilliseconds: 5100 };

  test('counts revocations, failures and overdue grants per route id, with unroutable work apart', async () => {
    const gcs = stubAdapter('gcs');
    const s3 = stubAdapter('s3', {
      revoke: async input => {
        s3.calls.push(['revoke', input.authorization.transport]);
        throw new Error('provider unavailable');
      },
    });
    const router = ledger.createReportingManagedDeliveryAdapterRouterV1({
      routes: [route('gcs', 'gcs', gcs), route('s3', 's3', s3)],
    });
    const store = revocationStore([
      revocationLease({ destination_ref: 'd-gcs', transport: 'gcs' }),
      { ...revocationLease({ destination_ref: 'd-s3', transport: 's3' }), overdue: true },
      revocationLease({ destination_ref: 'd-legacy', transport: undefined, pattern: undefined }),
    ]);
    const result = await ledger.runManagedDeliveryWorker(store, router, workerOptions);
    assert.deepEqual(store.completed, ['d-gcs']);
    assert.deepEqual(store.released.sort(), ['d-legacy', 'd-s3']);
    assert.equal(result.revocationsCompleted, 1);
    assert.deepEqual(result.revocationsByRoute, { gcs: 1 });
    assert.deepEqual(result.revocationFailuresByRoute, { s3: 1, [ledger.UNROUTED_REPORTING_ROUTE_KEY_V1]: 1 });
    assert.deepEqual(result.overdueByRoute, { s3: 1 });
    assert.equal(result.revocationsOverdue, 1);
    assert.deepEqual(gcs.calls, [['revoke', 'gcs']]);
    // The unrouted grant reached no adapter at all.
    assert.equal(s3.calls.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /bucket|token|secret|https?:/);
  });

  test('a legacy grant with a legacyDefault is revoked and counted under that route', async () => {
    const gcs = stubAdapter('gcs');
    const router = ledger.createReportingManagedDeliveryAdapterRouterV1({
      routes: [route('gcs', 'gcs', gcs)],
      legacyDefault: 'gcs',
    });
    const store = revocationStore([
      revocationLease({ destination_ref: 'd-legacy', transport: undefined, pattern: undefined }),
    ]);
    const result = await ledger.runManagedDeliveryWorker(store, router, workerOptions);
    assert.deepEqual(store.completed, ['d-legacy']);
    assert.deepEqual(result.revocationsByRoute, { gcs: 1 });
  });

  test('a bare adapter keeps exactly the result shape it has today', async () => {
    const store = revocationStore([revocationLease()]);
    const result = await ledger.runManagedDeliveryWorker(store, stubAdapter('bare'), workerOptions);
    assert.deepEqual(Object.keys(result).sort(), [
      'claimed',
      'delivered',
      'exhausted',
      'failed',
      'planned',
      'revocationsCompleted',
      'revocationsOverdue',
    ]);
    assert.equal(result.revocationsCompleted, 1);
  });
});

function offering(transport, reconciliationMode = 'delivery_only') {
  return {
    offering_id: `managed-${transport}-${reconciliationMode}`,
    feed_purpose: reconciliationMode === 'consumer_receipt' ? 'billing' : 'analytics',
    report_definition_id: 'report-definition-v1',
    report_definition_uri: 'https://schemas.fixture.example/report-definition.json',
    report_definition_sha256: 'd'.repeat(64),
    reporting_profile: {
      id: 'reporting-profile-v1',
      version: '1.0',
      schema_uri: 'https://schemas.fixture.example/reporting-profile.json',
      schema_sha256: 'e'.repeat(64),
      schema_dialect: 'https://json-schema.org/draft/2020-12/schema',
      schema_ref_policy: 'local_fragment_only',
      grain: 'media_buy/day',
      primary_keys: ['media_buy_id'],
      ...(reconciliationMode === 'consumer_receipt'
        ? {
            canonicalization_id: 'billing-rows-v1',
            canonicalization_contract_version: '1.0',
            canonicalization_media_type: 'application/vnd.adcp.reporting-canonicalization+json',
            canonicalization_uri: 'https://schemas.fixture.example/canonicalization.json',
            canonicalization_sha256: 'a'.repeat(64),
          }
        : {}),
    },
    schedule: { period_duration: 'P1D', alignment: 'utc', delivery_sla: 'PT1H' },
    supported_finality: ['official'],
    reconciliation_mode: reconciliationMode,
    method: {
      pattern: 'file_transfer',
      transport,
      orchestration: 'producer_managed',
      destination_modes: ['existing'],
      provider: { domain: 'fixture.example' },
      format: 'jsonl',
    },
  };
}

describe('createReportingManagedDeliveryRuntime with a router', () => {
  function harness(overrides = {}) {
    const events = [];
    const store = {
      events,
      probe: async () => true,
      adoptAdvertisedPolicies: async policy => {
        events.push('adopt');
        return policy;
      },
      setBindingAdmission: admit => {
        events.push(admit ? 'admission-registered' : 'admission-cleared');
        store.admit = admit;
      },
      ...overrides.store,
    };
    const routerOptions = overrides.routerOptions ?? {
      routes: [
        route('gcs', 'gcs', stubAdapter('gcs', { verificationProfiles: ['canonical_digest', 'manifest_checksums'] })),
        route('s3', 's3', stubAdapter('s3', { verificationProfiles: ['manifest_checksums'] })),
      ],
    };
    return {
      store,
      options: {
        coreStore: {},
        store,
        adapter: ledger.createReportingManagedDeliveryAdapterRouterV1(routerOptions),
        offerings: overrides.offerings ?? [offering('gcs'), offering('s3')],
        automatedRecoveryWindowSeconds: 60,
        statusRetentionDays: 30,
        resourceRetentionDays: 30,
        authorizationRevocationSeconds: 60,
      },
    };
  }

  test('starts, and registers its binding admission with the store only after adoption', async () => {
    const { store, options } = harness();
    const runtime = await ledger.createReportingManagedDeliveryRuntime(options);
    assert.equal(runtime.reportingDeliveryCapabilities.managed_delivery, true);
    assert.deepEqual(store.events, ['adopt', 'admission-registered']);
    assert.throws(
      () => store.admit(binding({ transport: 's3', verification_profile: 'canonical_digest' })),
      /cannot verify/
    );
    assert.throws(() => store.admit(binding({ transport: 'azure_blob' })), /No Managed Delivery route/);
    assert.doesNotThrow(() => store.admit(binding({ transport: 'gcs' })));
  });

  test('refuses an offering no route can serve, before adopting any policy', async () => {
    const { store, options } = harness({ offerings: [offering('gcs'), offering('azure_blob')] });
    await assert.rejects(
      () => ledger.createReportingManagedDeliveryRuntime(options),
      error => error.code === 'REPORTING_ROUTE_NOT_FOUND' && /file_transfer\/azure_blob/.test(error.message)
    );
    assert.deepEqual(store.events, []);
  });

  test('refuses a consumer-receipt offering whose route cannot verify canonical_digest', async () => {
    const { store, options } = harness({ offerings: [offering('s3', 'consumer_receipt')] });
    await assert.rejects(
      () => ledger.createReportingManagedDeliveryRuntime({ ...options, resolveConsumerId: () => 'consumer-1' }),
      error => error.code === 'REPORTING_ROUTE_VERIFICATION_UNSUPPORTED'
    );
    assert.deepEqual(store.events, []);
  });

  test('refuses a store that cannot enforce install-time admission', async () => {
    const { options } = harness({ store: { setBindingAdmission: undefined } });
    await assert.rejects(
      () => ledger.createReportingManagedDeliveryRuntime(options),
      /cannot enforce an install-time admission/
    );
  });

  test('a single adapter needs no admission support and behaves as before', async () => {
    const { store, options } = harness({ store: { setBindingAdmission: undefined } });
    const runtime = await ledger.createReportingManagedDeliveryRuntime({
      ...options,
      adapter: stubAdapter('single', { verificationProfiles: ['native_commit'] }),
      offerings: [offering('anything_at_all')],
    });
    assert.equal(runtime.reportingDeliveryCapabilities.managed_delivery, true);
    assert.deepEqual(store.events, ['adopt']);
  });

  test('a failing route probe fails startup naming the route, before any durable adoption', async () => {
    const { store, options } = harness({
      routerOptions: {
        routes: [
          route('gcs', 'gcs', stubAdapter('gcs', { probe: async () => {} })),
          route(
            's3',
            's3',
            stubAdapter('s3', {
              probe: async () => {
                throw new Error('NoSuchBucket for https://s3.example/private-bucket');
              },
            })
          ),
        ],
      },
    });
    await assert.rejects(
      () => ledger.createReportingManagedDeliveryRuntime(options),
      error => {
        assert.match(error.message, /probe failed for route "s3"/);
        assert.doesNotMatch(error.message, /gcs|private-bucket/);
        assert.ok(error.cause instanceof ledger.ReportingManagedDeliveryProbeErrorV1);
        return true;
      }
    );
    assert.deepEqual(store.events, [], 'nothing was adopted or registered');
  });

  test('a healthy probe lets startup proceed, and a bare adapter probe failure also fails startup', async () => {
    let probed = 0;
    const healthy = harness({
      routerOptions: {
        routes: [
          route('gcs', 'gcs', stubAdapter('gcs', { probe: async () => void (probed += 1) })),
          route('s3', 's3', stubAdapter('s3', { probe: async () => void (probed += 1) })),
        ],
      },
    });
    await ledger.createReportingManagedDeliveryRuntime(healthy.options);
    assert.equal(probed, 2);

    const bare = harness();
    await assert.rejects(
      () =>
        ledger.createReportingManagedDeliveryRuntime({
          ...bare.options,
          adapter: stubAdapter('bare', {
            probe: async () => {
              throw new Error('down');
            },
          }),
          offerings: [offering('gcs')],
        }),
      /Managed Delivery adapter probe failed$/
    );
    assert.deepEqual(bare.store.events, []);
  });
});
