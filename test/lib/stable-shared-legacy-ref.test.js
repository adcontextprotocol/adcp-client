const { test } = require('node:test');
const assert = require('node:assert/strict');
const { projectSyncCreativesForDelivery, CreativeFormatProjectionError } = require('../../dist/lib/v2/projection');
const owner = 'https://creative.adcontextprotocol.org';
const ref = (id, rest = {}) => ({ agent_url: owner, id, ...rest });
function creative(height = 250) {
  return {
    creative_id: `html-${height}`,
    format_kind: 'html5',
    format_parameters: { width: 300, height },
    assets: { html: { asset_type: 'html', content: '<div>Creative</div>' } },
  };
}
function project(item, selectors, mode = 'legacy', assigned = false) {
  return projectSyncCreativesForDelivery(
    {
      creatives: [item],
      ...(assigned && {
        assignments: selectors.map(s => ({ creative_id: item.creative_id, package_id: s.package_id })),
      }),
    },
    selectors,
    mode
  ).creatives[0];
}
for (const mode of ['legacy', 'unknown']) {
  for (const height of [250, 600]) {
    test(`${mode}: selects the shared HTML ref across sized and unsized packages at 300x${height}`, () => {
      const selectors = [
        {
          package_id: 'sized',
          format_ids: [
            ref(`display_300x${height}_html`, { width: 300, height }),
            ref('display_html', { width: 300, height }),
          ],
        },
        { package_id: 'generic', format_ids: [ref('display_html')] },
      ];
      for (const assigned of [false, true]) {
        for (const ordered of [selectors, [...selectors].reverse()]) {
          const source = creative(height);
          const before = structuredClone(source);
          const result = project(source, ordered, mode, assigned);
          assert.deepEqual(result.format_id, ref('display_html', { width: 300, height }));
          assert.deepEqual(source, before);
          assert.equal(result.format_kind, undefined);
        }
      }
    });
  }
}
test('library matching ignores an unrelated package kind, while an explicit assignment fails closed', () => {
  const selectors = [
    { package_id: 'html', format_ids: [ref('display_html', { width: 300, height: 250 })] },
    { package_id: 'video', format_ids: [ref('video_30s')] },
  ];
  assert.equal(project(creative(), selectors).format_id.id, 'display_html');
  assert.throws(() => project(creative(), selectors, 'legacy', true), CreativeFormatProjectionError);
});
test('two compatible packages without a common owner and ID refuse a union-only selection', () => {
  const selectors = [
    { package_id: 'one', format_ids: [ref('display_300x250_html')] },
    { package_id: 'two', format_ids: [ref('display_html')] },
  ];
  assert.throws(() => project(creative(), selectors), /do not share a legacy format identity/);
  selectors[0].format_ids = [ref('display_html', { agent_url: 'https://other-owner.example' })];
  assert.throws(() => project(creative(), selectors), /do not share a legacy format identity/);
});
test('shared identity does not override incompatible explicit package sizes', () => {
  const selectors = [
    { package_id: 'one', format_ids: [ref('display_html', { width: 300, height: 250 })] },
    { package_id: 'two', format_ids: [ref('display_html', { width: 300, height: 600 })] },
  ];
  assert.throws(() => project(creative(), selectors, 'legacy', true), /no compatible legacy reference/);
});
test('intersection retains package option pins and refuses borrowed option mappings', () => {
  const selectors = [
    {
      package_id: 'one',
      format_option_refs: [{ scope: 'product', format_option_id: 'a' }],
      format_options: [
        { scope: 'product', format_option_id: 'a', format_kind: 'html5', v1_format_ref: [ref('display_html')] },
      ],
    },
    {
      package_id: 'two',
      format_option_refs: [{ scope: 'product', format_option_id: 'b' }],
      format_options: [
        { scope: 'product', format_option_id: 'b', format_kind: 'html5', v1_format_ref: [ref('display_html')] },
      ],
    },
  ];
  const pinned = { ...creative(), format_option_ref: { scope: 'product', format_option_id: 'a' } };
  assert.throws(() => project(pinned, selectors, 'legacy', true), /no compatible legacy reference/);
});
test('canonical wire projection and the stable canonical kind registry stay unchanged', () => {
  const source = creative();
  const selectors = [
    { package_id: 'one', format_ids: [ref('display_html')] },
    { package_id: 'two', format_ids: [ref('display_html')] },
  ];
  assert.deepEqual(project(source, selectors, 'canonical'), source);
  assert.throws(() => project({ ...source, format_kind: 'display_tag' }, selectors), CreativeFormatProjectionError);
});
test('unscoped, unmapped and same-package selectors retain stable resolver behavior', () => {
  const source = creative();
  const sized = { package_id: 'one', format_ids: [ref('display_300x250_html', { width: 300, height: 250 })] };
  for (const selectors of [
    [sized, { package_id: 'unknown' }],
    [sized, { format_ids: [ref('display_html')] }],
    [sized, { package_id: 'one', format_ids: [ref('display_html')] }],
  ])
    assert.equal(project(source, selectors).format_id.id, 'display_300x250_html');
});
test('two shared but different owners remain ambiguous instead of depending on package order', () => {
  const formats = [ref('display_html'), ref('display_html', { agent_url: 'https://other-owner.example' })];
  const selectors = [
    { package_id: 'one', format_ids: formats },
    { package_id: 'two', format_ids: formats },
  ];
  for (const ordered of [selectors, [...selectors].reverse()])
    assert.throws(() => project(creative(), ordered), /do not share one unambiguous legacy format reference/);
});
test('unmapped preflight and existing fallback share one snapshotted resolver answer', () => {
  const declaration = { format_kind: 'html5', format_option_id: 'unmapped' };
  const selectors = [
    { package_id: 'unmapped', product_id: 'one', format_options: [declaration] },
    { package_id: 'known', format_ids: [ref('display_html')] },
  ];
  let productCalls = 0;
  const result = projectSyncCreativesForDelivery(
    { creatives: [creative()] },
    selectors,
    'legacy',
    undefined,
    context => {
      if (context.source !== 'product') return undefined;
      productCalls++;
      return productCalls === 1 ? undefined : ref('display_html', { agent_url: 'https://changed-answer.example' });
    }
  );
  assert.equal(productCalls, 1, 'fallback must not re-query the unresolved product mapping');
  assert.equal(result.creatives[0].format_id.agent_url, owner);
});

test('nested package selectors retain each child option pin before intersecting identities', () => {
  const option = (id, legacy) => ({
    scope: 'product',
    format_option_id: id,
    format_kind: 'html5',
    v1_format_ref: [ref(legacy)],
  });
  const a = option('a', 'display_300x250_html');
  const b = option('b', 'display_html');
  const child = { format_option_refs: [{ scope: 'product', format_option_id: 'a' }], format_options: [a, b] };
  const one = { package_id: 'one', selector_containers: [child] };
  const two = { package_id: 'two', format_options: [b] };
  assert.throws(() => project(creative(), [one, two], 'legacy', true), /do not share a legacy format identity/);
  // Multiple leaves for the same package receive exactly the same pin screen.
  assert.throws(
    () => project(creative(), [{ ...child, package_id: 'one' }, { ...child, package_id: 'one' }, two], 'legacy', true),
    /do not share a legacy format identity/
  );
});
