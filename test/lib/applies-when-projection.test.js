'use strict';

// Prototype coverage for the proposed `x-adcp-applies-when` annotation
// (adcontextprotocol/adcp#8452 / #8454). The SDK's bundled AdCP schemas don't
// carry the annotation yet, so the unit tests use fixture schemas shaped like
// the bundled MCP tool schemas: one document whose `$ref`s point at its own
// `$defs` through the document `$id`.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');

const {
  APPLIES_WHEN_KEYWORD,
  appliesWhenSatisfied,
  projectSchemaForCapabilities,
} = require('../../dist/lib/schemas/index.js');

const ID = 'https://example.test/schemas/mcp/media-buy/get-products-response.json';
const ref = def => ({ $ref: `${ID}#/$defs/${def.replace(/\//g, '~1')}` });
const when = (annotation, schema) => ({ [APPLIES_WHEN_KEYWORD]: annotation, ...schema });
const NON_GUARANTEED = { delivery_types: ['non_guaranteed'] };
const GUARANTEED = { delivery_types: ['guaranteed'] };

function productResponseFixture() {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: ID,
    type: 'object',
    properties: {
      products: { type: 'array', items: ref('external:core/product.json') },
    },
    required: ['products'],
    $defs: {
      'external:core/product.json': {
        type: 'object',
        properties: {
          product_id: { type: 'string' },
          delivery_type: { type: 'string', enum: ['guaranteed', 'non_guaranteed'] },
          cancellation_policy: when(GUARANTEED, ref('external:core/cancellation-policy.json')),
          conversion_tracking: when({ capabilities: ['media_buy.conversion_tracking'] }, { type: 'object' }),
          trusted_match: when({ capabilities: ['media_buy.execution.trusted_match'] }, { type: 'object' }),
          pricing_options: {
            type: 'array',
            items: {
              oneOf: [ref('external:pricing-options/cpm-option.json'), ref('external:pricing-options/cpc-option.json')],
            },
          },
        },
        required: ['product_id', 'delivery_type', 'pricing_options'],
        additionalProperties: true,
      },
      'external:pricing-options/cpm-option.json': {
        type: 'object',
        properties: {
          pricing_option_id: { type: 'string' },
          pricing_model: { const: 'cpm' },
          fixed_price: { type: 'number' },
          floor_price: when(NON_GUARANTEED, { type: 'number' }),
          price_guidance: when(NON_GUARANTEED, ref('external:pricing-options/price-guidance.json')),
        },
        required: ['pricing_option_id', 'pricing_model'],
      },
      'external:pricing-options/cpc-option.json': {
        type: 'object',
        properties: {
          pricing_option_id: { type: 'string' },
          pricing_model: { const: 'cpc' },
          floor_price: when(NON_GUARANTEED, { type: 'number' }),
        },
        required: ['pricing_option_id', 'pricing_model'],
      },
      'external:pricing-options/price-guidance.json': {
        type: 'object',
        properties: { p50: { type: 'number' } },
      },
      'external:core/cancellation-policy.json': {
        type: 'object',
        properties: { notice_days: { type: 'integer' } },
      },
    },
  };
}

const defs = schema => schema.$defs;
const propsOf = (schema, def) => Object.keys(defs(schema)[def].properties);
const CPM = 'external:pricing-options/cpm-option.json';
const CPC = 'external:pricing-options/cpc-option.json';
const PRODUCT = 'external:core/product.json';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

