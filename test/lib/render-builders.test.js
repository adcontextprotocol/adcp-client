const test = require('node:test');
const assert = require('node:assert');
const { Render, urlRender, htmlRender, bothRender } = require('../../dist/lib/index.js');

test('render builders', async t => {
  await t.test('urlRender injects output_format and forwards fields', () => {
    assert.deepStrictEqual(
      urlRender({
        render_id: 'r1',
        preview_url: 'https://preview.example/r1',
        role: 'primary',
        dimensions: { width: 300, height: 250 },
      }),
      {
        render_id: 'r1',
        preview_url: 'https://preview.example/r1',
        role: 'primary',
        dimensions: { width: 300, height: 250 },
        output_format: 'url',
      }
    );
  });

  await t.test('each builder tags its output with the canonical discriminator', () => {
    assert.strictEqual(urlRender({ render_id: 'r', preview_url: 'https://x', role: 'primary' }).output_format, 'url');
    assert.strictEqual(
      htmlRender({ render_id: 'r', preview_html: '<div></div>', role: 'primary' }).output_format,
      'html'
    );
    assert.strictEqual(
      bothRender({
        render_id: 'r',
        preview_url: 'https://x',
        preview_html: '<div></div>',
        role: 'primary',
      }).output_format,
      'both'
    );
  });

  await t.test('builder overwrites a foreign output_format that bypasses the types', () => {
    // The input type `Omit<T, 'output_format'>` forbids the discriminator at
    // compile time; spread order guarantees the correct tag still lands at
    // runtime if a caller casts around the types.
    const smuggled = { render_id: 'r', preview_html: '<div></div>', role: 'primary', output_format: 'url' };
    assert.strictEqual(htmlRender(smuggled).output_format, 'html');
  });

  await t.test('Render namespace exposes every builder and matches the named exports', () => {
    assert.deepStrictEqual(Object.keys(Render).sort(), ['both', 'html', 'url']);
    assert.strictEqual(Render.url, urlRender);
    assert.strictEqual(Render.html, htmlRender);
    assert.strictEqual(Render.both, bothRender);
  });
});
