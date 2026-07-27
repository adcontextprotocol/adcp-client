// Exercise the v1 → v2 projection layer against the full AAO
// catalog (reference-formats.json). Every catalog entry is a v1 format
// definition — we wrap each one in a minimal v1 Product and run it
// through the projection to see how many land cleanly in v2 shape.
//
// Skips in CI when the 3.1-beta cache + vendored catalog aren't
// present — same pattern as the v2 → v1 prototype tests.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { readFileSync, existsSync } = require('node:fs');
const path = require('node:path');

const { projectV1ProductToV2 } = require('../../dist/lib/v2/projection/v1-to-v2.js');

const FIXTURE_DIR = path.join(__dirname, 'v2-projection-fixtures');
const CATALOG_PATH = path.join(FIXTURE_DIR, 'aao-reference-formats.json');
// Track whichever 3.1+ cache the workspace happens to have synced —
// CI syncs `3.1.0-beta.1` via `npm run sync-schemas:3.1-beta`; older
// workspaces may still have `3.1.0-beta.0`. Either is fine; the
// registry loader (`src/lib/v2/projection/registry.ts`) reads from
// whichever exists.
const SCHEMAS_CACHE_ROOT = path.join(__dirname, '..', '..', 'schemas', 'cache');
const REGISTRY_EXISTS = ['3.1.0-beta.1', '3.1.0-beta.0', 'latest'].some(v =>
  existsSync(path.join(SCHEMAS_CACHE_ROOT, v, 'registries', 'v1-canonical-mapping.json'))
);

const SKIP_REASON =
  existsSync(CATALOG_PATH) && REGISTRY_EXISTS
    ? false
    : 'requires a 3.1+ schemas/cache/<beta>/ + vendored aao-reference-formats.json — only present in workspaces with a local 3.1-beta sync';

function loadCatalog() {
  return JSON.parse(readFileSync(CATALOG_PATH, 'utf-8'));
}

/**
 * Wrap a catalog entry in a minimal v1 Product for the projection. Real
 * v1 Products carry pricing_options / publisher_properties / etc.;
 * for a projection test we only need format_ids + a product_id.
 */
function v1ProductFor(catalogEntry, productId) {
  return {
    product_id: productId,
    name: catalogEntry.name ?? productId,
    description: catalogEntry.description ?? '',
    format_ids: [catalogEntry.format_id],
  };
}

