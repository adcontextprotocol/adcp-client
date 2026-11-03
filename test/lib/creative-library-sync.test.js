const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  projectSyncCreativesForDelivery,
  fitCreativeToPackages,
  CreativeFormatProjectionError,
} = require('../../dist/lib/v2/projection');

const OWNER = 'https://creative.adcontextprotocol.org';
const htmlRef = height => ({ agent_url: OWNER, id: `display_300x${height}_html`, width: 300, height });
const packages = [250, 600].map(height => ({
  package_id: `p${height}`,
  product_id: `product-${height}`,
  format_ids: [{ ...htmlRef(height), id: 'display_html' }, htmlRef(height)],
}));
const creative = height => ({
  creative_id: `c${height}`,
  name: `Banner 300x${height}`,
  format_kind: 'display_tag',
  format_parameters: { width: 300, height },
  assets: {
    html_creative: {
      asset_type: 'display_tag',
      delivery_type: 'inline_markup',
      markup_type: 'standard',
      markup: '<div/>',
    },
  },
});

for (const mode of ['legacy', 'unknown', 'canonical']) {
  for (const assignments of [undefined, []]) {
    test(`library sync: mixed sizes with ${assignments ? 'empty' : 'omitted'} assignments on ${mode} wire (#3570)`, () => {
      const input = { creatives: [creative(250), creative(600)], ...(assignments && { assignments }) };
      const before = structuredClone({ input, packages });
      const result = projectSyncCreativesForDelivery(input, packages, mode);
      assert.equal(result.creatives.length, 2);
      for (const [index, height] of [250, 600].entries()) {
        assert.equal(result.creatives[index].creative_id, `c${height}`);
        if (mode === 'canonical') assert.equal(result.creatives[index].format_kind, 'display_tag');
        else assert.deepEqual(result.creatives[index].format_id, htmlRef(height));
      }
      assert.deepEqual(result.assignments, assignments);
      assert.deepEqual({ input, packages }, before);
    });
  }

  test(`library sync: assignments for another creative do not assign the library upload on ${mode} wire`, () => {
    const input = {
      creatives: [creative(250), creative(600)],
      assignments: [{ creative_id: 'c250', package_id: 'p250' }],
    };
    const result = projectSyncCreativesForDelivery(input, packages, mode);
    assert.equal(result.creatives.length, 2);
    assert.deepEqual(result.assignments, input.assignments);
    if (mode !== 'canonical') assert.deepEqual(result.creatives[1].format_id, htmlRef(600));
  });

  test(`library sync: an explicit assignment to an incompatible package still refuses on ${mode} wire`, () => {
    assert.throws(
      () =>
        projectSyncCreativesForDelivery(
          {
            creatives: [creative(250)],
            assignments: packages.map(({ package_id }) => ({ creative_id: 'c250', package_id })),
          },
          packages,
          mode
        ),
      CreativeFormatProjectionError
    );
  });

  for (const operation of ['assign', 'replace', 'merge']) {
    test(`library sync: ${operation} operations enforce the assigned package on ${mode} wire`, () => {
      const assignment = {
        operation,
        creative_id: 'c250',
        package_id: 'p600',
        ...(operation === 'replace' && { replaces_creative_id: 'old' }),
        ...(operation === 'merge' && { merged_creative_id: 'old' }),
      };
      const input = { creatives: [creative(250)], assignment_operations: [assignment] };
      assert.throws(() => projectSyncCreativesForDelivery(input, packages, mode), CreativeFormatProjectionError);
      const compatible = { ...input, assignment_operations: [{ ...assignment, package_id: 'p250' }] };
      const result = projectSyncCreativesForDelivery(compatible, packages, mode);
      assert.deepEqual(result.assignment_operations, compatible.assignment_operations);
      if (mode !== 'canonical') assert.deepEqual(result.creatives[0].format_id, htmlRef(250));
    });
  }

  test(`library sync: removing an assignment does not assign the library creative on ${mode} wire`, () => {
    const input = {
      creatives: [creative(250)],
      assignment_operations: [{ operation: 'unassign', creative_id: 'c250', package_id: 'p600' }],
    };
    const result = projectSyncCreativesForDelivery(input, packages, mode);
    assert.deepEqual(result.assignment_operations, input.assignment_operations);
    if (mode !== 'canonical') assert.deepEqual(result.creatives[0].format_id, htmlRef(250));
  });

  test(`library sync: assignments for another creative cannot bypass no-fit refusal on ${mode} wire`, () => {
    assert.throws(
      () =>
        projectSyncCreativesForDelivery(
          {
            creatives: [creative(250), creative(90)],
            assignments: [{ creative_id: 'c250', package_id: 'p250' }],
          },
          packages,
          mode
        ),
      error => {
        assert.ok(error instanceof CreativeFormatProjectionError);
        assert.equal(error.creativeId, 'c90');
        assert.deepEqual(
          error.details.package_refs.map(entry => entry.package_id),
          ['p250', 'p600']
        );
        return true;
      }
    );
  });

  test(`library sync: fitting none of the packages still refuses on ${mode} wire`, () => {
    assert.throws(
      () => projectSyncCreativesForDelivery({ creatives: [creative(90)] }, packages, mode),
      error => {
        assert.ok(error instanceof CreativeFormatProjectionError);
        assert.deepEqual(
          error.details.package_refs.map(entry => entry.package_id),
          ['p250', 'p600']
        );
        return true;
      }
    );
  });

  test(`library sync: unscoped and repeated package layers still bind on ${mode} wire`, () => {
    const input = { creatives: [creative(250), creative(600)] };
    const result = projectSyncCreativesForDelivery(input, [...packages, packages[0]], mode);
    assert.equal(result.creatives.length, 2);
    assert.throws(
      () =>
        projectSyncCreativesForDelivery(
          { creatives: [creative(250)] },
          [...packages, { format_ids: [htmlRef(600)] }],
          mode
        ),
      CreativeFormatProjectionError
    );
  });
}

