// resolveCanonicalFormatKind / canonicalDeclarationFromBareId — public
// bare-format-id → canonical resolver. Adopters migrating off legacy
// format storage hold a bare id string (no agent_url); these lift it to
// the canonical format_kind (and a full v2 declaration) via the same
// catalog + registry resolution the v1 → v2 product projection uses.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { readFileSync, existsSync } = require('node:fs');
const path = require('node:path');

const { resolveCanonicalFormatKind, canonicalDeclarationFromBareId } = require('../../dist/lib/v2/projection/index.js');

const CATALOG_PATH = path.join(__dirname, 'v2-projection-fixtures', 'aao-reference-formats.json');

// Resolution reaches the registry only for ids that miss the catalog
// (the fail-closed `null` cases). loadRegistry() throws when no registry
// is on disk, so the null assertions need one present — in dist (vendored
// by build:lib) or the source-tree cache.
const DIST_SCHEMAS = path.join(__dirname, '..', '..', 'dist', 'lib', 'schemas-data');
const SRC_CACHE = path.join(__dirname, '..', '..', 'schemas', 'cache');
const REGISTRY_PRESENT = [DIST_SCHEMAS, SRC_CACHE].some(
  root =>
    existsSync(root) &&
    require('node:fs')
      .readdirSync(root)
      .some(v => existsSync(path.join(root, v, 'registries', 'v1-canonical-mapping.json')))
);

const SKIP_REASON =
  existsSync(CATALOG_PATH) && REGISTRY_PRESENT
    ? false
    : 'requires the vendored AAO catalog + a v1-canonical-mapping registry (run npm run build:lib)';

const AAO_AGENT_URL = 'https://creative.adcontextprotocol.org/';

function catalogEntries() {
  return JSON.parse(readFileSync(CATALOG_PATH, 'utf-8'));
}

