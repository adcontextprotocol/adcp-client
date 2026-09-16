const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '..');

test('exact Zod projection resolves refs only from the verified schema cache', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '.zod-verified-cache-'));
  const harness = path.join(directory, 'harness.ts');
  fs.writeFileSync(
    harness,
    `
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { __test__ } from ${JSON.stringify(path.join(REPO_ROOT, 'scripts/generate-zod-from-ts.ts'))};

async function main() {
const cacheRoot = ${JSON.stringify(path.join(REPO_ROOT, 'schemas/cache/latest'))};
const targetingInput = JSON.parse(readFileSync(${JSON.stringify(
      path.join(REPO_ROOT, 'schemas/cache/latest/core/targeting-input.json')
    )}, 'utf8'));
const dereferenced = await __test__.dereferenceFromVerifiedSchemaCache(targetingInput, cacheRoot);
assert.equal(dereferenced.properties.geo_countries.anyOf[0].minItems, 1);
assert.equal(dereferenced.properties.geo_countries.anyOf[0].items.pattern, '^[A-Z]{2}$');

await assert.rejects(
  __test__.dereferenceFromVerifiedSchemaCache(
    { $id: 'https://adcontextprotocol.org/schemas/test/root.json', $ref: 'https://example.com/live.json' },
    cacheRoot
  ),
  /resolve|resolver|reference/i
);
}
main();
`
  );
  try {
    const result = spawnSync('npx', ['tsx', harness], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
