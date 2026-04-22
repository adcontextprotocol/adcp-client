const test = require('node:test');
const assert = require('node:assert');
const {
  Asset,
  imageAsset,
  videoAsset,
  audioAsset,
  textAsset,
  urlAsset,
  htmlAsset,
  javascriptAsset,
  cssAsset,
  markdownAsset,
  webhookAsset,
} = require('../../dist/lib/index.js');

test('asset builders', async t => {
  await t.test('imageAsset injects asset_type and forwards fields', () => {
    assert.deepStrictEqual(imageAsset({ url: 'https://cdn.example/a.png', width: 300, height: 250, alt_text: 'hi' }), {
      url: 'https://cdn.example/a.png',
      width: 300,
      height: 250,
      alt_text: 'hi',
      asset_type: 'image',
    });
  });

  await t.test('each builder tags its output with the canonical discriminator', () => {
    assert.strictEqual(videoAsset({ url: 'x', width: 1920, height: 1080 }).asset_type, 'video');
    assert.strictEqual(audioAsset({ url: 'x' }).asset_type, 'audio');
    assert.strictEqual(textAsset({ content: 'x' }).asset_type, 'text');
    assert.strictEqual(urlAsset({ url: 'x' }).asset_type, 'url');
    assert.strictEqual(htmlAsset({ content: '<div></div>' }).asset_type, 'html');
    assert.strictEqual(javascriptAsset({ content: '/* */' }).asset_type, 'javascript');
    assert.strictEqual(cssAsset({ content: '/* */' }).asset_type, 'css');
    assert.strictEqual(markdownAsset({ content: '# title' }).asset_type, 'markdown');
    assert.strictEqual(
      webhookAsset({
        url: 'https://hook.example/dco',
        response_type: 'html',
        security: { method: 'hmac_sha256', hmac_header: 'X-Signature' },
      }).asset_type,
      'webhook'
    );
  });

  await t.test('builder overwrites a foreign asset_type that bypasses the types', () => {
    // The input type `Omit<T, 'asset_type'>` forbids the discriminator at
    // compile time; spread order guarantees the correct tag still lands at
    // runtime if a caller casts around the types.
    const smuggled = { content: 'hello', asset_type: 'image' };
    assert.strictEqual(textAsset(smuggled).asset_type, 'text');
  });

  await t.test('Asset namespace exposes every builder and produces matching output', () => {
    const expected = ['image', 'video', 'audio', 'text', 'url', 'html', 'javascript', 'css', 'markdown', 'webhook'];
    assert.deepStrictEqual(Object.keys(Asset).sort(), expected.slice().sort());
    assert.strictEqual(Asset.image, imageAsset);
    assert.strictEqual(Asset.text({ content: 'hi' }).asset_type, textAsset({ content: 'hi' }).asset_type);
  });
});