test('library sync: fitting packages must still agree on a shared legacy VAST reference', () => {
  const vast = {
    creative_id: 'vast',
    name: 'VAST tag',
    format_kind: 'video_vast',
    format_parameters: { duration_ms: 30000 },
    assets: { vast_tag: { asset_type: 'vast', url: 'https://ads.example/vast.xml' } },
  };
  const players = [360, 480].map(height => ({
    package_id: `player-${height}`,
    format_ids: [{ agent_url: OWNER, id: 'video_vast', width: 640, height, duration_ms: 30000 }],
  }));
  for (const mode of ['legacy', 'unknown']) {
    assert.throws(
      () => projectSyncCreativesForDelivery({ creatives: [vast] }, [...packages, ...players], mode),
      error => {
        assert.ok(error instanceof CreativeFormatProjectionError);
        assert.deepEqual(
          error.details.package_refs,
          players.map(({ package_id, format_ids }) => ({
            package_id,
            ref: format_ids[0],
          }))
        );
        for (const player of players) assert.ok(error.message.includes(player.package_id));
        assert.equal(error.details.conflicts[0].constraint, 'size');
        return true;
      }
    );
  }
});

test('library sync: the public fit API keeps every package verdict and its strict shared-wire decision', () => {
  for (const adcpVersion of ['3.1.0', '3.3.0-beta.3']) {
    const result = fitCreativeToPackages(creative(250), packages, { adcpVersion });
    assert.deepEqual(
      result.perPackage.map(entry => entry.verdict),
      ['fits', 'does_not_fit']
    );
    assert.equal(result.wire, undefined);
    assert.equal(result.refusal.code, 'package_does_not_fit');
  }
});

test('library sync: mixed durations select each creative independently', () => {
  const selectors = [15000, 30000].map(duration_ms => ({
    package_id: `p${duration_ms}`,
    format_ids: [{ agent_url: OWNER, id: 'video_vast', duration_ms }],
  }));
  const input = {
    creatives: [15000, 30000].map(duration_ms => ({
      creative_id: `c${duration_ms}`,
      name: `${duration_ms}ms VAST`,
      format_kind: 'video_vast',
      format_parameters: { duration_ms },
      assets: { vast_tag: { asset_type: 'vast', url: 'https://ads.example/vast.xml' } },
    })),
  };
  const result = projectSyncCreativesForDelivery(input, selectors, 'legacy');
  assert.deepEqual(
    result.creatives.map(item => item.format_id),
    selectors.map(item => item.format_ids[0])
  );
});

test('library sync: insufficient facts still constrain the shared legacy wire', () => {
  const vast = {
    creative_id: 'vast',
    name: 'VAST tag',
    format_kind: 'video_vast',
    format_parameters: { duration_ms: 30000 },
    assets: { vast_tag: { asset_type: 'vast', url: 'https://ads.example/vast.xml' } },
  };
  const playerRef = height => ({ agent_url: OWNER, id: 'video_vast', width: 640, height, duration_ms: 30000 });
  const selectors = [
    { package_id: 'fits', format_ids: [playerRef(360)] },
    {
      package_id: 'unknown',
      format_options: [
        {
          format_kind: 'video_vast',
          params: { width: 640, height: 480, duration_ms_exact: 30000 },
          v1_format_ref: [playerRef(480)],
        },
      ],
    },
    packages[0],
  ];
  assert.deepEqual(
    fitCreativeToPackages(vast, selectors, { adcpVersion: '3.1.31' }).perPackage.map(entry => entry.verdict),
    ['fits', 'insufficient_facts', 'does_not_fit']
  );
  assert.throws(
    () => projectSyncCreativesForDelivery({ creatives: [vast] }, selectors, 'legacy'),
    error => {
      assert.ok(error instanceof CreativeFormatProjectionError);
      assert.deepEqual(
        error.details.package_refs.map(entry => entry.package_id),
        ['fits', 'unknown']
      );
      return true;
    }
  );
});