describe('projectSchemaForCapabilities: delivery types', () => {
  test('a guaranteed-only seller drops floor_price and price_guidance', () => {
    const projected = projectSchemaForCapabilities(productResponseFixture(), {
      media_buy: { supported_delivery_types: ['guaranteed'] },
    });
    assert.deepEqual(propsOf(projected, CPM), ['pricing_option_id', 'pricing_model', 'fixed_price']);
    assert.deepEqual(propsOf(projected, CPC), ['pricing_option_id', 'pricing_model']);
    assert.ok(propsOf(projected, PRODUCT).includes('cancellation_policy'));
    // The $ref target stays in $defs: projection removes properties, never definitions.
    assert.ok(defs(projected)['external:pricing-options/price-guidance.json']);
  });

  test('a non-guaranteed-only seller drops cancellation_policy', () => {
    const projected = projectSchemaForCapabilities(productResponseFixture(), {
      media_buy: { supported_delivery_types: ['non_guaranteed'] },
    });
    assert.ok(!propsOf(projected, PRODUCT).includes('cancellation_policy'));
    assert.deepEqual(propsOf(projected, CPM), [
      'pricing_option_id',
      'pricing_model',
      'fixed_price',
      'floor_price',
      'price_guidance',
    ]);
  });

  test('undeclared delivery types keep every delivery-keyed property (fail open)', () => {
    const capabilities = {
      media_buy: { conversion_tracking: {}, execution: { trusted_match: {} }, supported_pricing_models: ['cpm'] },
    };
    const schema = productResponseFixture();
    const projected = projectSchemaForCapabilities(schema, capabilities);
    assert.equal(projected, schema, 'nothing removed, so the input is returned as-is');

    // An empty list is invalid (minItems: 1) and is treated as undeclared, not as "sells nothing".
    const empty = projectSchemaForCapabilities(schema, {
      ...capabilities,
      media_buy: { ...capabilities.media_buy, supported_delivery_types: [] },
    });
    assert.equal(empty, schema);
  });

  test('pricing_models matches media_buy.supported_pricing_models and fails open when undeclared', () => {
    const schema = {
      type: 'object',
      properties: { cpcv_terms: when({ pricing_models: ['cpcv'] }, { type: 'object' }) },
    };
    const kept = projectSchemaForCapabilities(schema, { media_buy: { supported_pricing_models: ['cpm', 'cpcv'] } });
    assert.deepEqual(Object.keys(kept.properties), ['cpcv_terms']);
    const dropped = projectSchemaForCapabilities(schema, { media_buy: { supported_pricing_models: ['cpm'] } });
    assert.deepEqual(Object.keys(dropped.properties), []);
    assert.equal(projectSchemaForCapabilities(schema, { media_buy: {} }), schema);
  });
});

describe('projectSchemaForCapabilities: capability paths', () => {
  const trackingSchema = () => ({
    type: 'object',
    properties: {
      conversion_tracking: when({ capabilities: ['media_buy.conversion_tracking'] }, { type: 'object' }),
      trusted_match: when({ capabilities: ['media_buy.execution.trusted_match'] }, { type: 'object' }),
    },
  });
  const keptNames = capabilities =>
    Object.keys(projectSchemaForCapabilities(trackingSchema(), capabilities).properties);

  test('a present path keeps the property, including nested paths and non-boolean values', () => {
    assert.deepEqual(keptNames({ media_buy: { conversion_tracking: {}, execution: { trusted_match: {} } } }), [
      'conversion_tracking',
      'trusted_match',
    ]);
    assert.deepEqual(keptNames({ media_buy: { conversion_tracking: true, execution: { trusted_match: 0 } } }), [
      'conversion_tracking',
      'trusted_match',
    ]);
  });

  test('an absent path drops the property', () => {
    assert.deepEqual(keptNames({ media_buy: { execution: {} } }), []);
    assert.deepEqual(keptNames({ signals: {} }), []);
    assert.deepEqual(keptNames({ media_buy: { conversion_tracking: null } }), []);
  });

  test('a path declared false drops the property', () => {
    assert.deepEqual(keptNames({ media_buy: { conversion_tracking: false, execution: { trusted_match: {} } } }), [
      'trusted_match',
    ]);
  });

  test('a seller-level path is independent of the product-level property it gates', () => {
    const projected = projectSchemaForCapabilities(productResponseFixture(), {
      media_buy: { supported_delivery_types: ['guaranteed', 'non_guaranteed'], conversion_tracking: {} },
    });
    assert.ok(propsOf(projected, PRODUCT).includes('conversion_tracking'));
    assert.ok(!propsOf(projected, PRODUCT).includes('trusted_match'));
  });
});

