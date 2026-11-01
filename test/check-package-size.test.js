const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');

const modulePromise = import(pathToFileURL(path.resolve(__dirname, '..', 'scripts', 'check-package-size.mjs')).href);

test('parses clean npm pack JSON output', async () => {
  const { parseNpmPackOutput } = await modulePromise;
  assert.deepEqual(parseNpmPackOutput('[{"size": 42}]\n'), [{ size: 42 }]);
});

test('ignores ANSI-colored prepare output before npm pack JSON', async () => {
  const { parseNpmPackOutput } = await modulePromise;
  const output = '\x1b[32m✅ Git hooks are already configured\x1b[0m\n[prepare] done\n[{"size": 42}]\n';
  assert.deepEqual(parseNpmPackOutput(output), [{ size: 42 }]);
});

test('fails closed when npm pack returns no JSON array', async () => {
  const { parseNpmPackOutput } = await modulePromise;
  assert.throws(() => parseNpmPackOutput('\x1b[31mpack failed\x1b[0m\n'), /valid JSON array/);
});

const budget = {
  packages: {
    '@adcp/sdk': {
      ceiling: { packedBytes: 1_000_000, unpackedBytes: 5_000_000, files: 500 },
      perPullRequest: { packedBytes: 10_000, files: 10 },
    },
  },
};

function measurement(packedBytes, files, ceiling = budget.packages['@adcp/sdk'].ceiling) {
  return {
    schema: 1,
    commit: 'base',
    packages: { '@adcp/sdk': { packedBytes, unpackedBytes: packedBytes * 5, files, ceiling } },
  };
}

test('ceilings leave headroom and warn once fewer than two PRs fit', async () => {
  const { checkCeilings } = await modulePromise;
  const entry = budget.packages['@adcp/sdk'];
  assert.deepEqual(checkCeilings('@adcp/sdk', { packedBytes: 900_000, unpackedBytes: 1, files: 400 }, entry), {
    failures: [],
    warnings: [],
  });
  const tight = checkCeilings('@adcp/sdk', { packedBytes: 985_000, unpackedBytes: 1, files: 485 }, entry);
  assert.equal(tight.failures.length, 0);
  assert.equal(tight.warnings.length, 2);
  const over = checkCeilings('@adcp/sdk', { packedBytes: 1_000_001, unpackedBytes: 1, files: 501 }, entry);
  assert.equal(over.failures.length, 2);
  assert.match(over.failures[0], /over the ceiling of 1,000,000/);
});

test('per-PR growth within the allowance passes', async () => {
  const { compareWithBaseline } = await modulePromise;
  const result = compareWithBaseline(measurement(910_000, 410), measurement(900_000, 400), budget);
  assert.deepEqual(result.failures, []);
  assert.equal(result.rows.find(row => row.metric === 'packedBytes').delta, 10_000);
});

test('per-PR growth past the allowance fails unless the PR raises the ceiling', async () => {
  const { compareWithBaseline } = await modulePromise;
  const grown = compareWithBaseline(measurement(950_000, 420), measurement(900_000, 400), budget);
  assert.equal(grown.failures.length, 2);
  assert.match(grown.failures[0], /grows by 50,000 packed bytes against the merge base; one PR may add 10,000/);
  assert.match(grown.failures[1], /ceiling\.files/);

  const lowerCeiling = { packedBytes: 990_000, unpackedBytes: 5_000_000, files: 480 };
  const acknowledged = compareWithBaseline(measurement(950_000, 420), measurement(900_000, 400, lowerCeiling), budget);
  assert.deepEqual(acknowledged.failures, []);
  assert.equal(acknowledged.notes.length, 2);
  assert.match(acknowledged.notes[0], /raises the ceiling from 990,000 to 1,000,000/);
});

test('a package missing from the merge-base measurement is not growth-checked', async () => {
  const { compareWithBaseline, formatGrowthSummary } = await modulePromise;
  const result = compareWithBaseline(measurement(950_000, 420), { schema: 1, packages: {} }, budget);
  assert.deepEqual(result.failures, []);
  assert.match(result.notes[0], /merge base has no measurement/);
  assert.match(formatGrowthSummary([], 'abc'), /merge base \(abc\)/);
});

test('the committed budget keeps headroom above its recorded measurement', async () => {
  const { readBudget } = await modulePromise;
  const committed = readBudget(path.resolve(__dirname, '..'));
  for (const [name, entry] of Object.entries(committed.packages)) {
    for (const metric of ['packedBytes', 'files']) {
      const headroom = entry.ceiling[metric] - entry.measuredWhenSet[metric];
      assert.ok(
        headroom >= 2 * entry.perPullRequest[metric],
        `${name} ${metric}: a ceiling needs at least two PRs of headroom when it is set`
      );
    }
  }
});
