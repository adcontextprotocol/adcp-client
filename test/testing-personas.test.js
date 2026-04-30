// Tests for canonical buyer personas at @adcp/sdk/testing/personas.
// Two layers of coverage:
//   1. Pure-fixture invariants — IDs unique, fields populated, brands
//      have plausible domains.
//   2. Wire-shape integration — each persona drives a real
//      DecisioningPlatform's get_products tool through dispatchTestRequest
//      and the seller observes the persona's brief / brand / account.

process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  ALL_PERSONAS,
  dtcSkincareBuyer,
  luxuryAutoBuyer,
  b2bSaasBuyer,
  restaurantLocalBuyer,
  buildAccountReference,
  buildBrandReference,
  buildGetProductsRequest,
  getPersonaById,
} = require('../dist/lib/testing/personas');
const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');

describe('Canonical buyer personas — fixture invariants', () => {
  it('ALL_PERSONAS contains the four shipped personas', () => {
    assert.strictEqual(ALL_PERSONAS.length, 4);
    assert.ok(ALL_PERSONAS.includes(dtcSkincareBuyer));
    assert.ok(ALL_PERSONAS.includes(luxuryAutoBuyer));
    assert.ok(ALL_PERSONAS.includes(b2bSaasBuyer));
    assert.ok(ALL_PERSONAS.includes(restaurantLocalBuyer));
  });

  it('every persona has unique id, populated brand + brief + budget', () => {
    const ids = new Set();
    for (const p of ALL_PERSONAS) {
      assert.ok(p.id, `persona missing id`);
      assert.ok(!ids.has(p.id), `duplicate persona id: ${p.id}`);
      ids.add(p.id);
      assert.ok(p.brand?.domain, `${p.id} missing brand.domain`);
      assert.ok(p.brand?.name, `${p.id} missing brand.name`);
      assert.ok(p.account_id, `${p.id} missing account_id`);
      assert.ok(p.promoted_offering, `${p.id} missing promoted_offering`);
      assert.ok(p.brief && p.brief.length > 50, `${p.id} brief too short`);
      assert.ok(typeof p.budget?.amount === 'number' && p.budget.amount > 0, `${p.id} budget invalid`);
      assert.ok(p.budget?.currency, `${p.id} missing budget.currency`);
      assert.ok(p.channels?.length, `${p.id} missing channels`);
    }
  });

  it('all brand domains use .example.com (no real-world branding)', () => {
    for (const p of ALL_PERSONAS) {
      assert.ok(
        p.brand.domain.endsWith('.example.com'),
        `${p.id} brand.domain must use .example.com — got ${p.brand.domain}`
      );
    }
  });

  it('getPersonaById returns the matching persona, undefined for unknown', () => {
    assert.strictEqual(getPersonaById('dtc_skincare_buyer'), dtcSkincareBuyer);
    assert.strictEqual(getPersonaById('luxury_auto_buyer'), luxuryAutoBuyer);
    assert.strictEqual(getPersonaById('not_a_real_id'), undefined);
  });
});

describe('Persona builders — wire-shape construction', () => {
  it('buildAccountReference returns the account_id arm of AccountReference', () => {
    assert.deepStrictEqual(buildAccountReference(dtcSkincareBuyer), { account_id: 'acc_glowlab' });
  });

  it('buildBrandReference returns just the domain', () => {
    assert.deepStrictEqual(buildBrandReference(luxuryAutoBuyer), { domain: 'velaramotors.example.com' });
  });

  it('buildGetProductsRequest assembles the wire shape from persona fields', () => {
    const req = buildGetProductsRequest(b2bSaasBuyer);
    assert.strictEqual(req.buying_mode, 'brief');
    assert.ok(req.brief.includes('Enterprise SaaS'));
    assert.deepStrictEqual(req.brand, { domain: 'threadline.example.com' });
    assert.deepStrictEqual(req.account, { account_id: 'acc_threadline' });
  });

  it('buildGetProductsRequest applies overrides on top of persona defaults', () => {
    const req = buildGetProductsRequest(restaurantLocalBuyer, {
      preferred_delivery_types: ['guaranteed'],
      time_budget: { value: 30, unit: 'seconds' },
    });
    // Persona-derived fields preserved
    assert.strictEqual(req.buying_mode, 'brief');
    assert.deepStrictEqual(req.account, { account_id: 'acc_anchoroak' });
    // Overrides applied
    assert.deepStrictEqual(req.preferred_delivery_types, ['guaranteed']);
    assert.deepStrictEqual(req.time_budget, { value: 30, unit: 'seconds' });
  });
});

describe('Personas — end-to-end against a DecisioningPlatform', () => {
  function buildSellerThatEchoesPersona(observed) {
    return {
      capabilities: {
        specialisms: ['sales-non-guaranteed'],
        creative_agents: [],
        channels: ['display'],
        pricingModels: ['cpm'],
        config: {},
      },
      statusMappers: {},
      accounts: {
        resolve: async ref => ({
          id: ref?.account_id ?? 'unknown',
          name: 'Persona Test Seller',
          status: 'active',
          metadata: {},
          authInfo: { kind: 'api_key' },
        }),
      },
      sales: {
        getProducts: async (req, ctx) => {
          observed.brief = req.brief;
          observed.brand_domain = req.brand?.domain;
          observed.account_id = ctx.account?.id;
          return { products: [] };
        },
        createMediaBuy: async () => ({
          media_buy_id: 'mb_1',
          status: 'pending_creatives',
          confirmed_at: '2026-04-29T00:00:00Z',
          packages: [],
        }),
        updateMediaBuy: async () => ({ media_buy_id: 'mb_1', status: 'active' }),
        syncCreatives: async () => [],
        getMediaBuyDelivery: async () => ({
          currency: 'USD',
          reporting_period: { start: '2026-04-01', end: '2026-04-30' },
          media_buy_deliveries: [],
        }),
      },
    };
  }

  for (const persona of [dtcSkincareBuyer, luxuryAutoBuyer, b2bSaasBuyer, restaurantLocalBuyer]) {
    it(`${persona.id} drives get_products with persona brief + brand + account`, async () => {
      const observed = {};
      const server = createAdcpServerFromPlatform(buildSellerThatEchoesPersona(observed), {
        name: 'persona-test',
        version: '0.0.1',
        validation: { requests: 'off', responses: 'off' },
      });
      const result = await server.dispatchTestRequest({
        method: 'tools/call',
        params: { name: 'get_products', arguments: buildGetProductsRequest(persona) },
      });
      assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
      assert.strictEqual(observed.brief, persona.brief, 'seller saw persona brief');
      assert.strictEqual(observed.brand_domain, persona.brand.domain, 'seller saw persona brand domain');
      assert.strictEqual(observed.account_id, persona.account_id, 'seller saw persona account_id');
    });
  }
});
