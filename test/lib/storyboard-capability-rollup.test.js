process.env.NODE_ENV = 'test';

// A scenario the agent's own declaration puts outside its surface must not cap
// the agent's bundle (adcp-client#2945).
//
// Scope is AdCP 3.2 (the pinned compliance bundle), and the version boundary
// is load-bearing, so it is pinned below rather than described.
//
// AdCP 3.2 `media_buy_seller/governance_approved` and `.../governance_conditions`
// declare `requires_capability` on `adcp.governance_enforcement.tasks`, plus
// `requires: [multi_agent]` and `agent:` route pins. `storyboard-schema.yaml`
// > "Applicability order" makes the consequence normative:
//
//   > storyboard-level `requires_capability` and `requires_all_capabilities`
//   > predicates MUST be evaluated before the runner evaluates `requires`.
//   > When any capability predicate is not satisfied, the runner emits
//   > `not_applicable` and MUST NOT report a missing runtime requirement. Only
//   > an agent that selected the storyboard by satisfying every authored
//   > capability predicate can receive `requirement_unmet`. This keeps optional
//   > capability storyboards out of the coverage totals of agents that never
//   > claimed the capability.
//
// The runner already emitted `capability_unsupported` for the non-claimant;
// `buildComplianceBundleResults` was still counting it as missing coverage, so
// `passing` was unreachable for a seller with nothing wrong. That rollup is
// what this change fixes, and only that:
//
//   (A) a seller that does NOT claim governance-aware capability has the
//       scenario graded not-applicable and reaches `passing` on its own
//       surface;
//   (B) a seller that DOES claim it clears the capability gate, proceeds to
//       `requires: [multi_agent]`, and stays capped with no second tenant. A
//       claimant is never credited for a capability it never exercised.
//
// AdCP 3.1.x is deliberately untouched: that bundle's copy of the scenario
// declares no machine-readable capability predicate, so nothing distinguishes
// a pure seller from a claimant without inferring intent from prose. Its
// grades are pinned here as unchanged, and the declaration backport is an
// upstream ask.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

const {
  buildRoutingContextFromProfiles,
  resolveAgentForStep,
  RoutingError,
} = require('../../dist/lib/testing/storyboard/agent-routing.js');
const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner.js');
const { loadStoryboardFile } = require('../../dist/lib/testing/storyboard/loader.js');
const { buildComplianceBundleResults } = require('../../dist/lib/testing/compliance/comply.js');
const { resolveStoryboardsForCapabilities } = require('../../dist/lib/testing/storyboard/compliance.js');
const { closeConnections } = require('../../dist/lib/protocols/index.js');
const { ADCP_VERSION } = require('../../dist/lib/version.js');

const RUN_OPTIONS = { strictResponseSchemaValidation: false };

function phaseOf(steps, id = 'p1') {
  return { id, title: id, steps };
}

// ────────────────────────────────────────────────────────────
// Live mock agents with schema-valid payloads
// ────────────────────────────────────────────────────────────

const SELLER_TOOLS = [
  'get_products',
  'create_media_buy',
  'get_media_buys',
  'sync_accounts',
  'sync_governance',
  'list_accounts',
  'list_creative_formats',
  'get_media_buy_delivery',
  'update_media_buy',
];

// The capability block a governance-aware seller declares. A genuine pure
// seller omits it entirely, which is what makes case (A) real rather than
// staged.
const GOVERNANCE_AWARE = {
  governance_enforcement: {
    tasks: [
      { task: 'create_media_buy', modes: ['signed_context'] },
      { task: 'create_media_buy', modes: ['signed_context', 'online_execution_check'] },
    ],
  },
};

function product(id, channel, formatId, price) {
  return {
    product_id: id,
    name: `Product ${id}`,
    description: `Test product ${id}`,
    publisher_properties: [
      { publisher_domain: 'acmeoutdoor.example', selection_type: 'by_id', property_ids: ['prop_1'] },
    ],
    channels: [channel],
    format_ids: [{ agent_url: 'https://creative.adcontextprotocol.org', id: formatId }],
    delivery_type: 'guaranteed',
    pricing_options: [{ pricing_option_id: 'cpm_standard', pricing_model: 'cpm', currency: 'USD', fixed_price: price }],
    reporting_capabilities: {
      available_reporting_frequencies: ['daily'],
      expected_delay_minutes: 240,
      timezone: 'UTC',
      supports_webhooks: false,
      available_metrics: ['impressions', 'spend'],
      date_range_support: 'date_range',
    },
  };
}

const RESPONSES = {
  get_products: {
    products: [
      product('outdoor_display_q2', 'display', 'display_300x250', 8),
      product('outdoor_video_q2', 'video', 'video_15s', 12),
    ],
    cache_scope: 'public',
  },
  create_media_buy: {
    media_buy_id: 'mb-1',
    buyer_ref: 'br-1',
    media_buy_status: 'pending_creatives',
    confirmed_at: '2026-01-01T00:00:00Z',
    revision: 1,
    packages: [{ package_id: 'pkg-1' }],
  },
  get_media_buys: { media_buys: [{ media_buy_id: 'mb-1', media_buy_status: 'pending_creatives' }] },
  sync_accounts: {
    accounts: [
      {
        account_id: 'acct-1',
        brand: { domain: 'acmeoutdoor.example' },
        operator: 'acmeoutdoor.example',
        action: 'created',
        status: 'active',
      },
    ],
  },
  get_signals: { signals: [] },
  sync_governance: {
    accounts: [
      { account: { account_id: 'acct-1' }, status: 'synced', governance_agents: [{ url: 'https://gov.example/mcp' }] },
    ],
  },
};