describe('resolveCanonicalFormatKind', { skip: SKIP_REASON }, () => {
  test('resolves every annotated AAO catalog id to its catalog canonical', () => {
    const mismatches = [];
    for (const entry of catalogEntries()) {
      if (!entry.canonical) continue;
      const id = entry.format_id.id;
      const got = resolveCanonicalFormatKind(id);
      if (got !== entry.canonical.kind) {
        mismatches.push({ id, expected: entry.canonical.kind, got });
      }
    }
    assert.deepStrictEqual(mismatches, [], `bare-id → kind diverged from catalog for: ${JSON.stringify(mismatches)}`);
  });

  test('resolves representative bare ids across canonical families', () => {
    assert.strictEqual(resolveCanonicalFormatKind('display_300x250_image'), 'image');
    assert.strictEqual(resolveCanonicalFormatKind('display_300x250_html'), 'html5');
    assert.strictEqual(resolveCanonicalFormatKind('display_js'), 'display_tag');
    assert.strictEqual(resolveCanonicalFormatKind('video_standard_30s'), 'video_hosted');
    assert.strictEqual(resolveCanonicalFormatKind('video_vast_30s'), 'video_vast');
    assert.strictEqual(resolveCanonicalFormatKind('audio_standard_30s'), 'audio_hosted');
    assert.strictEqual(resolveCanonicalFormatKind('sponsored_recommendation'), 'sponsored_placement');
    assert.strictEqual(resolveCanonicalFormatKind('native_mention'), 'agent_placement');
  });

  test('resolves deployed AAO legacy aliases for canonical and historical owner URLs', () => {
    const expected = new Map([
      ['display_320x50_html', 'html5'],
      ['display_300x50_html', 'html5'],
      ['display_static', 'image'],
      ['video_hosted', 'video_hosted'],
      ['audio_30s', 'audio_hosted'],
    ]);
    for (const agentUrl of [
      'https://creative.adcontextprotocol.org',
      'https://creative.adcontextprotocol.org/',
      'HTTPS://CREATIVE.ADCONTEXTPROTOCOL.ORG:443/#ignored',
      'https://adcontextprotocol.org',
      'https://adcontextprotocol.org/',
      'HTTPS://ADCONTEXTPROTOCOL.ORG:443/a/../#ignored',
    ]) {
      for (const [id, kind] of expected) {
        assert.strictEqual(resolveCanonicalFormatKind(id, { agentUrl }), kind, `${agentUrl} ${id}`);
      }
    }
  });

  test('unique bare-id aliases still require a valid HTTP agent URL', () => {
    for (const agentUrl of ['https://user@creative.adcontextprotocol.org/', 'ftp://creative.adcontextprotocol.org/']) {
      assert.strictEqual(resolveCanonicalFormatKind('display_320x50_html', { agentUrl }), null, agentUrl);
    }
  });

  test('fails closed (null) for an under-specified bare id the catalog disambiguates by suffix', () => {
    // `display_300x250` alone is ambiguous — the catalog only carries
    // `_image` / `_html` / `_generative` variants. The resolver MUST NOT
    // guess one; it returns null.
    assert.strictEqual(resolveCanonicalFormatKind('display_300x250'), null);
  });

  test('fails closed (null) for an unknown id', () => {
    assert.strictEqual(resolveCanonicalFormatKind('totally_made_up_format'), null);
  });

  test('fails closed (null) for empty input', () => {
    assert.strictEqual(resolveCanonicalFormatKind(''), null);
  });

  test('a non-AAO owner still resolves an exact, uniquely AAO-published standard id', () => {
    assert.strictEqual(
      resolveCanonicalFormatKind('display_300x250_image', { agentUrl: 'https://example.com/' }),
      'image'
    );
    assert.strictEqual(
      resolveCanonicalFormatKind('totally_made_up_format', { agentUrl: 'https://example.com/' }),
      null
    );
  });

  test('assetType disambiguates an under-specified bare id to its catalog variant', () => {
    assert.strictEqual(resolveCanonicalFormatKind('display_300x250', { assetType: 'image' }), 'image');
    assert.strictEqual(resolveCanonicalFormatKind('display_300x250', { assetType: 'html' }), 'html5');
    assert.strictEqual(resolveCanonicalFormatKind('display_300x250', { assetType: 'generative' }), 'image');
    // Size-less base id disambiguates too.
    assert.strictEqual(resolveCanonicalFormatKind('display', { assetType: 'js' }), 'display_tag');
  });

  test('assetType accepts catalog and canonical-kind aliases (javascript → js, html5 → html, display_tag → js)', () => {
    assert.strictEqual(resolveCanonicalFormatKind('display', { assetType: 'javascript' }), 'display_tag');
    assert.strictEqual(resolveCanonicalFormatKind('display_300x250', { assetType: 'html5' }), 'html5');
    assert.strictEqual(resolveCanonicalFormatKind('display', { assetType: 'display_tag' }), 'display_tag');
  });

  test('assetType still fails closed when the disambiguated id is not a catalog entry', () => {
    assert.strictEqual(resolveCanonicalFormatKind('display_300x250', { assetType: 'nope' }), null);
    assert.strictEqual(resolveCanonicalFormatKind('totally_made_up', { assetType: 'image' }), null);
  });

  test('a directly-resolvable id wins over a contradicting assetType', () => {
    // display_300x250_image is a real catalog id (image); a stray html hint
    // must not override the authoritative direct match.
    assert.strictEqual(resolveCanonicalFormatKind('display_300x250_image', { assetType: 'html' }), 'image');
  });

  test('assetTypeHint remains a backwards-compatible alias', () => {
    assert.strictEqual(resolveCanonicalFormatKind('display_300x250', { assetTypeHint: 'image' }), 'image');
  });
});

