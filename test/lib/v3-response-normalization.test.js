const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { SingleAgentClient } = require('../../dist/lib/core/SingleAgentClient.js');

const normalize = (task, data) => SingleAgentClient.prototype.normalizeEstablishedResponse.call({}, task, data);

describe('AdCP 3 response normalization', () => {
  for (const task of ['create_media_buy', 'update_media_buy']) {
    test(`${task} cleans null creative assignments without dropping extension fields`, () => {
      const response = {
        media_buy_id: 'buy-1',
        packages: [{ package_id: 'package-1', creative_assignments: null, products: null, ext: { revision: 1 } }],
      };
      assert.deepEqual(normalize(task, response), {
        ...response,
        packages: [{ package_id: 'package-1', products: null, ext: { revision: 1 } }],
      });
      assert.equal(response.packages[0].creative_assignments, null);
    });
  }

  test('list_creative_formats wraps bare arrays without converting legacy format fields', () => {
    const formats = [{ format_id: { id: 'display' }, renders: [{ render_id: 'main', role: 'primary' }] }];
    assert.deepEqual(normalize('list_creative_formats', formats), { formats });
    assert.strictEqual(normalize('list_creative_formats', { formats }).formats, formats);
  });

  test('preview responses preserve renderer provenance and extension fields', () => {
    const response = { previews: [{ renders: [{ render_id: 'main', role: 'primary', ext: { revision: 1 } }] }] };
    assert.strictEqual(normalize('preview_creative', response), response);
  });
});
