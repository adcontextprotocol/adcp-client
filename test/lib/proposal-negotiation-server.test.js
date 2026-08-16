const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { createAdcpServer } = require('../../dist/lib/server/legacy/v5/index.js');
const {
  createIdempotencyStore,
  createAdcpServerFromPlatform,
  createInMemoryTaskRegistry,
  createProposalRefinementHandler,
  createProposalSuccessor,
  InMemoryStateStore,
  memoryBackend,
  proposalRefinementScopeFromContext,
  proposalTermsDigest,
} = require('../../dist/lib/server/index.js');

const request = (key, proposalId = 'source-1') => ({
  adcp_version: '3.2',
  adcp_major_version: 3,
  idempotency_key: key,
  refinements: [{ proposal_id: proposalId, action: 'finalize' }],
});

async function call(server, name, args, clientId) {
  return server.dispatchTestRequest(
    { method: 'tools/call', params: { name, arguments: args } },
    clientId ? { authInfo: { token: 'redacted', clientId, scopes: [] } } : undefined
  );
}

function negotiationServer(onCall, options = {}) {
  return createAdcpServer({
    name: 'proposal-test',
    version: '1.0.0',
    ...(options.adcpVersion && { adcpVersion: options.adcpVersion }),
    ...(options.serverCapabilities && { capabilities: options.serverCapabilities }),
    validation: options.validation ?? { requests: 'strict', responses: 'strict' },
    stateStore: new InMemoryStateStore(),
    idempotency: createIdempotencyStore({ backend: memoryBackend({ sweepIntervalMs: 0 }), ttlSeconds: 3600 }),
    resolveIdempotencyPrincipal: ctx => ctx.proposalRefinementScope?.principal_id,
    proposalNegotiation: {
      capabilities: options.capabilities ?? {
        supported_dimensions: ['total_budget', 'alternatives'],
        max_alternatives: 4,
      },
      resolveScope:
        options.resolveScope ?? (ctx => ({ tenant_id: 'seller-tenant', principal_id: ctx.authInfo.clientId })),
      refineProposals:
        options.refineProposals ??
        (async (params, ctx) => {
          onCall?.(params, ctx);
          return {
            status: 'completed',
            results: params.refinements.map(entry => ({
              source_proposal_id: entry.proposal_id,
              outcome: 'unable',
              reason_code: 'source_unavailable',
              reason: 'not present',
            })),
            products: [],
          };
        }),
    },
  });
}

