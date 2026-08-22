// storyboard_start_offset — distribute coverage across budget-limited comply()
// runs (adcontextprotocol/adcp#6632). The rotation itself is a pure exported
// helper so it is testable without a live agent; option validation is
// asserted through comply(), which validates synchronously before any
// network activity.
const { describe, test } = require('node:test');
const assert = require('node:assert');

const { comply, rotateStoryboardsForOffset } = require('../../dist/lib/testing/compliance/index.js');

describe('rotateStoryboardsForOffset', () => {
  const items = ['a', 'b', 'c', 'd', 'e'];

  test('offset 0 returns the input order', () => {
    assert.deepStrictEqual(rotateStoryboardsForOffset(items, 0), items);
  });

  test('rotates to the offset, preserving relative order with wrap', () => {
    assert.deepStrictEqual(rotateStoryboardsForOffset(items, 2), ['c', 'd', 'e', 'a', 'b']);
  });

  test('offset wraps modulo the list length', () => {
    assert.deepStrictEqual(rotateStoryboardsForOffset(items, 5), items);
    assert.deepStrictEqual(rotateStoryboardsForOffset(items, 7), ['c', 'd', 'e', 'a', 'b']);
  });

  test('empty list stays empty', () => {
    assert.deepStrictEqual(rotateStoryboardsForOffset([], 3), []);
  });

  test('does not mutate the input', () => {
    const input = ['a', 'b', 'c'];
    rotateStoryboardsForOffset(input, 1);
    assert.deepStrictEqual(input, ['a', 'b', 'c']);
  });

  test('rotation loses no items (set-equal at every offset)', () => {
    for (let off = 0; off < 12; off++) {
      const rotated = rotateStoryboardsForOffset(items, off);
      assert.strictEqual(rotated.length, items.length);
      assert.deepStrictEqual([...rotated].sort(), [...items].sort());
    }
  });
});

describe('comply() storyboard_start_offset validation', () => {
  for (const bad of [-1, 1.5, NaN, Infinity, 'two']) {
    test(`rejects ${String(bad)}`, async () => {
      await assert.rejects(comply('https://agent.example/mcp', { storyboard_start_offset: bad }), TypeError);
    });
  }
});