async function startAgent({ tools = SELLER_TOOLS, protocols = ['media_buy'], adcpExtra = {}, capabilities } = {}) {
  const calls = [];
  const servers = [];
  const server = http.createServer(async (req, res) => {
    if (req.url.includes('/.well-known/')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    const mcp = new McpServer({ name: 'capability-rollup-test', version: '1.0.0' });
    for (const name of new Set(['get_adcp_capabilities', ...tools])) {
      mcp.registerTool(name, {}, async () => {
        calls.push(name);
        const data =
          name === 'get_adcp_capabilities'
            ? (capabilities ?? {
                supported_protocols: protocols,
                adcp: { major_versions: [3], supported_versions: ['3.1', '3.2'], ...adcpExtra },
              })
            : (RESPONSES[name] ?? {});
        return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
      });
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    servers.push(mcp);
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });
  // A storyboard run pauses between steps while ajv compiles the next task's
  // schemas — measured at 5.5s between `get_products` and `create_media_buy`
  // here. Node's default 5s `keepAliveTimeout` closes the pooled socket inside
  // that gap, and the next dispatch lands on a half-closed connection and
  // surfaces as a bare undici `fetch failed`, which graded the third step as a
  // genuine failure. Hold connections open for the length of a run (the same
  // `keepAliveTimeout` idiom media-buy-lifecycle-release-gate.test.js uses) and
  // keep `headersTimeout` above it so an idle socket is never reaped mid-run.
  // `close()` below force-closes, so nothing leaks.
  server.keepAliveTimeout = 60_000;
  server.headersTimeout = 65_000;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    calls,
    close: async () => {
      await Promise.all(servers.map(s => s.close()));
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

/**
 * One HTTP endpoint fronting several tenants, told apart ONLY by the bearer
 * the caller presents — the shared-control-plane topology that makes a
 * storyboard's `agents` map hold two keys with the same `url` and different
 * `auth`. Nothing but the token distinguishes the routes, which is exactly
 * why a URL is not a route identity.
 *
 * `tenants` maps bearer token → `{ tools, capabilities }`. An unrecognised
 * token is a 401, so a test cannot pass by accidentally hitting the wrong
 * tenant's view.
 */
async function startSharedUrlAgent(tenants) {
  const calls = [];
  const servers = [];
  const server = http.createServer(async (req, res) => {
    if (req.url.includes('/.well-known/')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    const tenant = token ? tenants[token] : undefined;
    if (!tenant) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `unknown tenant token ${JSON.stringify(token ?? null)}` }));
      return;
    }
    const mcp = new McpServer({ name: 'shared-url-test', version: '1.0.0' });
    for (const name of new Set(['get_adcp_capabilities', ...tenant.tools])) {
      mcp.registerTool(name, {}, async () => {
        calls.push({ tenant: token, task: name });
        const data = name === 'get_adcp_capabilities' ? tenant.capabilities : (RESPONSES[name] ?? {});
        return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
      });
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    servers.push(mcp);
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });
  // Same keep-alive rationale as `startAgent`.
  server.keepAliveTimeout = 60_000;
  server.headersTimeout = 65_000;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    calls,
    close: async () => {
      await Promise.all(servers.map(s => s.close()));
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

function rows(result) {
  return result.phases
    .flatMap(phase => phase.steps)
    .map(step => [step.step_id, step.skip_reason ?? (step.passed ? 'PASS' : 'FAIL')]);
}

function bundleOf(storyboards, id = 'media-buy') {
  return {
    ref: { kind: 'protocol', id, path: '/unused' },
    storyboards: storyboards.map(sb => (typeof sb === 'string' ? { id: sb, phases: [{ id: 'p' }] } : sb)),
  };
}

function rollupOf(storyboards, results, id = 'media-buy') {
  return buildComplianceBundleResults([bundleOf(storyboards, id)], results)[0].status;
}

function passingStub(storyboardId) {
  return {
    storyboard_id: storyboardId,
    overall_passed: true,
    passed_count: 1,
    failed_count: 0,
    skipped_count: 0,
    phases: [],
  };
}

// Seller scenario the mock genuinely satisfies, including a real observation
// for the default `status.monotonic` invariant so its pass is not vacuous.
const SELLER_SCENARIO = {
  id: 'media_buy_seller/discovery_and_buy',
  title: 'Seller discovers, buys, and confirms',
  track: 'media_buy',
  required_tools: ['get_products', 'create_media_buy'],
  phases: [
    phaseOf([
      { id: 'discover', title: 'Discover products', task: 'get_products', sample_request: {} },
      { id: 'buy', title: 'Create the buy', task: 'create_media_buy', sample_request: {} },
      { id: 'confirm', title: 'Read the buy back', task: 'get_media_buys', sample_request: {} },
    ]),
  ],
};

const SCENARIO_DIR = path.join(
  __dirname,
  '..',
  '..',
  'compliance',
  'cache',
  ADCP_VERSION,
  'domains',
  'media-buy',
  'scenarios'
);
const GOVERNANCE_SCENARIOS = ['governance_approved.yaml', 'governance_conditions.yaml'];
// The compliance cache is gitignored and populated by `npm run sync-schemas`.
const scenariosAvailable = GOVERNANCE_SCENARIOS.every(file => fs.existsSync(path.join(SCENARIO_DIR, file)));

// Pulled through the real selection path, not `loadStoryboardFile`: the
// version the rollup gate reads is stamped by `annotateStoryboardVersion`
// inside `loadBundleStoryboards`, never by the scenario YAML itself. Loading
// the file directly would leave `adcp_version` undefined and the gate would
// fail closed — which is correct behaviour, and exactly why the regression
// has to exercise the same loader the runner uses.
function loadGovernanceScenarios() {
  const resolved = resolveStoryboardsForCapabilities(
    {
      supported_protocols: ['media_buy'],
      specialisms: ['sales-guaranteed'],
      supported_versions: ['3.1', '3.2', ADCP_VERSION],
      major_versions: [3],
    },
    { complianceVersion: ADCP_VERSION, complianceDir: path.join('compliance', 'cache', ADCP_VERSION) }
  );
  const ids = GOVERNANCE_SCENARIOS.map(file => `media_buy_seller/${file.replace(/\.yaml$/, '')}`);
  const storyboards = ids.map(id => {
    const found = resolved.storyboards.find(sb => sb.id === id);
    assert.ok(found, `${id} must be selected for a pure seller`);
    return found;
  });
  for (const storyboard of storyboards) {
    // Premise guards: the rules below apply only to this declared shape. If
    // upstream changes it, this regression should fail loudly here.
    assert.ok(storyboard.requires_capability !== undefined, `${storyboard.id} gates on a declared capability`);
    assert.deepEqual(storyboard.requires, ['multi_agent'], `${storyboard.id} declares multi_agent`);
    assert.equal(storyboard.adcp_version, ADCP_VERSION, `${storyboard.id} carries the loader-stamped version`);
  }
  return storyboards;
}

// ────────────────────────────────────────────────────────────
// 1. The release criterion, executed
// ────────────────────────────────────────────────────────────

describe(
  'AdCP 3.2 governance scenarios aggregate on the agent’s own declaration',
  {
    skip: !scenariosAvailable,
  },
  () => {
    test('(A) a genuine pure seller reaches passing — the unclaimed capability is not applicable', async () => {
      const governance = loadGovernanceScenarios();
      // No `governance_enforcement` block at all.
      const seller = await startAgent();
      try {
        const results = [];
        for (const storyboard of governance) {
          const result = await runStoryboard(seller.url, storyboard, { ...RUN_OPTIONS, adcpVersion: ADCP_VERSION });
          results.push(result);
          assert.deepEqual(rows(result), [['capability_unsupported', 'capability_unsupported']], storyboard.id);
          assert.equal(result.failed_count, 0, storyboard.id);
        }

        // Executed seller evidence — real MCP discovery and dispatch, with an
        // observed invariant so the pass is not vacuous.
        const sellerResult = await runStoryboard(seller.url, SELLER_SCENARIO, {
          ...RUN_OPTIONS,
          adcpVersion: ADCP_VERSION,
        });
        assert.equal(sellerResult.passed_count, 3);
        assert.equal(sellerResult.failed_count, 0);
        const observed = (sellerResult.assertions ?? []).filter(a => typeof a.observation_count === 'number');
        assert.ok(
          observed.some(a => a.observation_count > 0),
          'executed evidence must include an observed invariant'
        );

        assert.equal(rollupOf([...governance, SELLER_SCENARIO], [...results, sellerResult]), 'passing');
        // On their own they are evidence of nothing — no vacuous pass.
        assert.equal(rollupOf(governance, results, 'governance-only'), 'not_applicable');
      } finally {
        await closeConnections();
        await seller.close();
      }
    });

    test('(B) a governance-aware claimant without a second tenant stays capped and is never credited', async () => {
      const governance = loadGovernanceScenarios();
      const claimant = await startAgent({ adcpExtra: GOVERNANCE_AWARE });
      try {
        const results = [];
        for (const storyboard of governance) {
          const result = await runStoryboard(claimant.url, storyboard, { ...RUN_OPTIONS, adcpVersion: ADCP_VERSION });
          results.push(result);
          // The claim clears the capability gate, so the scenario proceeds to
          // the topology gate rather than being excused.
          assert.deepEqual(rows(result), [['requirement_unmet:multi_agent', 'requirement_unmet']], storyboard.id);
          assert.equal(result.phases[0].steps[0].skip.requirement, 'multi_agent', storyboard.id);
        }

        const sellerResult = await runStoryboard(claimant.url, SELLER_SCENARIO, {
          ...RUN_OPTIONS,
          adcpVersion: ADCP_VERSION,
        });
        assert.equal(sellerResult.failed_count, 0);

        assert.equal(rollupOf([...governance, SELLER_SCENARIO], [...results, sellerResult]), 'partial');
        assert.ok(!claimant.calls.includes('check_governance'), 'no governance evidence was collected');
        assert.ok(!claimant.calls.includes('sync_plans'));
      } finally {
        await closeConnections();
        await claimant.close();
      }
    });
  }
);

// ────────────────────────────────────────────────────────────
// 2. Version scoping, pinned
// ────────────────────────────────────────────────────────────

const LEGACY_CACHE = path.join(__dirname, '..', '..', 'compliance', 'cache', '3.1.18');
const LEGACY_STORYBOARD = path.join(
  __dirname,
  '..',
  'fixtures',
  'routed-applicability',
  'storyboards',
  'dbccbd1e7053-governance_approved.yaml'
);
const legacyAvailable = fs.existsSync(LEGACY_CACHE) && fs.existsSync(LEGACY_STORYBOARD);

// The headline release criterion and the census that backs the changeset's
// scope claim both read the gitignored compliance cache. Locally a missing
// cache is a legitimate skip — `npm run schemas:ensure` populates it on
// demand and a fresh clone should not hard-fail. In CI the cache is always
// synced (`sync-schemas:all`, restored into every test job), so a skip there
// would retire those suites silently and nobody would notice. Assert it.
describe('cache-backed suites actually run', () => {
  test('CI does not silently skip the cache-dependent regressions', () => {
    if (!process.env.CI) return;
    assert.ok(
      scenariosAvailable,
      `compliance/cache/${ADCP_VERSION} governance scenarios are missing in CI; the headline ` +
        `release-criterion suite would have skipped silently. Run \`npm run sync-schemas:all\`.`
    );
    assert.ok(
      legacyAvailable,
      'compliance/cache/3.1.18 (or the legacy fixture) is missing in CI; the version-scoping ' +
        'suite would have skipped silently. Run `npm run sync-schemas:all`.'
    );
  });
});

describe('version scoping', { skip: !legacyAvailable }, () => {
  test('selection is not the lever: a pure seller is selected into the scenario in both bundles', () => {
    const caps = {
      supported_protocols: ['media_buy'],
      specialisms: ['sales-guaranteed'],
      supported_versions: ['3.1', '3.2', '3.2.0-rc.4'],
      major_versions: [3],
    };
    for (const version of ['3.1.18', ADCP_VERSION]) {
      const resolved = resolveStoryboardsForCapabilities(caps, {
        complianceVersion: version,
        complianceDir: path.join('compliance', 'cache', version),
      });
      const ids = resolved.storyboards.map(s => s.id);
      // Documented, not endorsed: the media_buy baseline sweeps the scenario
      // in for an agent that never claimed governance, which is why the
      // capability predicate (3.2) is what has to carry the distinction.
      assert.ok(ids.includes('media_buy_seller/governance_approved'), `${version} selects the scenario`);
    }
  });

  test('no AdCP 3.1.18 capability-gated scenario is neutralized', () => {
    // Enumerated rather than three fixed ids, so the guard cannot rot if
    // upstream renames one. 33 of these flipped partial -> passing before the
    // version gate landed.
    const caps = {
      supported_protocols: ['media_buy'],
      specialisms: ['sales-guaranteed'],
      supported_versions: ['3.1', '3.2', ADCP_VERSION],
      major_versions: [3],
    };
    const resolved = resolveStoryboardsForCapabilities(caps, {
      complianceVersion: '3.1.18',
      complianceDir: path.join('compliance', 'cache', '3.1.18'),
    });
    const gated = resolved.storyboards.filter(sb => {
      const predicates = [
        ...(sb.requires_capability ? [sb.requires_capability] : []),
        ...(sb.requires_all_capabilities ?? []),
      ];
      return (
        predicates.length > 0 && !predicates.some(predicate => String(predicate.path).startsWith('compliance_testing'))
      );
    });
    assert.ok(gated.length > 0, 'the 3.1.18 bundle must still contain capability-gated scenarios');
    for (const storyboard of gated) {
      assert.equal(storyboard.adcp_version, '3.1.18', `${storyboard.id} carries the loader-stamped version`);
      assert.equal(
        rollupOf([storyboard, 'seller'], [capabilityUnsupportedResult(storyboard.id), passingStub('seller')]),
        'partial',
        storyboard.id
      );
    }
  });

  test('AdCP 3.1.x is untouched: the legacy scenario declares no capability predicate and still grades missing_tool', async () => {
    const storyboard = loadStoryboardFile(LEGACY_STORYBOARD);
    // The declaration gap that makes 3.1.x unfixable in the SDK without
    // inferring intent: no capability predicate, no `requires`, no `agent:`.
    assert.equal(storyboard.requires_capability, undefined);
    assert.equal(storyboard.requires, undefined);
    assert.ok(!(storyboard.required_tools ?? []).includes('sync_plans'));

    const seller = await startAgent();
    try {
      const result = await runStoryboard(seller.url, storyboard, {
        ...RUN_OPTIONS,
        skip_controller_seeding: true,
        adcpVersion: '3.1.18',
      });
      // Unchanged from before this PR: the governance row is an actionable
      // `missing_tool` skip and the seller's own steps all execute and pass.
      // Closing this needs the 3.2 declarations backported upstream.
      assert.deepEqual(rows(result), [
        ['sync_plans', 'missing_tool'],
        ['sync_accounts', 'PASS'],
        ['sync_governance', 'PASS'],
        ['get_products_brief', 'PASS'],
        ['create_media_buy', 'PASS'],
      ]);
      assert.equal(result.failed_count, 0);
      assert.equal(result.passed_count, 4);
    } finally {
      await closeConnections();
      await seller.close();
    }
  });
});

// ────────────────────────────────────────────────────────────
// 3. Rollup discrimination and fail-closed controls
// ────────────────────────────────────────────────────────────

// Mirrors `buildCapabilityUnsupportedResult` exactly. The rollup guard is a
// public boundary, so the fixture has to be the real emission rather than a
// loose approximation of it.
function capabilityUnsupportedResult(storyboardId) {
  return {
    storyboard_id: storyboardId,
    storyboard_title: 'Gated storyboard',
    agent_url: 'http://127.0.0.1:1/mcp',
    context: {},
    total_duration_ms: 0,
    runner_capability_version: 'test',
    tested_at: '2026-01-01T00:00:00.000Z',
    strict_validation_summary: {
      observable: false,
      checked: 0,
      passed: 0,
      failed: 0,
      strict_only_failures: 0,
      lenient_also_failed: 0,
    },
    notices: [],
    overall_passed: true,
    passed_count: 0,
    failed_count: 0,
    skipped_count: 1,
    phases: [
      {
        phase_id: 'capability_unsupported',
        phase_title: 'Capability unsupported',
        passed: true,
        steps: [
          {
            storyboard_id: storyboardId,
            step_id: 'capability_unsupported',
            phase_id: 'capability_unsupported',
            title: 'Storyboard skipped: capability not supported by this agent',
            task: '',
            passed: true,
            skipped: true,
            skip_reason: 'capability_unsupported',
            skip: { reason: 'not_applicable', detail: 'detail' },
            duration_ms: 0,
            validations: [],
            context: {},
            error: 'detail',
            extraction: { path: 'none' },
          },
        ],
        duration_ms: 0,
      },
    ],
  };
}

function requirementUnmetResult(storyboardId, requirement, reason = 'requirement_unmet') {
  return {
    storyboard_id: storyboardId,
    overall_passed: true,
    passed_count: 0,
    failed_count: 0,
    skipped_count: 1,
    phases: [
      {
        phase_id: 'requirement_unmet',
        steps: [
          {
            step_id: `requirement_unmet:${requirement ?? 'family'}`,
            skipped: true,
            passed: true,
            skip_reason: reason,
            skip: { reason, detail: 'detail', ...(requirement !== undefined && { requirement }) },
          },
        ],
      },
    ],
  };
}

// A storyboard that declares a capability predicate, which the rule requires.
const GATED_STORYBOARD = {
  id: 'gated',
  adcp_version: ADCP_VERSION,
  requires_capability: { path: 'a.b', equals: true },
  phases: [{ id: 'p' }],
};

describe('rollup discrimination', () => {
  test('a declared capability gap is neutral; every unmet requirement still caps', () => {
    assert.equal(
      rollupOf([GATED_STORYBOARD, 'seller'], [capabilityUnsupportedResult('gated'), passingStub('seller')]),
      'passing'
    );
    for (const requirement of [
      'multi_agent',
      'webhook_receiver',
      'seeded_state',
      'real_wire',
      'trusted_match_publisher_auth_runner',
      'controller',
      'some_future_gate',
    ]) {
      assert.equal(
        rollupOf([GATED_STORYBOARD, 'seller'], [requirementUnmetResult('gated', requirement), passingStub('seller')]),
        'partial',
        requirement
      );
    }
  });

  test('the rule is anchored to a declared predicate and to the root gate’s own row', () => {
    // No declared predicate → not neutralized, even carrying the reason.
    assert.equal(
      rollupOf(
        [{ id: 'gated', adcp_version: ADCP_VERSION, phases: [{ id: 'p' }] }, 'seller'],
        [capabilityUnsupportedResult('gated'), passingStub('seller')]
      ),
      'partial',
      'undeclared predicate'
    );
    // Declared predicate but a different row id → a phase/step-scope skip,
    // which is coverage, not applicability.
    const stepScoped = capabilityUnsupportedResult('gated');
    stepScoped.phases[0].steps[0].step_id = 'some_step';
    assert.equal(rollupOf([GATED_STORYBOARD, 'seller'], [stepScoped, passingStub('seller')]), 'partial', 'step scope');
    // `requires_all_capabilities` is an equally valid declaration.
    const allCaps = {
      id: 'gated',
      adcp_version: ADCP_VERSION,
      requires_all_capabilities: [{ path: 'a.b', equals: true }],
      phases: [{ id: 'p' }],
    };
    assert.equal(
      rollupOf([allCaps, 'seller'], [capabilityUnsupportedResult('gated'), passingStub('seller')]),
      'passing'
    );
  });

  test('fail-closed: a `compliance_testing.*` gate is test-harness scope and still caps', () => {
    // Seven cached storyboards gate on `compliance_testing.scenarios`.
    // Neutralizing those would let an agent drop one scenario string from its
    // own controller list and flip the bundle to `passing` at no cost.
    for (const storyboard of [
      {
        id: 'gated',
        adcp_version: ADCP_VERSION,
        requires_capability: { path: 'compliance_testing.scenarios', contains: 'force_create_media_buy_arm' },
        phases: [{ id: 'p' }],
      },
      {
        id: 'gated',
        adcp_version: ADCP_VERSION,
        requires_all_capabilities: [
          { path: 'a.b', equals: true },
          { path: 'compliance_testing.scenarios', contains: 'force_error' },
        ],
        phases: [{ id: 'p' }],
      },
    ]) {
      assert.equal(
        rollupOf([storyboard, 'seller'], [capabilityUnsupportedResult('gated'), passingStub('seller')]),
        'partial',
        JSON.stringify(storyboard.requires_capability ?? storyboard.requires_all_capabilities)
      );
    }
  });

  test('fail-closed: a version-excluded sibling keeps capping the bundle', () => {
    // `options.notApplicable` comes from the agent's declared
    // `major_versions`. That path is untouched by this change.
    assert.equal(
      buildComplianceBundleResults([bundleOf([GATED_STORYBOARD, 'newer'])], [passingStub('gated')], {
        notApplicable: [{ storyboard_id: 'newer' }],
      })[0].status,
      'partial'
    );
  });

  test('fail-closed: the rule is version-scoped to AdCP 3.2+', () => {
    for (const [label, adcp_version, expected] of [
      ['absent', undefined, 'partial'],
      ['3.0.25', '3.0.25', 'partial'],
      ['3.1.18', '3.1.18', 'partial'],
      ['3.2', '3.2', 'passing'],
      [ADCP_VERSION, ADCP_VERSION, 'passing'],
    ]) {
      const storyboard = {
        id: 'gated',
        ...(adcp_version !== undefined && { adcp_version }),
        requires_capability: { path: 'a.b', equals: true },
        phases: [{ id: 'p' }],
      };
      assert.equal(
        rollupOf([storyboard, 'seller'], [capabilityUnsupportedResult('gated'), passingStub('seller')]),
        expected,
        label
      );
    }
  });

  test('fail-closed: a non-string adcp_version never throws out of the exported grader', () => {
    // `buildComplianceBundleResults` is exported, and `adcp_version` is
    // loader-stamped — a hand-built or caller-supplied storyboard can carry
    // anything. `compareAdcpVersionStrings` calls `.startsWith`, so a `null`
    // or numeric version used to take the whole rollup down with a TypeError
    // instead of grading (adcp-client#2945 review).
    for (const [label, adcp_version] of [
      ['null', null],
      ['number', 3.2],
      ['object', { major: 3 }],
      ['array', ['3.2']],
      ['boolean', true],
      ['empty string', ''],
    ]) {
      const storyboard = {
        id: 'gated',
        adcp_version,
        requires_capability: { path: 'a.b', equals: true },
        phases: [{ id: 'p' }],
      };
      const results = [capabilityUnsupportedResult('gated'), passingStub('seller')];
      let status;
      assert.doesNotThrow(() => {
        status = rollupOf([storyboard, 'seller'], results);
      }, label);
      // Unreadable version → the rule cannot apply → the bundle keeps capping.
      assert.equal(status, 'partial', label);
    }
  });

  test('fail-closed: a row naming a runtime requirement is an unmet gate, not an unclaimed capability', () => {
    const tagged = capabilityUnsupportedResult('gated');
    tagged.phases[0].steps[0].skip.requirement = 'request_signer';
    assert.equal(rollupOf([GATED_STORYBOARD, 'seller'], [tagged, passingStub('seller')]), 'partial');
  });

  test('adversarial public grader: any incompleteness indicator refuses neutralization', () => {
    // `buildComplianceBundleResults` is exported, so a caller can hand it a
    // result carrying the exact synthetic row alongside contradictory
    // evidence. Each mutation below must fall through to the ordinary cap
    // checks rather than being neutralized by the early return.
    const mutations = {
      'coverage_gaps present': r => {
        r.coverage_gaps = [{ reason: 'fixture_unsatisfied', detail: 'd' }];
      },
      'validations_not_applicable > 0': r => {
        r.validations_not_applicable = 1;
      },
      'overall_passed false without a failure count': r => {
        r.overall_passed = false;
      },
      'failed_count > 0 while overall_passed stays true': r => {
        r.failed_count = 1;
      },
      'passed_count claims execution': r => {
        r.passed_count = 1;
      },
      'skipped_count disagrees': r => {
        r.skipped_count = 2;
      },
      'assertions attached': r => {
        r.assertions = [{ observation_count: 0, passed: true }];
      },
      'failed assertion attached': r => {
        r.assertions = [{ passed: false }];
      },
      'passes[] present': r => {
        r.passes = [{ phases: r.phases }];
      },
      'extra row in the synthetic phase': r => {
        r.phases[0].steps.push({ step_id: 'other', passed: true });
      },
      'duplicate synthetic row': r => {
        r.phases[0].steps.push({ ...r.phases[0].steps[0] });
      },
      'extra phase': r => {
        r.phases.push({ phase_id: 'p', passed: true, steps: [{ step_id: 's', passed: true }] });
      },
      'wrong phase id': r => {
        r.phases[0].phase_id = 'some_phase';
      },
      'phase not passed': r => {
        r.phases[0].passed = false;
      },
      'wrong step id': r => {
        r.phases[0].steps[0].step_id = 'some_step';
      },
      'row not skipped': r => {
        r.phases[0].steps[0].skipped = false;
      },
      'row not passed': r => {
        r.phases[0].steps[0].passed = false;
      },
      'canonical reason is not not_applicable': r => {
        r.phases[0].steps[0].skip.reason = 'missing_tool';
      },
      'empty detail': r => {
        r.phases[0].steps[0].skip.detail = '';
      },
      'detail missing': r => {
        delete r.phases[0].steps[0].skip.detail;
      },
      'row names a runtime requirement': r => {
        r.phases[0].steps[0].skip.requirement = 'request_signer';
      },
      'row carries validation evidence': r => {
        r.phases[0].steps[0].validations = [{ check: 'response_schema', passed: true }];
      },
      'detailed reason swapped': r => {
        r.phases[0].steps[0].skip_reason = 'not_applicable';
      },
      // Positive-whitelist cases: fields that carry execution evidence, and
      // anything a future release adds, are refused without being enumerated
      // as negative checks.
      'response_record present': r => {
        r.response_record = { requests: [{}] };
      },
      'strict_validation_summary.failed > 0': r => {
        r.strict_validation_summary = {
          observable: false,
          checked: 0,
          passed: 0,
          failed: 1,
          strict_only_failures: 0,
          lenient_also_failed: 0,
        };
      },
      'strict_validation_summary observable': r => {
        r.strict_validation_summary = {
          observable: true,
          checked: 0,
          passed: 0,
          failed: 0,
          strict_only_failures: 0,
          lenient_also_failed: 0,
        };
      },
      'unknown future result field': r => {
        r.some_future_field = 1;
      },
      'unknown future phase field': r => {
        r.phases[0].branch_taken = 'a';
      },
      'unknown future row field': r => {
        r.phases[0].steps[0].response = {};
      },
    };

    // Control: the unmutated shape is the one case that neutralizes.
    assert.equal(
      rollupOf([GATED_STORYBOARD, 'seller'], [capabilityUnsupportedResult('gated'), passingStub('seller')]),
      'passing',
      'control'
    );

    for (const [label, mutate] of Object.entries(mutations)) {
      const result = capabilityUnsupportedResult('gated');
      mutate(result);
      assert.notEqual(rollupOf([GATED_STORYBOARD, 'seller'], [result, passingStub('seller')]), 'passing', label);
    }
  });

  test('a bundle of nothing but inapplicable scenarios is not_applicable, never passing', () => {
    assert.equal(rollupOf([GATED_STORYBOARD], [capabilityUnsupportedResult('gated')]), 'not_applicable');
  });

  test('a version-excluded sibling caps even when every executed storyboard is neutralized', () => {
    // The gap: `graded` retains the version-excluded entry, but with nothing
    // else in it the all-not_applicable branch used to win and report
    // `not_applicable`. Base reports `partial` here — real coverage is still
    // missing — so the version-excluded entry has to cap.
    assert.equal(
      buildComplianceBundleResults([bundleOf([GATED_STORYBOARD, 'newer'])], [capabilityUnsupportedResult('gated')], {
        notApplicable: [{ storyboard_id: 'newer' }],
      })[0].status,
      'partial'
    );
    // Two neutralized siblings plus a version-excluded one: still partial.
    const second = { ...GATED_STORYBOARD, id: 'gated2' };
    assert.equal(
      buildComplianceBundleResults(
        [bundleOf([GATED_STORYBOARD, second, 'newer'])],
        [capabilityUnsupportedResult('gated'), capabilityUnsupportedResult('gated2')],
        { notApplicable: [{ storyboard_id: 'newer' }] }
      )[0].status,
      'partial'
    );
    // A wholly version-excluded bundle has nothing neutralized and keeps its
    // pre-existing `not_applicable` verdict.
    assert.equal(
      buildComplianceBundleResults([bundleOf(['a', 'b'])], [], {
        notApplicable: [{ storyboard_id: 'a' }, { storyboard_id: 'b' }],
      })[0].status,
      'not_applicable'
    );
  });

  test('untested and failing siblings still block passing', () => {
    assert.equal(rollupOf([GATED_STORYBOARD, 'never_ran'], [capabilityUnsupportedResult('gated')]), 'partial');
    assert.equal(
      rollupOf(
        [GATED_STORYBOARD, 'broken'],
        [
          capabilityUnsupportedResult('gated'),
          { ...passingStub('broken'), overall_passed: false, passed_count: 0, failed_count: 1 },
        ]
      ),
      'failing'
    );
  });

  test('an inapplicable result that also carries a failure row stays failing', () => {
    const withFailure = capabilityUnsupportedResult('gated');
    withFailure.overall_passed = false;
    withFailure.failed_count = 1;
    withFailure.phases.push({ phase_id: 'p', steps: [{ step_id: 'step', passed: false, error: 'boom' }] });
    assert.equal(rollupOf([GATED_STORYBOARD, 'seller'], [withFailure, passingStub('seller')]), 'failing');
  });

  test('step-level coverage skips and zero-evidence states are untouched', () => {
    for (const reason of ['missing_tool', 'missing_test_controller', 'prerequisite_failed', 'not_applicable']) {
      const gap = {
        storyboard_id: 'gap',
        overall_passed: true,
        passed_count: 1,
        failed_count: 0,
        skipped_count: 1,
        phases: [{ phase_id: 'p', steps: [{ step_id: 's', skipped: true, passed: true, skip: { reason } }] }],
      };
      assert.equal(rollupOf(['gap', 'seller'], [gap, passingStub('seller')]), 'partial', reason);
    }
    const silent = { ...passingStub('silent'), assertions: [{ observation_count: 0, passed: true }] };
    assert.equal(rollupOf(['silent'], [silent]), 'partial', 'zero observed evidence');
    const ungradable = { ...passingStub('ungradable'), validations_not_applicable: 1 };
    assert.equal(rollupOf(['ungradable'], [ungradable]), 'partial', 'ungradable validation');
  });
});

// ────────────────────────────────────────────────────────────
// 3b. Real bundle aggregates — the rule is generic, not governance-specific
// ────────────────────────────────────────────────────────────

describe('real AdCP 3.2 bundle aggregates', { skip: !scenariosAvailable }, () => {
  function resolveBundles(specialisms) {
    return resolveStoryboardsForCapabilities(
      {
        supported_protocols: ['media_buy', 'creative'],
        specialisms,
        supported_versions: ['3.1', '3.2', ADCP_VERSION],
        major_versions: [3],
      },
      { complianceVersion: ADCP_VERSION, complianceDir: path.join('compliance', 'cache', ADCP_VERSION) }
    );
  }

  test('every authored non-compliance_testing root predicate is eligible, and compliance_testing is not', () => {
    // The rule is not governance-specific: it keys on any authored root
    // capability predicate in a 3.2+ bundle. Asserted as a shape claim over
    // the real cache so the changeset's scope statement stays true.
    const resolved = resolveBundles(['sales-guaranteed', 'creative-template']);
    const gated = resolved.storyboards.filter(sb => {
      const predicates = [
        ...(sb.requires_capability ? [sb.requires_capability] : []),
        ...(sb.requires_all_capabilities ?? []),
      ];
      return predicates.length > 0;
    });
    assert.ok(gated.length > 20, `expected a broad gated set, saw ${gated.length}`);
    const controllerGated = gated.filter(sb =>
      [...(sb.requires_capability ? [sb.requires_capability] : []), ...(sb.requires_all_capabilities ?? [])].some(
        predicate => String(predicate.path).startsWith('compliance_testing')
      )
    );
    assert.ok(controllerGated.length > 0, 'the cache must still contain compliance_testing-gated scenarios');

    for (const storyboard of gated) {
      const expected = controllerGated.includes(storyboard) ? 'partial' : 'passing';
      assert.equal(
        rollupOf([storyboard, 'seller'], [capabilityUnsupportedResult(storyboard.id), passingStub('seller')]),
        expected,
        `${storyboard.id} (${storyboard.adcp_version})`
      );
    }
  });

  test('the cache census behind the scope claim holds: 174 gated files, 14 compliance_testing', () => {
    // File-level census, which is what the changeset's "160 of 174" claims.
    // Distinct storyboard ids are fewer, because the same scenario is carried
    // in more than one bundle directory — both numbers are asserted so the
    // claim cannot drift silently in either direction.
    const root = path.join(__dirname, '..', '..', 'compliance', 'cache', ADCP_VERSION);
    const walk = dir =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return entry.isFile() && entry.name.endsWith('.yaml') ? [full] : [];
      });

    // Root predicates are top-level keys, so they start at column 0; the
    // block's `path:` lines are the indented lines that follow.
    const rootPredicatePaths = text => {
      const lines = text.split('\n');
      const paths = [];
      let inBlock = false;
      for (const line of lines) {
        if (/^(requires_capability|requires_all_capabilities):/.test(line)) {
          inBlock = true;
          continue;
        }
        if (inBlock && /^\S/.test(line)) inBlock = false;
        if (!inBlock) continue;
        const match = /^\s+-?\s*path:\s*(.+?)\s*$/.exec(line);
        if (match) paths.push(match[1].replace(/^["']|["']$/g, ''));
      }
      return paths;
    };

    const gatedFiles = [];
    const controllerGatedFiles = [];
    for (const file of walk(root)) {
      const text = fs.readFileSync(file, 'utf8');
      if (!/^(requires_capability|requires_all_capabilities):/m.test(text)) continue;
      gatedFiles.push(file);
      const segments = rootPredicatePaths(text).flatMap(capabilityPath =>
        capabilityPath
          .trim()
          .toLowerCase()
          .split('.')
          .map(segment => segment.trim())
      );
      if (segments.includes('compliance_testing')) controllerGatedFiles.push(file);
    }

    assert.equal(gatedFiles.length, 174, 'root capability-gated file census drifted');
    assert.equal(controllerGatedFiles.length, 14, 'compliance_testing-gated file census drifted');
    assert.equal(gatedFiles.length - controllerGatedFiles.length, 160, 'eligible census drifted');

    // Normalization, not prefix matching: padded case and a nested namespace
    // are both recognised and both keep capping.
    for (const capabilityPath of [' Compliance_Testing.scenarios ', 'adcp.compliance_testing.scenarios']) {
      assert.equal(
        rollupOf(
          [
            {
              id: 'gated',
              adcp_version: ADCP_VERSION,
              requires_capability: { path: capabilityPath, equals: true },
              phases: [{ id: 'p' }],
            },
            'seller',
          ],
          [capabilityUnsupportedResult('gated'), passingStub('seller')]
        ),
        'partial',
        capabilityPath
      );
    }
  });

  test('a real protocol bundle of only-neutralized scenarios is not_applicable, never passing', () => {
    // No vacuous pass: neutralizing every storyboard in a real bundle leaves
    // it reporting not-applicable, not success.
    const resolved = resolveBundles(['sales-guaranteed', 'creative-template']);
    const bundlesWithGates = resolved.bundles.filter(bundle =>
      bundle.storyboards.some(
        sb => sb.requires_capability !== undefined || (sb.requires_all_capabilities ?? []).length > 0
      )
    );
    assert.ok(bundlesWithGates.length > 0, 'expected at least one real bundle with capability gates');
    const bundle = bundlesWithGates[0];
    const gated = bundle.storyboards.filter(
      sb => sb.requires_capability !== undefined || (sb.requires_all_capabilities ?? []).length > 0
    );
    const status = buildComplianceBundleResults(
      [{ ref: bundle.ref, storyboards: gated }],
      gated.map(sb => capabilityUnsupportedResult(sb.id))
    )[0].status;
    assert.notEqual(status, 'passing', `${bundle.ref.kind}:${bundle.ref.id}`);
  });
});

// ────────────────────────────────────────────────────────────
// 4. Requirement ordering, executed
// ────────────────────────────────────────────────────────────

function requiresStoryboard(requires) {
  return {
    id: 'gate_probe',
    title: 'Gate probe',
    requires,
    phases: [phaseOf([{ id: 'discover', title: 'discover', task: 'get_products', sample_request: {} }])],
  };
}

describe('executed: an unmet runtime requirement keeps its provenance in routed mode', () => {
  // Routed mode used to fold an unmet `request_signer` into the root
  // capability channel, so the same agent got `capability_unsupported` with no
  // `skip.requirement` routed and `requirement_unmet: request_signer`
  // non-routed — and the rollup then read the routed row as an unclaimed
  // capability and let the bundle pass.
  const SIGNING_STORYBOARD = {
    id: 'signing_probe',
    title: 'Signing probe',
    adcp_version: ADCP_VERSION,
    requires: ['request_signer'],
    // The agent SATISFIES this predicate; only the requirement is unmet.
    requires_capability: { path: 'account.require_operator_auth', equals: true },
    phases: [phaseOf([{ id: 'discover', title: 'discover', task: 'get_products', sample_request: {} }])],
  };
  const SIGNING_AGENT = {
    tools: ['get_products'],
    capabilities: {
      supported_protocols: ['media_buy'],
      adcp: { major_versions: [3], supported_versions: ['3.1', '3.2'] },
      account: { require_operator_auth: true },
      // No `request_signing` block: the agent did not opt in.
    },
  };

  // Requirement precedence must be identical in both modes. The routed signer
  // verdict is handed to the ordered `requires` gate rather than returned
  // ahead of it, so whichever gate is DECLARED FIRST and is unmet wins —
  // whether that is an unknown forward-compat value or `request_signer`
  // itself. Neither requirement class outranks the other.
  test('the first declared unmet gate wins in both modes, in either declared order', async () => {
    // Both gates below are unmet: the SDK cannot interpret `future_runtime`,
    // and the agent advertises no `request_signing` block. Declared order is
    // the only tiebreak, and it must not shift with the mode — nor with
    // whether the requirement happened to be assessable before discovery.
    const agent = await startAgent({
      tools: ['get_products'],
      capabilities: {
        supported_protocols: ['media_buy'],
        adcp: { major_versions: [3], supported_versions: ['3.1', '3.2'] },
      },
    });
    try {
      for (const [requires, expected] of [
        [['request_signer', 'future_runtime'], 'request_signer'],
        [['future_runtime', 'request_signer'], 'future_runtime'],
      ]) {
        const storyboard = {
          id: 'permutation_probe',
          title: 'Permutation probe',
          adcp_version: ADCP_VERSION,
          requires,
          phases: [phaseOf([{ id: 'discover', title: 'discover', task: 'get_products', sample_request: {} }])],
        };
        const nonRouted = await runStoryboard(agent.url, storyboard, RUN_OPTIONS);
        const routed = await runStoryboard('', storyboard, {
          ...RUN_OPTIONS,
          agents: { seller: { url: agent.url } },
        });
        const reported = result =>
          result.phases
            .flatMap(phase => phase.steps)
            .map(step => step.skip?.requirement)
            .find(Boolean);
        assert.equal(reported(nonRouted), expected, `${requires.join(',')} (non-routed)`);
        assert.equal(reported(routed), expected, `${requires.join(',')} (routed)`);
      }
    } finally {
      await closeConnections();
      await agent.close();
    }
  });

  test('an earlier unmet gate wins over the routed signer verdict, identically in both modes', async () => {
    for (const [label, tools, extraCapabilities, requires, expected] of [
      [
        'unknown forward-compat value outranks request_signer',
        ['get_products', 'comply_test_controller'],
        { compliance_testing: { scenarios: ['force_error'] } },
        ['controller', 'future_runtime', 'request_signer'],
        'future_runtime',
      ],
      [
        'missing controller outranks request_signer',
        ['get_products'],
        {},
        ['controller', 'request_signer'],
        'controller',
      ],
    ]) {
      const agent = await startAgent({
        tools,
        capabilities: {
          supported_protocols: ['media_buy'],
          adcp: { major_versions: [3], supported_versions: ['3.1', '3.2'] },
          ...extraCapabilities,
        },
      });
      try {
        const storyboard = { ...SIGNING_STORYBOARD, id: 'ordering_probe', requires };
        // No root capability predicate: requirement precedence is the only
        // thing under test here.
        delete storyboard.requires_capability;

        const nonRouted = await runStoryboard(agent.url, storyboard, RUN_OPTIONS);
        const routed = await runStoryboard('', storyboard, {
          ...RUN_OPTIONS,
          agents: { seller: { url: agent.url } },
        });
        const reported = result =>
          result.phases
            .flatMap(phase => phase.steps)
            .map(step => step.skip?.requirement)
            .find(Boolean);

        assert.equal(reported(nonRouted), expected, `${label} (non-routed)`);
        assert.equal(reported(routed), expected, `${label} (routed)`);
        assert.equal(reported(routed), reported(nonRouted), `${label} (parity)`);
      } finally {
        await closeConnections();
        await agent.close();
      }
    }
  });

  test('routed and non-routed report the same requirement and the same verdict', async () => {
    const agent = await startAgent(SIGNING_AGENT);
    try {
      const nonRouted = await runStoryboard(agent.url, SIGNING_STORYBOARD, RUN_OPTIONS);
      const routed = await runStoryboard('', SIGNING_STORYBOARD, {
        ...RUN_OPTIONS,
        agents: { seller: { url: agent.url } },
      });

      const shape = result =>
        result.phases
          .flatMap(phase => phase.steps)
          .map(step => [step.step_id, step.skip_reason, step.skip?.reason, step.skip?.requirement]);

      // Parity: identical rows, and the requirement is named in both.
      assert.deepEqual(shape(routed), shape(nonRouted));
      assert.deepEqual(shape(routed), [
        ['requirement_unmet:request_signer', 'not_applicable', 'not_applicable', 'request_signer'],
      ]);
      // The mislabeled root row is gone, not merely tagged.
      for (const result of [routed, nonRouted]) {
        assert.ok(
          !result.phases.flatMap(p => p.steps).some(step => step.skip_reason === 'capability_unsupported'),
          'an unmet requirement must not be reported as an unclaimed capability'
        );
      }
      // And the bundle caps either way — the signing surface was never tested.
      for (const result of [routed, nonRouted]) {
        assert.equal(rollupOf([SIGNING_STORYBOARD, 'seller'], [result, passingStub('seller')]), 'partial');
      }
    } finally {
      await closeConnections();
      await agent.close();
    }
  });
});

describe('executed: the multi_agent gate never pre-empts discovery or another gate', () => {
  test('no root predicate: multi_agent is gated pre-discovery, so an unreachable route is a neutral skip', async () => {
    // Topology is statically determined from the `agents` map plus declared
    // route keys, so the gate precedes discovery and MUST report the
    // requirement rather than letting the run fail on an unreachable agent.
    const result = await runStoryboard('', requiresStoryboard(['multi_agent']), {
      ...RUN_OPTIONS,
      allow_http: true,
      agents: { sales: { url: 'http://127.0.0.1:1/sales/mcp' } },
      default_agent: 'sales',
    });
    const step = result.phases[0].steps[0];
    assert.equal(step.skipped, true);
    assert.equal(step.skip_reason, 'requirement_unmet');
    assert.equal(step.skip.requirement, 'multi_agent');
    assert.equal(result.failed_count, 0);
    assert.equal(result.overall_passed, true);
    // Still caps the bundle: nothing was exercised.
    assert.equal(rollupOf(['gate_probe', 'seller'], [result, passingStub('seller')]), 'partial');
  });

  test('no agents map at all still reports multi_agent, not a discovery failure', async () => {
    const result = await runStoryboard('http://127.0.0.1:1/mcp', requiresStoryboard(['multi_agent']), RUN_OPTIONS);
    const step = result.phases[0].steps[0];
    assert.equal(step.skip_reason, 'requirement_unmet');
    assert.equal(step.skip.requirement, 'multi_agent');
    assert.equal(result.failed_count, 0);
  });

  test('with a root predicate the capability verdict comes first, then multi_agent', async () => {
    // AdCP 3.2 applicability order: a non-claimant gets the capability
    // verdict and MUST NOT be told about a missing runtime requirement.
    const seller = await startAgent();
    try {
      const gated = {
        ...requiresStoryboard(['multi_agent']),
        adcp_version: ADCP_VERSION,
        requires_capability: { path: 'account.require_operator_auth', equals: true },
      };
      const result = await runStoryboard(seller.url, gated, RUN_OPTIONS);
      assert.deepEqual(rows(result), [['capability_unsupported', 'capability_unsupported']]);
      assert.equal(result.phases[0].steps[0].skip.requirement, undefined);
    } finally {
      await closeConnections();
      await seller.close();
    }
  });

  test('a capability-gated claimant defers requirements past discovery, in declared order', async () => {
    // The claimant clears the predicate, so the gate defers to after
    // discovery — where `controller` can finally be assessed. Declared order
    // then decides: neither requirement class outranks the other.
    const seller = await startAgent({
      tools: ['get_products'],
      capabilities: {
        supported_protocols: ['media_buy'],
        adcp: { major_versions: [3], supported_versions: ['3.1', '3.2'] },
        account: { require_operator_auth: true },
      },
    });
    try {
      for (const [requires, expected, expectedReason] of [
        [['controller', 'multi_agent'], 'controller', 'missing_test_controller'],
        [['multi_agent', 'controller'], 'multi_agent', 'requirement_unmet'],
      ]) {
        const gated = {
          ...requiresStoryboard(requires),
          adcp_version: ADCP_VERSION,
          requires_capability: { path: 'account.require_operator_auth', equals: true },
        };
        const result = await runStoryboard(seller.url, gated, RUN_OPTIONS);
        assert.equal(result.phases[0].steps[0].skip.requirement, expected, requires.join(','));
        assert.equal(result.phases[0].steps[0].skip.reason, expectedReason, requires.join(','));
        assert.equal(rollupOf(['gate_probe'], [result]), 'partial', requires.join(','));
      }
    } finally {
      await closeConnections();
      await seller.close();
    }
  });

  test('multi_agent stays unmet when live routes resolve to one distinct key', async () => {
    // Moved here from `storyboard-requires-gate.test.js`, which pinned this
    // with unreachable ports — the requirement is now evaluated after
    // discovery, so both tenants must be reachable for the route-key count to
    // be the thing under test.
    const sales = await startAgent();
    const signals = await startAgent({ tools: ['get_signals'], protocols: ['signals'] });
    try {
      const result = await runStoryboard(
        '',
        {
          id: 'route_keys',
          title: 'Route keys',
          requires: ['multi_agent'],
          phases: [phaseOf([{ id: 'step1', title: 'A routed read', task: 'get_products', agent: 'sales' }])],
        },
        {
          ...RUN_OPTIONS,
          agents: { sales: { url: sales.url }, signals: { url: signals.url } },
          default_agent: 'sales',
        }
      );
      const step = result.phases[0].steps[0];
      assert.equal(step.skip_reason, 'requirement_unmet');
      assert.equal(step.skip.requirement, 'multi_agent');
      assert.match(step.skip.detail, /Resolved route keys: \[sales\]/);
      assert.match(step.skip.detail, /Available agents: \[sales, signals\]/);
      assert.equal(rollupOf(['route_keys', 'seller'], [result, passingStub('seller')]), 'partial');
    } finally {
      await closeConnections();
      await sales.close();
      await signals.close();
    }
  });

  test('an unmapped tool and an ambiguous protocol claim stay routing failures', async () => {
    const seller = await startAgent();
    const govA = await startAgent({ tools: ['sync_plans'], protocols: ['governance'] });
    const govB = await startAgent({ tools: ['sync_plans'], protocols: ['governance'] });
    try {
      const unmapped = await runStoryboard(
        '',
        {
          id: 'u',
          title: 'u',
          phases: [phaseOf([{ id: 'c', title: 'c', task: 'sync_creatives', sample_request: {} }])],
        },
        { ...RUN_OPTIONS, agents: { seller: { url: seller.url } } }
      );
      assert.equal(unmapped.failed_count, 1);
      assert.match(unmapped.phases[0].steps[0].error, /no specialism mapping/);

      const conflict = await runStoryboard(
        '',
        {
          id: 'c',
          title: 'c',
          phases: [phaseOf([{ id: 'p', title: 'p', task: 'sync_plans', sample_request: {} }])],
        },
        { ...RUN_OPTIONS, agents: { a: { url: govA.url }, b: { url: govB.url } } }
      );
      assert.equal(conflict.failed_count, 1);
      assert.equal(conflict.overall_passed, false);
    } finally {
      await closeConnections();
      await seller.close();
      await govA.close();
      await govB.close();
    }
  });

  test('a cross-protocol tool the agent does not advertise still grades missing_tool', async () => {
    // No step-scope reclassification ships in this change: a seller that does
    // not advertise a governance tool is still told so.
    const seller = await startAgent();
    try {
      const result = await runStoryboard(
        seller.url,
        {
          id: 'cross_protocol',
          title: 'Cross protocol',
          required_tools: ['get_products'],
          phases: [
            phaseOf([{ id: 'setup', title: 'setup', task: 'sync_plans', stateful: true, sample_request: {} }]),
            phaseOf([{ id: 'work', title: 'work', task: 'get_products', sample_request: {} }], 'p2'),
          ],
        },
        RUN_OPTIONS
      );
      assert.deepEqual(rows(result)[0], ['setup', 'missing_tool']);
    } finally {
      await closeConnections();
      await seller.close();
    }
  });
});

// ────────────────────────────────────────────────────────────
// 4b. Routed / non-routed requirement parity matrix
// ────────────────────────────────────────────────────────────

describe('requirement reporting is identical routed and non-routed', () => {
  // `checkRequires` reports the first unmet gate in DECLARED order. What
  // varies by mode is only which gates are assessable at the point the
  // pre-flight runs, and the runner now arranges for the answer not to depend
  // on that at all: a requirement it cannot assess yet defers TOGETHER WITH
  // every requirement declared after it, so the post-discovery pass always
  // resolves the same declared-first gate.
  //
  //   - no root capability predicate: the pre-flight answers the statically
  //     decidable prefix (`multi_agent`, unrecognized values, harness gates)
  //     and stops at the first `controller` / `request_signer` it cannot
  //     settle in this mode.
  //   - with a root predicate: AdCP 3.2 applicability order puts the
  //     capability verdict first, so the whole list defers until after
  //     discovery, and the routed `controller` / `request_signer` verdicts are
  //     consumed at their declared positions.
  //
  // The third column is the one the last review turned up. A real `comply()`
  // run threads `_profile` + `agentTools` into `runStoryboard`
  // (`comply.ts`: `effectiveOptions._profile = profile`, `agentTools:
  // profile.tools`), so its non-routed pre-flight CAN settle a declared-first
  // `controller` / `request_signer`. Filtering `controller` out of the routed
  // pre-flight therefore made the two modes answer differently for exactly
  // the shape `comply()` produces. All three columns must agree cell for cell:
  // the reported requirement is a property of the declared list and the agent,
  // never of the mode or of whether the caller pre-supplied a profile.
  //
  // `origin/main` diverges on six of these ten cells across the three columns.
  const CASES = [
    [false, ['request_signer', 'future_runtime'], 'request_signer'],
    [false, ['future_runtime', 'request_signer'], 'future_runtime'],
    [false, ['multi_agent', 'request_signer', 'future_runtime'], 'multi_agent'],
    [false, ['controller', 'future_runtime'], 'controller'],
    [false, ['controller', 'multi_agent'], 'controller'],
    [false, ['multi_agent', 'controller'], 'multi_agent'],
    [true, ['request_signer', 'future_runtime'], 'request_signer'],
    [true, ['future_runtime', 'request_signer'], 'future_runtime'],
    [true, ['controller', 'multi_agent'], 'controller'],
    [true, ['multi_agent', 'controller'], 'multi_agent'],
  ];

  test('every predicate state, declared order and mode reports the same requirement', async () => {
    // One agent: satisfies the root predicate, advertises no controller and
    // no request signing, and is the only tenant in the routed map.
    const AGENT_CAPS = {
      supported_protocols: ['media_buy'],
      adcp: { major_versions: [3], supported_versions: ['3.1', '3.2'] },
      account: { require_operator_auth: true },
    };
    const agent = await startAgent({ tools: ['get_products'], capabilities: AGENT_CAPS });
    // Exactly what `comply()` hands `runStoryboard`: the discovered profile
    // plus its tool list, so every gate is assessable before discovery.
    const complyShaped = {
      ...RUN_OPTIONS,
      _profile: {
        name: 'Parity agent',
        tools: ['get_adcp_capabilities', 'get_products'],
        raw_capabilities: AGENT_CAPS,
      },
      agentTools: ['get_adcp_capabilities', 'get_products'],
    };
    try {
      for (const [withPredicate, requires, expected] of CASES) {
        const storyboard = {
          id: 'parity_probe',
          title: 'Parity probe',
          adcp_version: ADCP_VERSION,
          requires,
          ...(withPredicate && { requires_capability: { path: 'account.require_operator_auth', equals: true } }),
          phases: [phaseOf([{ id: 'discover', title: 'discover', task: 'get_products', sample_request: {} }])],
        };
        const nonRouted = await runStoryboard(agent.url, storyboard, RUN_OPTIONS);
        const complyNonRouted = await runStoryboard(agent.url, storyboard, complyShaped);
        const routed = await runStoryboard('', storyboard, {
          ...RUN_OPTIONS,
          agents: { seller: { url: agent.url } },
        });
        const reported = result =>
          result.phases
            .flatMap(phase => phase.steps)
            .map(step => step.skip?.requirement)
            .find(Boolean) ??
          (result.phases.flatMap(phase => phase.steps).some(step => step.skip_reason === 'capability_unsupported')
            ? '(capability_unsupported)'
            : '(none)');

        const label = `${withPredicate ? 'root' : 'no-root'} ${requires.join(',')}`;
        assert.equal(reported(nonRouted), expected, `${label} (non-routed)`);
        assert.equal(reported(complyNonRouted), expected, `${label} (non-routed, comply-shaped)`);
        assert.equal(reported(routed), expected, `${label} (routed)`);
      }
    } finally {
      await closeConnections();
      await agent.close();
    }
  });
});

// ────────────────────────────────────────────────────────────
// 5. Routing diagnostics that survive (message text only)
// ────────────────────────────────────────────────────────────

describe('routing errors name the agents that advertise an unclaimed tool', () => {
  test('the unclaimed-protocol message points at the declaration to fix', () => {
    const sb = {
      id: 'kind_probe',
      title: 'Kind probe',
      phases: [phaseOf([{ id: 'plan', title: 'plan', task: 'sync_plans' }])],
    };
    const options = {
      agents: { seller: { url: 'https://s.example/mcp' }, peer: { url: 'https://p.example/mcp' } },
    };
    const profiles = new Map([
      ['seller', { name: 'mock', tools: ['get_products'], supported_protocols: ['media_buy'] }],
      // Serves the tool, declares no protocol.
      ['peer', { name: 'mock', tools: ['sync_plans'], supported_protocols: [] }],
    ]);
    const ctx = buildRoutingContextFromProfiles(sb, options, profiles);
    assert.throws(
      () => resolveAgentForStep(sb.phases[0].steps[0], options, ctx),
      err =>
        err instanceof RoutingError &&
        /No agent in the map claims protocol "governance"/.test(err.message) &&
        /Agent\(s\) \[peer\] advertise "sync_plans" but do not declare "governance"/.test(err.message)
    );
  });
});

// ────────────────────────────────────────────────────────────
// Routed `controller` provenance
// ────────────────────────────────────────────────────────────
//
// `requires: [controller]` asks whether a test controller can seed the state
// this storyboard exercises. Routed runs answered it from the cross-tenant
// tool union the runner builds for `required_tools` ANY-OF gating, so any
// tenant's `comply_test_controller` satisfied every tenant's gate. A seller
// with no controller then executed against unseeded state and graded green,
// while a non-routed run of the same seller correctly reported
// `missing_test_controller` — the routed/non-routed divergence class this
// storyboard work exists to close. The union predates this change; these pin
// the narrowed rule.
//
// The rule is deliberately not "every callable route must advertise one": a
// route that is only read from — a signals peer serving static marketplace
// data — is no fixture target and needs no controller. The gate is unmet only
// when NO route serving a state-exercising step advertises its own. A single
// control plane genuinely fronting two tenants therefore has to be declared
// rather than inferred, which is the per-tenant seed dispatch already tracked
// where routed + `controller_seeding: true` fail-fasts.

const CONTROLLER_CAPS = {
  supported_protocols: ['media_buy'],
  adcp: { major_versions: [3], supported_versions: ['3.1', '3.2'] },
  compliance_testing: { scenarios: ['seed_product'] },
};
const SIGNALS_CAPS = {
  supported_protocols: ['signals'],
  adcp: { major_versions: [3], supported_versions: ['3.1', '3.2'] },
};

function controllerStoryboard(steps) {
  return {
    id: 'gate_probe',
    title: 'Gate probe',
    adcp_version: ADCP_VERSION,
    requires: ['controller'],
    phases: [phaseOf(steps ?? [{ id: 'discover', title: 'discover', task: 'get_products', sample_request: {} }])],
  };
}

const taskCalls = agent => agent.calls.filter(call => call !== 'get_adcp_capabilities');

describe('executed: routed `controller` answers from the route that owns the state', () => {
  test('a peer route’s controller cannot satisfy the gate of the route under test', async () => {
    // The reported false pass: the seller serves the only step and has no
    // controller; an unrelated signals peer has one. The union said yes.
    const seller = await startAgent({ tools: ['get_products'], protocols: ['media_buy'] });
    const peer = await startAgent({
      tools: ['get_signals', 'comply_test_controller'],
      capabilities: { ...SIGNALS_CAPS, compliance_testing: { scenarios: ['seed_product'] } },
    });
    try {
      const result = await runStoryboard('', controllerStoryboard(), {
        ...RUN_OPTIONS,
        agents: { seller: { url: seller.url }, peer: { url: peer.url } },
      });

      const step = result.phases[0].steps[0];
      assert.equal(step.skip_reason, 'missing_test_controller');
      assert.equal(step.skip.requirement, 'controller');
      // The gate must actually hold: no step may reach the wire.
      assert.deepEqual(taskCalls(seller), [], 'the step must not execute');
      assert.equal(result.failed_count, 0);
      // A coverage gap, never credited.
      assert.equal(rollupOf(['gate_probe', 'seller'], [result, passingStub('seller')]), 'partial');
      // The operator is told which route is short and why the peer does not count.
      assert.match(step.skip.detail, /Route\(s\) exercised: \[seller\]/);
      assert.match(step.skip.detail, /Agent\(s\) \[peer\] in this map do advertise it/);
    } finally {
      await closeConnections();
      await seller.close();
      await peer.close();
    }
  });

  test('a `comply_test_controller` step cannot vouch for the route it is dispatched to', async () => {
    // The subtle half of the rule. The controller step is the back-channel,
    // not the state under test, so its route is excluded from the
    // state-exercising set. Here the ONLY route advertising a controller
    // serves nothing but that step; the seller whose products are actually
    // read has none. Without the exclusion the controller would satisfy the
    // gate for the very route it is dispatched to, and `discover` would run
    // against unseeded seller state.
    const seller = await startAgent({ tools: ['get_products'], protocols: ['media_buy'] });
    const peer = await startAgent({
      tools: ['get_signals', 'comply_test_controller'],
      capabilities: { ...SIGNALS_CAPS, compliance_testing: { scenarios: ['seed_product'] } },
    });
    try {
      const result = await runStoryboard(
        '',
        controllerStoryboard([
          { id: 'seed', title: 'seed', task: 'comply_test_controller', sample_request: {} },
          { id: 'discover', title: 'discover', task: 'get_products', sample_request: {} },
        ]),
        {
          ...RUN_OPTIONS,
          agents: { seller: { url: seller.url }, peer: { url: peer.url } },
          // Forces the unmapped controller task onto the peer that advertises it.
          default_agent: 'peer',
        }
      );

      const step = result.phases[0].steps[0];
      assert.equal(step.skip_reason, 'missing_test_controller');
      assert.equal(step.skip.requirement, 'controller');
      assert.deepEqual(taskCalls(seller), [], 'the read step must not execute');
      assert.deepEqual(taskCalls(peer), [], 'the controller step must not execute either');
      assert.match(step.skip.detail, /Route\(s\) exercised: \[seller\]/);
    } finally {
      await closeConnections();
      await seller.close();
      await peer.close();
    }
  });

  test('the controller on the route under test still runs the storyboard', async () => {
    // Negative control for over-skipping: same topology, controller moved onto
    // the route that serves the step.
    const seller = await startAgent({
      tools: ['get_products', 'comply_test_controller'],
      capabilities: CONTROLLER_CAPS,
    });
    const peer = await startAgent({ tools: ['get_signals'], capabilities: SIGNALS_CAPS });
    try {
      const result = await runStoryboard('', controllerStoryboard(), {
        ...RUN_OPTIONS,
        agents: { seller: { url: seller.url }, peer: { url: peer.url } },
      });
      assert.deepEqual(rows(result), [['discover', 'PASS']]);
      assert.deepEqual(taskCalls(seller), ['get_products']);
    } finally {
      await closeConnections();
      await seller.close();
      await peer.close();
    }
  });

  test('a read-only peer without a controller does not skip the storyboard', async () => {
    // This is what makes the rule (C) and not "every callable route needs one".
    // The seeded route has a controller; the signals peer is only read from.
    const seller = await startAgent({
      tools: ['get_products', 'comply_test_controller'],
      capabilities: CONTROLLER_CAPS,
    });
    const peer = await startAgent({ tools: ['get_signals'], capabilities: SIGNALS_CAPS });
    try {
      const result = await runStoryboard(
        '',
        controllerStoryboard([
          { id: 'discover', title: 'discover', task: 'get_products', sample_request: {} },
          { id: 'read_peer', title: 'read peer', task: 'get_signals', sample_request: {} },
        ]),
        { ...RUN_OPTIONS, agents: { seller: { url: seller.url }, peer: { url: peer.url } } }
      );
      assert.deepEqual(rows(result), [
        ['discover', 'PASS'],
        ['read_peer', 'PASS'],
      ]);
      assert.deepEqual(taskCalls(peer), ['get_signals']);
    } finally {
      await closeConnections();
      await seller.close();
      await peer.close();
    }
  });

  test('routed and non-routed agree about the same seller, in both directions', async () => {
    const without = await startAgent({ tools: ['get_products'], protocols: ['media_buy'] });
    const with_ = await startAgent({
      tools: ['get_products', 'comply_test_controller'],
      capabilities: CONTROLLER_CAPS,
    });
    try {
      const nonRoutedUnmet = await runStoryboard(without.url, controllerStoryboard(), RUN_OPTIONS);
      const routedUnmet = await runStoryboard('', controllerStoryboard(), {
        ...RUN_OPTIONS,
        agents: { seller: { url: without.url } },
      });
      assert.equal(nonRoutedUnmet.phases[0].steps[0].skip.requirement, 'controller');
      assert.equal(routedUnmet.phases[0].steps[0].skip.requirement, 'controller');

      const nonRoutedMet = await runStoryboard(with_.url, controllerStoryboard(), RUN_OPTIONS);
      const routedMet = await runStoryboard('', controllerStoryboard(), {
        ...RUN_OPTIONS,
        agents: { seller: { url: with_.url } },
      });
      assert.deepEqual(rows(nonRoutedMet), [['discover', 'PASS']]);
      assert.deepEqual(rows(routedMet), [['discover', 'PASS']]);
    } finally {
      await closeConnections();
      await without.close();
      await with_.close();
    }
  });

  test('the disjunctive `required_any_of_tools` union is untouched', async () => {
    // The union the controller gate stopped reading is still correct for the
    // ANY-OF family gate it was built for: one tenant serving one member of
    // the family satisfies it for the topology.
    const seller = await startAgent({ tools: ['get_products'], protocols: ['media_buy'] });
    const peer = await startAgent({ tools: ['get_signals', 'activate_signal'], capabilities: SIGNALS_CAPS });
    try {
      const result = await runStoryboard(
        '',
        {
          id: 'anyof_probe',
          title: 'Any-of probe',
          adcp_version: ADCP_VERSION,
          required_any_of_tools: [
            { tools: ['sync_governance', 'activate_signal'], rationale: 'either family serves this gate' },
          ],
          phases: [phaseOf([{ id: 'discover', title: 'discover', task: 'get_products', sample_request: {} }])],
        },
        { ...RUN_OPTIONS, agents: { seller: { url: seller.url }, peer: { url: peer.url } } }
      );
      assert.deepEqual(rows(result), [['discover', 'PASS']]);
    } finally {
      await closeConnections();
      await seller.close();
      await peer.close();
    }
  });

  test('routed + `controller_seeding: true` still fail-fasts, so the gate change cannot open it', async () => {
    // change_rights_state_projection is the one shipped controller storyboard
    // that spans routes (`default_agent: sales`), and it declares
    // `controller_seeding: true` — so routed runs of it throw before any gate
    // runs, and stay fail-closed.
    const seller = await startAgent({ tools: ['get_products'], protocols: ['media_buy'] });
    try {
      await assert.rejects(
        runStoryboard(
          '',
          {
            ...controllerStoryboard(),
            default_agent: 'seller',
            prerequisites: { controller_seeding: true },
            fixtures: { products: [{ product_id: 'p1', name: 'P', delivery_type: 'guaranteed' }] },
          },
          { ...RUN_OPTIONS, agents: { seller: { url: seller.url } } }
        ),
        /`agents` \+ `prerequisites.controller_seeding: true` is not yet supported/
      );
    } finally {
      await closeConnections();
      await seller.close();
    }
  });

  test('a storyboard of nothing but controller steps still needs a controller', async () => {
    // `comply_test_controller` steps are excluded from the state-exercising
    // set, so a storyboard whose ONLY callable steps are controller calls left
    // that set empty and the gate was silently dropped — the run then dialed
    // the back-channel on a route that does not serve it. With no
    // state-exercising route to read, the verdict falls back to every in-scope
    // route, which keeps it fail-closed.
    const without = await startAgent({ tools: ['get_products'], protocols: ['media_buy'] });
    try {
      const result = await runStoryboard(
        '',
        controllerStoryboard([
          { id: 'seed', title: 'seed', task: 'comply_test_controller', agent: 'seller', sample_request: {} },
        ]),
        { ...RUN_OPTIONS, agents: { seller: { url: without.url } } }
      );
      const step = result.phases[0].steps[0];
      assert.equal(step.skip_reason, 'missing_test_controller');
      assert.equal(step.skip.requirement, 'controller');
      assert.deepEqual(taskCalls(without), [], 'the controller step must not reach the wire');
      assert.equal(result.failed_count, 0);
      assert.match(step.skip.detail, /Route\(s\) exercised: \[seller\]/);
      assert.equal(rollupOf(['gate_probe', 'seller'], [result, passingStub('seller')]), 'partial');
    } finally {
      await closeConnections();
      await without.close();
    }

    // Negative control: the same storyboard against a route that does
    // advertise the controller is not skipped.
    const with_ = await startAgent({
      tools: ['get_products', 'comply_test_controller'],
      capabilities: CONTROLLER_CAPS,
    });
    try {
      const result = await runStoryboard(
        '',
        controllerStoryboard([
          { id: 'seed', title: 'seed', task: 'comply_test_controller', agent: 'seller', sample_request: {} },
        ]),
        { ...RUN_OPTIONS, agents: { seller: { url: with_.url } } }
      );
      assert.ok(
        !result.phases.flatMap(phase => phase.steps).some(step => step.skip?.requirement === 'controller'),
        JSON.stringify(rows(result))
      );
      assert.deepEqual(taskCalls(with_), ['comply_test_controller']);
    } finally {
      await closeConnections();
      await with_.close();
    }
  });

  test('a route the phase’s own capability predicate excludes exercises no state', async () => {
    // The controller-bearing route serves only a phase it is not applicable
    // to, so it executes nothing and cannot vouch for the gate. Reading it
    // anyway let the seller's step run against unseeded state.
    const seller = await startAgent({
      tools: ['get_products'],
      capabilities: {
        supported_protocols: ['media_buy'],
        adcp: { major_versions: [3], supported_versions: ['3.1', '3.2'] },
      },
    });
    for (const [label, peerOptsIn, expectSkipped] of [
      ['peer is out of the phase’s scope', false, true],
      ['peer is in the phase’s scope', true, false],
    ]) {
      const peer = await startAgent({
        tools: ['get_products', 'comply_test_controller'],
        capabilities: {
          ...CONTROLLER_CAPS,
          ...(peerOptsIn && { account: { require_operator_auth: true } }),
        },
      });
      try {
        const result = await runStoryboard(
          '',
          {
            ...controllerStoryboard(),
            phases: [
              phaseOf([{ id: 'discover', title: 'discover', task: 'get_products', agent: 'seller' }], 'p1'),
              {
                id: 'p2',
                title: 'p2',
                requires_capability: { path: 'account.require_operator_auth', equals: true },
                steps: [{ id: 'peer_read', title: 'peer read', task: 'get_products', agent: 'peer' }],
              },
            ],
          },
          { ...RUN_OPTIONS, agents: { seller: { url: seller.url }, peer: { url: peer.url } } }
        );
        if (expectSkipped) {
          const step = result.phases[0].steps[0];
          assert.equal(step.skip_reason, 'missing_test_controller', label);
          assert.equal(step.skip.requirement, 'controller', label);
          // The exercised set names only the applicable route, and the
          // excluded one is reported as a peer that cannot stand in for it.
          assert.match(step.skip.detail, /Route\(s\) exercised: \[seller\]/, label);
          assert.match(step.skip.detail, /Agent\(s\) \[peer\] in this map do advertise it/, label);
          assert.deepEqual(taskCalls(seller), [], label);
          assert.deepEqual(taskCalls(peer), [], label);
        } else {
          // Negative control against over-skipping: once the peer is in scope
          // it is a state-exercising route, and its controller answers.
          assert.ok(
            !result.phases.flatMap(phase => phase.steps).some(step => step.skip?.requirement === 'controller'),
            `${label}: ${JSON.stringify(rows(result))}`
          );
          assert.deepEqual(taskCalls(peer), ['get_products'], label);
        }
      } finally {
        await closeConnections();
        await peer.close();
      }
    }
    await seller.close();
  });

  test('two tenants behind one URL are distinct routes, in either step order', async () => {
    // A shared control plane fronting two tenants: same `url`, different
    // `auth`. Mapping a selected agent back to its key BY URL collapsed them
    // onto whichever key the map listed first, so the last step to dispatch
    // overwrote the other's tool list and the verdict flipped with step order.
    // Both tenants serve state here and one advertises a controller, so scope
    // (C) is satisfied and the storyboard must run — in either order.
    for (const order of [
      ['seller_a', 'seller_b'],
      ['seller_b', 'seller_a'],
    ]) {
      const shared = await startSharedUrlAgent({
        'tok-a': { tools: ['get_products'], capabilities: { ...CONTROLLER_CAPS, compliance_testing: undefined } },
        'tok-b': { tools: ['get_products', 'comply_test_controller'], capabilities: CONTROLLER_CAPS },
      });
      try {
        const result = await runStoryboard(
          '',
          controllerStoryboard(
            order.map((agent, index) => ({
              id: `step_${index}`,
              title: `step ${index}`,
              task: 'get_products',
              agent,
            }))
          ),
          {
            ...RUN_OPTIONS,
            agents: {
              seller_a: { url: shared.url, auth: { type: 'bearer', token: 'tok-a' } },
              seller_b: { url: shared.url, auth: { type: 'bearer', token: 'tok-b' } },
            },
          }
        );
        const label = order.join(' then ');
        // No false negative: `seller_b`'s controller is not erased by
        // `seller_a` dispatching after it.
        assert.deepEqual(
          rows(result),
          [
            ['step_0', 'PASS'],
            ['step_1', 'PASS'],
          ],
          label
        );
        // Each step reached its own tenant, so the two keys really are
        // distinct routes over one URL.
        assert.deepEqual(
          shared.calls.filter(call => call.task !== 'get_adcp_capabilities'),
          order.map(agent => ({ tenant: agent === 'seller_a' ? 'tok-a' : 'tok-b', task: 'get_products' })),
          label
        );
      } finally {
        await closeConnections();
        await shared.close();
      }
    }
  });

  test('a shared URL cannot let an out-of-scope tenant vouch for its peer', async () => {
    // The false-green half of the same collapse. `ctl` advertises a
    // controller but serves only a phase it is not applicable to, so it
    // exercises no state; `seller` serves the state and has none. Keyed by
    // URL, `ctl`'s tool list overwrote `seller`'s entry and the gate passed —
    // the seller's step then ran against unseeded state. Pinned in both
    // phase orders, because the collapse was last-writer-wins.
    for (const ctlFirst of [false, true]) {
      const shared = await startSharedUrlAgent({
        'tok-seller': {
          tools: ['get_products'],
          capabilities: {
            supported_protocols: ['media_buy'],
            adcp: { major_versions: [3], supported_versions: ['3.1', '3.2'] },
          },
        },
        'tok-ctl': { tools: ['get_products', 'comply_test_controller'], capabilities: CONTROLLER_CAPS },
      });
      const sellerPhase = phaseOf(
        [{ id: 'discover', title: 'discover', task: 'get_products', agent: 'seller' }],
        'p_seller'
      );
      const ctlPhase = {
        id: 'p_ctl',
        title: 'p_ctl',
        requires_capability: { path: 'account.require_operator_auth', equals: true },
        steps: [{ id: 'ctl_read', title: 'ctl read', task: 'get_products', agent: 'ctl' }],
      };
      try {
        const result = await runStoryboard(
          '',
          { ...controllerStoryboard(), phases: ctlFirst ? [ctlPhase, sellerPhase] : [sellerPhase, ctlPhase] },
          {
            ...RUN_OPTIONS,
            agents: {
              seller: { url: shared.url, auth: { type: 'bearer', token: 'tok-seller' } },
              ctl: { url: shared.url, auth: { type: 'bearer', token: 'tok-ctl' } },
            },
          }
        );
        const label = ctlFirst ? 'ctl phase first' : 'seller phase first';
        const step = result.phases[0].steps[0];
        assert.equal(step.skip_reason, 'missing_test_controller', label);
        assert.equal(step.skip.requirement, 'controller', label);
        assert.deepEqual(
          shared.calls.filter(call => call.task !== 'get_adcp_capabilities'),
          [],
          `${label}: no step may reach the wire`
        );
        // The detail names the exact key, never the first key that happens to
        // share the URL, and it points at the peer that does advertise one.
        assert.match(step.skip.detail, /Route\(s\) exercised: \[seller\]/, label);
        assert.match(step.skip.detail, /Agent\(s\) \[ctl\] in this map do advertise it/, label);
        assert.equal(rollupOf(['gate_probe', 'seller'], [result, passingStub('seller')]), 'partial', label);
      } finally {
        await closeConnections();
        await shared.close();
      }
    }
  });

  test('non-routed seeding grades missing_test_controller from the agent’s own tools', async () => {
    // The seeding twin of the gate. Non-routed is the only reachable shape
    // today (routed + seeding throws above), and its provenance is the single
    // agent's own tool list, not a union.
    const seller = await startAgent({ tools: ['get_products'], protocols: ['media_buy'] });
    try {
      const result = await runStoryboard(
        seller.url,
        {
          ...controllerStoryboard(),
          prerequisites: { controller_seeding: true },
          fixtures: { products: [{ product_id: 'p1', name: 'P', delivery_type: 'guaranteed' }] },
        },
        RUN_OPTIONS
      );
      assert.ok(
        result.phases.flatMap(phase => phase.steps).every(step => step.skip_reason === 'missing_test_controller'),
        JSON.stringify(rows(result))
      );
    } finally {
      await closeConnections();
      await seller.close();
    }
  });
});
