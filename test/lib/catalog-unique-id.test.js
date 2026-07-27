const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  _resetCatalogCache,
  lookupUniqueV1FormatById,
  lookupV1Format,
} = require('../../dist/lib/v2/projection/catalog.js');

const temporaryDirectories = [];

afterEach(() => {
  _resetCatalogCache();
  while (temporaryDirectories.length > 0) rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
});

function catalogPath(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'adcp-catalog-'));
  temporaryDirectories.push(directory);
  const file = path.join(directory, 'catalog.json');
  writeFileSync(file, JSON.stringify(entries));
  return file;
}

describe('unique AAO bare-id compatibility lookup', () => {
  test('returns one uniquely published bare id', () => {
    const entry = {
      format_id: { agent_url: 'https://creative.adcontextprotocol.org/', id: 'display_standard' },
      canonical: { kind: 'image' },
    };
    const file = catalogPath([entry]);

    assert.deepStrictEqual(lookupUniqueV1FormatById('display_standard', file), entry);
  });

  test('fails closed when two owners publish the same bare id', () => {
    const first = {
      format_id: { agent_url: 'https://creative.adcontextprotocol.org/', id: 'shared_name' },
      canonical: { kind: 'image' },
    };
    const second = {
      format_id: { agent_url: 'https://formats.publisher.example/', id: 'shared_name' },
      canonical: { kind: 'display_tag' },
    };
    const file = catalogPath([first, second]);

    assert.strictEqual(lookupUniqueV1FormatById('shared_name', file), undefined);
    assert.deepStrictEqual(lookupV1Format(first.format_id, file), first);
    assert.deepStrictEqual(lookupV1Format(second.format_id, file), second);
  });

  test('keeps uniqueness caches isolated by catalog path', () => {
    const unique = catalogPath([
      {
        format_id: { agent_url: 'https://creative.adcontextprotocol.org/', id: 'same_id' },
        canonical: { kind: 'image' },
      },
    ]);
    const colliding = catalogPath([
      {
        format_id: { agent_url: 'https://one.example/', id: 'same_id' },
        canonical: { kind: 'image' },
      },
      {
        format_id: { agent_url: 'https://two.example/', id: 'same_id' },
        canonical: { kind: 'display_tag' },
      },
    ]);

    assert.ok(lookupUniqueV1FormatById('same_id', unique));
    assert.strictEqual(lookupUniqueV1FormatById('same_id', colliding), undefined);
  });
});
