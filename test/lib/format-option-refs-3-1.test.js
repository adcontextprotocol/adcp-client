// adcp-client#3665: AdCP 3.1 defines `format_option_refs` on package requests
// (media-buy/package-request.json); 3.0 does not. On a proven 3.1 seller a
// canonical-only selection is sent as refs instead of throwing. Omitting the
// selector would silently activate every format on the product, which is why
// the legacy wire either carries the refs or refuses.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  AgentClient,
  SingleAgentClient,
  CreativeFormatCapabilityError,
  CreativeFormatProjectionError,
  parseCapabilitiesResponse,
} = require('../../dist/lib/index.js');
const {
  projectMediaBuyCreativesForDelivery,
  releaseCarriesPackageFormatOptionRefs,
} = require('../../dist/lib/v2/projection/index.js');
const { convertRequest } = require('../../dist/lib/adapters/version/index.js');
const { getSchemaValidatorByRef } = require('../../dist/lib/validation/schema-loader.js');

const AGENT = { id: 'refs-3-1', name: 'Refs 3.1', agent_uri: 'https://seller.example/mcp', protocol: 'mcp' };
const LEGACY_REF = { agent_url: 'https://seller.example/formats', id: 'display_300x250_image' };
const NATIVE_REF = { scope: 'product', format_option_id: 'native_card' };
const MAPPED_REF = { scope: 'product', format_option_id: 'mrec' };

const resolveNothing = () => undefined;
// Maps only the `mrec` option; anything else has no legacy representation.
const resolveMappedOnly = context => {
  if (context.source !== 'selector') return undefined;
  const refs = context.selector?.format_option_refs ?? [];
  return refs.every(ref => ref.format_option_id === 'mrec') ? [LEGACY_REF] : undefined;
};

function createRequest(refs, extra = {}) {
  return {
    account: { account_id: 'test-account' },
    brand: { domain: 'brand.example' },
    start_time: 'asap',
    end_time: '2027-12-31T00:00:00Z',
    idempotency_key: 'refs-3-1-create-0001',
    packages: [
      { product_id: 'product-1', budget: 1000, pricing_option_id: 'pricing-1', format_option_refs: refs, ...extra },
    ],
  };
}

function project(request, formatOptionRefsOnWire, resolver, operation = 'create_media_buy') {
  return projectMediaBuyCreativesForDelivery(
    request,
    'legacy',
    operation,
    undefined,
    resolver,
    undefined,
    formatOptionRefsOnWire
  );
}

function prime(client, supportedVersions) {
  assert.equal(
    client.primeCapabilities({
      scope: client.getCapabilityEvidenceScope(),
      capabilities: parseCapabilitiesResponse({
        adcp: { major_versions: [3], ...(supportedVersions && { supported_versions: supportedVersions }) },
        media_buy: { features: { canonical_creatives: false } },
      }),
      observedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      toolSchemas: {},
    }),
    true
  );
}

function stubbed(Client, supportedVersions, config) {
  const client = new Client(AGENT, config);
  prime(client, supportedVersions);
  const calls = [];
  const single = client instanceof SingleAgentClient ? client : client.client;
  single.executeAndHandle = async (_task, _handler, params) => {
    calls.push(params);
    return { success: true, status: 'completed', data: {} };
  };
  return { client, calls };
}

const caps = supported => parseCapabilitiesResponse({ adcp: { major_versions: [3], supported_versions: supported } });

