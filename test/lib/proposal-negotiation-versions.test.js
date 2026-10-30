const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildRefineProposalsRequest,
  proposalTermsDigest,
  validateRefineProposalsRequest,
  validateRefineProposalsResponseShape,
  verifyRefineProposalsResponse,
} = require('../../dist/lib/index.js');
const { withExternalSchemaRoot, withIdentity33SchemaScope } = require('../../dist/lib/validation/schema-loader.js');
const { ADCP_VERSION } = require('../../dist/lib/version.js');
const verify = (req, payload, options = {}) =>
  verifyRefineProposalsResponse(req, payload, { adcpVersion: BUNDLE_VERSION, ...options });

const VERSION = '3.3-beta.2';
const BUNDLE_VERSION = '3.3.0-beta.2';
const refinement = { proposal_id: 'source-1', action: 'revise', ask: 'Improve the terms' };
const request = (refinements = [refinement]) => buildRefineProposalsRequest({ adcp_version: VERSION, refinements });
function proposal(overrides = {}) {
  const commercial_terms = {
    brand: { domain: 'buyer.example' },
    purchases: [
      {
        product_id: 'product-1',
        pricing_option_id: 'price-1',
        pricing: { pricing_option_id: 'price-1', pricing_model: 'cpm', currency: 'USD', fixed_price: 8 },
        impressions: 1000,
        start_time: '2027-01-01T00:00:00Z',
        end_time: '2027-02-01T00:00:00Z',
      },
    ],
    start_time: '2027-01-01T00:00:00Z',
    end_time: '2027-02-01T00:00:00Z',
    total_budget: { amount: 8, currency: 'USD' },
    change_terms: [{ term_id: 'candidate-term', action: 'pause', service_mode: 'self_serve' }],
  };
  return {
    proposal_id: 'successor-1',
    parent_proposal_id: 'source-1',
    proposal_kind: 'new_media_buy',
    proposal_status: 'draft',
    name: 'candidate-proposal',
    commercial_terms,
    terms_digest: proposalTermsDigest(commercial_terms),
    ...overrides,
  };
}
const response = (child = proposal()) => ({
  adcp_version: VERSION,
  results: [{ source_proposal_id: 'source-1', outcome: 'revised', proposals: [child] }],
  products: [],
});

