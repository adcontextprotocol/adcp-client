const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

test('v2.5 archive fetch retries availability failures only', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-v2-5-retry-'));
  const harness = path.join(directory, 'harness.ts');
  fs.writeFileSync(
    harness,
    `
import { fetchBinary } from ${JSON.stringify(path.join(REPO_ROOT, 'scripts/sync-v2-5-schemas.ts'))};

async function run(statuses: Array<number | 'network' | 'body' | 'rate-limit-403'>, attempts = 3) {
  const calls: string[] = [];
  const delays: number[] = [];
  let error: string | undefined;
  let body: string | undefined;
  try {
    body = (await fetchBinary('https://codeload.example/archive.tgz', {
      attempts,
      async fetchImpl() {
        const outcome = statuses[calls.length] ?? statuses.at(-1)!;
        calls.push(String(outcome));
        if (outcome === 'network') throw new Error('socket reset');
        if (outcome === 'body') {
          return { ok: true, arrayBuffer: async () => { throw new Error('body reset'); } } as Response;
        }
        if (outcome === 'rate-limit-403') {
          return new Response('rate limited', {
            status: 403,
            statusText: 'Forbidden',
            headers: { 'x-ratelimit-remaining': '0' },
          });
        }
        return new Response(outcome === 200 ? 'bundle' : 'unavailable', {
          status: outcome,
          statusText:
            outcome === 403
              ? 'Forbidden'
              : outcome === 404
                ? 'Not Found'
                : outcome === 429
                  ? 'Too Many Requests'
                  : 'Bad Gateway',
        });
      },
      async sleep(delayMs) { delays.push(delayMs); },
    })).toString();
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  return { calls, delays, body, error };
}

async function main() {
  const results = {
    statusRetry: await run([502, 200]),
    networkRetry: await run(['network', 200]),
    bodyRetry: await run(['body', 200]),
    timeoutRetry: await run([408, 200]),
    rateLimitRetry: await run([429, 200]),
    forbiddenRateLimitRetry: await run(['rate-limit-403', 200]),
    forbidden: await run([403, 200]),
    notFound: await run([404, 200]),
    exhausted: await run([502, 502, 502]),
    invalidAttempts: await run([200], 0),
  };
  process.stdout.write(JSON.stringify(results));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
`
  );

  try {
    const result = spawnSync(path.join(REPO_ROOT, 'node_modules/.bin/tsx'), [harness], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `harness failed:\n${result.stderr}\n${result.stdout}`);
    const results = JSON.parse(result.stdout);

    for (const name of [
      'statusRetry',
      'networkRetry',
      'bodyRetry',
      'timeoutRetry',
      'rateLimitRetry',
      'forbiddenRateLimitRetry',
    ]) {
      assert.equal(results[name].body, 'bundle');
      assert.deepEqual(results[name].delays, [1000]);
      assert.equal(results[name].calls.length, 2);
    }
    assert.deepEqual(results.notFound.calls, ['404']);
    assert.deepEqual(results.notFound.delays, []);
    assert.match(results.notFound.error, /404 Not Found/);
    assert.deepEqual(results.forbidden.calls, ['403']);
    assert.deepEqual(results.forbidden.delays, []);
    assert.match(results.forbidden.error, /403 Forbidden/);
    assert.deepEqual(results.exhausted.calls, ['502', '502', '502']);
    assert.deepEqual(results.exhausted.delays, [1000, 2000]);
    assert.match(results.exhausted.error, /502 Bad Gateway/);
    assert.match(results.invalidAttempts.error, /positive integer/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
