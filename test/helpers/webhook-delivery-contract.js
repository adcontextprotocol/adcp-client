const { test } = require('node:test');
const assert = require('node:assert/strict');

const KEY = { publisherScope: 'publisher-a', tenantScope: 'tenant-a', deliveryId: 'delivery-contract-a' };
const PROPOSAL = { idempotencyKey: 'idem.contract.00000001', payloadFingerprint: 'a'.repeat(64) };

// Live backends measure leases and retry delays on their own clock (PostgreSQL
// clock_timestamp(), Redis TIME), so a CI runner can lose tens of milliseconds
// between two calls. "Not yet" assertions therefore use windows far beyond
// runner jitter, and "eventually" assertions poll against a deadline instead
// of trusting a fixed sleep.
const CONTENDED_LEASE_MS = 1_000;
const RETRY_HOLD_MS = 60_000;
const RETRY_DELAY_MS = 20;
const CLAIM_DEADLINE_MS = 10_000;

async function claimWhenDue(backend, ownerToken) {
  const deadline = Date.now() + CLAIM_DEADLINE_MS;
  for (;;) {
    const claimed = await backend.claimPending({ ownerToken, leaseMs: 30_000, limit: 1 });
    if (claimed.length > 0 || Date.now() >= deadline) return claimed;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function runWebhookDeliveryStoreContract(name, factory) {
  test(`${name}: immutable binding, conflict evidence, and trusted scopes`, async () => {
    const store = await factory();
    const first = await store.claim(KEY, PROPOSAL, 60_000);
    assert.equal(first.status, 'bound');
    assert.equal(first.idempotencyKey, PROPOSAL.idempotencyKey);
    assert.equal(first.payloadFingerprint, PROPOSAL.payloadFingerprint);
    assert.ok(first.retainUntilMs >= first.firstAttemptAtMs + 60_000);

    const conflict = await store.claim(
      KEY,
      { idempotencyKey: 'idem.contract.00000002', payloadFingerprint: 'b'.repeat(64) },
      120_000
    );
    assert.deepEqual(conflict, first);

    const otherTenant = await store.claim(
      { ...KEY, tenantScope: 'tenant-b' },
      { idempotencyKey: 'idem.contract.00000003', payloadFingerprint: 'c'.repeat(64) },
      60_000
    );
    assert.equal(otherTenant.status, 'bound');
    assert.notEqual(otherTenant.idempotencyKey, first.idempotencyKey);

    const raceKey = { ...KEY, deliveryId: 'delivery-contract-race' };
    const race = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        store.claim(
          raceKey,
          {
            idempotencyKey: `idem.contract.race.${String(index).padStart(4, '0')}`,
            payloadFingerprint: index.toString(16).padStart(64, '0'),
          },
          60_000
        )
      )
    );
    assert.ok(race.every(record => record.status === 'bound'));
    assert.equal(new Set(race.map(record => JSON.stringify(record))).size, 1);

    const expiringKey = { ...KEY, deliveryId: 'delivery-contract-expiry' };
    await store.claim(
      expiringKey,
      { idempotencyKey: 'idem.contract.expiry.001', payloadFingerprint: 'd'.repeat(64) },
      5
    );
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(
      await store.claim(
        expiringKey,
        { idempotencyKey: 'idem.contract.expiry.002', payloadFingerprint: 'e'.repeat(64) },
        5
      ),
      { status: 'retired' }
    );
    assert.deepEqual(
      await store.claim(
        expiringKey,
        { idempotencyKey: 'idem.contract.expiry.003', payloadFingerprint: 'f'.repeat(64) },
        5
      ),
      { status: 'retired' }
    );
  });
}

