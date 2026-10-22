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
const { withExternalSchemaRoot } = require('../../dist/lib/validation/schema-loader.js');
const { ADCP_VERSION } = require('../../dist/lib/version.js');

const VERSION = '3.3-beta.0';
const BUNDLE_VERSION = '3.3.0-beta.0';
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
  for (const adcp_version of ['3.2', '3.2-beta.1', '3.3-beta.0', '3.3-rc.2', '3.3', '3.10']) {
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
  ]) {
    assert.throws(() => buildRefineProposalsRequest({ adcp_version, refinements: [refinement] }), /AdCP 3.2 or newer/);
  }
});

test('negotiated 3.3 validates canonical proposals and nested change terms against its external bundle', () =>
  withCandidateSchema(() => {
    assert.equal(verifyRefineProposalsResponse(request(), response()).ok, true);
    assert.equal(validateRefineProposalsResponseShape(response(), { adcpVersion: BUNDLE_VERSION }).ok, true);
    const wrongProposal = response(proposal({ name: 'valid-only-under-default' }));
    assert.equal(verifyRefineProposalsResponse(request(), wrongProposal).ok, false);
    const wrongTerm = response();
    wrongTerm.results[0].proposals[0].commercial_terms.change_terms[0].term_id = 'valid-only-under-default';
    wrongTerm.results[0].proposals[0].terms_digest = proposalTermsDigest(
      wrongTerm.results[0].proposals[0].commercial_terms
    );
    assert.equal(verifyRefineProposalsResponse(request(), wrongTerm).ok, false);
    assert.equal(
      validateRefineProposalsResponseShape({ ...wrongTerm, adcp_version: '3.2' }).ok,
      true,
      'negative control: the same terms satisfy the SDK default schema'
    );
  }));

test('negotiation rejects a different echoed release and conflicting schema selection', () =>
  withCandidateSchema(() => {
    for (const adcp_version of ['3.2', '3.3-rc.1']) {
      const result = verifyRefineProposalsResponse(request(), { ...response(), adcp_version });
      assert.equal(result.ok, false);
      assert.equal(result.issues[0].path, 'adcp_version');
    }
    assert.equal(verifyRefineProposalsResponse(request(), response(), { adcpVersion: '3.2' }).ok, false);
    assert.equal(
      validateRefineProposalsResponseShape(response()).ok,
      false,
      'an unbound caller must not validate a newer envelope using the SDK default bundle'
    );
  }));

test('an unavailable selected schema fails closed even for an unable result without proposals', () => {
  const req = buildRefineProposalsRequest({ adcp_version: '3.99', refinements: [refinement] });
  const result = verifyRefineProposalsResponse(req, {
    adcp_version: '3.99',
    products: [],
    results: [
      {
        source_proposal_id: 'source-1',
        outcome: 'unable',
        reason_code: 'commercially_declined',
        reason: 'Unavailable',
      },
    ],
  });
  assert.equal(result.ok, false);
  assert.match(result.issues[0].message, /schema is unavailable/);
});

test('3.3 still rejects digest tampering, wrong lineage, expired holds and non-atomic finalize results', () =>
  withCandidateSchema(() => {
    const tampered = response(proposal({ terms_digest: `sha256:${'a'.repeat(43)}` }));
    const badLineage = response(proposal({ parent_proposal_id: 'different-source' }));
    for (const payload of [tampered, badLineage])
      assert.equal(verifyRefineProposalsResponse(request(), payload).ok, false);
    const finalRequest = request([
      { proposal_id: 'source-1', action: 'finalize' },
      { proposal_id: 'source-2', action: 'finalize' },
    ]);
    const expired = proposal({ proposal_status: 'committed', expires_at: '2000-01-01T00:00:00Z' });
    const result = verifyRefineProposalsResponse(finalRequest, {
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
    let invalidEcho = false;
    const seller = new McpServer({ name: 'Candidate seller', version: '1.0.0' });
    seller.registerTool('get_adcp_capabilities', { inputSchema: {} }, async () => ({
      content: [{ type: 'text', text: '{}' }],
      structuredContent: {
        adcp_version: VERSION,
        adcp: {
          major_versions: [3],
          supported_versions: [VERSION],
          idempotency: { supported: true, replay_ttl_seconds: 86400 },
        },
        supported_protocols: ['media_buy'],
        specialisms: [],
      },
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
        if (invalidEcho) data.adcp_version = '3.2';
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
      }
      assert(captured.every(args => args.adcp_version === VERSION && args.adcp_major_version === 3));
      invalidEcho = true;
      await assert.rejects(() => buyer.refineProposals({ refinements: [refinement] }), /adcp_version must match/);
    } finally {
      await mcp.close();
      await seller.close();
    }
  }));