describe('v1 → v2 projection — every catalog entry projects', { skip: SKIP_REASON }, () => {
  test('all entries with `canonical` annotations project via Step 1', () => {
    const entries = loadCatalog().filter(e => e.canonical);
    const failures = [];
    for (const entry of entries) {
      const v1 = v1ProductFor(entry, `test_${entry.format_id.id}`);
      const { v2, diagnostics } = projectV1ProductToV2(v1);
      if (diagnostics.length > 0 || v2.format_options.length !== 1) {
        failures.push({
          id: entry.format_id.id,
          expected_canonical: entry.canonical,
          diagnostics: diagnostics.map(d => d.code),
        });
        continue;
      }
      if (v2.format_options[0].format_kind !== entry.canonical.kind) {
        failures.push({
          id: entry.format_id.id,
          expected: entry.canonical.kind,
          got: v2.format_options[0].format_kind,
        });
      }
    }
    assert.deepStrictEqual(failures, [], `catalog entries with \`canonical\` MUST all project cleanly`);
  });

  test('round-trip v1_format_ref preserves the input', () => {
    const entry = loadCatalog().find(e => e.canonical?.kind === 'image' && e.format_id.id === 'display_image');
    assert.ok(entry, 'expected display_image entry in the catalog');
    const v1 = v1ProductFor(entry, 'rt_display_image');
    const { v2 } = projectV1ProductToV2(v1);
    const decl = v2.format_options[0];
    // v1_format_ref is always an array per 3.1-beta spec (minItems:1).
    assert.ok(Array.isArray(decl.v1_format_ref), 'v1_format_ref MUST be an array');
    assert.strictEqual(decl.v1_format_ref.length, 1);
    assert.strictEqual(decl.v1_format_ref[0].agent_url, entry.format_id.agent_url);
    assert.strictEqual(decl.v1_format_ref[0].id, entry.format_id.id);
  });

  test('resolves the Optimera AAO legacy host alias without rewriting its source ref', () => {
    const formatId = { agent_url: 'https://adcontextprotocol.org', id: 'display_image' };
    const { v2, diagnostics } = projectV1ProductToV2({
      product_id: 'optimera_display_image',
      name: 'Optimera display image',
      description: 'AAO format published under the historical protocol-root URL',
      format_ids: [formatId],
    });

    assert.deepStrictEqual(diagnostics, []);
    assert.strictEqual(v2.format_options.length, 1);
    assert.strictEqual(v2.format_options[0].format_kind, 'image');
    assert.deepStrictEqual(v2.format_options[0].v1_format_ref, [formatId]);
  });

  test('treats a uniquely AAO-published bare id as an inbound legacy alias and preserves the seller owner', () => {
    const formatId = { agent_url: 'https://publisher.example', id: 'display_image' };
    const { v2, diagnostics } = projectV1ProductToV2({
      product_id: 'publisher_display_image',
      name: 'Publisher display image',
      description: 'AAO standard id emitted under the seller creative-agent URL',
      format_ids: [formatId],
    });

    assert.deepStrictEqual(diagnostics, []);
    assert.strictEqual(v2.format_options[0].format_kind, 'image');
    assert.deepStrictEqual(v2.format_options[0].v1_format_ref, [formatId]);
  });

  test('maps all 16 AAO ids observed under Vox, Triton, and OpenAds legacy owners', () => {
    const deployed = [
      ...[
        'display_300x250_image',
        'display_728x90_image',
        'display_320x50_image',
        'display_300x600_image',
        'display_970x250_image',
      ].map(id => ({ agent_url: 'https://salesagent.voxmedia.com/mcp', id, kind: 'image' })),
      ...['audio_standard_15s', 'audio_standard_30s', 'audio_standard_60s', 'audio_30s'].map(id => ({
        agent_url: 'https://agents.scope3.com/triton',
        id,
        kind: 'audio_hosted',
      })),
      ...[
        'display_300x250_generative',
        'display_728x90_generative',
        'display_320x50_generative',
        'display_160x600_generative',
        'display_336x280_generative',
        'display_300x600_generative',
        'display_970x250_generative',
      ].map(id => ({ agent_url: 'https://api.openads.ai/adcp/creative', id, kind: 'image' })),
    ];

    assert.strictEqual(deployed.length, 16);
    for (const { kind, ...formatId } of deployed) {
      const { v2, diagnostics } = projectV1ProductToV2({
        product_id: `deployed_${formatId.id}`,
        name: formatId.id,
        description: 'Deployed seller legacy AAO alias',
        format_ids: [formatId],
      });
      assert.deepStrictEqual(diagnostics, [], `${formatId.agent_url} ${formatId.id}`);
      assert.strictEqual(v2.format_options[0].format_kind, kind);
      assert.deepStrictEqual(v2.format_options[0].v1_format_ref, [formatId]);
    }
  });

  test('derived option ids are stable when a seller reorders legacy formats', () => {
    const mrec = {
      agent_url: 'https://salesagent.voxmedia.com/mcp',
      id: 'display_300x250_image',
    };
    const leaderboard = {
      agent_url: 'https://salesagent.voxmedia.com/mcp',
      id: 'display_728x90_image',
    };
    const project = format_ids =>
      projectV1ProductToV2({
        product_id: 'vox_display',
        name: 'Vox display',
        description: 'Same legacy formats in seller-controlled order',
        format_ids,
      }).v2.format_options;

    const first = project([mrec, leaderboard]);
    const reordered = project([leaderboard, mrec]);
    const idsByWidth = options =>
      Object.fromEntries(options.map(option => [option.params.width, option.format_option_id]));

    assert.deepStrictEqual(idsByWidth(reordered), idsByWidth(first));
    assert.notStrictEqual(first[0].format_option_id, first[1].format_option_id);
    assert.match(first[0].format_option_id, /^migrated_[a-f0-9]{32}$/);
  });

  test('rejects inline dimensions that contradict the unique AAO catalog entry', () => {
    const { v2, diagnostics } = projectV1ProductToV2({
      product_id: 'vox_bad_dimensions',
      name: 'Vox bad dimensions',
      description: 'Contradictory inline legacy tuple',
      format_ids: [
        {
          agent_url: 'https://salesagent.voxmedia.com/mcp',
          id: 'display_300x250_image',
          width: 728,
          height: 90,
        },
      ],
    });

    assert.deepStrictEqual(v2.format_options, []);
    assert.strictEqual(diagnostics[0].error.details.resolution_failure, 'catalog_requirement_conflict');
  });

  test('does not use the bare-id fallback for an invalid agent URL', () => {
    const { v2, diagnostics } = projectV1ProductToV2({
      product_id: 'invalid_owner',
      name: 'Invalid owner',
      description: 'Legacy tuple with userinfo',
      format_ids: [
        {
          agent_url: 'https://user@creative.adcontextprotocol.org/',
          id: 'display_300x250_image',
        },
      ],
    });

    assert.deepStrictEqual(v2.format_options, []);
    assert.strictEqual(diagnostics[0].error.details.resolution_failure, 'no_match');
  });

  test('does not use the bare-id fallback for HTTP or private agent URLs', () => {
    for (const agent_url of [
      'http://public.example/creative',
      'https://127.0.0.1/creative',
      'https://169.254.169.254/latest/meta-data',
    ]) {
      const { v2, diagnostics } = projectV1ProductToV2({
        product_id: 'unsafe_owner',
        name: 'Unsafe owner',
        description: 'Unsafe legacy owner URL',
        format_ids: [{ agent_url, id: 'display_300x250_image' }],
      });
      assert.deepStrictEqual(v2.format_options, [], agent_url);
      assert.strictEqual(diagnostics[0].error.details.resolution_failure, 'no_match', agent_url);
    }
  });

  test('an explicit converter overrides the foreign-owner bare-id compatibility fallback', () => {
    const formatId = { agent_url: 'https://custom.example/mcp', id: 'display_300x250_image' };
    const { v2, diagnostics } = projectV1ProductToV2(
      {
        product_id: 'explicit_override',
        name: 'Explicit override',
        description: 'The adopter knows this seller reused an AAO slug with different semantics',
        format_ids: [formatId],
      },
      {
        legacyFormatConverter: () => ({
          format_kind: 'display_tag',
          format_option_id: 'custom-display-tag',
          params: { width: 300, height: 250 },
        }),
      }
    );

    assert.deepStrictEqual(diagnostics, []);
    assert.strictEqual(v2.format_options[0].format_kind, 'display_tag');
    assert.deepStrictEqual(v2.format_options[0].v1_format_ref, [formatId]);
  });
});

