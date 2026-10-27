const { test } = require('node:test');
const assert = require('node:assert/strict');
const { projectCreativeForDelivery, CreativeFormatProjectionError } = require('../../dist/lib/v2/projection');
const agent_url = 'https://creative.adcontextprotocol.org';
const refs = (...ids) => ({ format_ids: ids.map(id => ({ agent_url, id })) });
const image = params => ({
  creative_id: 'image-3438',
  name: 'Image',
  format_kind: 'image',
  ...(params && { format_parameters: params }),
  assets: { banner: { asset_type: 'image', url: 'https://cdn.example/banner.png' } },
});
const failure = (creative, product) => {
  let error;
  try {
    projectCreativeForDelivery(creative, product, 'legacy');
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof CreativeFormatProjectionError);
  return error.message;
};
test('legacy kind mismatch names the offered kind without SDK17 mapping advice', () => {
  const message = failure(image(), refs('display_300x250_html'));
  assert.match(message, /offers legacy refs for canonical kind html5, not image/);
  assert.doesNotMatch(message, /SDK 17|migration-16-to-17/);
});
test('legacy size mismatch names the requested size', () => {
  assert.match(failure(image({ width: 728, height: 90 }), refs('display_300x250_image')), /728x90 size/);
});
test('ambiguous legacy sizes include a concrete sizing hint', () => {
  assert.match(
    failure(image(), refs('display_300x250_image', 'display_300x600_image')),
    /format_parameters.width\/height/
  );
});
test('a matching legacy image still selects the same format', () => {
  assert.equal(
    projectCreativeForDelivery(image({ width: 300, height: 250 }), refs('display_300x250_image'), 'legacy').format_id
      .id,
    'display_300x250_image'
  );
});
