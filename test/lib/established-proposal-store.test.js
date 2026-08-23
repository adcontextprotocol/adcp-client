const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createInMemoryEstablishedProposalStore,
  ESTABLISHED_PROPOSAL_COMPLETION_TOMBSTONE_RETENTION_MS,
} = require('../../dist/lib/index.js');

const scope = {
  principalScope: 'buyer-tenant-1',
  sellerScope: 'seller-scope-1',
  sourceAdcpVersion: '3.1',
};

function snapshot(proposalId = 'proposal-1', accountScope = '{"account_id":"account-1"}') {
  return {
    ...scope,
    accountScope,
    proposalId,
    proposal: {
      proposal_id: proposalId,
      proposal_status: 'committed',
      expires_at: '2099-12-31T23:59:59Z',
      commercial_terms: { total_budget: { amount: 1000, currency: 'USD' } },
    },
    expiresAt: '2099-12-31T23:59:59Z',
    snapshotFingerprint: `snapshot-${proposalId}`,
    capturedAt: '2026-08-22T00:00:00.000Z',
  };
}

function request(entry, overrides = {}) {
  return {
    bindings: [
      {
        principalScope: entry.principalScope,
        sellerScope: entry.sellerScope,
        sourceAdcpVersion: entry.sourceAdcpVersion,
        accountScope: entry.accountScope,
        proposalId: entry.proposalId,
        snapshotFingerprint: entry.snapshotFingerprint,
      },
    ],
    claim: {
      operation: 'accept',
      requestFingerprint: 'request-fingerprint-1',
      operationKey: 'operation-key-1',
      retryTtlMs: 60 * 60 * 1000,
      idempotencyKey: 'accept-proposal-key-0001',
      ...overrides,
    },
  };
}