describe('projectMediaBuyCreativesForDelivery — format_option_refs on AdCP 3.1 (#3665)', () => {
  test('canonical-only option: refs sent unchanged, no format_ids, no throw', () => {
    const projected = project(createRequest([NATIVE_REF]), true, resolveNothing);
    const pkg = projected.packages[0];
    assert.deepStrictEqual(pkg.format_option_refs, [NATIVE_REF]);
    assert.equal(Object.hasOwn(pkg, 'format_ids'), false);
    assert.equal(Object.hasOwn(pkg, 'format_kind'), false);
    assert.equal(Object.hasOwn(pkg, 'params'), false);
  });

  test('canonical-only option drops format_kind/params alongside the refs', () => {
    const projected = project(
      createRequest([NATIVE_REF], { format_kind: 'native', params: { width: 300 } }),
      true,
      resolveNothing
    );
    assert.deepStrictEqual(projected.packages[0].format_option_refs, [NATIVE_REF]);
    assert.equal(Object.hasOwn(projected.packages[0], 'format_kind'), false);
    assert.equal(Object.hasOwn(projected.packages[0], 'params'), false);
  });

  test('refs are copied, not aliased to the caller request', () => {
    const request = createRequest([NATIVE_REF]);
    const projected = project(request, true, resolveNothing);
    assert.notEqual(projected.packages[0].format_option_refs[0], request.packages[0].format_option_refs[0]);
  });

  for (const flag of [true, false]) {
    test(`fully-mapped option → format_ids only, refs removed (flag=${flag})`, () => {
      const projected = project(createRequest([MAPPED_REF]), flag, resolveMappedOnly);
      const pkg = projected.packages[0];
      assert.deepStrictEqual(pkg.format_ids, [LEGACY_REF]);
      assert.equal(Object.hasOwn(pkg, 'format_option_refs'), false);
    });
  }

  test('mixed selection with flag → refs for both, no partial format_ids', () => {
    const refs = [MAPPED_REF, NATIVE_REF];
    const projected = project(createRequest(refs), true, resolveMappedOnly);
    const pkg = projected.packages[0];
    assert.deepStrictEqual(pkg.format_option_refs, refs);
    assert.equal(Object.hasOwn(pkg, 'format_ids'), false);
  });

  test('mixed selection without flag → throws CreativeFormatProjectionError', () => {
    assert.throws(
      () => project(createRequest([MAPPED_REF, NATIVE_REF]), false, resolveMappedOnly),
      CreativeFormatProjectionError
    );
  });

  test('3.0 default (flag omitted) still throws for a canonical-only option', () => {
    assert.throws(
      () =>
        projectMediaBuyCreativesForDelivery(
          createRequest([NATIVE_REF]),
          'legacy',
          'create_media_buy',
          undefined,
          resolveNothing
        ),
      CreativeFormatProjectionError
    );
    assert.throws(() => project(createRequest([NATIVE_REF]), false, resolveNothing), CreativeFormatProjectionError);
  });

  test('update_media_buy new_packages with flag → refs sent', () => {
    const projected = project(
      {
        idempotency_key: 'update-refs-3-1-0001',
        media_buy_id: 'mb-1',
        new_packages: createRequest([NATIVE_REF]).packages,
      },
      true,
      resolveNothing,
      'update_media_buy'
    );
    assert.deepStrictEqual(projected.new_packages[0].format_option_refs, [NATIVE_REF]);
    assert.equal(Object.hasOwn(projected.new_packages[0], 'format_ids'), false);
  });

  test('update_media_buy new_packages without flag → throws', () => {
    assert.throws(
      () =>
        project(
          {
            idempotency_key: 'update-refs-3-1-0001',
            media_buy_id: 'mb-1',
            new_packages: createRequest([NATIVE_REF]).packages,
          },
          false,
          resolveNothing,
          'update_media_buy'
        ),
      CreativeFormatProjectionError
    );
  });

  test('update_media_buy packages (package updates) with flag → still throws', () => {
    assert.throws(
      () =>
        project(
          {
            idempotency_key: 'update-refs-3-1-0001',
            media_buy_id: 'mb-1',
            packages: [{ package_id: 'pkg-1', format_option_refs: [NATIVE_REF] }],
          },
          true,
          resolveNothing,
          'update_media_buy'
        ),
      CreativeFormatProjectionError
    );
  });
});

describe('releaseCarriesPackageFormatOptionRefs', () => {
  test('true when a mutually served release is 3.1+', () => {
    assert.equal(releaseCarriesPackageFormatOptionRefs(caps(['3.0', '3.1']), '3.3.0-beta.5'), true);
    assert.equal(releaseCarriesPackageFormatOptionRefs(caps(['3.1']), '3.1'), true);
  });

  test('false for a 3.0-only seller', () => {
    assert.equal(releaseCarriesPackageFormatOptionRefs(caps(['3.0']), '3.3.0-beta.5'), false);
    assert.equal(releaseCarriesPackageFormatOptionRefs(caps(['3.0', '3.1']), '3.0'), false);
  });

  test('false with no supported_versions evidence', () => {
    assert.equal(
      releaseCarriesPackageFormatOptionRefs(parseCapabilitiesResponse({ adcp: { major_versions: [3] } }), '3.1'),
      false
    );
  });

  test('throws CreativeFormatCapabilityError when no release is mutually served', () => {
    assert.throws(() => releaseCarriesPackageFormatOptionRefs(caps(['3.1']), '3.0'), CreativeFormatCapabilityError);
  });
});