test('library sync: assign operations remain strict before the AdCP 3.1 adapter runs', () => {
  const { convertRequest } = require('../../dist/lib/adapters/version');
  const input = {
    creatives: [creative(250)],
    assignment_operations: [{ operation: 'assign', creative_id: 'c250', package_id: 'p250' }],
  };
  const projected = projectSyncCreativesForDelivery(input, packages, 'legacy');
  const converted = convertRequest('sync_creatives', projected, { fromVersion: '3.2.5', toVersion: '3.1.31' });
  assert.deepEqual(converted.params.assignments, [{ creative_id: 'c250', package_id: 'p250' }]);
  assert.deepEqual(converted.params.creatives[0].format_id, htmlRef(250));
  assert.equal(converted.params.validation_mode, 'strict');
  assert.equal(converted.params.assignment_operations, undefined);
  assert.throws(
    () =>
      projectSyncCreativesForDelivery(
        {
          ...input,
          assignments: [{ creative_id: 'c250', package_id: 'p600' }],
        },
        packages,
        'legacy'
      ),
    CreativeFormatProjectionError
  );
});

test('library sync: canonical option selection excludes non-fitting packages', () => {
  const selectors = [250, 600].map(height => ({
    package_id: `p${height}`,
    format_options: [height, 90].map(optionHeight => ({
      format_kind: 'display_tag',
      format_option_id: `size-${optionHeight}`,
      params: { width: 300, height: optionHeight },
      technical_requirements_complete: true,
    })),
  }));
  const result = projectSyncCreativesForDelivery({ creatives: [creative(250), creative(600)] }, selectors, 'canonical');
  assert.deepEqual(
    result.creatives.map(item => item.format_option_ref),
    [250, 600].map(height => ({
      scope: 'product',
      format_option_id: `size-${height}`,
    }))
  );
});

for (const mode of ['legacy', 'canonical']) {
  test(`library sync: SingleAgentClient forwards the mixed-size library on ${mode} wire`, async () => {
    const { SingleAgentClient } = require('../../dist/lib');
    const client = new SingleAgentClient(
      { id: 'seller', name: 'Seller', protocol: 'mcp', agent_uri: 'https://seller.example/mcp' },
      { adcpVersion: '3.1.31', validation: { requests: 'off', responses: 'off' } }
    );
    client.resolveCreativeWireMode = async () => mode;
    const calls = [];
    client.executeAndHandle = async (tool, _handler, params) => {
      calls.push({ tool, params });
      return { success: true, status: 'completed' };
    };
    await client.syncCreatives(
      { account: { account_id: 'account' }, creatives: [creative(250), creative(600)] },
      undefined,
      { creativeFormatProjection: { selectorContainers: packages } }
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tool, 'sync_creatives');
    assert.equal(calls[0].params.creatives.length, 2);
    assert.equal(calls[0].params.assignments, undefined);
    if (mode === 'legacy')
      assert.deepEqual(
        calls[0].params.creatives.map(item => item.format_id),
        [htmlRef(250), htmlRef(600)]
      );
  });

  test(`library sync: SingleAgentClient retains missing package context for assignment operations on ${mode} wire`, async () => {
    const { SingleAgentClient } = require('../../dist/lib');
    const client = new SingleAgentClient(
      { id: 'seller', name: 'Seller', protocol: 'mcp', agent_uri: 'https://seller.example/mcp' },
      { adcpVersion: '3.1.31', validation: { requests: 'off', responses: 'off' } }
    );
    client.resolveCreativeWireMode = async () => mode;
    const calls = [];
    client.executeAndHandle = async (_tool, _handler, params) => {
      calls.push(params);
      return { success: true, status: 'completed' };
    };
    const resolverPackages = [];
    const resolver = context => {
      if (context.source === 'creative') {
        resolverPackages.push(context.selector.package_id);
        return htmlRef(250);
      }
    };
    const input = {
      account: { account_id: 'account' },
      creatives: [creative(250)],
      assignment_operations: [
        { operation: 'assign', creative_id: 'c250', package_id: 'p250' },
        { operation: 'assign', creative_id: 'c250', package_id: 'unconfigured' },
      ],
    };
    await client.syncCreatives(input, undefined, {
      canonicalFormatLegacyResolver: resolver,
      creativeFormatProjection: { selectorContainers: packages },
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].assignment_operations, input.assignment_operations);
    if (mode === 'legacy') assert.ok(resolverPackages.includes('unconfigured'));
  });
}