function runWebhookRecoveryBackendContract(name, factory) {
  test(`${name}: checkpoint conflict, leases, and stale-owner fencing`, async () => {
    const backend = await factory();
    const snapshot = {
      url: 'https://buyer.invalid/webhook',
      payload: { task_id: 'task-a', empty: [] },
      authentication: { kind: 'none' },
      retries: { maxAttempts: 5, initialDelayMs: 1000, maxDelayMs: 60000, jitter: 0.25 },
    };
    await assert.rejects(
      () =>
        backend.checkpoint({ ...KEY, publisherScope: 'x'.repeat(513) }, snapshot, '1'.repeat(64), '2'.repeat(64), {
          ownerToken: 'oversized-key-owner',
          leaseMs: 30_000,
        }),
      /at most 512 bytes/
    );
    for (const publisherScope of ['bad-\ud800-key', 'bad-\udc00-key', 'trailing-high-\ud800']) {
      await assert.rejects(
        () =>
          backend.checkpoint({ ...KEY, publisherScope }, snapshot, '1'.repeat(64), '2'.repeat(64), {
            ownerToken: 'surrogate-key-owner',
            leaseMs: 30_000,
          }),
        /unpaired surrogates/
      );
    }
    const astralKey = { ...KEY, publisherScope: 'valid-astral-\u{1f600}', deliveryId: 'astral-key-contract' };
    const astral = await backend.checkpoint(astralKey, snapshot, '3'.repeat(64), '4'.repeat(64), {
      ownerToken: 'astral-key-owner',
      leaseMs: 30_000,
    });
    assert.ok(astral.lease, 'a valid UTF-16 surrogate pair must remain portable');
    assert.equal(await backend.settleLease(astral.lease, 'delivered'), true);
    const initial = await backend.checkpoint(KEY, snapshot, 'a'.repeat(64), 'f'.repeat(64), {
      ownerToken: 'live-owner-a',
      leaseMs: 30_000,
    });
    assert.equal(initial.result, 'inserted');
    assert.ok(initial.lease);
    const renewedUntil = await backend.renew(initial.lease, 45_000);
    assert.equal(typeof renewedUntil, 'number');
    assert.ok(renewedUntil > initial.lease.leaseExpiresAtMs);
    assert.deepEqual(
      await backend.checkpoint(KEY, snapshot, 'a'.repeat(64), 'f'.repeat(64), {
        ownerToken: 'live-owner-a',
        leaseMs: 30_000,
      }),
      { result: 'duplicate' },
      'an active same-owner checkpoint must not manufacture a second lease'
    );
    assert.deepEqual(
      await backend.checkpoint(KEY, snapshot, 'a'.repeat(64), 'f'.repeat(64), {
        ownerToken: 'live-owner-b',
        leaseMs: 30_000,
      }),
      { result: 'duplicate' }
    );
    assert.deepEqual(
      await backend.checkpoint(KEY, { ...snapshot, url: 'https://changed.invalid' }, 'b'.repeat(64), 'e'.repeat(64), {
        ownerToken: 'live-owner-c',
        leaseMs: 30_000,
      }),
      { result: 'conflict' }
    );
    assert.equal(await backend.release(initial.lease, 0), true);

    const restarted = await backend.checkpoint(KEY, snapshot, 'a'.repeat(64), 'f'.repeat(64), {
      ownerToken: 'restarted-live-owner',
      leaseMs: 30_000,
    });
    assert.equal(restarted.result, 'duplicate');
    assert.ok(restarted.lease, 'an exact checkpoint is recoverable after restart without rebinding');
    assert.equal(await backend.release(restarted.lease, 0), true);

    const [first] = await backend.claimPending({ ownerToken: 'worker-owner-a', leaseMs: 30_000, limit: 1 });
    assert.ok(first);
    assert.deepEqual(first.snapshot.payload.empty, []);
    assert.equal(first.attemptCount, 3);
    assert.equal(await backend.release(first, 0), true);

    const [second] = await backend.claimPending({ ownerToken: 'worker-owner-b', leaseMs: 30_000, limit: 1 });
    assert.ok(second);
    assert.ok(second.leaseVersion > first.leaseVersion);
    assert.equal(await backend.settleLease(first, 'delivered'), false);
    assert.equal(await backend.settleLease(second, 'delivered'), true);
    assert.deepEqual(await backend.claimPending({ ownerToken: 'worker-owner-c', leaseMs: 30_000, limit: 1 }), []);

    const scopedKeys = [
      { publisherScope: 'publisher-a', tenantScope: 'tenant-a', deliveryId: 'same-outbox-id' },
      { publisherScope: 'publisher-b', tenantScope: 'tenant-a', deliveryId: 'same-outbox-id' },
      { publisherScope: 'publisher-a', tenantScope: 'tenant-b', deliveryId: 'same-outbox-id' },
    ];
    const scopedClaims = await Promise.all(
      scopedKeys.map((key, index) =>
        backend.checkpoint(
          key,
          { ...snapshot, payload: { scope: index } },
          (index + 1).toString(16).repeat(64),
          (index + 4).toString(16).repeat(64),
          { ownerToken: `scoped-live-owner-${index}`, leaseMs: 30_000 }
        )
      )
    );
    assert.ok(scopedClaims.every(claim => claim.result === 'inserted' && claim.lease));
    assert.equal(new Set(scopedClaims.map(claim => claim.lease.key.publisherScope)).size, 2);
    assert.equal(new Set(scopedClaims.map(claim => claim.lease.key.tenantScope)).size, 2);
    await Promise.all(scopedClaims.map(claim => backend.settleLease(claim.lease, 'delivered')));

    const crashKey = { ...KEY, deliveryId: 'delivery-contract-crash' };
    const crashInitial = await backend.checkpoint(crashKey, snapshot, 'c'.repeat(64), 'd'.repeat(64), {
      ownerToken: 'crashing-live-owner',
      leaseMs: 20,
    });
    assert.equal(crashInitial.result, 'inserted');
    await new Promise(resolve => setTimeout(resolve, 30));
    // The winner's lease must outlive the whole concurrent burst, or a slow
    // runner lets a second worker legitimately reclaim it mid-burst.
    const claims = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        backend.claimPending({ ownerToken: `concurrent-worker-${index}`, leaseMs: CONTENDED_LEASE_MS, limit: 1 })
      )
    );
    const winners = claims.flat().filter(record => record.key.deliveryId === crashKey.deliveryId);
    assert.equal(winners.length, 1);
    const [takeover] = await claimWhenDue(backend, 'crash-takeover-worker');
    assert.ok(takeover, 'an expired lease must become claimable by another worker');
    assert.equal(takeover.key.deliveryId, crashKey.deliveryId);
    assert.ok(takeover.leaseVersion > winners[0].leaseVersion);
    assert.equal(await backend.settleLease(winners[0], 'delivered'), false);
    assert.equal(await backend.settleLease(takeover, 'delivered'), true);

    // A released lease is not claimable before its retry delay. The hold is far
    // longer than any runner stall, so an immediate claim must find nothing.
    const heldKey = { ...KEY, deliveryId: 'delivery-contract-retry-held' };
    const heldInitial = await backend.checkpoint(heldKey, snapshot, '5'.repeat(64), '6'.repeat(64), {
      ownerToken: 'retry-held-owner',
      leaseMs: 30_000,
    });
    assert.ok(heldInitial.lease);
    assert.equal(await backend.release(heldInitial.lease, RETRY_HOLD_MS), true);
    assert.deepEqual(
      await backend.claimPending({ ownerToken: 'too-early-worker', leaseMs: 30_000, limit: 1 }),
      [],
      'a released record must not be claimable before its retry delay elapses'
    );

    // A short retry delay does elapse: the record becomes claimable, and its
    // next attempt is at least the delay past the checkpoint on the backend clock.
    const retryKey = { ...KEY, deliveryId: 'delivery-contract-retry' };
    const retryInitial = await backend.checkpoint(retryKey, snapshot, '7'.repeat(64), '8'.repeat(64), {
      ownerToken: 'retry-live-owner',
      leaseMs: 30_000,
    });
    assert.ok(retryInitial.lease);
    const retryCheckpointedAtMs = retryInitial.lease.leaseExpiresAtMs - 30_000;
    assert.equal(await backend.release(retryInitial.lease, RETRY_DELAY_MS), true);
    const [retryClaim] = await claimWhenDue(backend, 'retry-worker');
    assert.ok(retryClaim, 'a released record must become claimable once its retry delay elapses');
    assert.equal(retryClaim.key.deliveryId, retryKey.deliveryId);
    assert.ok(
      retryClaim.nextAttemptAtMs >= retryCheckpointedAtMs + RETRY_DELAY_MS,
      `next attempt ${retryClaim.nextAttemptAtMs} must honour the ${RETRY_DELAY_MS} ms retry delay after ${retryCheckpointedAtMs}`
    );
    assert.equal(await backend.settleLease(retryClaim, 'terminal'), true);
    await backend.settle(heldKey, 'terminal');
    assert.deepEqual(await backend.claimPending({ ownerToken: 'drained-worker', leaseMs: 30_000, limit: 1 }), []);

    const protectedKey = { ...KEY, deliveryId: 'delivery-contract-protected-snapshot' };
    const protectedA = {
      ...snapshot,
      authentication: { kind: 'protected', protectedValue: { ciphertext: 'first' }, fingerprint: 'stable-secret' },
    };
    const protectedB = {
      ...snapshot,
      authentication: { kind: 'protected', protectedValue: { ciphertext: 'second' }, fingerprint: 'stable-secret' },
    };
    const protectedInitial = await backend.checkpoint(protectedKey, protectedA, '9'.repeat(64), 'a'.repeat(64), {
      ownerToken: 'protected-live-owner',
      leaseMs: 30_000,
    });
    assert.ok(protectedInitial.lease);
    assert.equal(await backend.release(protectedInitial.lease, 0), true);
    const protectedRestart = await backend.checkpoint(protectedKey, protectedB, '9'.repeat(64), 'b'.repeat(64), {
      ownerToken: 'protected-restart-owner',
      leaseMs: 30_000,
    });
    assert.ok(protectedRestart.lease);
    assert.equal(protectedRestart.lease.storageFingerprint, 'a'.repeat(64));
    assert.deepEqual(protectedRestart.lease.snapshot, protectedA);
    await assert.rejects(() => backend.settleLease(protectedRestart.lease, 'invalid'), /disposition/);
    assert.equal(await backend.settleLease(protectedRestart.lease, 'delivered'), true);

    const invalidSettleKey = { ...KEY, deliveryId: 'delivery-contract-invalid-settle' };
    const invalidSettle = await backend.checkpoint(invalidSettleKey, snapshot, 'd'.repeat(64), 'e'.repeat(64), {
      ownerToken: 'invalid-settle-owner',
      leaseMs: 30_000,
    });
    assert.ok(invalidSettle.lease);
    assert.equal(await backend.release(invalidSettle.lease, 0), true);
    await assert.rejects(() => backend.settle(invalidSettleKey, 'invalid'), /disposition/);
    await backend.settle(invalidSettleKey, 'terminal');
  });
}

module.exports = { runWebhookDeliveryStoreContract, runWebhookRecoveryBackendContract };