describe(
  'v1 → v2 projection — structural fallback (registry is structural-only post-3.1-GA)',
  { skip: SKIP_REASON },
  () => {
    // After the publisher-scoped format catalog landed (adcp commit
    // f88522cfc5), the registry shrank from 17 entries to 7 pure-
    // structural fallbacks. The literal globs (`iab_mrec_300x250` etc.)
    // moved into per-publisher catalogs declared via
    // `adagents.json#/formats` (or the AAO community mirror for
    // publishers who haven't adopted yet). The SDK's
    // `forwardLookupByGlob` path stays in place for forward-compat —
    // the registry MAY grow literal entries again — but at 3.1 GA it
    // never fires for catalog-known formats.

    test('publisher-bespoke id without catalog entry falls through to structural', () => {
      // A v1 product whose format_id doesn't match the AAO catalog OR
      // a registry literal, but DOES have a structural signature the
      // registry recognizes. The SDK needs to know about the format's
      // assets — we can't fetch them at projection time (auto-
      // negotiation surface concern), so we expect fail-closed with
      // `no_match` here. Structural Step 3 only fires when a catalog
      // lookup returned an entry without a `canonical:` annotation.
      const v1 = {
        product_id: 'bespoke_unknown',
        name: 'test',
        description: 'test',
        format_ids: [
          {
            agent_url: 'https://some-publisher.example/',
            id: 'definitely_not_in_catalog_or_registry',
          },
        ],
      };
      const { v2, diagnostics } = projectV1ProductToV2(v1);
      // Either fail-closed (the realistic case — we don't know the
      // publisher's format definition) or a structural fallback.
      // The prototype's scope means the publisher-fetch side is
      // deferred to the auto-negotiation surface, so this is fail-
      // closed today.
      assert.strictEqual(v2.format_options.length, 0);
      assert.strictEqual(diagnostics.length, 1);
      assert.strictEqual(diagnostics[0].code, 'FORMAT_PROJECTION_FAILED');
      assert.strictEqual(diagnostics[0].error.details.resolution_failure, 'no_match');
    });
  }
);

