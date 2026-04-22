// Tier-3 seeder tests. Spins up in-process agents that implement create_*
// handlers, verifies seedFixtures captures IDs and degrades gracefully.

const { test, describe, after } = require('node:test');
const assert = require('node:assert');

const { seedFixtures, runConformance } = require('../../dist/lib/conformance/index.js');
const { serve, createAdcpServer, adcpError } = require('../../dist/lib/index.js');

function waitForListening(server) {
  return new Promise(resolve => {
    if (server.listening) return resolve();
    server.on('listening', resolve);
  });
}

function startAgent(config) {
  // Seeder tests use deliberately sparse handler fixtures. Opt out of the
  // strict response-validation default so VALIDATION_ERROR envelopes don't
  // short-circuit the seeder under test.
  const s = serve(
    () =>
      createAdcpServer({ name: 'Seed Test Agent', version: '1.0.0', validation: { responses: 'off' }, ...config }),
    { port: 0, onListening: () => {} }
  );
  return waitForListening(s).then(() => ({ server: s, port: s.address().port }));
}

describe('conformance: seedFixtures', () => {
  const agents = [];
  after(() => agents.forEach(a => a.server.close()));

  test('captures list_id, standards_id, and media_buy_id from a friendly agent', async () => {
    const createdMediaBuys = [];
    const { server, port } = await startAgent({
      mediaBuy: {
        getProducts: async () => ({
          products: [
            {
              product_id: 'prod_display',
              name: 'Display Standard',
              description: 'Test product',
              format_ids: [{ id: 'display_300x250', agent_url: 'https://test/' }],
              pricing_options: [{ pricing_option_id: 'po_cpm', model: 'cpm', cpm: 1.0, currency: 'USD' }],
              delivery_type: 'non_guaranteed',
            },
          ],
        }),
        createMediaBuy: async params => {
          const media_buy_id = 'mb_' + Math.random().toString(36).slice(2, 10);
          createdMediaBuys.push(media_buy_id);
          return {
            media_buy_id,
            packages: [{ package_id: 'pkg_' + media_buy_id, buyer_ref: params.packages[0].buyer_ref }],
          };
        },
      },
      governance: {
        createPropertyList: async params => ({
          list: { list_id: 'pl_' + Math.random().toString(36).slice(2, 8), name: params.name },
          auth_token: 'tok_test',
        }),
        createContentStandards: async () => ({
          standards_id: 'cs_' + Math.random().toString(36).slice(2, 8),
        }),
      },
    });
    agents.push({ server });

    // Restrict to the three seeders this stub implements so the test
    // isn't sensitive to future additions to the default seed set.
    const result = await seedFixtures(`http://localhost:${port}/mcp`, {
      protocol: 'mcp',
      seeders: ['create_property_list', 'create_content_standards', 'create_media_buy'],
    });

    assert.ok(Array.isArray(result.fixtures.list_ids) && result.fixtures.list_ids.length === 1, 'list_id captured');
    assert.ok(result.fixtures.list_ids[0].startsWith('pl_'));
    assert.ok(
      Array.isArray(result.fixtures.standards_ids) && result.fixtures.standards_ids.length === 1,
      'standards_id captured'
    );
    assert.ok(result.fixtures.standards_ids[0].startsWith('cs_'));
    assert.ok(
      Array.isArray(result.fixtures.media_buy_ids) && result.fixtures.media_buy_ids.length === 1,
      'media_buy_id captured'
    );
    assert.ok(result.fixtures.media_buy_ids[0].startsWith('mb_'));
    assert.equal(createdMediaBuys.length, 1, 'agent saw exactly one create_media_buy call');
    assert.deepEqual(result.warnings, [], 'no warnings on a clean run');
  });

  test('records a warning when create_property_list is rejected, keeps running other seeders', async () => {
    const { server, port } = await startAgent({
      governance: {
        createPropertyList: async () => adcpError('INVALID_REQUEST', 'no seeder lists allowed here'),
        createContentStandards: async () => ({ standards_id: 'cs_ok' }),
      },
    });
    agents.push({ server });

    const result = await seedFixtures(`http://localhost:${port}/mcp`, {
      protocol: 'mcp',
      seeders: ['create_property_list', 'create_content_standards'],
    });
    // create_media_buy omitted — ensures other seeders still run when one fails.
    assert.equal(result.fixtures.list_ids, undefined);
    assert.deepEqual(result.fixtures.standards_ids, ['cs_ok']);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0].seeder, 'create_property_list');
    assert.match(result.warnings[0].reason, /INVALID_REQUEST/);
  });

  test('sync_creatives seeds creative_ids via list_creative_formats preflight', async () => {
    // Minimal format: one required text asset. Seeder should pick it up,
    // synthesize { content: 'Conformance seed text' }, and capture the
    // creative_id from sync_creatives's response.
    const observed = { formatIds: [], assets: [] };
    const { server, port } = await startAgent({
      creative: {
        listCreativeFormats: async () => ({
          formats: [
            {
              format_id: { id: 'text_line', agent_url: 'https://test/' },
              name: 'Text Line',
              description: 'single text asset',
              assets: [{ asset_id: 'headline', asset_type: 'text', required: true, item_type: 'individual' }],
            },
          ],
        }),
        syncCreatives: async params => {
          observed.formatIds.push(params.creatives[0].format_id.id);
          observed.assets.push(params.creatives[0].assets);
          return {
            creatives: [{ creative_id: 'cre_seeded_abc', buyer_ref: params.creatives[0].creative_id }],
          };
        },
      },
    });
    agents.push({ server });

    const result = await seedFixtures(`http://localhost:${port}/mcp`, {
      protocol: 'mcp',
      seeders: ['sync_creatives'],
    });

    assert.deepEqual(result.fixtures.creative_ids, ['cre_seeded_abc']);
    assert.equal(observed.formatIds[0], 'text_line');
    assert.deepEqual(observed.assets[0], { headline: { content: 'Conformance seed text' } });
    assert.deepEqual(result.warnings, []);
  });

  test('sync_creatives warns when no format has a synthesizable required-asset set', async () => {
    const { server, port } = await startAgent({
      creative: {
        listCreativeFormats: async () => ({
          formats: [
            {
              format_id: { id: 'exotic', agent_url: 'https://test/' },
              name: 'Exotic',
              description: 'requires something unknown',
              assets: [{ asset_id: 'mystery', asset_type: 'vast', required: true, item_type: 'individual' }],
            },
          ],
        }),
      },
    });
    agents.push({ server });

    const result = await seedFixtures(`http://localhost:${port}/mcp`, {
      protocol: 'mcp',
      seeders: ['sync_creatives'],
    });
    assert.equal(result.fixtures.creative_ids, undefined);
    assert.ok(result.warnings[0].reason.includes('synthesizable'));
  });

  test('brand option is threaded through create_media_buy seeder', async () => {
    let receivedBrand;
    const { server, port } = await startAgent({
      mediaBuy: {
        getProducts: async () => ({
          products: [
            {
              product_id: 'prod1',
              name: 'p',
              description: 'x',
              format_ids: [{ id: 'f', agent_url: 'https://t/' }],
              pricing_options: [{ pricing_option_id: 'po', model: 'cpm', cpm: 1, currency: 'USD' }],
              delivery_type: 'non_guaranteed',
            },
          ],
        }),
        createMediaBuy: async params => {
          receivedBrand = params.brand;
          return { media_buy_id: 'mb_1', packages: [{ package_id: 'pkg_1' }] };
        },
      },
    });
    agents.push({ server });

    await seedFixtures(`http://localhost:${port}/mcp`, {
      protocol: 'mcp',
      seeders: ['create_media_buy'],
      brand: { domain: 'custom-brand.example', brand_id: 'custom' },
    });
    assert.deepEqual(receivedBrand, { domain: 'custom-brand.example', brand_id: 'custom' });
  });

  test('create_media_buy warns when get_products returns no products', async () => {
    const { server, port } = await startAgent({
      mediaBuy: {
        getProducts: async () => ({ products: [] }),
      },
    });
    agents.push({ server });

    const result = await seedFixtures(`http://localhost:${port}/mcp`, {
      protocol: 'mcp',
      seeders: ['create_media_buy'],
    });
    assert.equal(result.fixtures.media_buy_ids, undefined);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0].reason, /no products/);
  });
});

