const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  projectSyncCreativesForDelivery: project,
  fitCreativeToPackages,
  CreativeFormatProjectionError,
} = require('../../dist/lib/v2/projection');

const OWNER = 'https://creative.adcontextprotocol.org';
const html = height => ({
  creative_id: `c${height}`,
  name: `Acme ${height} banner`,
  format_kind: 'display_tag',
  format_parameters: { width: 300, height },
  assets: {
    html_creative: {
      asset_type: 'display_tag',
      delivery_type: 'inline_markup',
      markup_type: 'standard',
      markup: '<div>Acme</div>',
    },
  },
});
const legacy = (package_id, height) => ({
  package_id,
  product_id: `product-${package_id}`,
  format_ids: [
    { agent_url: OWNER, id: 'display_html', width: 300, height },
    { agent_url: OWNER, id: `display_300x${height}_html`, width: 300, height },
  ],
});
const contexts = () => [legacy('p250', 250), legacy('p600', 600)];
const image = height => ({
  creative_id: `image${height}`,
  name: 'Acme image',
  format_kind: 'image',
  assets: { image_main: { asset_type: 'image', url: `https://assets.example/${height}.png`, width: 300, height } },
});
const canonical = (package_id, height, complete = true) => ({
  package_id,
  format_options: [{ format_kind: 'image', params: { width: 300, height }, technical_requirements_complete: complete }],
});

for (const assignments of [undefined, []]) {
  for (const mode of ['legacy', 'unknown']) {
    test(`library sync selects each creative's fitting sizes: assignments=${JSON.stringify(assignments)}, mode=${mode}`, () => {
      const request = { creatives: [html(250), html(600)], ...(assignments && { assignments }) };
      const selectors = contexts();
      const before = structuredClone({ request, selectors });
      for (const ordered of [selectors, [...selectors].reverse()]) {
        const result = project(request, ordered, mode);
        assert.deepEqual(
          result.creatives.map(creative => creative.format_id),
          [250, 600].map(height => ({
            agent_url: OWNER,
            id: `display_300x${height}_html`,
            width: 300,
            height,
          }))
        );
        assert.equal(Object.hasOwn(result, 'assignments'), assignments !== undefined);
        assert.deepEqual(result.assignments, assignments);
      }
      assert.deepEqual({ request, selectors }, before);
    });
  }
}

test('canonical library sync can store mixed sizes without assigning either creative', () => {
  const request = { creatives: [image(250), image(600)] };
  const result = project(request, [canonical('p250', 250), canonical('p600', 600)], 'canonical');
  assert.deepEqual(result.creatives, request.creatives);
  assert.equal(Object.hasOwn(result, 'assignments'), false);
});

test('explicit assignments still require every targeted package to accept the creative', () => {
  const selectors = contexts();
  assert.throws(
    () =>
      project(
        {
          creatives: [html(250)],
          assignments: [
            { creative_id: 'c250', package_id: 'p250' },
            { creative_id: 'c250', package_id: 'p600' },
          ],
        },
        selectors,
        'legacy'
      ),
    CreativeFormatProjectionError
  );
});

for (const operation of ['assign', 'replace', 'merge']) {
  test(`${operation} operations cannot be mistaken for an unassigned library creative`, () => {
    assert.throws(
      () =>
        project(
          {
            creatives: [html(250)],
            validation_mode: 'strict',
            assignment_operations: [
              {
                operation,
                creative_id: 'c250',
                package_id: 'p600',
                ...(operation === 'replace' ? { replaces_creative_id: 'old' } : {}),
                ...(operation === 'merge' ? { merged_creative_id: 'seller-copy' } : {}),
              },
            ],
          },
          contexts(),
          'legacy'
        ),
      CreativeFormatProjectionError
    );
  });
}

