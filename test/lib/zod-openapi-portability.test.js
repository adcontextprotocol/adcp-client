const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

function findSinglePrefixMinItemsTwo(value, path = '$', matches = []) {
  if (!value || typeof value !== 'object') return matches;
  if (value.minItems === 2 && Array.isArray(value.prefixItems) && value.prefixItems.length === 1) {
    matches.push(path);
  }
  for (const [key, child] of Object.entries(value)) {
    findSinglePrefixMinItemsTwo(child, `${path}.${key}`, matches);
  }
  return matches;
}

describe('public Zod schema portability', () => {
  test('an adopter extension does not repeat Product format intersection blocks', async () => {
    const [{ ProductSchema }, { createDocument }, { z }] = await Promise.all([
      import('../../dist/lib/schemas/index.js'),
      import('zod-openapi'),
      import('zod'),
    ]);
    const adopterProduct = ProductSchema.extend({
      product_id: z.string().min(1),
      ext: z.object({ local: z.string().optional() }),
    });
    const document = createDocument({
      openapi: '3.1.0',
      info: { title: 'adopter-schema-portability', version: '1.0.0' },
      components: { schemas: { InterchangeProduct: adopterProduct } },
      paths: {},
    });
    const component = document.components.schemas.InterchangeProduct;
    const formatItems = component.properties.format_options.items;
    const serializedMembers = formatItems.allOf.map(member => JSON.stringify(member));
    const renderedBytes = Buffer.byteLength(JSON.stringify(document), 'utf8');

    assert.equal(formatItems.allOf.length, 2);
    assert.equal(new Set(serializedMembers).size, serializedMembers.length);
    assert.ok(
      renderedBytes < 1024 * 1024,
      `extended ProductSchema OpenAPI document must stay below 1 MiB; rendered ${(renderedBytes / 1024 / 1024).toFixed(2)} MiB`
    );
  });

  test('ProductSchema renders as OpenAPI 3.1 with every canonical format branch', async () => {
    const [{ PostalAreaSupportSchema, ProductSchema, ProvenanceSchema }, { createDocument }] = await Promise.all([
      import('../../dist/lib/schemas/index.js'),
      import('zod-openapi'),
    ]);

    const document = createDocument({
      openapi: '3.1.0',
      info: { title: 'adcp-schema-portability', version: '1.0.0' },
      paths: {
        '/products': {
          get: {
            responses: {
              200: {
                description: 'ok',
                content: { 'application/json': { schema: ProductSchema } },
              },
            },
          },
        },
      },
    });

    assert.equal(document.openapi, '3.1.0');
    assert.ok(document.paths['/products']);
    const rendered = JSON.stringify(document);
    const renderedBytes = Buffer.byteLength(rendered, 'utf8');
    assert.ok(
      renderedBytes < 5 * 1024 * 1024,
      `ProductSchema OpenAPI document must stay below 5 MiB; rendered ${(renderedBytes / 1024 / 1024).toFixed(2)} MiB`
    );
    assert.deepEqual(
      findSinglePrefixMinItemsTwo(document),
      [],
      'single-prefix minItems: 1 arrays must not be projected as minItems: 2'
    );
    for (const formatKind of [
      'agent_placement',
      'audio_daast',
      'audio_hosted',
      'audio_vast',
      'coordinated_placements',
      'display_tag',
      'html5',
      'image',
      'image_carousel',
      'native_in_feed',
      'responsive_creative',
      'seller_rendered_stateful_display',
      'sponsored_placement',
      'video_hosted',
      'video_vast',
    ]) {
      assert.ok(
        rendered.includes(`\"format_kind\":{\"type\":\"string\",\"const\":\"${formatKind}\"}`),
        `OpenAPI output must retain the ${formatKind} branch`
      );
    }

    const postalDocument = createDocument({
      openapi: '3.1.0',
      info: { title: 'adcp-postal-schema-portability', version: '1.0.0' },
      paths: {
        '/postal-support': {
          get: {
            responses: {
              200: {
                description: 'ok',
                content: { 'application/json': { schema: PostalAreaSupportSchema } },
              },
            },
          },
        },
      },
    });
    assert.ok(
      !JSON.stringify(postalDocument).includes('"prefixItems"'),
      'PostalAreaSupportSchema arrays must render as OpenAPI arrays, not tuples'
    );

    const provenanceDocument = createDocument({
      openapi: '3.1.0',
      info: { title: 'adcp-provenance-schema-portability', version: '1.0.0' },
      paths: {
        '/provenance': {
          get: {
            responses: {
              200: {
                description: 'ok',
                content: { 'application/json': { schema: ProvenanceSchema } },
              },
            },
          },
        },
      },
    });
    assert.ok(
      !JSON.stringify(provenanceDocument).includes('"prefixItems"'),
      'complex provenance arrays must render as OpenAPI arrays, not tuples'
    );
  });
});