// A disposable bundle with deliberately distinct constraints proves that the
// selected version, rather than the SDK's default bundle, controls validation.
// This is a loader-isolation fixture, not a replacement for published schemas.
async function withCandidateSchema(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-refinement-versions-'));
  try {
    fs.cpSync(path.resolve(__dirname, '../../schemas/cache', ADCP_VERSION), root, {
      recursive: true,
      filter: source => !['bundled', 'mcp'].includes(path.basename(source)),
    });
    for (const relative of fs.readdirSync(root, { recursive: true })) {
      if (!relative.endsWith('.json')) continue;
      const filename = path.join(root, relative);
      fs.writeFileSync(
        filename,
        fs.readFileSync(filename, 'utf8').replaceAll(`/schemas/${ADCP_VERSION}/`, '/schemas/latest/')
      );
    }
    for (const [relative, field, value] of [
      ['core/canonical-proposal.json', 'name', 'candidate-proposal'],
      ['media-buy/change-term.json', 'term_id', 'candidate-term'],
    ]) {
      const filename = path.join(root, relative);
      const schema = JSON.parse(fs.readFileSync(filename, 'utf8'));
      schema.properties[field] = { type: 'string', const: value };
      fs.writeFileSync(filename, JSON.stringify(schema));
    }
    const indexPath = path.join(root, 'index.json');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    fs.writeFileSync(indexPath, JSON.stringify({ ...index, adcp_version: BUNDLE_VERSION }));
    return await withExternalSchemaRoot(BUNDLE_VERSION, root, fn);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('proposal refinement accepts same-major release pins from 3.2 and rejects older, malformed or patch wire pins', () => {
  for (const adcp_version of ['3.2', '3.2-beta.1', '3.3-beta.1', '3.3-rc.2', '3.3']) {
    const built = buildRefineProposalsRequest({ adcp_version, refinements: [refinement] });
    assert.equal(built.adcp_version, adcp_version);
    assert.doesNotThrow(() => validateRefineProposalsRequest(built));
  }
  assert.equal(
    buildRefineProposalsRequest({ refinements: [refinement] }, undefined, BUNDLE_VERSION).adcp_version,
    VERSION
  );
  for (const adcp_version of [
    '3.0',
    '3.1',
    '3.1-rc.2',
    '4.0',
    '3.03',
    '3.3.0',
    BUNDLE_VERSION,
    '3.3-.',
    '3.3-rc.',
    '3.3--rc',
    '3.3-beta.01',
    '3.2-01',
    '3.3\n',
    '3.2\r\n',
    `3.3-beta.${'9'.repeat(300)}`,
    '3.4',
    '3.10',
  ]) {
    assert.throws(() => buildRefineProposalsRequest({ adcp_version, refinements: [refinement] }), /AdCP 3.2 or 3.3/);
  }
});

test('discovery served evidence is explicit, valid and compatible with the current request ceiling', () => {
  const { applicableRefinementServedVersion } = require('../../dist/lib/negotiation/version');
  assert.equal(applicableRefinementServedVersion(BUNDLE_VERSION, VERSION), BUNDLE_VERSION);
  assert.equal(applicableRefinementServedVersion(BUNDLE_VERSION, '3.2'), undefined);
  assert.equal(applicableRefinementServedVersion('3.2.5', VERSION), '3.2.5');
  assert.equal(applicableRefinementServedVersion('3.2-beta.0', '3.2', '3.2-beta.0'), undefined);
  assert.equal(applicableRefinementServedVersion('3.2-beta.0', '3.2-beta.0', '3.2-beta.0'), '3.2-beta.0');
  for (const invalid of [
    undefined,
    '3.1',
    '3.4',
    '3.3.01',
    '3.3-beta.01',
    '3.3.0-beta.01',
    `3.3-beta.${'9'.repeat(300)}`,
  ]) {
    assert.equal(applicableRefinementServedVersion(invalid, VERSION), undefined);
  }
});

test('negotiated 3.3 validates canonical proposals and nested change terms against its external bundle', () =>
  withCandidateSchema(() => {
    assert.equal(verify(request(), response()).ok, true);
    assert.equal(validateRefineProposalsResponseShape(response(), { adcpVersion: BUNDLE_VERSION }).ok, true);
    const wrongProposal = response(proposal({ name: 'valid-only-under-default' }));
    assert.equal(verify(request(), wrongProposal).ok, false);
    const wrongTerm = response();
    wrongTerm.results[0].proposals[0].commercial_terms.change_terms[0].term_id = 'valid-only-under-default';
    wrongTerm.results[0].proposals[0].terms_digest = proposalTermsDigest(
      wrongTerm.results[0].proposals[0].commercial_terms
    );
    assert.equal(verify(request(), wrongTerm).ok, false);
    assert.equal(
      validateRefineProposalsResponseShape({ ...wrongTerm, adcp_version: '3.2' }, { adcpVersion: '3.2.7' }).ok,
      true,
      'negative control: the same terms satisfy the maintained stable schema'
    );
  }));

test('negotiation rejects a different echoed release and conflicting schema selection', () =>
  withCandidateSchema(() => {
    for (const adcp_version of [
      '3.3-rc.1',
      '3.1',
      '4.0',
      '3.3.0',
      '3.3-.',
      '3.3-beta.01',
      '3.2-01',
      `3.3-beta.${'9'.repeat(300)}`,
    ]) {
      const result = verify(request(), { ...response(), adcp_version });
      assert.equal(result.ok, false);
      assert.equal(result.issues[0].path, 'adcp_version');
    }
    assert.equal(verify(request(), response(), { adcpVersion: '3.2' }).ok, false);
    assert.equal(
      validateRefineProposalsResponseShape(response()).ok,
      true,
      'the published beta now matches the SDK default bundle'
    );
  }));

test('an unavailable selected schema fails closed even for an unable result without proposals', () => {
  const req = buildRefineProposalsRequest({ adcp_version: '3.3-beta.999', refinements: [refinement] });
  const result = verifyRefineProposalsResponse(
    req,
    {
      adcp_version: '3.3-beta.999',
      products: [],
      results: [
        {
          source_proposal_id: 'source-1',
          outcome: 'unable',
          reason_code: 'commercially_declined',
          reason: 'Unavailable',
        },
      ],
    },
    { adcpVersion: '3.3.0-beta.999' }
  );
  assert.equal(result.ok, false);
  assert.match(result.issues[0].message, /3\.3\.0-beta\.999.*unavailable.*(?:ConfigurationError|Error)/);
  assert.match(result.issues[0].message, /register a matching external schema root/);
  assert(!result.issues[0].message.includes(process.cwd()), 'bundle diagnostics must not expose local paths');
});

test('3.3 still rejects digest tampering, wrong lineage, expired holds and non-atomic finalize results', () =>
  withCandidateSchema(() => {
    const tampered = response(proposal({ terms_digest: `sha256:${'a'.repeat(43)}` }));
    const badLineage = response(proposal({ parent_proposal_id: 'different-source' }));
    for (const payload of [tampered, badLineage]) assert.equal(verify(request(), payload).ok, false);
    const finalRequest = request([
      { proposal_id: 'source-1', action: 'finalize' },
      { proposal_id: 'source-2', action: 'finalize' },
    ]);
    const expired = proposal({ proposal_status: 'committed', expires_at: '2000-01-01T00:00:00Z' });
    const result = verify(finalRequest, {
      adcp_version: VERSION,
      products: [],
      results: [
        { source_proposal_id: 'source-1', outcome: 'finalized', proposal: expired },
        { source_proposal_id: 'source-2', outcome: 'unable', reason_code: 'batch_aborted', reason: 'Unavailable' },
      ],
    });
    assert.equal(result.ok, false);
    assert(result.issues.some(issue => issue.code === 'hold_expired'));
    assert(result.issues.some(issue => issue.code === 'outcome'));
  }));

test('the public buyer refines and finalizes over the official MCP transport on the real 3.3 wire pin', () =>
  withCandidateSchema(async () => {
    const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
    const { AgentClient } = require('../../dist/lib/index.js');
    const z = require('zod');
    const captured = [];
    let completedResult;
    let invalidEcho;
    let invalidName = false;
    let capabilityVersion = VERSION;
    const seller = new McpServer({ name: 'Candidate seller', version: '1.0.0' });
    seller.registerTool('get_adcp_capabilities', { inputSchema: {} }, async () => ({
      content: [{ type: 'text', text: '{}' }],
      structuredContent: {
        status: 'completed',
        adcp_version: capabilityVersion,
        adcp: {
          major_versions: [3],
          supported_versions: [capabilityVersion, '3.2'],
          idempotency: { supported: true, replay_ttl_seconds: 86400 },
        },
        supported_protocols: ['media_buy'],
        specialisms: [],
        media_buy: { lifecycle_tools: ['list_products', 'refine_proposals'] },
      },
    }));
    seller.registerTool('list_products', { inputSchema: {} }, async () => ({
      content: [{ type: 'text', text: '{}' }],
      structuredContent: { outcome: 'listed', products: [], feed_version: 'feed-1', pricing_version: 'pricing-1' },
    }));
    seller.registerTool(
      'refine_proposals',
      {
        inputSchema: {
          adcp_version: z.string(),
          adcp_major_version: z.number(),
          idempotency_key: z.string(),
          refinements: z.array(z.any()),
        },
      },
      async args => {
        captured.push(args);
        const finalize = args.refinements[0].action === 'finalize';
        const data = finalize
          ? {
              adcp_version: VERSION,
              products: [],
              results: [
                {
                  source_proposal_id: 'source-1',
                  outcome: 'finalized',
                  proposal: proposal({ proposal_status: 'committed', expires_at: '2100-01-01T00:00:00Z' }),
                },
              ],
            }
          : response();
        const sourceId = args.refinements[0].proposal_id;
        data.results[0].source_proposal_id = sourceId;
        const child = finalize ? data.results[0].proposal : data.results[0].proposals[0];
        child.parent_proposal_id = sourceId;
        child.proposal_id = `successor-${captured.length}`;
        if (args.adcp_version.startsWith('3.2')) {
          data.adcp_version = args.adcp_version;
          child.name = 'stable-only-proposal';
        }
        if (invalidName) child.name = 'stable-only-proposal';
        if (invalidEcho !== undefined) data.adcp_version = invalidEcho;
        return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
      }
    );
    const [buyerTransport, sellerTransport] = InMemoryTransport.createLinkedPair();
    await seller.connect(sellerTransport);
    const mcp = new Client({ name: 'Candidate buyer', version: '1.0.0' });
    try {
      await mcp.connect(buyerTransport);
      const buyer = AgentClient.fromMCPClient(mcp, { adcpVersion: BUNDLE_VERSION, wireAdcpVersion: VERSION });
      for (const entry of [refinement, { proposal_id: 'source-1', action: 'finalize' }]) {
        const result = await buyer.refineProposals({ refinements: [entry] });
        assert.equal(result.success, true);
        assert.equal(result.data.adcp_version, VERSION);
        completedResult = result;
      }
      const coordinator = await buyer.negotiateMediaBuyLifecycle();
      assert.equal(coordinator.negotiated_version, VERSION);
      const coordinated = await coordinator.refineProposals({
        refinements: [{ ...refinement, proposal_id: 'coordinator-source' }],
      });
      assert.equal(coordinated.data.results[0].outcome, 'revised');
      assert(captured.every(args => args.adcp_version === VERSION && args.adcp_major_version === 3));
      const strictBuyer = AgentClient.fromMCPClient(mcp, {
        adcpVersion: BUNDLE_VERSION,
        validation: { responses: 'strict' },
      });
      const strictCoordinator = await strictBuyer.negotiateMediaBuyLifecycle();
      for (const [client, prefix] of [
        [strictBuyer, 'direct'],
        [strictCoordinator, 'coordinated'],
      ]) {
        const matched = await client.refineProposals({
          refinements: [{ ...refinement, proposal_id: `strict-matched-${prefix}` }],
        });
        assert.equal(matched.success, true, matched.error);
        assert.equal(matched.data.results[0].proposals[0].name, 'candidate-proposal');
        const lower = await client.refineProposals({
          adcp_version: '3.2',
          refinements: [{ ...refinement, proposal_id: `explicit-lower-${prefix}` }],
        });
        assert.equal(lower.success, true, lower.error);
        assert.equal(lower.metadata.adcpVersion, '3.2');
        assert.equal(lower.data.results[0].proposals[0].name, 'stable-only-proposal');
      }
      capabilityVersion = '3.2-beta.0';
      const betaBuyer = AgentClient.fromMCPClient(mcp, {
        adcpVersion: '3.2.7',
        wireAdcpVersion: '3.2-beta.0',
        validation: { responses: 'strict' },
      });
      const betaCoordinator = await betaBuyer.negotiateMediaBuyLifecycle();
      assert.equal(betaCoordinator.negotiated_version, '3.2-beta.0');
      for (const [client, prefix] of [
        [betaBuyer, 'direct'],
        [betaCoordinator, 'coordinated'],
      ]) {
        const original = await client.refineProposals({
          refinements: [{ ...refinement, proposal_id: `beta-default-${prefix}` }],
        });
        assert.equal(original.success, true, original.error);
        assert.equal(original.metadata.adcpVersion, '3.2-beta.0');
        const raised = await client.refineProposals({
          adcp_version: '3.2',
          refinements: [{ ...refinement, proposal_id: `raised-stable-${prefix}` }],
        });
        assert.equal(raised.success, true, raised.error);
        assert.equal(raised.metadata.adcpVersion, '3.2');
      }
      capabilityVersion = VERSION;
      invalidEcho = '3.2';
      invalidName = true;
      await assert.rejects(
        () => buyer.refineProposals({ refinements: [refinement] }),
        /response echo 3\.2 conflicts with served version metadata 3\.3-beta\.2/
      );
      await assert.rejects(
        () => coordinator.refineProposals({ refinements: [{ ...refinement, proposal_id: 'hostile-source' }] }),
        /response echo 3\.2 conflicts with served version metadata 3\.3-beta\.2/
      );
      // Isolate the coordinator's own verification: a completed task can
      // reach projection through polling/callbacks rather than this helper.
      const publicRefine = buyer.refineProposals;
      const hostileData = {
        ...response(proposal({ name: 'stable-only-proposal', parent_proposal_id: 'projection-hostile-source' })),
        adcp_version: '3.2',
      };
      hostileData.results[0].source_proposal_id = 'projection-hostile-source';
      buyer.refineProposals = async () => ({ ...completedResult, data: hostileData });
      try {
        await assert.rejects(
          () =>
            coordinator.refineProposals({
              refinements: [{ ...refinement, proposal_id: 'projection-hostile-source' }],
            }),
          /response echo 3\.2 conflicts with served version metadata 3\.3-beta\.2/
        );
      } finally {
        buyer.refineProposals = publicRefine;
      }
      invalidName = false;
      for (invalidEcho of ['3.3-rc.1', '3.3.0', '3.1', '4.0', '3.3-beta.01', `3.3-beta.${'9'.repeat(300)}`]) {
        await assert.rejects(
          () => buyer.refineProposals({ refinements: [refinement] }),
          /ceiling|conflicts with served version metadata/
        );
      }
      invalidEcho = '3.3.0';
      for (const [mode, logSchemaViolations] of [
        ['warn', false],
        ['strict', false],
        ['strict', true],
      ]) {
        const loggingBuyer = AgentClient.fromMCPClient(mcp, {
          adcpVersion: BUNDLE_VERSION,
          validation: { responses: mode, logSchemaViolations },
        });
        const logged = [];
        const originalError = console.error;
        const originalWarn = console.warn;
        console.error = (...args) => logged.push(args);
        console.warn = (...args) => logged.push(args);
        try {
          if (mode === 'warn') {
            await assert.rejects(
              () => loggingBuyer.refineProposals({ refinements: [refinement] }),
              /refine_proposals response failed verification:.*request ceiling/
            );
          } else {
            const invalid = await loggingBuyer.refineProposals({ refinements: [refinement] });
            assert.equal(invalid.success, false);
            assert.match(invalid.error, /^Schema validation failed: adcp_version: response must echo/);
            assert.doesNotMatch(invalid.error, /Validation error:|response failed verification/);
          }
        } finally {
          console.error = originalError;
          console.warn = originalWarn;
        }
        assert.equal(logged.length, logSchemaViolations ? 1 : 0, 'honor the schema violation logging flag');
        if (logSchemaViolations) assert.match(logged[0][0], /^Schema validation failed for refine_proposals/);
      }
      invalidEcho = '3.3';
      capabilityVersion = '3.3';
      await withIdentity33SchemaScope(async () => {
        // The identity-only client scope may construct this pin without a
        // real stable-3.3 bundle, but public proposal verification must refuse it.
        const identityBuyer = AgentClient.fromMCPClient(mcp, { adcpVersion: '3.3', experimentalIdentity33: true });
        await assert.rejects(
          () => identityBuyer.refineProposals({ refinements: [refinement] }),
          /AdCP 3\.3 resolved to "3\.3\.0-beta\.2/
        );
      });
    } finally {
      await mcp.close();
      await seller.close();
    }
  }));

test('a lower actual served contract selects its bundle, including when task echo is absent', () =>
  withCandidateSchema(() => {
    const stable = { ...response(proposal({ name: 'stable-only-proposal' })), adcp_version: '3.2' };
    assert.equal(verify(request(), stable).ok, true);
    const withoutEcho = { ...stable };
    delete withoutEcho.adcp_version;
    assert.equal(verify(request(), withoutEcho, { servedAdcpVersion: '3.2' }).ok, true);
    assert.equal(
      verify(request(), stable, { servedAdcpVersion: VERSION }).ok,
      false,
      'same-response metadata cannot contradict the response echo'
    );
    const newerRequest = buildRefineProposalsRequest({ adcp_version: '3.3-rc.1', refinements: [refinement] });
    assert.equal(
      verify(newerRequest, response(), { adcpVersion: '3.3.0-rc.1' }).ok,
      true,
      'a lower genuine prerelease uses its actual registered beta bundle, not an unavailable rc bundle'
    );
  }));

test('same-minor wire-only overrides preserve the configured schema without relabelled fixture bundles', () => {
  const req = buildRefineProposalsRequest({ adcp_version: '3.2-beta.1', refinements: [refinement] });
  assert.equal(
    verifyRefineProposalsResponse(
      req,
      {
        ...response(proposal({ name: 'stable-proposal' })),
        adcp_version: '3.2-beta.1',
      },
      { adcpVersion: '3.2.7' }
    ).ok,
    true
  );
});

test('official MCP mixed-version buyer and coordinator accept a lower 3.2 seller with and without task echoes', () =>
  withCandidateSchema(async () => {
    const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
    const { AgentClient } = require('../../dist/lib/index.js');
    const z = require('zod');
    let omitEcho = false;
    let omitDiscoveryEcho = false;
    const captured = [];
    const seller = new McpServer({ name: 'Stable seller', version: '1.0.0' });
    seller.registerTool('get_adcp_capabilities', { inputSchema: {} }, async () => {
      const data = {
        status: 'completed',
        adcp_version: '3.2',
        adcp: {
          major_versions: [3],
          supported_versions: [VERSION, '3.2'],
          idempotency: { supported: true, replay_ttl_seconds: 86400 },
        },
        supported_protocols: ['media_buy'],
        specialisms: [],
        media_buy: { lifecycle_tools: ['list_products', 'refine_proposals'] },
      };
      if (omitDiscoveryEcho) delete data.adcp_version;
      return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
    });
    seller.registerTool('list_products', { inputSchema: {} }, async () => ({
      content: [{ type: 'text', text: '{}' }],
      structuredContent: { outcome: 'listed', products: [], feed_version: 'feed-1', pricing_version: 'pricing-1' },
    }));
    seller.registerTool(
      'refine_proposals',
      {
        inputSchema: {
          adcp_version: z.string(),
          adcp_major_version: z.number(),
          idempotency_key: z.string(),
          refinements: z.array(z.any()),
        },
      },
      async args => {
        captured.push(args);
        const data = { ...response(proposal({ name: 'stable-only-proposal' })), adcp_version: '3.2' };
        data.results[0].source_proposal_id = args.refinements[0].proposal_id;
        data.results[0].proposals[0].parent_proposal_id = args.refinements[0].proposal_id;
        data.results[0].proposals[0].proposal_id = `stable-successor-${captured.length}`;
        if (omitEcho) delete data.adcp_version;
        return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
      }
    );
    const [buyerTransport, sellerTransport] = InMemoryTransport.createLinkedPair();
    await seller.connect(sellerTransport);
    const mcp = new Client({ name: 'New buyer', version: '1.0.0' });
    try {
      await mcp.connect(buyerTransport);
      const buyer = AgentClient.fromMCPClient(mcp, {
        adcpVersion: BUNDLE_VERSION,
        validation: { responses: 'strict' },
      });
      const coordinator = await buyer.negotiateMediaBuyLifecycle();
      assert.equal(coordinator.negotiated_version, '3.2');
      for (omitEcho of [false, true]) {
        const direct = await buyer.refineProposals({
          refinements: [{ ...refinement, proposal_id: `direct-source-${omitEcho}` }],
        });
        assert.equal(direct.success, true);
        const coordinated = await coordinator.refineProposals({
          refinements: [{ ...refinement, proposal_id: `coordinator-source-${omitEcho}` }],
        });
        assert.equal(coordinated.data.results[0].outcome, 'revised');
        assert.equal(coordinated.data.results[0].proposals[0].name, 'stable-only-proposal');
      }
      omitEcho = false;
      omitDiscoveryEcho = true;
      const noDiscoveryEchoBuyer = AgentClient.fromMCPClient(mcp, {
        adcpVersion: BUNDLE_VERSION,
        validation: { responses: 'strict' },
      });
      const noDiscoveryEchoCoordinator = await noDiscoveryEchoBuyer.negotiateMediaBuyLifecycle();
      assert.equal(noDiscoveryEchoCoordinator.negotiated_version, VERSION, 'advertised inventory selects tools');
      for (const [client, prefix] of [
        [noDiscoveryEchoBuyer, 'direct'],
        [noDiscoveryEchoCoordinator, 'coordinated'],
      ]) {
        const lower = await client.refineProposals({
          refinements: [{ ...refinement, proposal_id: `no-discovery-echo-${prefix}` }],
        });
        assert.equal(lower.success, true, lower.error);
        assert.equal(lower.metadata.adcpVersion, '3.2');
        assert.equal(lower.data.results[0].proposals[0].name, 'stable-only-proposal');
      }
      assert(
        captured.every(args => args.adcp_version === VERSION),
        'the real buyer ceiling remains 3.3; it is not rewritten to 3.2'
      );
    } finally {
      await mcp.close();
      await seller.close();
    }
  }));

test('identity-only 3.3 aliases cannot replace a genuine proposal schema bundle', async () => {
  const req = buildRefineProposalsRequest({ adcp_version: '3.3', refinements: [refinement] });
  const payload = { ...response(), adcp_version: '3.3' };
  const aliased = withIdentity33SchemaScope(() => verifyRefineProposalsResponse(req, payload, { adcpVersion: '3.3' }));
  assert.equal(aliased.ok, false);
  assert.match(aliased.issues[0].message, /AdCP 3\.3 resolved to "3\.3\.0-beta\.2/);
  assert.match(aliased.issues[0].message, /actual matching schema bundle/);
  await withCandidateSchema(() =>
    withIdentity33SchemaScope(() => {
      assert.equal(verify(request(), response()).ok, true, 'a real matching external preview bundle remains valid');
    })
  );
});

test('strict refinement validation retains explicit served evidence across a fresh durable resume without an echo', () =>
  withCandidateSchema(async () => {
    const { TaskExecutor, MemoryStorage, ProtocolClient } = require('../../dist/lib/index.js');
    const originalCallTool = ProtocolClient.callTool;
    const storage = new MemoryStorage({ autoCleanup: false });
    const token = require('node:crypto')
      .createHash('sha256')
      .update('refinement-served-version-resume')
      .digest('base64url');
    const agent = {
      id: 'resume-seller',
      name: 'Resume seller',
      agent_uri: 'https://seller.example/a2a',
      protocol: 'a2a',
    };
    const now = Date.now();
    await storage.putIfAbsent(
      token,
      {
        continuationVersion: 'refinement-version-checkpoint',
        taskId: 'refinement-local-operation',
        a2aTaskId: 'refinement-seller-task',
        serverVersion: 'v3',
        serverVersionSynthetic: false,
        refinementServedVersion: '3.2',
        agentId: agent.id,
        taskName: 'refine_proposals',
        params: request(),
        messages: [],
        createdAt: now,
        expiresAt: now + 60_000,
      },
      60
    );
    ProtocolClient.callTool = async () => {
      const data = { ...response(proposal({ name: 'stable-only-proposal' })), status: 'completed' };
      delete data.adcp_version;
      return data;
    };
    const executor = new TaskExecutor({
      adcpVersion: BUNDLE_VERSION,
      deferredStorage: storage,
      resolveDeferredAgent: async () => agent,
      validation: { requests: 'off', responses: 'strict' },
    });
    try {
      const resumed = await executor.resumeDeferredTask(token, { approved: true });
      assert.equal(resumed.success, true, resumed.error);
      assert.equal(resumed.data.results[0].proposals[0].name, 'stable-only-proposal');
    } finally {
      ProtocolClient.callTool = originalCallTool;
      storage.destroy();
    }
  }));