describe('projectSchemaForCapabilities: OR semantics', () => {
  const schema = {
    type: 'object',
    properties: {
      mixed: when(
        { delivery_types: ['guaranteed'], pricing_models: ['cpp'], capabilities: ['media_buy.conversion_tracking'] },
        { type: 'object' }
      ),
    },
  };
  const kept = capabilities => 'mixed' in projectSchemaForCapabilities(schema, capabilities).properties;

  test('any single matching key keeps the property', () => {
    const base = { supported_delivery_types: ['non_guaranteed'], supported_pricing_models: ['cpm'] };
    assert.equal(kept({ media_buy: { ...base } }), false, 'no key matches');
    assert.equal(kept({ media_buy: { ...base, supported_delivery_types: ['guaranteed'] } }), true);
    assert.equal(kept({ media_buy: { ...base, supported_pricing_models: ['cpm', 'cpp'] } }), true);
    assert.equal(kept({ media_buy: { ...base, conversion_tracking: {} } }), true);
  });

  test('one undeclared list keeps the property even when the other keys do not match', () => {
    assert.equal(kept({ media_buy: { supported_pricing_models: ['cpm'] } }), true);
  });

  test('unknown keys and malformed annotations keep the property', () => {
    assert.equal(appliesWhenSatisfied({ channels: ['ctv'] }, { media_buy: {} }), true);
    assert.equal(
      appliesWhenSatisfied(
        { delivery_types: ['guaranteed'], channels: ['ctv'] },
        { media_buy: { supported_delivery_types: ['non_guaranteed'] } }
      ),
      true
    );
    assert.equal(appliesWhenSatisfied({}, { media_buy: {} }), true);
    assert.equal(appliesWhenSatisfied({ delivery_types: [] }, { media_buy: {} }), true);
    assert.equal(appliesWhenSatisfied('guaranteed', { media_buy: {} }), true);
  });
});

describe('projectSchemaForCapabilities: traversal', () => {
  const NG_ONLY = { media_buy: { supported_delivery_types: ['guaranteed'] } };

  test('removes annotated properties in nested objects and array items', () => {
    const schema = {
      type: 'object',
      properties: {
        packages: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              pricing: {
                type: 'object',
                properties: { fixed_price: { type: 'number' }, floor_price: when(NON_GUARANTEED, { type: 'number' }) },
              },
            },
          },
        },
        tuple: {
          type: 'array',
          prefixItems: [{ type: 'object', properties: { floor_price: when(NON_GUARANTEED, { type: 'number' }) } }],
          items: [{ type: 'object', properties: { floor_price: when(NON_GUARANTEED, { type: 'number' }) } }],
        },
        either: {
          anyOf: [
            { type: 'object', properties: { floor_price: when(NON_GUARANTEED, { type: 'number' }) } },
            { allOf: [{ properties: { price_guidance: when(NON_GUARANTEED, { type: 'object' }) } }] },
          ],
        },
        conditional: {
          if: { properties: { kind: { const: 'auction' } } },
          then: { properties: { floor_price: when(NON_GUARANTEED, { type: 'number' }) } },
        },
      },
      definitions: {
        legacy: { type: 'object', properties: { floor_price: when(NON_GUARANTEED, { type: 'number' }) } },
      },
    };
    const projected = projectSchemaForCapabilities(schema, NG_ONLY);
    const pricing = projected.properties.packages.items.properties.pricing;
    assert.deepEqual(Object.keys(pricing.properties), ['fixed_price']);
    assert.deepEqual(projected.properties.tuple.prefixItems[0].properties, {});
    assert.deepEqual(projected.properties.tuple.items[0].properties, {});
    assert.deepEqual(projected.properties.either.anyOf[0].properties, {});
    assert.deepEqual(projected.properties.either.anyOf[1].allOf[0].properties, {});
    assert.deepEqual(projected.properties.conditional.then.properties, {});
    assert.deepEqual(projected.definitions.legacy.properties, {});
    assert.equal(
      projected.properties.conditional.if,
      schema.properties.conditional.if,
      'unchanged subtrees are shared'
    );
  });

  test('leaves $ref pointers intact so every reference sees the projected target', () => {
    const schema = productResponseFixture();
    const projected = projectSchemaForCapabilities(schema, NG_ONLY);
    assert.deepEqual(projected.properties, schema.properties);
    assert.deepEqual(
      defs(projected)[PRODUCT].properties.pricing_options,
      defs(schema)[PRODUCT].properties.pricing_options
    );
    assert.ok(!('floor_price' in defs(projected)[CPM].properties));
  });

  test('does not treat instance data (const/default/enum/examples) as schema', () => {
    const lookalike = { properties: { floor_price: when(NON_GUARANTEED, { type: 'number' }) } };
    const schema = { type: 'object', default: lookalike, examples: [lookalike], const: lookalike };
    assert.equal(projectSchemaForCapabilities(schema, NG_ONLY), schema);
  });
});