describe('v1 → v2 projection — fail-closed for fully-unknown formats', { skip: SKIP_REASON }, () => {
  test('a bespoke format with no catalog/registry/structural match surfaces FORMAT_PROJECTION_FAILED', () => {
    const v1 = {
      product_id: 'bespoke_proprietary',
      name: 'test',
      description: 'test',
      format_ids: [
        {
          agent_url: 'https://obscure-publisher.example/',
          id: 'definitely_not_in_catalog_or_registry',
        },
      ],
    };
    const { v2, diagnostics } = projectV1ProductToV2(v1);
    assert.strictEqual(v2.format_options.length, 0);
    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(diagnostics[0].code, 'FORMAT_PROJECTION_FAILED');
    assert.strictEqual(diagnostics[0].error.details.resolution_failure, 'no_match');
  });
});

describe('v1 → v2 projection — injected publisher/community catalog snapshots', { skip: SKIP_REASON }, () => {
  const legacyRef = {
    agent_url: 'https://formats.publisher.example',
    id: 'homepage_image',
    width: 1200,
    height: 628,
  };
  const mirror = {
    source: 'aao_mirror',
    publisher_domain: 'publisher.example',
    formats: [
      {
        format_kind: 'image',
        format_option_id: 'homepage_image',
        params: { width: 1200, height: 628, slots: [{ asset_group_id: 'image', asset_type: 'image', required: true }] },
        platform_extensions: [{ uri: 'https://publisher.example/image.json', digest: `sha256:${'a'.repeat(64)}` }],
        v1_format_ref: [legacyRef],
      },
    ],
  };

  test('uses an exact catalog-authored alias and preserves the full canonical subclass', () => {
    const { v2, diagnostics } = projectV1ProductToV2(
      {
        product_id: 'publisher-homepage',
        name: 'Publisher homepage',
        description: 'Publisher-defined canonical image subclass',
        format_ids: [legacyRef],
      },
      { projectionCatalogs: [mirror] }
    );
    assert.deepStrictEqual(diagnostics, []);
    assert.strictEqual(v2.format_options.length, 1);
    const option = v2.format_options[0];
    assert.strictEqual(option.format_kind, 'image');
    assert.strictEqual(option.format_option_id, 'homepage_image');
    assert.strictEqual(option.publisher_domain, 'publisher.example');
    assert.deepStrictEqual(option.params.slots, [{ asset_group_id: 'image', asset_type: 'image', required: true }]);
    assert.strictEqual(option.platform_extensions[0].uri, 'https://publisher.example/image.json');
    assert.deepStrictEqual(option.v1_format_ref, [legacyRef]);
  });

  test('never matches the same local id under an unrelated owner', () => {
    const { v2, diagnostics } = projectV1ProductToV2(
      {
        product_id: 'unrelated',
        name: 'Unrelated',
        description: 'Same id, different owner',
        format_ids: [{ ...legacyRef, agent_url: 'https://unrelated.example' }],
      },
      { projectionCatalogs: [mirror] }
    );
    assert.deepStrictEqual(v2.format_options, []);
    assert.strictEqual(diagnostics[0].error.details.resolution_failure, 'no_match');
  });

  test('canonicalizes host and default port while preserving trailing slash, path, and query identity', () => {
    const canonicalUrlMirror = {
      ...mirror,
      formats: [
        {
          ...mirror.formats[0],
          v1_format_ref: [
            {
              ...legacyRef,
              agent_url: 'HTTPS://Formats.Publisher.Example:443/TenantA?mode=Prod',
            },
          ],
        },
      ],
    };
    const slashMismatch = projectV1ProductToV2(
      {
        product_id: 'canonical-owner-url',
        name: 'Canonical owner URL',
        description: 'Equivalent URL spellings identify the same owner',
        format_ids: [
          {
            ...legacyRef,
            agent_url: 'https://formats.publisher.example/TenantA/?mode=Prod',
          },
        ],
      },
      { projectionCatalogs: [canonicalUrlMirror] }
    );
    assert.deepStrictEqual(slashMismatch.v2.format_options, []);
    assert.strictEqual(slashMismatch.diagnostics[0].error.details.resolution_failure, 'no_match');

    const equivalent = projectV1ProductToV2(
      {
        product_id: 'canonical-owner-url',
        name: 'Canonical owner URL',
        description: 'Equivalent URL spellings identify the same owner',
        format_ids: [{ ...legacyRef, agent_url: 'https://formats.publisher.example/TenantA?mode=Prod' }],
      },
      { projectionCatalogs: [canonicalUrlMirror] }
    );
    assert.deepStrictEqual(equivalent.diagnostics, []);
    assert.strictEqual(equivalent.v2.format_options[0].format_option_id, 'homepage_image');
  });

  test('canonicalizes unreserved percent encoding and ignores URL fragments', () => {
    const encodedMirror = {
      ...mirror,
      formats: [
        {
          ...mirror.formats[0],
          v1_format_ref: [
            {
              ...legacyRef,
              agent_url: 'https://Formats.Publisher.Example:443/%7Eagent#stale-fragment',
            },
          ],
        },
      ],
    };
    const { v2, diagnostics } = projectV1ProductToV2(
      {
        product_id: 'canonical-owner-unreserved',
        name: 'Canonical owner URL',
        description: 'Protocol-equivalent URL spellings identify the same owner',
        format_ids: [{ ...legacyRef, agent_url: 'https://formats.publisher.example/~agent' }],
      },
      { projectionCatalogs: [encodedMirror] }
    );
    assert.deepStrictEqual(diagnostics, []);
    assert.strictEqual(v2.format_options[0].format_option_id, 'homepage_image');
  });

  test('keeps owner paths, queries, and dimensional variants distinct', () => {
    const scopedMirror = {
      ...mirror,
      formats: [
        {
          ...mirror.formats[0],
          v1_format_ref: [
            {
              ...legacyRef,
              agent_url: 'https://formats.publisher.example/TenantA?mode=Prod',
            },
          ],
        },
      ],
    };
    for (const formatId of [
      { ...legacyRef, agent_url: 'https://formats.publisher.example/tenanta?mode=Prod' },
      { ...legacyRef, agent_url: 'https://formats.publisher.example/TenantA?mode=prod' },
      {
        ...legacyRef,
        width: 728,
        height: 90,
        agent_url: 'https://formats.publisher.example/TenantA?mode=Prod',
      },
    ]) {
      const { v2, diagnostics } = projectV1ProductToV2(
        {
          product_id: 'distinct-owner-variant',
          name: 'Distinct owner variant',
          description: 'Owner paths, queries, and dimensions are identity-bearing',
          format_ids: [formatId],
        },
        { projectionCatalogs: [scopedMirror] }
      );
      assert.deepStrictEqual(v2.format_options, []);
      assert.strictEqual(diagnostics[0].error.details.resolution_failure, 'no_match');
    }
  });

  test('compiles an immutable snapshot index unaffected by later caller mutation', () => {
    const mutableRef = { ...legacyRef };
    const mutableDeclaration = {
      ...mirror.formats[0],
      format_option_id: 'compiled-homepage',
      params: structuredClone(mirror.formats[0].params),
      v1_format_ref: [mutableRef],
    };
    const mutableSnapshots = [{ ...mirror, formats: [mutableDeclaration] }];
    const input = {
      product_id: 'immutable-snapshot',
      name: 'Immutable snapshot',
      description: 'Catalog compilation snapshots caller-owned data',
      format_ids: [{ ...legacyRef }],
    };

    const first = projectV1ProductToV2(input, { projectionCatalogs: mutableSnapshots });
    assert.strictEqual(first.v2.format_options[0].format_option_id, 'compiled-homepage');

    mutableDeclaration.format_option_id = 'mutated-homepage';
    mutableDeclaration.format_kind = 'video_hosted';
    mutableRef.agent_url = 'https://mutated.example';
    mutableDeclaration.params.width = 1;

    const second = projectV1ProductToV2(input, { projectionCatalogs: mutableSnapshots });
    assert.deepStrictEqual(second.diagnostics, []);
    assert.strictEqual(second.v2.format_options[0].format_option_id, 'compiled-homepage');
    assert.strictEqual(second.v2.format_options[0].format_kind, 'image');
    assert.strictEqual(second.v2.format_options[0].params.width, 1200);

    const mutatedOwner = projectV1ProductToV2(
      { ...input, format_ids: [{ ...legacyRef, agent_url: 'https://mutated.example' }] },
      { projectionCatalogs: mutableSnapshots }
    );
    assert.deepStrictEqual(mutatedOwner.v2.format_options, []);
  });

  test('canonical_formats_only declarations never become legacy mappings', () => {
    const { v2, diagnostics } = projectV1ProductToV2(
      {
        product_id: 'canonical-only',
        name: 'Canonical only',
        description: 'Public availability is not a legacy alias',
        format_ids: [legacyRef],
      },
      {
        projectionCatalogs: [
          {
            ...mirror,
            formats: [{ ...mirror.formats[0], canonical_formats_only: true }],
          },
        ],
      }
    );
    assert.deepStrictEqual(v2.format_options, []);
    assert.strictEqual(diagnostics[0].error.details.resolution_failure, 'no_match');
  });

  test('uses snapshot order as publisher-over-mirror precedence', () => {
    const publisher = {
      ...mirror,
      source: 'publisher',
      formats: [{ ...mirror.formats[0], format_option_id: 'publisher-homepage' }],
    };
    const { v2, diagnostics } = projectV1ProductToV2(
      {
        product_id: 'precedence',
        name: 'Precedence',
        description: 'Direct publisher wins',
        format_ids: [legacyRef],
      },
      { projectionCatalogs: [publisher, mirror] }
    );
    assert.deepStrictEqual(diagnostics, []);
    assert.strictEqual(v2.format_options[0].format_option_id, 'publisher-homepage');
  });
});