test('positive assignment operations use only their explicit targets and remain unchanged', () => {
  for (const operation of ['assign', 'replace', 'merge']) {
    const request = {
      creatives: [html(250)],
      validation_mode: 'strict',
      assignment_operations: [
        {
          operation,
          creative_id: 'c250',
          package_id: 'p250',
          ...(operation === 'replace' ? { replaces_creative_id: 'old' } : {}),
          ...(operation === 'merge' ? { merged_creative_id: 'seller-copy' } : {}),
        },
      ],
    };
    const result = project(request, contexts(), 'legacy');
    assert.equal(result.creatives[0].format_id.id, 'display_300x250_html');
    assert.deepEqual(result.assignment_operations, request.assignment_operations);
  }
});

test('unassign operations do not make the uploaded creative fit the package being removed', () => {
  const request = {
    creatives: [html(250)],
    validation_mode: 'strict',
    assignment_operations: [{ operation: 'unassign', creative_id: 'c250', package_id: 'p600' }],
  };
  const result = project(request, contexts(), 'legacy');
  assert.equal(result.creatives[0].format_id.id, 'display_300x250_html');
  assert.deepEqual(result.assignment_operations, request.assignment_operations);
});

test('unknown assignment operation intent retains strict package handling', () => {
  assert.throws(
    () =>
      project(
        {
          creatives: [html(250)],
          assignment_operations: [{ operation: 'future_assign', creative_id: 'c250', package_id: 'p600' }],
        },
        contexts(),
        'legacy'
      ),
    CreativeFormatProjectionError
  );
});

test('packages that are unknown do not displace a positively fitting library route', () => {
  const result = project({ creatives: [html(250)] }, [legacy('p250', 250), { package_id: 'unknown' }], 'legacy');
  assert.equal(result.creatives[0].format_id.id, 'display_300x250_html');
});

test('no positive fit refuses with every examined package named', () => {
  const selectors = [legacy('p600', 600), legacy('p900', 900)];
  assert.throws(
    () => project({ creatives: [html(250)] }, selectors, 'legacy'),
    error => {
      assert.ok(error instanceof CreativeFormatProjectionError);
      assert.match(error.message, /no supplied package is proven to fit/);
      assert.deepEqual(
        error.details.package_refs.map(entry => entry.package_id),
        ['p600', 'p900']
      );
      for (const entry of error.details.package_refs) assert.ok(entry.refs.length > 0);
      return true;
    }
  );
});

test('incomplete technical declarations cannot establish the only library candidate', () => {
  assert.throws(
    () => project({ creatives: [image(250)] }, [canonical('unknown', 250, false)], 'canonical'),
    CreativeFormatProjectionError
  );
});

test('unscoped technical layers remain binding before library candidates are selected', () => {
  assert.throws(
    () =>
      project(
        { creatives: [html(250)] },
        [...contexts(), { format_ids: [{ agent_url: OWNER, id: 'display_300x600_html', width: 300, height: 600 }] }],
        'legacy'
      ),
    CreativeFormatProjectionError
  );
});

test('a library creative and an assignment of a different stored creative need no routing catalog', () => {
  const request = { creatives: [image(250)], assignments: [{ creative_id: 'stored', package_id: 'target' }] };
  const result = project(request, [{ package_id: 'target' }], 'canonical');
  assert.deepEqual(result, request);
});

test('public planning keeps reporting and enforcing the entire requested assignment scope', () => {
  const planned = fitCreativeToPackages(html(250), contexts(), { adcpVersion: '3.1' });
  assert.deepEqual(
    planned.perPackage.map(entry => entry.verdict),
    ['fits', 'does_not_fit']
  );
  assert.equal(planned.wire, undefined);
  assert.equal(
    project({ creatives: [html(250)] }, contexts(), 'legacy').creatives[0].format_id.id,
    'display_300x250_html'
  );
});

for (const assignments of [
  { creative_id: 'c250', package_id: 'p600' },
  [{ creative_id: 'c250', package_id: 42 }],
  [null],
]) {
  test(`unresolved explicit assignments never opt into library subset selection: ${JSON.stringify(assignments)}`, () => {
    assert.throws(
      () => project({ creatives: [html(250)], assignments }, contexts(), 'legacy'),
      CreativeFormatProjectionError
    );
  });
}