describe('projectSchemaForCapabilities: safety', () => {
  const NG_ONLY = { media_buy: { supported_delivery_types: ['guaranteed'] } };

  test('never drops a required property, even when annotated', () => {
    const annotated = () => when(NON_GUARANTEED, { type: 'number' });
    const schema = {
      type: 'object',
      properties: {
        direct: annotated(),
        via_all_of: annotated(),
        via_then: annotated(),
        dependent: annotated(),
        optional: annotated(),
        trigger: { type: 'boolean' },
      },
      required: ['direct'],
      allOf: [{ required: ['via_all_of'] }],
      if: { required: ['trigger'] },
      then: { required: ['via_then'] },
      dependentRequired: { trigger: ['dependent'] },
    };
    const projected = projectSchemaForCapabilities(schema, NG_ONLY);
    assert.deepEqual(Object.keys(projected.properties), ['direct', 'via_all_of', 'via_then', 'dependent', 'trigger']);
    assert.deepEqual(projected.required, ['direct']);
  });

  test('never mutates its input', () => {
    const schema = deepFreeze(productResponseFixture());
    const before = JSON.stringify(schema);
    for (const capabilities of [
      NG_ONLY,
      { media_buy: { supported_delivery_types: ['non_guaranteed'] } },
      { media_buy: {} },
      {},
    ]) {
      const projected = projectSchemaForCapabilities(schema, capabilities);
      assert.notEqual(projected, undefined);
    }
    assert.equal(JSON.stringify(schema), before);
  });

  test('keeps a property literally named __proto__ as data', () => {
    const schema = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string"},' +
        '"floor_price":{"x-adcp-applies-when":{"delivery_types":["non_guaranteed"]},"type":"number"}}}'
    );
    const projected = projectSchemaForCapabilities(schema, NG_ONLY);
    assert.deepEqual(Object.keys(projected.properties), ['__proto__']);
    assert.equal(Object.getPrototypeOf(projected.properties), Object.prototype);
  });

  test('returns the input unchanged when there are no capabilities', () => {
    const schema = productResponseFixture();
    assert.equal(projectSchemaForCapabilities(schema, undefined), schema);
    assert.equal(projectSchemaForCapabilities(schema, null), schema);
  });
});

// ---------------------------------------------------------------------------
// createAdcpServer({ projectToolSchemas })
// ---------------------------------------------------------------------------

function annotatedCustomTool() {
  const { z } = require('zod');
  return {
    description: 'Fixture tool whose input schema carries x-adcp-applies-when.',
    inputSchema: {
      product_id: z.string(),
      floor_price: z
        .number()
        .optional()
        .meta({ [APPLIES_WHEN_KEYWORD]: NON_GUARANTEED }),
      cancellation_policy: z
        .object({ notice_days: z.number() })
        .optional()
        .meta({ [APPLIES_WHEN_KEYWORD]: GUARANTEED }),
    },
    handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  };
}

function makeServer(overrides = {}) {
  const { createAdcpServer } = require('../../dist/lib/server/create-adcp-server.js');
  return createAdcpServer({
    name: 'applies-when-projection-test',
    version: '1.0.0',
    validation: { requests: 'off', responses: 'off' },
    mediaBuy: { getProducts: async () => ({ products: [] }) },
    capabilities: {
      overrides: { media_buy: { supported_delivery_types: ['guaranteed'] } },
    },
    customTools: { annotated_fixture: annotatedCustomTool() },
    ...overrides,
  });
}