describe('InMemoryEstablishedProposalStore', () => {
  test('detaches immutable proposal evidence and fences terminal rediscovery', async () => {
    const store = createInMemoryEstablishedProposalStore();
    const entry = snapshot();
    assert.equal((await store.putSnapshot(entry)).outcome, 'stored');
    entry.proposal.commercial_terms.total_budget.amount = 999999;
    assert.equal((await store.get(entry)).snapshot.proposal.commercial_terms.total_budget.amount, 1000);

    const claim = request(entry);
    assert.equal((await store.reserveMutation(claim)).outcome, 'reserved');
    assert.equal((await store.completeMutation(claim, 'accepted', 'terminal-result-1')).outcome, 'updated');
    assert.equal((await store.completeMutation(claim, 'accepted', 'terminal-result-1')).outcome, 'updated');
    assert.equal((await store.completeMutation(claim, 'accepted', 'different-terminal-result')).outcome, 'conflict');
    assert.equal((await store.putSnapshot(snapshot())).outcome, 'fenced');
    assert.equal((await store.reserveMutation(claim)).outcome, 'terminal');
    assert.equal((await store.releaseMutation(claim)).outcome, 'conflict');
    assert.equal((await store.get(entry)).operation.state, 'terminal');
  });

  test('atomically admits only one concurrent worker and permits only an exact bounded retry', async () => {
    let now = Date.parse('2026-08-22T00:30:00.000Z');
    const store = createInMemoryEstablishedProposalStore({ clock: () => new Date(now) });
    const entry = snapshot();
    entry.proposal.expires_at = '2026-08-22T00:45:00.000Z';
    entry.expiresAt = entry.proposal.expires_at;
    await store.putSnapshot(entry);
    const claim = request(entry, {
      reservedAt: '2099-01-01T00:00:00.000Z',
      retryExpiresAt: '2099-01-01T01:00:00.000Z',
      state: 'terminal',
    });
    const [first, second] = await Promise.all([store.reserveMutation(claim), store.reserveMutation(claim)]);
    assert.deepEqual([first.outcome, second.outcome].sort(), ['in_flight', 'reserved']);
    const reserved = await store.get(entry);
    assert.equal(reserved.operation.state, 'reserved');
    assert.equal(reserved.operation.reservedAt, '2026-08-22T00:30:00.000Z');
    assert.equal(reserved.operation.retryExpiresAt, '2026-08-22T01:30:00.000Z');

    assert.equal((await store.markAmbiguous(claim, 'commit-uncertain')).outcome, 'updated');
    const conflict = request(entry, { requestFingerprint: 'different-request' });
    assert.equal((await store.reserveMutation(conflict)).outcome, 'conflict');
    now = Date.parse('2026-08-22T00:46:00.000Z');
    assert.deepEqual(await store.reserveMutation(claim), {
      outcome: 'reserved',
      records: await store.find(scope, [entry.proposalId]),
      retry: true,
    });

    await store.markAmbiguous(claim, 'commit-uncertain');
    now = Date.parse('2026-08-22T01:30:00.001Z');
    const extended = request(entry, { retryTtlMs: 70 * 365 * 24 * 60 * 60 * 1000 });
    assert.equal((await store.reserveMutation(extended)).outcome, 'expired');
  });

  test('retains submitted task identity and supports ledger-owned reconciliation', async () => {
    const store = createInMemoryEstablishedProposalStore();
    const entry = snapshot();
    const claim = request(entry);
    await store.putSnapshot(entry);
    await store.reserveMutation(claim);
    await store.recordSubmittedTask(claim, 'seller-task-123');
    assert.equal((await store.get(entry)).operation.sellerTaskId, 'seller-task-123');
    const recovered = await store.findSubmittedTask({ ...scope, accountScope: entry.accountScope }, 'seller-task-123');
    assert.equal(recovered.request.claim.operationKey, claim.claim.operationKey);
    assert.equal(recovered.request.bindings[0].snapshotFingerprint, entry.snapshotFingerprint);
    assert.equal(
      await store.findSubmittedTask(
        { ...scope, principalScope: 'different-tenant', accountScope: entry.accountScope },
        'seller-task-123'
      ),
      undefined
    );

    assert.equal((await store.completeMutation(claim, 'accepted', 'terminal-result-1')).outcome, 'updated');
    assert.equal((await store.get(entry)).operation.disposition, 'accepted');
    assert.equal(await store.discardSnapshot(entry, entry.snapshotFingerprint), 'fenced');
  });

  test('authoritative task reconciliation can settle a permanent uncertainty fence', async () => {
    const store = createInMemoryEstablishedProposalStore();
    const entry = snapshot('terminal-uncertainty');
    const claim = request(entry, { retryTtlMs: undefined, operationKey: 'terminal-uncertainty-operation' });
    await store.putSnapshot(entry);
    await store.reserveMutation(claim);
    await store.recordSubmittedTask(claim, 'terminal-uncertainty-task');
    await store.markAmbiguous(claim, 'commit-uncertain');
    const recovered = await store.findSubmittedTask(
      { ...scope, accountScope: entry.accountScope },
      'terminal-uncertainty-task'
    );
    assert.equal(recovered.settled, undefined);
    assert.equal((await store.completeMutation(claim, 'accepted', 'reconciled-terminal-result')).outcome, 'updated');
    assert.equal(
      (await store.findSubmittedTask({ ...scope, accountScope: entry.accountScope }, 'terminal-uncertainty-task'))
        .settled,
      true
    );

    const failedEntry = snapshot('terminal-uncertainty-failure');
    const failedClaim = request(failedEntry, {
      retryTtlMs: undefined,
      operationKey: 'terminal-uncertainty-failure-operation',
      requestFingerprint: 'terminal-uncertainty-failure-request',
    });
    await store.putSnapshot(failedEntry);
    await store.reserveMutation(failedClaim);
    await store.recordSubmittedTask(failedClaim, 'terminal-uncertainty-failure-task');
    await store.markAmbiguous(failedClaim, 'commit-uncertain');
    assert.equal((await store.releaseMutation(failedClaim)).outcome, 'updated');
    assert.equal((await store.get(failedEntry)).operation.state, 'available');
  });

  test('submitted-task lookup never crosses an account boundary', async () => {
    const store = createInMemoryEstablishedProposalStore();
    const first = snapshot('multi-account-task', '{"account_id":"account-1"}');
    const second = snapshot('multi-account-task', '{"account_id":"account-2"}');
    await store.putSnapshot(first);
    await store.putSnapshot(second);
    const mutation = {
      bindings: [...request(first).bindings, ...request(second).bindings],
      claim: {
        ...request(first).claim,
        operationKey: 'multi-account-task-operation',
        requestFingerprint: 'multi-account-task-request',
      },
    };
    await store.reserveMutation(mutation);
    await store.recordSubmittedTask(mutation, 'shared-seller-task');
    assert.equal(
      await store.findSubmittedTask({ ...scope, accountScope: first.accountScope }, 'shared-seller-task'),
      undefined
    );
  });

  test('completion tombstones prevent task ID reuse in the same recovery scope', async () => {
    const store = createInMemoryEstablishedProposalStore();
    const first = snapshot('completed-task-owner');
    const firstRequest = request(first, {
      operation: 'refine',
      operationKey: 'completed-task-owner-operation',
      requestFingerprint: 'completed-task-owner-request',
    });
    await store.putSnapshot(first);
    await store.reserveMutation(firstRequest);
    await store.recordSubmittedTask(firstRequest, 'completed-seller-task');
    await store.completeRefinement(firstRequest, [], firstRequest.bindings);

    const second = snapshot('later-task-owner');
    const secondRequest = request(second, {
      operationKey: 'later-task-owner-operation',
      requestFingerprint: 'later-task-owner-request',
    });
    await store.putSnapshot(second);
    await store.reserveMutation(secondRequest);
    assert.equal((await store.recordSubmittedTask(secondRequest, 'completed-seller-task')).outcome, 'conflict');
  });

  test('a terminal proposal fence spans alternate account representations', async () => {
    const store = createInMemoryEstablishedProposalStore();
    const first = snapshot('shared-proposal', '{"account_id":"account-1"}');
    const second = snapshot('shared-proposal', '{"brand":{"domain":"example.com"}}');
    await store.putSnapshot(first);
    await store.putSnapshot(second);
    const accepted = request(first);
    await store.reserveMutation(accepted);
    await store.completeMutation(accepted, 'accepted', 'terminal-result-1');
    const alternate = request(second, {
      operationKey: 'alternate-operation-key',
      requestFingerprint: 'alternate-request-fingerprint',
    });
    assert.equal((await store.reserveMutation(alternate)).outcome, 'conflict');
    assert.equal((await store.putSnapshot(second)).outcome, 'fenced');
    assert.equal(
      (
        await store.putSnapshot(
          { ...second, snapshotFingerprint: 'alternate-generation-2' },
          second.snapshotFingerprint
        )
      ).outcome,
      'fenced'
    );
    assert.equal(
      (await store.putSnapshot(snapshot('shared-proposal', '{"account_id":"account-2"}'))).outcome,
      'fenced'
    );
  });

  test('atomically installs same-ID refinement generations and makes completion idempotent', async () => {
    const store = createInMemoryEstablishedProposalStore();
    const source = snapshot('same-id-refinement');
    await store.putSnapshot(source);
    const firstRequest = request(source, {
      operation: 'refine',
      operationKey: 'refine-operation-1',
      requestFingerprint: 'refine-request-1',
    });
    await store.reserveMutation(firstRequest);
    await store.recordSubmittedTask(firstRequest, 'same-id-refinement-task');
    const secondGeneration = {
      ...snapshot('same-id-refinement'),
      proposal: { ...source.proposal, proposal_status: 'draft' },
      snapshotFingerprint: 'snapshot-generation-2',
    };
    assert.equal((await store.completeRefinement(firstRequest, [secondGeneration])).outcome, 'updated');
    assert.equal((await store.completeRefinement(firstRequest, [secondGeneration])).outcome, 'updated');
    assert.equal((await store.get(source)).snapshot.snapshotFingerprint, 'snapshot-generation-2');
    assert.equal(
      (await store.findSubmittedTask({ ...scope, accountScope: source.accountScope }, 'same-id-refinement-task'))
        .settled,
      true
    );
    assert.equal((await store.reserveMutation(firstRequest)).outcome, 'conflict');
    assert.equal((await store.putSnapshot(source)).outcome, 'fenced');

    const secondRequest = request(secondGeneration, {
      operation: 'refine',
      operationKey: 'refine-operation-2',
      requestFingerprint: 'refine-request-2',
    });
    await store.reserveMutation(secondRequest);
    const thirdGeneration = { ...secondGeneration, snapshotFingerprint: 'snapshot-generation-3' };
    await store.completeRefinement(secondRequest, [thirdGeneration]);
    assert.equal((await store.completeRefinement(firstRequest, [secondGeneration])).outcome, 'updated');
    assert.equal((await store.get(source)).snapshot.snapshotFingerprint, 'snapshot-generation-3');
  });

  test('does not resurrect an identical refinement generation and restores authoritative unable sources', async () => {
    const store = createInMemoryEstablishedProposalStore();
    const identical = snapshot('identical-refinement');
    await store.putSnapshot(identical);
    const consumed = request(identical, {
      operation: 'refine',
      operationKey: 'identical-operation',
      requestFingerprint: 'identical-request',
    });
    await store.reserveMutation(consumed);
    await store.completeRefinement(consumed, [identical]);
    assert.equal((await store.get(identical)).operation.state, 'terminal');

    const unable = snapshot('unable-refinement');
    await store.putSnapshot(unable);
    const retained = request(unable, {
      operation: 'refine',
      operationKey: 'unable-operation',
      requestFingerprint: 'unable-request',
    });
    await store.reserveMutation(retained);
    await store.completeRefinement(retained, [], retained.bindings);
    assert.equal((await store.get(unable)).operation.state, 'available');
  });

  test('compares the expected snapshot generation inside reservation', async () => {
    const store = createInMemoryEstablishedProposalStore();
    const current = snapshot('generation-cas');
    await store.putSnapshot(current);
    const stale = request({ ...current, snapshotFingerprint: 'stale-generation' });
    assert.equal((await store.reserveMutation(stale)).outcome, 'conflict');
    assert.equal((await store.get(current)).operation.state, 'available');
  });

  test('atomically restores unable declines while terminalizing successful rows', async () => {
    const store = createInMemoryEstablishedProposalStore();
    const declined = snapshot('declined-row');
    const unable = snapshot('unable-row');
    await store.putSnapshot(declined);
    await store.putSnapshot(unable);
    const mutation = {
      bindings: [...request(declined).bindings, ...request(unable).bindings],
      claim: {
        ...request(declined).claim,
        operation: 'decline',
        operationKey: 'mixed-decline-operation',
        requestFingerprint: 'mixed-decline-request',
      },
    };
    await store.reserveMutation(mutation);
    assert.equal((await store.completeDecline(mutation, request(unable).bindings)).outcome, 'updated');
    assert.equal((await store.completeDecline(mutation, request(unable).bindings)).outcome, 'updated');
    assert.equal((await store.get(declined)).operation.state, 'terminal');
    assert.equal((await store.get(unable)).operation.state, 'available');

    const allDeclined = snapshot('all-declined-row');
    await store.putSnapshot(allDeclined);
    const allDeclinedMutation = request(allDeclined, {
      operation: 'decline',
      operationKey: 'all-declined-operation',
      requestFingerprint: 'all-declined-request',
      idempotencyKey: 'all-declined-key-0001',
    });
    await store.reserveMutation(allDeclinedMutation);
    await store.recordSubmittedTask(allDeclinedMutation, 'all-declined-task');
    await store.completeDecline(allDeclinedMutation);
    assert.equal(
      (await store.findSubmittedTask({ ...scope, accountScope: allDeclined.accountScope }, 'all-declined-task'))
        .settled,
      true
    );
  });

  test('atomically replaces only the expected available discovery generation', async () => {
    const store = createInMemoryEstablishedProposalStore();
    const first = snapshot('rediscovered-generation');
    const second = { ...first, snapshotFingerprint: 'snapshot-generation-2' };
    const stale = { ...first, snapshotFingerprint: 'snapshot-generation-stale' };
    assert.equal((await store.putSnapshot(first)).outcome, 'stored');
    assert.equal((await store.putSnapshot(second, first.snapshotFingerprint)).outcome, 'stored');
    assert.equal((await store.putSnapshot(stale, first.snapshotFingerprint)).outcome, 'fenced');
    assert.equal((await store.get(first)).snapshot.snapshotFingerprint, second.snapshotFingerprint);

    const deleted = snapshot('deleted-generation');
    await store.putSnapshot(deleted);
    await store.discardSnapshot(deleted, deleted.snapshotFingerprint);
    assert.equal(
      (await store.putSnapshot({ ...deleted, snapshotFingerprint: 'replacement' }, deleted.snapshotFingerprint))
        .outcome,
      'missing'
    );
    assert.equal(await store.get(deleted), undefined);
  });

  test('all-unable completions fence exact retries while permitting a new idempotency attempt', async () => {
    for (const operation of ['refine', 'decline']) {
      const store = createInMemoryEstablishedProposalStore();
      const entry = snapshot(`all-unable-${operation}`);
      await store.putSnapshot(entry);
      const first = request(entry, {
        operation,
        operationKey: `${operation}-unable-operation-1`,
        requestFingerprint: `${operation}-unable-request`,
        idempotencyKey: `${operation}-unable-key-0001`,
      });
      await store.reserveMutation(first);
      await store.recordSubmittedTask(first, `${operation}-unable-task`);
      const completed =
        operation === 'refine'
          ? await store.completeRefinement(first, [], first.bindings)
          : await store.completeDecline(first, first.bindings);
      assert.equal(completed.outcome, 'updated');
      assert.equal((await store.reserveMutation(first)).outcome, 'conflict');
      const recovered = await store.findSubmittedTask(
        { ...scope, accountScope: entry.accountScope },
        `${operation}-unable-task`
      );
      assert.equal(recovered.settled, true);

      const next = request(entry, {
        operation,
        operationKey: `${operation}-unable-operation-2`,
        requestFingerprint: `${operation}-unable-request`,
        idempotencyKey: `${operation}-unable-key-0002`,
      });
      assert.equal((await store.reserveMutation(next)).outcome, 'reserved');
    }
  });

  test('retains completion proofs through the minimum horizon and prunes them at the boundary', async () => {
    for (const operation of ['refine', 'decline']) {
      let now = Date.parse('2026-08-22T00:00:00.000Z');
      const store = createInMemoryEstablishedProposalStore({ clock: () => new Date(now) });
      const entry = snapshot(`retained-completion-${operation}`);
      await store.putSnapshot(entry);
      const mutation = request(entry, {
        operation,
        operationKey: `retained-completion-${operation}-operation`,
        requestFingerprint: `retained-completion-${operation}-request`,
        idempotencyKey: `retained-completion-${operation}-key`,
      });
      await store.reserveMutation(mutation);
      await store.recordSubmittedTask(mutation, `retained-completion-${operation}-task`);
      const completion =
        operation === 'refine'
          ? await store.completeRefinement(mutation, [], mutation.bindings)
          : await store.completeDecline(mutation, mutation.bindings);
      assert.equal(completion.outcome, 'updated');

      now += ESTABLISHED_PROPOSAL_COMPLETION_TOMBSTONE_RETENTION_MS - 1;
      assert.equal(await store.pruneCompletionTombstones(), 0);
      assert.equal((await store.reserveMutation(mutation)).outcome, 'conflict');
      const conflictingReuse = request(entry, {
        operation,
        operationKey: mutation.claim.operationKey,
        requestFingerprint: `retained-completion-${operation}-changed-request`,
        idempotencyKey: `retained-completion-${operation}-changed-key`,
      });
      assert.equal((await store.reserveMutation(conflictingReuse)).outcome, 'conflict');
      const recovered = await store.findSubmittedTask(
        { ...scope, accountScope: entry.accountScope },
        `retained-completion-${operation}-task`
      );
      assert.equal(recovered.settled, true);
      assert.deepEqual(recovered.completion, {
        completedAt: '2026-08-22T00:00:00.000Z',
        retainUntil: new Date(
          Date.parse('2026-08-22T00:00:00.000Z') + ESTABLISHED_PROPOSAL_COMPLETION_TOMBSTONE_RETENTION_MS
        ).toISOString(),
      });

      now += 1;
      assert.equal(await store.pruneCompletionTombstones(), 1);
      assert.equal(
        await store.findSubmittedTask(
          { ...scope, accountScope: entry.accountScope },
          `retained-completion-${operation}-task`
        ),
        undefined
      );
      assert.equal((await store.reserveMutation(mutation)).outcome, 'reserved');
    }
  });

  test('rejects completion retention below the protocol-owned minimum', () => {
    assert.throws(
      () =>
        createInMemoryEstablishedProposalStore({
          completionTombstoneRetentionMs: ESTABLISHED_PROPOSAL_COMPLETION_TOMBSTONE_RETENTION_MS - 1,
        }),
      /completionTombstoneRetentionMs must be a safe integer of at least/
    );
  });

  test('prunes at most the requested limit and rejects invalid limits', async () => {
    let now = Date.parse('2026-08-22T00:00:00.000Z');
    const store = createInMemoryEstablishedProposalStore({ clock: () => new Date(now) });
    for (const suffix of ['a', 'b']) {
      const entry = snapshot(`limited-prune-${suffix}`);
      await store.putSnapshot(entry);
      const mutation = request(entry, {
        operation: 'decline',
        operationKey: `limited-prune-${suffix}-operation`,
        requestFingerprint: `limited-prune-${suffix}-request`,
        idempotencyKey: `limited-prune-${suffix}-key`,
      });
      assert.equal((await store.reserveMutation(mutation)).outcome, 'reserved');
      assert.equal((await store.completeDecline(mutation, mutation.bindings)).outcome, 'updated');
    }

    now += ESTABLISHED_PROPOSAL_COMPLETION_TOMBSTONE_RETENTION_MS;
    assert.equal(await store.pruneCompletionTombstones(1), 1);
    assert.equal(await store.pruneCompletionTombstones(1), 1);
    assert.equal(await store.pruneCompletionTombstones(1), 0);

    for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
      await assert.rejects(store.pruneCompletionTombstones(invalid), /limit must be a positive safe integer/);
    }
  });

  test('pruning task recovery never reauthorizes consumed refinement or decline sources', async () => {
    for (const operation of ['refine', 'decline']) {
      let now = Date.parse('2026-08-22T00:00:00.000Z');
      const store = createInMemoryEstablishedProposalStore({ clock: () => new Date(now) });
      const entry = snapshot(`consumed-completion-${operation}`);
      await store.putSnapshot(entry);
      const mutation = request(entry, {
        operation,
        operationKey: `consumed-completion-${operation}-operation`,
        requestFingerprint: `consumed-completion-${operation}-request`,
        idempotencyKey: `consumed-completion-${operation}-key`,
      });
      await store.reserveMutation(mutation);
      await store.recordSubmittedTask(mutation, `consumed-completion-${operation}-task`);
      const completion =
        operation === 'refine' ? await store.completeRefinement(mutation, []) : await store.completeDecline(mutation);
      assert.equal(completion.outcome, 'updated');

      now += ESTABLISHED_PROPOSAL_COMPLETION_TOMBSTONE_RETENTION_MS;
      assert.equal(await store.pruneCompletionTombstones(), 1);
      assert.equal(
        await store.findSubmittedTask(
          { ...scope, accountScope: entry.accountScope },
          `consumed-completion-${operation}-task`
        ),
        undefined
      );
      assert.equal((await store.reserveMutation(mutation)).outcome, 'terminal');
      assert.equal((await store.get(entry)).operation.disposition, operation === 'refine' ? 'refined' : 'declined');
    }
  });

  test('completion tombstones count toward every atomic transition capacity check', async () => {
    let reserveCapacityObserved = false;
    let submittedCapacityObserved = false;

    for (let maxBytes = 900; maxBytes <= 8_000 && !reserveCapacityObserved; maxBytes += 1) {
      const store = createInMemoryEstablishedProposalStore({ maxBytes });
      const completedEntry = snapshot('capacity-completed');
      if ((await store.putSnapshot(completedEntry)).outcome !== 'stored') continue;
      const completedRequest = request(completedEntry, {
        operation: 'refine',
        operationKey: 'capacity-completed-operation',
        requestFingerprint: 'capacity-completed-request',
        idempotencyKey: 'capacity-completed-key-0001',
      });
      if ((await store.reserveMutation(completedRequest)).outcome !== 'reserved') continue;
      if ((await store.completeRefinement(completedRequest, [], completedRequest.bindings)).outcome !== 'updated') {
        continue;
      }

      const nextEntry = snapshot('capacity-next');
      if ((await store.putSnapshot(nextEntry)).outcome !== 'stored') continue;
      const nextRequest = request(nextEntry, {
        operationKey: 'capacity-next-operation',
        requestFingerprint: 'capacity-next-request',
        idempotencyKey: 'capacity-next-key-0001',
      });
      const reserved = await store.reserveMutation(nextRequest);
      if (reserved.outcome !== 'capacity') continue;
      assert.equal((await store.get(nextEntry)).operation.state, 'available');
      reserveCapacityObserved = true;
    }

    for (let maxBytes = 900; maxBytes <= 8_000 && !submittedCapacityObserved; maxBytes += 1) {
      const store = createInMemoryEstablishedProposalStore({ maxBytes });
      const completedEntry = snapshot('task-capacity-completed');
      if ((await store.putSnapshot(completedEntry)).outcome !== 'stored') continue;
      const completedRequest = request(completedEntry, {
        operation: 'decline',
        operationKey: 'task-capacity-completed-operation',
        requestFingerprint: 'task-capacity-completed-request',
        idempotencyKey: 'task-capacity-completed-key-0001',
      });
      if ((await store.reserveMutation(completedRequest)).outcome !== 'reserved') continue;
      if ((await store.completeDecline(completedRequest, completedRequest.bindings)).outcome !== 'updated') continue;

      const nextEntry = snapshot('task-capacity-next');
      if ((await store.putSnapshot(nextEntry)).outcome !== 'stored') continue;
      const nextRequest = request(nextEntry, {
        operationKey: 'task-capacity-next-operation',
        requestFingerprint: 'task-capacity-next-request',
        idempotencyKey: 'task-capacity-next-key-0001',
      });
      if ((await store.reserveMutation(nextRequest)).outcome !== 'reserved') continue;
      const submitted = await store.recordSubmittedTask(nextRequest, 'seller-task-that-grows-the-record');
      if (submitted.outcome !== 'capacity') continue;
      assert.equal((await store.get(nextEntry)).operation.sellerTaskId, undefined);
      submittedCapacityObserved = true;
    }

    assert.equal(reserveCapacityObserved, true, 'expected a capacity boundary between available and reserved');
    assert.equal(submittedCapacityObserved, true, 'expected a capacity boundary before recording a seller task');
  });

  test('refinement successors cannot bypass a terminal fence through another account scope', async () => {
    const store = createInMemoryEstablishedProposalStore();
    const source = snapshot('source-proposal', '{"account_id":"account-1"}');
    const terminalAlias = snapshot('child-proposal', '{"account_id":"account-2"}');
    await store.putSnapshot(source);
    await store.putSnapshot(terminalAlias);
    const accepted = request(terminalAlias, {
      operationKey: 'terminal-child-operation',
      requestFingerprint: 'terminal-child-request',
      idempotencyKey: 'terminal-child-key-0001',
    });
    await store.reserveMutation(accepted);
    await store.completeMutation(accepted, 'accepted', 'terminal-result-1');

    const refinement = request(source, {
      operation: 'refine',
      operationKey: 'source-refinement-operation',
      requestFingerprint: 'source-refinement-request',
      idempotencyKey: 'source-refinement-key-0001',
    });
    await store.reserveMutation(refinement);
    const child = snapshot('child-proposal', source.accountScope);
    assert.equal((await store.completeRefinement(refinement, [child])).outcome, 'conflict');
    assert.equal((await store.get(terminalAlias)).operation.disposition, 'accepted');
  });
});