describe('conformance: runConformance autoSeed', () => {
  const agents = [];
  after(() => agents.forEach(a => a.server.close()));

  test('autoSeed runs the seeder, merges IDs into fixtures, and adds update tools to the default set', async () => {
    let updatePropertyListCalls = 0;
    const capturedListIds = new Set();
    const { server, port } = await startAgent({
      governance: {
        createPropertyList: async params => ({
          list: { list_id: 'pl_seed_123', name: params.name },
          auth_token: 'tok',
        }),
        createContentStandards: async () => ({ standards_id: 'cs_seed_456' }),
        updatePropertyList: async params => {
          updatePropertyListCalls++;
          capturedListIds.add(params.list_id);
          return { list: { list_id: params.list_id, name: params.name ?? 'unchanged' }, auth_token: 'tok' };
        },
        listPropertyLists: async () => ({ lists: [] }),
        getPropertyList: async () => adcpError('REFERENCE_NOT_FOUND', 'not found'),
        updateContentStandards: async params => ({ standards_id: params.standards_id }),
        listContentStandards: async () => ({ standards: [] }),
        getContentStandards: async () => adcpError('REFERENCE_NOT_FOUND', 'not found'),
      },
    });
    agents.push({ server });

    const report = await runConformance(`http://localhost:${port}/mcp`, {
      seed: 5,
      tools: ['update_property_list'],
      turnBudget: 3,
      protocol: 'mcp',
      autoSeed: true,
    });

    assert.equal(report.autoSeeded, true);
    assert.deepEqual(report.fixturesUsed.list_ids, ['pl_seed_123']);
    assert.deepEqual(report.fixturesUsed.standards_ids, ['cs_seed_456']);
    assert.ok(updatePropertyListCalls > 0, 'update_property_list was called');
    assert.ok(capturedListIds.has('pl_seed_123'), 'seeded list_id was injected into update_property_list');
    // The two governance seeders ran cleanly. create_media_buy is expected
    // to warn here — this stub only implements the governance domain — so
    // we assert per-seeder rather than a blanket empty-array check.
    const governanceWarnings = report.seedWarnings.filter(
      w => w.seeder === 'create_property_list' || w.seeder === 'create_content_standards'
    );
    assert.deepEqual(governanceWarnings, [], 'governance seeders ran cleanly');
  });

  test('explicit fixtures override auto-seeded pool for the same key', async () => {
    const { server, port } = await startAgent({
      governance: {
        createPropertyList: async () => ({
          list: { list_id: 'pl_SEEDED', name: 'seed' },
          auth_token: 'tok',
        }),
        createContentStandards: async () => ({ standards_id: 'cs_SEEDED' }),
        listPropertyLists: async () => ({ lists: [] }),
        getPropertyList: async () => adcpError('REFERENCE_NOT_FOUND', 'not found'),
      },
    });
    agents.push({ server });

    const report = await runConformance(`http://localhost:${port}/mcp`, {
      seed: 5,
      tools: ['get_property_list'],
      turnBudget: 2,
      protocol: 'mcp',
      autoSeed: true,
      // Caller overrides the seeded list_ids pool with their own known-good IDs.
      fixtures: { list_ids: ['pl_CALLER_OVERRIDE'] },
    });

    assert.deepEqual(report.fixturesUsed.list_ids, ['pl_CALLER_OVERRIDE']);
    // standards_ids untouched by override, still from seeder
    assert.deepEqual(report.fixturesUsed.standards_ids, ['cs_SEEDED']);
  });

  test('empty explicit fixture array does not wipe the seeded pool', async () => {
    // Regression: an early `{...seeded, ...explicit}` spread let an empty
    // array passed in options.fixtures silently replace a populated seeded
    // pool. Now empty arrays fall through.
    const { server, port } = await startAgent({
      governance: {
        createPropertyList: async () => ({
          list: { list_id: 'pl_SEEDED_OK', name: 's' },
          auth_token: 'tok',
        }),
      },
    });
    agents.push({ server });

    const report = await runConformance(`http://localhost:${port}/mcp`, {
      seed: 5,
      tools: ['list_content_standards'], // any non-update tool
      turnBudget: 1,
      protocol: 'mcp',
      autoSeed: true,
      // User builds fixtures dynamically and ends up with an empty array —
      // should NOT wipe the seeded list_ids pool.
      fixtures: { list_ids: [], creative_ids: ['cre_extra'] },
    });

    assert.deepEqual(report.fixturesUsed.list_ids, ['pl_SEEDED_OK'], 'empty explicit array did not wipe seeded');
    assert.deepEqual(report.fixturesUsed.creative_ids, ['cre_extra'], 'non-empty explicit still wins');
  });

  test('autoSeed warnings surface on the report when a seeder fails', async () => {
    const { server, port } = await startAgent({
      governance: {
        createPropertyList: async () => adcpError('AUTH_REQUIRED', 'seed rejected'),
        createContentStandards: async () => ({ standards_id: 'cs_ok' }),
      },
    });
    agents.push({ server });

    const report = await runConformance(`http://localhost:${port}/mcp`, {
      seed: 5,
      tools: ['list_content_standards'], // any non-update tool so we don't need every handler
      turnBudget: 1,
      protocol: 'mcp',
      autoSeed: true,
    });

    assert.ok(
      report.seedWarnings.some(w => w.seeder === 'create_property_list'),
      'expected a seed warning for create_property_list'
    );
    assert.deepEqual(report.fixturesUsed.standards_ids, ['cs_ok'], 'non-failing seeders still populate');
  });
});