describe('createMediaBuy on a legacy-wire seller (#3665)', () => {
  for (const Client of [SingleAgentClient, AgentClient]) {
    test(`${Client.name}: 3.1 seller, default pin → refs sent unchanged`, async () => {
      const { client, calls } = stubbed(Client, ['3.0', '3.1']);
      await client.createMediaBuy(createRequest([NATIVE_REF]));
      assert.equal(calls.length, 1);
      assert.deepStrictEqual(calls[0].packages[0].format_option_refs, [NATIVE_REF]);
      assert.equal(Object.hasOwn(calls[0].packages[0], 'format_ids'), false);
    });

    test(`${Client.name}: wireAdcpVersion 3.1, seller ['3.1'] → refs sent unchanged`, async () => {
      const { client, calls } = stubbed(Client, ['3.1'], { wireAdcpVersion: '3.1' });
      await client.createMediaBuy(createRequest([NATIVE_REF]));
      assert.equal(calls.length, 1);
      assert.deepStrictEqual(calls[0].packages[0].format_option_refs, [NATIVE_REF]);
    });

    test(`${Client.name}: seller ['3.0'] → throws, never dispatches`, async () => {
      const { client, calls } = stubbed(Client, ['3.0']);
      await assert.rejects(() => client.createMediaBuy(createRequest([NATIVE_REF])), CreativeFormatProjectionError);
      assert.equal(calls.length, 0);
    });

    test(`${Client.name}: wireAdcpVersion 3.0 with a 3.0/3.1 seller → throws, never dispatches`, async () => {
      const { client, calls } = stubbed(Client, ['3.0', '3.1'], { wireAdcpVersion: '3.0' });
      await assert.rejects(() => client.createMediaBuy(createRequest([NATIVE_REF])), CreativeFormatProjectionError);
      assert.equal(calls.length, 0);
    });
  }

  test('3.2 canonical wire passes refs through unchanged (regression guard)', async () => {
    const client = new SingleAgentClient(AGENT, { wireAdcpVersion: '3.2' });
    assert.equal(
      client.primeCapabilities({
        scope: client.getCapabilityEvidenceScope(),
        capabilities: parseCapabilitiesResponse({
          adcp: { major_versions: [3], supported_versions: ['3.2'] },
          media_buy: { features: { canonical_creatives: true } },
        }),
        observedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        toolSchemas: {},
      }),
      true
    );
    const calls = [];
    client.executeAndHandle = async (_task, _handler, params) => {
      calls.push(params);
      return { success: true, status: 'completed', data: {} };
    };
    await client.createMediaBuy(createRequest([NATIVE_REF]));
    assert.equal(calls.length, 1);
    assert.deepStrictEqual(calls[0].packages[0].format_option_refs, [NATIVE_REF]);
    assert.equal(Object.hasOwn(calls[0].packages[0], 'format_ids'), false);
  });
});

describe('updateMediaBuy on a legacy-wire 3.1 seller (#3665)', () => {
  test('new_packages carry refs; package updates still throw', async () => {
    const { client, calls } = stubbed(SingleAgentClient, ['3.0', '3.1']);
    await client.updateMediaBuy({
      idempotency_key: 'update-refs-3-1-0002',
      media_buy_id: 'mb-1',
      new_packages: createRequest([NATIVE_REF]).packages,
    });
    assert.deepStrictEqual(calls[0].new_packages[0].format_option_refs, [NATIVE_REF]);

    await assert.rejects(
      () =>
        client.updateMediaBuy({
          idempotency_key: 'update-refs-3-1-0003',
          media_buy_id: 'mb-1',
          packages: [{ package_id: 'pkg-1', format_option_refs: [NATIVE_REF] }],
        }),
      CreativeFormatProjectionError
    );
    assert.equal(calls.length, 1);
  });
});

describe('issue #3665 end-to-end request shape', () => {
  test('projected request survives the 3.1 version adapter and validates against 3.1 package-request', async () => {
    // Default client pin, 3.0/3.1 seller on the legacy wire, option with no legacy mapping.
    const { client, calls } = stubbed(SingleAgentClient, ['3.0', '3.1']);
    await client.createMediaBuy(createRequest([NATIVE_REF]));
    const sent = calls[0];

    const converted = convertRequest('create_media_buy', sent, { fromVersion: '3.3.0-beta.5', toVersion: '3.1' });
    assert.deepStrictEqual(converted.refusedFields ?? [], []);
    assert.deepStrictEqual(converted.params.packages[0].format_option_refs, [NATIVE_REF]);

    const validate = getSchemaValidatorByRef('media-buy/package-request.json', '3.1.31');
    assert.ok(validate, 'package-request schema loads for 3.1.31');
    const ok = validate(converted.params.packages[0]);
    assert.equal(ok, true, JSON.stringify(validate.errors));

    // 3.0 does not define the field, so the adapter refuses it.
    const to30 = convertRequest('create_media_buy', sent, { fromVersion: '3.3.0-beta.5', toVersion: '3.0' });
    assert.ok(
      to30.refusedFields.some(field => field.path === 'packages[0].format_option_refs'),
      JSON.stringify(to30.refusedFields)
    );
  });
});