test('all positively fitting VAST players participate in legacy wire reconciliation', () => {
  const creative = {
    creative_id: 'vast',
    name: 'Acme VAST',
    format_kind: 'video_vast',
    assets: { vast_tag: { asset_type: 'vast', url: 'https://assets.example/vast.xml' } },
  };
  const selectors = [360, 480].map((height, index) => ({
    package_id: `player${index}`,
    format_ids: [{ agent_url: OWNER, id: 'video_vast', width: 640, height, duration_ms: 30000 }],
  }));
  const options = { creativeFacts: { vast: { primaryAssetFacts: { duration_ms: 30000 } } } };
  for (const ordered of [selectors, [...selectors].reverse()]) {
    assert.throws(
      () => project({ creatives: [creative] }, ordered, 'legacy', undefined, undefined, undefined, options),
      error => {
        assert.ok(error instanceof CreativeFormatProjectionError);
        assert.ok(error.details.conflicts.some(conflict => conflict.constraint === 'size'));
        assert.equal(error.details.package_refs.length, 2);
        return true;
      }
    );
  }
});

test('conflicting canonical pins from positively fitting packages cannot be cherry-picked', () => {
  const selectors = ['A', 'B'].map(id => ({
    package_id: id,
    format_options: [
      { format_kind: 'image', params: {}, format_option_id: id, technical_requirements_complete: true },
      {
        format_kind: 'image',
        params: { width: 1, height: 1 },
        format_option_id: `${id}-other`,
        technical_requirements_complete: true,
      },
    ],
  }));
  for (const ordered of [selectors, [...selectors].reverse()]) {
    assert.throws(() => project({ creatives: [image(250)] }, ordered, 'canonical'), CreativeFormatProjectionError);
  }
});

test('nested and repeated package layers cannot be dropped to establish a library fit', () => {
  const selectors = [{ package_id: 'p250', selector_containers: [legacy(undefined, 250)] }, canonical('p250', 600)];
  assert.throws(() => project({ creatives: [html(250)] }, selectors, 'legacy'), CreativeFormatProjectionError);
});

test('an unscoped library catalog plus another creative’s synthesized package ID remains a library upsert', () => {
  const request = { creatives: [image(250)], assignments: [{ creative_id: 'stored', package_id: 'target' }] };
  const selectors = [{ format_ids: [{ agent_url: OWNER, id: 'display_300x250_image' }] }, { package_id: 'target' }];
  const result = project(request, selectors, 'legacy');
  assert.equal(result.creatives[0].format_id.id, 'display_300x250_image');
  assert.deepEqual(result.assignments, request.assignments);
});

test('one assigned creative does not assign another upload when real catalogs are present', () => {
  const request = { creatives: [html(250), html(600)], assignments: [{ creative_id: 'c250', package_id: 'p250' }] };
  const result = project(request, contexts(), 'legacy');
  assert.deepEqual(
    result.creatives.map(value => value.format_id.height),
    [250, 600]
  );
  assert.deepEqual(result.assignments, request.assignments);
});

test('compatible positive VAST players share a legacy reference without inventing assignments', () => {
  const creative = {
    creative_id: 'vast',
    name: 'Acme VAST',
    format_kind: 'video_vast',
    format_parameters: { duration_ms: 30000 },
    assets: { vast_tag: { asset_type: 'vast', url: 'https://assets.example/vast.xml' } },
  };
  const selectors = ['A', 'B'].map(package_id => ({
    package_id,
    format_ids: [{ agent_url: OWNER, id: 'video_vast', width: 640, height: 360, duration_ms: 30000 }],
  }));
  const result = project({ creatives: [creative] }, selectors, 'legacy');
  assert.equal(result.creatives[0].format_id.height, 360);
  assert.equal(Object.hasOwn(result, 'assignments'), false);
});

test('an array-valued unassign is opaque assignment intent', () => {
  assert.throws(
    () =>
      project(
        {
          creatives: [html(250)],
          assignment_operations: [{ operation: ['unassign'], creative_id: 'c250', package_id: 'p600' }],
        },
        contexts(),
        'legacy'
      ),
    CreativeFormatProjectionError
  );
});