describe('v1 → v2 projection — every-catalog-entry coverage report', { skip: SKIP_REASON }, () => {
  test('emit per-canonical coverage', () => {
    const catalog = loadCatalog();
    const buckets = {
      step1_catalog_canonical: [], // seller-asserted, normative
      catalog_lacks_canonical: [], // catalog has entry, no v2 mapping yet
      no_match: [], // not in catalog, no registry, no structural
    };
    for (const entry of catalog) {
      const v1 = v1ProductFor(entry, `cov_${entry.format_id.id}`);
      const { v2, diagnostics } = projectV1ProductToV2(v1);
      const projectedKind = v2.format_options[0]?.format_kind;
      const tag = `${entry.format_id.id} → ${projectedKind ?? '✗'}`;
      if (diagnostics.length === 0) {
        buckets.step1_catalog_canonical.push(tag);
        continue;
      }
      const reason = diagnostics[0].error.details.resolution_failure;
      if (reason === 'catalog_lacks_canonical_annotation') {
        buckets.catalog_lacks_canonical.push(entry.format_id.id);
      } else {
        buckets.no_match.push(entry.format_id.id);
      }
    }
    console.log('\n=== v1 → v2 projection coverage (full AAO catalog, 57 entries) ===\n');
    const line = (label, list) => {
      console.log(`${label} (${list.length}):`);
      for (const n of list) console.log(`  ${n}`);
    };
    line('Step 1 — catalog `canonical` annotation (NORMATIVE, clean projection)', buckets.step1_catalog_canonical);
    console.log();
    line(
      'catalog_lacks_canonical_annotation (AAO knows the format, no v2 mapping yet — Native/DOOH/broadcast/card categories)',
      buckets.catalog_lacks_canonical
    );
    console.log();
    line('no_match (not in catalog, no registry hit, no structural)', buckets.no_match);
    console.log();
    assert.ok(true);
  });
});
