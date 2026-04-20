/**
 * CLI: `adcp storyboard run --brand` / `--brand-manifest` passthrough (#639).
 *
 * The runner's `applyBrandInvariant` is a no-op unless `options.brand` (or
 * `options.brand_manifest`) is set. Before this fix the CLI never populated
 * either, so any CLI-driven storyboard run lost the brand-scoped session
 * guarantee that PR #586 introduced.
 *
 * These tests verify the parse layer directly (fast, hermetic) and a small
 * end-to-end surface for the mutual-exclusion error.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const CLI = path.resolve(__dirname, '../../bin/adcp.js');
const { parseAgentOptions, parseBrandFlag } = require(CLI);

describe('parseBrandFlag', () => {
  test('treats a bare domain as BrandReference.domain', () => {
    assert.deepStrictEqual(parseBrandFlag('acmeoutdoor.example'), { domain: 'acmeoutdoor.example' });
  });

  test('parses inline JSON as a full BrandReference', () => {
    assert.deepStrictEqual(parseBrandFlag('{"domain":"acme.example","brand_id":"b-1"}'), {
      domain: 'acme.example',
      brand_id: 'b-1',
    });
  });

  test('trims surrounding whitespace on the domain form', () => {
    assert.deepStrictEqual(parseBrandFlag('  acme.example  '), { domain: 'acme.example' });
  });
});

describe('parseAgentOptions: --brand and --brand-manifest', () => {
  test('--brand <domain> populates options.brand as a BrandReference', () => {
    const opts = parseAgentOptions(['agent', 'some-id', '--brand', 'acmeoutdoor.example']);
    assert.deepStrictEqual(opts.brand, { domain: 'acmeoutdoor.example' });
    assert.strictEqual(opts.brandManifest, null);
    assert.deepStrictEqual(opts.positionalArgs, ['agent', 'some-id']);
  });

  test('--brand JSON populates options.brand with extra fields', () => {
    const opts = parseAgentOptions(['agent', '--brand', '{"domain":"acme.example","brand_id":"b-1"}']);
    assert.deepStrictEqual(opts.brand, { domain: 'acme.example', brand_id: 'b-1' });
  });

  test('--brand-manifest JSON populates options.brandManifest', () => {
    const opts = parseAgentOptions([
      'agent',
      '--brand-manifest',
      '{"name":"Acme","url":"https://acmeoutdoor.example"}',
    ]);
    assert.deepStrictEqual(opts.brandManifest, { name: 'Acme', url: 'https://acmeoutdoor.example' });
    assert.strictEqual(opts.brand, null);
  });

  test('strips the --brand value from positional args (does not collide with storyboard ID)', () => {
    const opts = parseAgentOptions(['agent', 'media_buy_seller', '--brand', 'acmeoutdoor.example']);
    assert.deepStrictEqual(opts.positionalArgs, ['agent', 'media_buy_seller']);
  });

  test('--brand before the positional storyboard ID also works', () => {
    const opts = parseAgentOptions(['agent', '--brand', 'acmeoutdoor.example', 'media_buy_seller']);
    assert.deepStrictEqual(opts.positionalArgs, ['agent', 'media_buy_seller']);
  });

  test('returns null brand / null brandManifest when neither flag is passed', () => {
    const opts = parseAgentOptions(['agent', 'some-id']);
    assert.strictEqual(opts.brand, null);
    assert.strictEqual(opts.brandManifest, null);
  });
});

// ────────────────────────────────────────────────────────────
// CLI surface: mutual-exclusion error path
// ────────────────────────────────────────────────────────────

describe('adcp storyboard run --brand conflicts', () => {
  test('rejects --brand combined with --brand-manifest', () => {
    const result = spawnSync(
      'node',
      [
        CLI,
        'storyboard',
        'run',
        'test-mcp',
        'media_buy_seller',
        '--brand',
        'acme.example',
        '--brand-manifest',
        '{"name":"Acme","url":"https://acme.example"}',
      ],
      { encoding: 'utf8' }
    );
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /--brand and --brand-manifest are mutually exclusive/);
  });

  test('rejects --brand JSON that lacks a string `domain`', () => {
    const result = spawnSync(
      'node',
      [CLI, 'storyboard', 'run', 'test-mcp', 'media_buy_seller', '--brand', '{"brand_id":"x"}'],
      { encoding: 'utf8' }
    );
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /BrandReference object with a string `domain`/);
  });
});