// AdCP 3.1 package requests also support the direct canonical selector (#3671).
function directRequest() {
  const request = createRequest([]);
  delete request.packages[0].format_option_refs;
  Object.assign(request.packages[0], { format_kind: 'image', params: { width: 300, height: 250 } });
  return request;
}

describe('direct format selectors on AdCP 3.1 package requests (#3671)', () => {
  test('unmapped direct selector survives projection without mutating the request', () => {
    const request = directRequest();
    const before = structuredClone(request);
    const result = project(request, true, resolveNothing);
    assert.equal(result.packages[0].format_kind, 'image');
    assert.deepStrictEqual(result.packages[0].params, { width: 300, height: 250 });
    assert.equal(Object.hasOwn(result.packages[0], 'format_ids'), false);
    assert.deepStrictEqual(request, before);
  });

  test('explicit legacy resolver still wins over the 3.1 direct selector', () => {
    const result = project(directRequest(), true, () => [LEGACY_REF]);
    assert.deepStrictEqual(result.packages[0].format_ids, [LEGACY_REF]);
    assert.equal(Object.hasOwn(result.packages[0], 'format_kind'), false);
    assert.equal(Object.hasOwn(result.packages[0], 'params'), false);
  });

  test('ambiguous explicit legacy references still refuse instead of bypassing selection', () => {
    const request = directRequest();
    request.packages[0].format_ids = [LEGACY_REF, { ...LEGACY_REF, id: 'display_728x90_image' }];
    assert.throws(() => project(request, true, resolveNothing), CreativeFormatProjectionError);
  });

  test('3.0 and unproven release projection still refuse an unmapped selector', () => {
    assert.throws(() => project(directRequest(), false, resolveNothing), CreativeFormatProjectionError);
  });

  test('only new_packages can use direct selectors during an update', () => {
    const packages = directRequest().packages;
    const result = project({ new_packages: packages }, true, resolveNothing, 'update_media_buy');
    assert.equal(result.new_packages[0].format_kind, 'image');
    assert.deepStrictEqual(result.new_packages[0].params, packages[0].params);
    assert.throws(() => project({ packages }, true, resolveNothing, 'update_media_buy'), CreativeFormatProjectionError);
  });

  for (const Client of [SingleAgentClient, AgentClient]) {
    for (const config of [undefined, { wireAdcpVersion: '3.1' }]) {
      test(`${Client.name}: proven 3.1 dispatch preserves the direct selector (${config ? 'explicit pin' : 'default pin'})`, async () => {
        const { client, calls } = stubbed(Client, ['3.0', '3.1'], config);
        await client.createMediaBuy(directRequest());
        assert.equal(calls.length, 1);
        assert.equal(calls[0].packages[0].format_kind, 'image');
        assert.deepStrictEqual(calls[0].packages[0].params, { width: 300, height: 250 });
        assert.equal(Object.hasOwn(calls[0].packages[0], 'format_ids'), false);
      });
    }

    test(`${Client.name}: 3.0 refuses before dispatch`, async () => {
      const { client, calls } = stubbed(Client, ['3.0']);
      await assert.rejects(() => client.createMediaBuy(directRequest()), CreativeFormatProjectionError);
      assert.equal(calls.length, 0);
    });

    test(`${Client.name}: 3.1 new package dispatch preserves the direct selector`, async () => {
      const { client, calls } = stubbed(Client, ['3.0', '3.1']);
      await client.updateMediaBuy({
        idempotency_key: 'direct-selector-update-0001',
        media_buy_id: 'mb-1',
        new_packages: directRequest().packages,
      });
      assert.equal(calls[0].new_packages[0].format_kind, 'image');
      assert.deepStrictEqual(calls[0].new_packages[0].params, { width: 300, height: 250 });
    });
  }

  test('3.1 conversion retains the selector and satisfies its package schema', () => {
    const projected = project(directRequest(), true, resolveNothing);
    const converted = convertRequest('create_media_buy', projected, {
      fromVersion: '3.3.0-beta.5',
      toVersion: '3.1',
    });
    assert.deepStrictEqual(converted.refusedFields ?? [], []);
    assert.equal(converted.params.packages[0].format_kind, 'image');
    assert.deepStrictEqual(converted.params.packages[0].params, { width: 300, height: 250 });
    const validate = getSchemaValidatorByRef('media-buy/package-request.json', '3.1');
    assert.ok(validate);
    assert.equal(validate(converted.params.packages[0]), true, JSON.stringify(validate.errors));
  });
});