describe('refine_proposals server integration', () => {
  test('modern platform seam auto-pins to an advertised 3.2 release', async () => {
    const server = createAdcpServerFromPlatform(
      {
        capabilities: { specialisms: [], supported_versions: ['3.2'] },
        accounts: {
          resolution: 'derived',
          resolve: async () => ({ id: 'account-1', metadata: {} }),
        },
      },
      {
        name: 'proposal-platform-test',
        version: '1.0.0',
        stateStore: new InMemoryStateStore(),
        taskRegistry: createInMemoryTaskRegistry(),
        resolveIdempotencyPrincipal: ctx => ctx.proposalRefinementScope?.principal_id,
        validation: { requests: 'strict', responses: 'strict' },
        proposalNegotiation: {
          capabilities: { supported_dimensions: [] },
          resolveScope: ctx => ({ tenant_id: 'seller-tenant', principal_id: ctx.authInfo.clientId }),
          refineProposals: async params => ({
            status: 'completed',
            results: params.refinements.map(entry => ({
              source_proposal_id: entry.proposal_id,
              outcome: 'unable',
              reason_code: 'source_unavailable',
              reason: 'not present',
            })),
            products: [],
          }),
        },
      }
    );

    const listed = await server.dispatchTestRequest({ method: 'tools/list' });
    assert.ok(listed.tools.some(tool => tool.name === 'refine_proposals'));
    const capabilities = await call(server, 'get_adcp_capabilities', {});
    assert.equal(capabilities.structuredContent.adcp_version, '3.2');
    assert.deepEqual(capabilities.structuredContent.adcp.supported_versions, ['3.2']);
    assert.deepEqual(capabilities.structuredContent.media_buy.proposal_refinement, {
      supported_dimensions: [],
    });
  });

  test('registers as a framework tool and projects proposal capabilities', async () => {
    const server = negotiationServer();
    const listed = await server.dispatchTestRequest({ method: 'tools/list' });
    assert.ok(listed.tools.some(tool => tool.name === 'refine_proposals'));

    const capabilities = await call(server, 'get_adcp_capabilities', {});
    assert.deepEqual(capabilities.structuredContent.media_buy.proposal_refinement, {
      supported_dimensions: ['total_budget', 'alternatives'],
      max_alternatives: 4,
    });
    assert.equal(capabilities.structuredContent.adcp_version, '3.2');
    assert.ok(capabilities.structuredContent.media_buy.lifecycle_tools.includes('refine_proposals'));

    const response = await call(server, 'refine_proposals', request('version-envelope-key-0001'), 'buyer-a');
    assert.equal(response.structuredContent.adcp_version, '3.2');
  });

  test('rejects an explicit pre-3.2 server pin', () => {
    assert.throws(() => negotiationServer(undefined, { adcpVersion: '3.1.13' }), /requires adcpVersion 3.2/);
  });

  test('rejects capability negotiation that advertises only pre-3.2 releases', () => {
    assert.throws(
      () => negotiationServer(undefined, { serverCapabilities: { supported_versions: ['3.1'] } }),
      /supported_versions to include a served AdCP 3.2 release/
    );
  });

  test('hides proposal refinement capabilities from a negotiated pre-3.2 response', async () => {
    const server = negotiationServer(undefined, {
      serverCapabilities: { supported_versions: ['3.1', '3.2'] },
    });

    const legacy = await call(server, 'get_adcp_capabilities', {
      adcp_version: '3.1',
      adcp_major_version: 3,
    });
    assert.equal(legacy.structuredContent.adcp_version, '3.1');
    assert.equal(legacy.structuredContent.media_buy.proposal_refinement, undefined);
    assert.equal(legacy.structuredContent.media_buy.lifecycle_tools, undefined);

    const modern = await call(server, 'get_adcp_capabilities', {
      adcp_version: '3.2',
      adcp_major_version: 3,
    });
    assert.equal(modern.structuredContent.adcp_version, '3.2');
    assert.deepEqual(modern.structuredContent.media_buy.proposal_refinement, {
      supported_dimensions: ['total_budget', 'alternatives'],
      max_alternatives: 4,
    });
    assert.ok(modern.structuredContent.media_buy.lifecycle_tools.includes('refine_proposals'));
  });

  test('requires authentication and validates before handler dispatch', async () => {
    let calls = 0;
    const server = negotiationServer(() => calls++);
    const anonymous = await call(server, 'refine_proposals', request('anonymous-key-0001'));
    assert.equal(anonymous.structuredContent.adcp_error.code, 'AUTH_MISSING');

    const malformed = await call(
      server,
      'refine_proposals',
      { idempotency_key: 'malformed-key-0001', refinements: [] },
      'buyer-a'
    );
    assert.equal(malformed.structuredContent.adcp_error.code, 'VALIDATION_ERROR');
    assert.equal(calls, 0);
  });

  test('scopes idempotency by trusted principal and replays exact retries', async () => {
    const scopes = [];
    const server = negotiationServer((_params, ctx) => scopes.push(ctx.proposalRefinementScope));
    const payload = request('principal-scope-key-0001');

    const first = await call(server, 'refine_proposals', payload, 'buyer-a');
    const replay = await call(server, 'refine_proposals', payload, 'buyer-a');
    const otherTenant = await call(server, 'refine_proposals', payload, 'buyer-b');

    assert.equal(first.structuredContent.replayed, undefined);
    assert.equal(replay.structuredContent.replayed, true);
    assert.equal(otherTenant.structuredContent.replayed, undefined);
    assert.deepEqual(scopes, [
      { tenant_id: 'seller-tenant', principal_id: 'buyer-a' },
      { tenant_id: 'seller-tenant', principal_id: 'buyer-b' },
    ]);
  });

  test('isolates replay state across trusted tenant and account scope', async () => {
    let activeScope = { tenant_id: 'tenant-a', principal_id: 'buyer-a', account_id: 'account-a' };
    let calls = 0;
    const server = negotiationServer(() => calls++, { resolveScope: () => activeScope });
    const payload = request('tenant-account-scope-key-0001');

    const tenantA = await call(server, 'refine_proposals', payload, 'buyer-a');
    const tenantAReplay = await call(server, 'refine_proposals', payload, 'buyer-a');
    activeScope = { tenant_id: 'tenant-b', principal_id: 'buyer-a', account_id: 'account-a' };
    const tenantB = await call(server, 'refine_proposals', payload, 'buyer-a');
    activeScope = { tenant_id: 'tenant-b', principal_id: 'buyer-a', account_id: 'account-b' };
    const accountB = await call(server, 'refine_proposals', payload, 'buyer-a');

    assert.equal(tenantA.structuredContent.replayed, undefined);
    assert.equal(tenantAReplay.structuredContent.replayed, true);
    assert.equal(tenantB.structuredContent.replayed, undefined);
    assert.equal(accountB.structuredContent.replayed, undefined);
    assert.equal(calls, 3);
  });

  test('enforces advertised dimensions before handler dispatch', async () => {
    let calls = 0;
    const server = negotiationServer(() => calls++, {
      capabilities: { supported_dimensions: [] },
    });
    const payload = {
      adcp_version: '3.2',
      adcp_major_version: 3,
      idempotency_key: 'unsupported-dimension-key-0001',
      refinements: [
        {
          proposal_id: 'source-1',
          action: 'revise',
          constraints: { total_budget: { currency: 'USD', max: 1000 } },
        },
      ],
    };

    const response = await call(server, 'refine_proposals', payload, 'buyer-a');
    assert.equal(response.structuredContent.adcp_error.code, 'UNSUPPORTED_FEATURE');
    assert.deepEqual(response.structuredContent.adcp_error.details, {
      unsupported_dimension: 'total_budget',
      supported_dimensions: [],
    });
    assert.equal(calls, 0);
  });

  test('enforces advertised dimensions when optional schema validation is off', async () => {
    let calls = 0;
    const server = negotiationServer(() => calls++, {
      capabilities: { supported_dimensions: [] },
      validation: { requests: 'off', responses: 'off' },
    });
    const payload = {
      idempotency_key: 'off-mode-dimension-key-0001',
      refinements: [
        {
          proposal_id: 'source-1',
          action: 'revise',
          constraints: { total_budget: { currency: 'USD', max: 1000 } },
        },
      ],
    };

    const response = await call(server, 'refine_proposals', payload, 'buyer-a');
    assert.equal(response.structuredContent.adcp_error.code, 'UNSUPPORTED_FEATURE');
    assert.equal(calls, 0);
  });

  test('accepts the compact submitted response arm in strict mode', async () => {
    const server = negotiationServer(undefined, {
      capabilities: { supported_dimensions: [] },
      refineProposals: async () => ({
        status: 'submitted',
        task_id: 'proposal-task-1',
        message: 'Inventory underwriting is pending.',
        errors: [{ code: 'UNDERWRITING_DELAY', message: 'Manual review requested.' }],
      }),
    });

    const response = await call(server, 'refine_proposals', request('submitted-response-key-0001'), 'buyer-a');
    assert.equal(response.isError, undefined);
    assert.equal(response.structuredContent.status, 'submitted');
    assert.equal(response.structuredContent.task_id, 'proposal-task-1');
    assert.equal(response.structuredContent.adcp_version, '3.2');
    assert.equal(response.structuredContent.results, undefined);
    assert.equal(response.structuredContent.products, undefined);
  });
});