async function legacyList(server) {
  return server.dispatchTestRequest({ method: 'tools/list' });
}

async function modernList(server, t) {
  const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');
  const { createModernMcpServerAdapter } = require('../../dist/lib/server/mcp-modern-server.js');
  const adapter = createModernMcpServerAdapter(server);
  const httpServer = createServer((req, res) => void adapter.handle(req, res));
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const client = new Client(
    { name: 'applies-when-projection-client', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } }
  );
  t.after(async () => {
    await client.close().catch(() => {});
    await adapter.close();
    await new Promise(resolve => httpServer.close(resolve));
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${httpServer.address().port}/mcp`)));
  return client.listTools();
}

const fixtureInputProps = listed =>
  Object.keys(listed.tools.find(tool => tool.name === 'annotated_fixture').inputSchema.properties);

describe('createAdcpServer projectToolSchemas', () => {
  for (const profile of ['all', 'media-buy']) {
    test(`off (default) leaves ${profile} tools/list byte-identical on both transports`, async t => {
      const omitted = makeServer({ mcpToolProfile: profile });
      const explicitOff = makeServer({ mcpToolProfile: profile, projectToolSchemas: false });
      const { getToolSchemaProjector } = require('../../dist/lib/server/adcp-server.js');
      assert.equal(getToolSchemaProjector(omitted), undefined);
      assert.equal(getToolSchemaProjector(explicitOff), undefined);
      assert.equal(JSON.stringify(await legacyList(explicitOff)), JSON.stringify(await legacyList(omitted)));
      assert.equal(JSON.stringify(await modernList(explicitOff, t)), JSON.stringify(await modernList(omitted, t)));
    });

    test(`on is a no-op for the bundled, unannotated ${profile} schemas`, async t => {
      const capabilities = { overrides: { media_buy: { supported_delivery_types: ['guaranteed'] } } };
      const off = makeServer({ mcpToolProfile: profile, customTools: {}, capabilities });
      const on = makeServer({ mcpToolProfile: profile, customTools: {}, capabilities, projectToolSchemas: true });
      assert.equal(JSON.stringify(await legacyList(on)), JSON.stringify(await legacyList(off)));
      assert.equal(JSON.stringify(await modernList(on, t)), JSON.stringify(await modernList(off, t)));
    });
  }

  test('on narrows annotated tool schemas to the declared delivery types on both transports', async t => {
    const off = makeServer({ mcpToolProfile: 'all' });
    assert.deepEqual(fixtureInputProps(await legacyList(off)), ['product_id', 'floor_price', 'cancellation_policy']);
    assert.deepEqual(fixtureInputProps(await modernList(off, t)), ['product_id', 'floor_price', 'cancellation_policy']);

    const guaranteedOnly = makeServer({ mcpToolProfile: 'all', projectToolSchemas: true });
    assert.deepEqual(fixtureInputProps(await legacyList(guaranteedOnly)), ['product_id', 'cancellation_policy']);
    assert.deepEqual(fixtureInputProps(await modernList(guaranteedOnly, t)), ['product_id', 'cancellation_policy']);

    const undeclared = makeServer({ mcpToolProfile: 'all', projectToolSchemas: true, capabilities: {} });
    assert.deepEqual(fixtureInputProps(await legacyList(undeclared)), [
      'product_id',
      'floor_price',
      'cancellation_policy',
    ]);
  });

  test('on leaves call-time handling untouched: a dropped field is still accepted on tools/call', async () => {
    let received;
    const tool = annotatedCustomTool();
    const server = makeServer({
      mcpToolProfile: 'all',
      projectToolSchemas: true,
      customTools: {
        annotated_fixture: {
          ...tool,
          handler: async args => {
            received = args;
            return { content: [{ type: 'text', text: 'ok' }] };
          },
        },
      },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'annotated_fixture', arguments: { product_id: 'p1', floor_price: 2.5 } },
    });
    assert.notEqual(result.isError, true);
    assert.equal(received.floor_price, 2.5);
  });
});