describe('canonicalDeclarationFromBareId', { skip: SKIP_REASON }, () => {
  test('returns a full v2 declaration carrying v1_format_ref lifted from the bare id', () => {
    const decl = canonicalDeclarationFromBareId('display_300x250_image');
    assert.ok(decl);
    assert.strictEqual(decl.format_kind, 'image');
    // Lifts the bare id to a structured ref in one step, defaulting agent_url.
    assert.deepStrictEqual(decl.v1_format_ref, [{ agent_url: AAO_AGENT_URL, id: 'display_300x250_image' }]);
  });

  test('honors an explicit agentUrl in the synthesized v1_format_ref when the entry resolves', () => {
    // Use a bare id whose entry the catalog carries; the catalog folds
    // trailing-slash variants of the AAO host, so the no-slash form still
    // resolves and the ref echoes the caller-supplied agent_url.
    const decl = canonicalDeclarationFromBareId('video_vast_30s', {
      agentUrl: 'https://creative.adcontextprotocol.org',
    });
    assert.ok(decl);
    assert.strictEqual(decl.format_kind, 'video_vast');
    assert.strictEqual(decl.v1_format_ref[0].agent_url, 'https://creative.adcontextprotocol.org');
    assert.strictEqual(decl.v1_format_ref[0].id, 'video_vast_30s');
  });

  test('preserves generative refinement (asset_source + slots) from the catalog annotation', () => {
    const decl = canonicalDeclarationFromBareId('display_300x250_generative');
    assert.ok(decl);
    assert.strictEqual(decl.format_kind, 'image');
    assert.strictEqual(decl.params.asset_source, 'agent_synthesized');
    assert.ok(Array.isArray(decl.params.slots));
  });

  test('extracts fixed canonical params from reviewed catalog requirements', () => {
    const mobileLeaderboard = canonicalDeclarationFromBareId('display_320x50_html');
    assert.ok(mobileLeaderboard);
    assert.strictEqual(mobileLeaderboard.format_kind, 'html5');
    assert.strictEqual(mobileLeaderboard.params.width, 320);
    assert.strictEqual(mobileLeaderboard.params.height, 50);

    const mobileBanner = canonicalDeclarationFromBareId('display_300x50_html');
    assert.ok(mobileBanner);
    assert.strictEqual(mobileBanner.format_kind, 'html5');
    assert.strictEqual(mobileBanner.params.width, 300);
    assert.strictEqual(mobileBanner.params.height, 50);

    const audio = canonicalDeclarationFromBareId('audio_30s');
    assert.ok(audio);
    assert.strictEqual(audio.format_kind, 'audio_hosted');
    assert.strictEqual(audio.params.duration_ms_exact, 30000);

    const genericImage = canonicalDeclarationFromBareId('display_static');
    assert.ok(genericImage);
    assert.strictEqual(genericImage.format_kind, 'image');
    assert.deepStrictEqual(genericImage.params, {});

    const genericVideo = canonicalDeclarationFromBareId('video_hosted');
    assert.ok(genericVideo);
    assert.strictEqual(genericVideo.format_kind, 'video_hosted');
    assert.deepStrictEqual(genericVideo.params, {});

    const broadcast = canonicalDeclarationFromBareId('broadcast_spot_30s');
    assert.ok(broadcast);
    assert.strictEqual(broadcast.params.width, 1920);
    assert.strictEqual(broadcast.params.height, 1080);
    assert.strictEqual(broadcast.params.duration_ms_exact, 30000);
  });

  test('assetType resolves an under-specified id and the v1_format_ref carries the DISAMBIGUATED id', () => {
    const decl = canonicalDeclarationFromBareId('display_300x250', { assetType: 'generative' });
    assert.ok(decl);
    assert.strictEqual(decl.format_kind, 'image');
    assert.strictEqual(decl.params.asset_source, 'agent_synthesized');
    // The ref points at the real catalog entry, not the under-specified base id.
    assert.deepStrictEqual(decl.v1_format_ref, [{ agent_url: AAO_AGENT_URL, id: 'display_300x250_generative' }]);
  });

  test('returns null for an unknown id', () => {
    assert.strictEqual(canonicalDeclarationFromBareId('totally_made_up_format'), null);
  });

  test('resolveCanonicalFormatKind agrees with the declaration helper', () => {
    for (const id of ['display_300x250_image', 'video_vast_30s', 'audio_standard_30s', 'nope_not_real']) {
      const viaDecl = canonicalDeclarationFromBareId(id)?.format_kind ?? null;
      assert.strictEqual(resolveCanonicalFormatKind(id), viaDecl, `mismatch for ${id}`);
    }
  });
});
