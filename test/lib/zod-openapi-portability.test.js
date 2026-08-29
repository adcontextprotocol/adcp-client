const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

describe('public Zod schema portability', () => {
  test('ProductSchema renders as OpenAPI 3.1 with every canonical format branch', async () => {
    const [{ ProductSchema }, { createDocument }] = await Promise.all([
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
    for (const formatKind of [
      'agent_placement',
      'audio_daast',
      'audio_hosted',
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
  });
});