function sourceProposal() {
  const commercial_terms = {
    brand: { domain: 'advertiser.test' },
    purchases: [
      {
        product_id: 'product-1',
        pricing_option_id: 'price-1',
        pricing: {
          pricing_option_id: 'price-1',
          pricing_model: 'cpm',
          currency: 'USD',
          fixed_price: 10,
        },
        start_time: '2027-01-01T00:00:00Z',
        end_time: '2027-02-01T00:00:00Z',
      },
    ],
    start_time: '2027-01-01T00:00:00Z',
    end_time: '2027-02-01T00:00:00Z',
  };
  return {
    proposal_id: 'source-1',
    proposal_kind: 'new_media_buy',
    proposal_status: 'draft',
    name: 'Source',
    commercial_terms,
    terms_digest: proposalTermsDigest(commercial_terms),
  };
}

test('source snapshot CAS prevents concurrent different-key double holds', async () => {
  const scope = { tenant_id: 'seller-tenant', principal_id: 'buyer-a' };
  const records = new Map([['source-1', { proposal: sourceProposal(), version: 1 }]]);
  let evaluations = 0;
  let releaseEvaluations;
  const bothEvaluating = new Promise(resolve => (releaseEvaluations = resolve));

  const handler = createProposalRefinementHandler({
    capabilities: { supported_dimensions: [] },
    scope: proposalRefinementScopeFromContext,
    store: {
      get: (_scope, id) => {
        const row = records.get(id);
        return row ? { proposal: row.proposal, version: String(row.version) } : null;
      },
      begin: (_scope, expected) => {
        const staged = [];
        return {
          stage: proposals => staged.push(...proposals),
          commit: () => {
            for (const source of expected) {
              const row = records.get(source.proposal_id);
              if ((row ? String(row.version) : null) !== source.version) throw new Error('CAS conflict');
            }
            for (const source of expected) {
              const row = records.get(source.proposal_id);
              if (row) records.set(source.proposal_id, { ...row, version: row.version + 1 });
            }
            for (const proposal of staged) {
              if (records.has(proposal.proposal_id)) throw new Error('insert conflict');
              records.set(proposal.proposal_id, { proposal, version: 1 });
            }
          },
          rollback: () => staged.splice(0),
        };
      },
    },
    evaluate: async ({ request: incoming, refinement, source }) => {
      evaluations++;
      if (evaluations === 2) releaseEvaluations();
      await bothEvaluating;
      return {
        source_proposal_id: refinement.proposal_id,
        outcome: 'finalized',
        proposal: createProposalSuccessor(source, {
          ...source,
          proposal_id: `held-${incoming.idempotency_key}`,
          proposal_status: 'committed',
          expires_at: '2028-01-01T00:00:00Z',
        }),
      };
    },
    now: () => new Date('2027-01-01T00:00:00Z'),
  });
  const context = { proposalRefinementScope: scope, store: {} };
  const settled = await Promise.allSettled([
    handler(request('concurrent-hold-key-0001'), context),
    handler(request('concurrent-hold-key-0002'), context),
  ]);

  assert.equal(settled.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(settled.filter(result => result.status === 'rejected').length, 1);
  assert.equal([...records.keys()].filter(id => id.startsWith('held-')).length, 1);
  assert.equal(records.get('source-1').version, 2);
});

test('active hold snapshot prevents sequential different-key double holds', async () => {
  const source = sourceProposal();
  const records = new Map([['source-1', { proposal: source, version: 1 }]]);
  let evaluations = 0;
  const handler = createProposalRefinementHandler({
    capabilities: { supported_dimensions: [] },
    scope: () => ({ tenant_id: 'seller-tenant', principal_id: 'buyer-a' }),
    store: {
      get: (_scope, id) => {
        const row = records.get(id);
        return row
          ? {
              proposal: row.proposal,
              version: String(row.version),
              ...(row.active_hold && { active_hold: structuredClone(row.active_hold) }),
            }
          : null;
      },
      begin: (_scope, expected) => {
        const staged = [];
        return {
          stage: proposals => staged.push(...proposals),
          commit: () => {
            for (const expectation of expected) {
              const row = records.get(expectation.proposal_id);
              if ((row ? String(row.version) : null) !== expectation.version) throw new Error('CAS conflict');
              if (row?.active_hold) throw new Error('active hold conflict');
            }
            for (const proposal of staged) {
              if (records.has(proposal.proposal_id)) throw new Error('insert conflict');
            }
            for (const expectation of expected) {
              const row = records.get(expectation.proposal_id);
              const held = staged.find(proposal => proposal.parent_proposal_id === expectation.proposal_id);
              if (row && held) {
                records.set(expectation.proposal_id, {
                  ...row,
                  version: row.version + 1,
                  active_hold: { proposal_id: held.proposal_id, expires_at: held.expires_at },
                });
              }
            }
            for (const proposal of staged) records.set(proposal.proposal_id, { proposal, version: 1 });
          },
          rollback: () => staged.splice(0),
        };
      },
    },
    evaluate: ({ request: incoming, refinement, source: immutableSource }) => {
      evaluations++;
      return {
        source_proposal_id: refinement.proposal_id,
        outcome: 'finalized',
        proposal: createProposalSuccessor(immutableSource, {
          ...immutableSource,
          proposal_id: `held-${incoming.idempotency_key}`,
          proposal_status: 'committed',
          expires_at: '2028-01-01T00:00:00Z',
        }),
      };
    },
    now: () => new Date('2027-01-01T00:00:00Z'),
  });

  await handler(request('sequential-hold-key-0001'), {});
  await assert.rejects(() => handler(request('sequential-hold-key-0002'), {}), /unexpired committed hold/);
  assert.equal(evaluations, 1);
  assert.equal([...records.keys()].filter(id => id.startsWith('held-')).length, 1);
  assert.deepEqual(records.get('source-1').active_hold, {
    proposal_id: 'held-sequential-hold-key-0001',
    expires_at: '2028-01-01T00:00:00Z',
  });
});

test('seller refuses a successor id that would overwrite its source', async () => {
  const source = sourceProposal();
  const handler = createProposalRefinementHandler({
    capabilities: { supported_dimensions: [] },
    scope: () => ({ tenant_id: 'seller-tenant', principal_id: 'buyer-a' }),
    store: {
      get: () => ({ proposal: source, version: '1' }),
      begin: () => assert.fail('transaction must not start'),
    },
    evaluate: ({ refinement }) => ({
      source_proposal_id: refinement.proposal_id,
      outcome: 'finalized',
      proposal: createProposalSuccessor(source, {
        ...source,
        proposal_id: source.proposal_id,
        proposal_status: 'committed',
        expires_at: '2028-01-01T00:00:00Z',
      }),
    }),
    now: () => new Date('2027-01-01T00:00:00Z'),
  });

  await assert.rejects(() => handler(request('overwrite-source-key-0001'), {}), /must differ from every source/);
});

test('seller returns and stages independent immutable snapshots', async () => {
  const source = sourceProposal();
  let evaluatorProposal;
  let staged;
  let persisted;
  const handler = createProposalRefinementHandler({
    capabilities: { supported_dimensions: [] },
    scope: () => ({ tenant_id: 'seller-tenant', principal_id: 'buyer-a' }),
    store: {
      get: () => ({ proposal: source, version: '1' }),
      begin: () => ({
        stage: proposals => {
          staged = proposals;
          assert.equal(Object.isFrozen(proposals), true);
          assert.equal(Object.isFrozen(proposals[0]), true);
          assert.equal(Object.isFrozen(proposals[0].commercial_terms), true);
          assert.equal(Reflect.set(proposals[0], 'name', 'store mutation'), false);
          assert.equal(Reflect.set(proposals[0].commercial_terms, 'start_time', '2099-01-01T00:00:00Z'), false);
        },
        commit: () => {
          persisted = structuredClone(staged[0]);
        },
        rollback: () => assert.fail('valid response must commit'),
      }),
    },
    evaluate: ({ request: incoming, refinement, source: immutableSource }) => {
      assert.equal(Object.isFrozen(incoming), true);
      assert.equal(Object.isFrozen(incoming.refinements[0]), true);
      evaluatorProposal = structuredClone(
        createProposalSuccessor(immutableSource, {
          ...immutableSource,
          proposal_id: 'held-independent-snapshot',
          proposal_status: 'committed',
          expires_at: '2028-01-01T00:00:00Z',
        })
      );
      return {
        source_proposal_id: refinement.proposal_id,
        outcome: 'finalized',
        proposal: evaluatorProposal,
      };
    },
    now: () => new Date('2027-01-01T00:00:00Z'),
  });

  const response = await handler(request('immutable-snapshot-key-0001'), {});
  const returned = response.results[0].proposal;
  assert.notStrictEqual(returned, evaluatorProposal);
  assert.notStrictEqual(returned, staged[0]);
  assert.equal(Object.isFrozen(response), true);
  assert.equal(Object.isFrozen(returned), true);
  assert.equal(Object.isFrozen(returned.commercial_terms), true);

  evaluatorProposal.name = 'evaluator mutation';
  evaluatorProposal.commercial_terms.start_time = '2099-01-01T00:00:00Z';
  assert.equal(returned.name, 'Source');
  assert.equal(returned.commercial_terms.start_time, '2027-01-01T00:00:00Z');
  assert.equal(persisted.name, 'Source');
  assert.equal(persisted.commercial_terms.start_time, '2027-01-01T00:00:00Z');
});
