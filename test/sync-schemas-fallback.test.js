const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

function runHarness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-schema-fallback-'));
  const script = path.join(directory, 'harness.ts');
  const output = path.join(directory, 'output.json');
  fs.writeFileSync(
    script,
    `
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import {
  assertBundleVersion,
  assertValidAdcpVersion,
  getGithubDistFallbackBaseUrls,
  SchemaSyncAvailabilityError,
  syncFromTarball,
  syncSchemasPerFile,
  syncSchemasWithFallbacks,
} from ${JSON.stringify(path.join(REPO_ROOT, 'scripts/sync-schemas.ts'))};

type Outcome = boolean | 'unavailable' | 'integrity-error';

async function scenario(
  outcomes: Record<string, Outcome>,
  overrides: Partial<Parameters<typeof syncSchemasWithFallbacks>[0]> = {},
  perFileOutcomes: Record<string, Outcome> = {},
  includeSource = false
) {
  const calls: string[] = [];
  let error: string | undefined;
  let source: 'primary' | 'github' | undefined;
  const options = {
    version: '3.0.25',
    primaryBaseUrl: 'https://primary.example',
    includeSharedSurfaces: false,
    githubFallbackEnabled: true,
    requireSignature: false,
    ...overrides,
  };
  try {
    source = await syncSchemasWithFallbacks(options, {
      async syncFromTarball(_version, baseUrl) {
        calls.push('tarball:' + baseUrl);
        const outcome = outcomes[baseUrl] ?? false;
        if (outcome === 'unavailable') throw new SchemaSyncAvailabilityError('offline');
        if (outcome === 'integrity-error') throw new Error('checksum mismatch');
        return outcome;
      },
      async syncSchemasPerFile(_version, baseUrl) {
        calls.push('per-file:' + baseUrl);
        const outcome = perFileOutcomes[baseUrl] ?? true;
        if (outcome === 'unavailable') throw new SchemaSyncAvailabilityError('per-file offline');
        if (outcome === 'integrity-error') throw new Error('per-file integrity failure');
      },
      warn() {},
    });
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  return includeSource ? { calls, error, source } : { calls, error };
}

async function main() {
  const tag = getGithubDistFallbackBaseUrls('3.0.25')[0];
  const main = getGithubDistFallbackBaseUrls('3.0.25')[1];
  const primary = 'https://primary.example';
  const results = {
    urls: getGithubDistFallbackBaseUrls('3.0.25'),
    latestUrls: getGithubDistFallbackBaseUrls('latest'),
    primaryError: await scenario({ [primary]: 'unavailable', [tag]: false, [main]: false }),
    perFileMainSuccess: await scenario(
      { [primary]: 'unavailable', [tag]: false, [main]: false },
      {},
      { [tag]: 'unavailable', [main]: true }
    ),
    primaryMissing: await scenario({ [primary]: false, [tag]: false, [main]: false }),
    mainSuccess: await scenario({ [primary]: 'unavailable', [tag]: 'unavailable', [main]: true }),
    optOut: await scenario({ [primary]: false }, { githubFallbackEnabled: false }),
    optOutError: await scenario({ [primary]: 'unavailable' }, { githubFallbackEnabled: false }),
    requireSignature: await scenario(
      { [primary]: false, [tag]: false, [main]: false },
      { requireSignature: true }
    ),
    integrityFailure: await scenario({ [primary]: false, [tag]: 'integrity-error', [main]: true }),
    invalidVersion: undefined as string | undefined,
    versionMismatch: undefined as string | undefined,
    sourceSelection: {
      primary: await scenario({ [primary]: true }, {}, {}, true),
      github: await scenario({ [primary]: 'unavailable', [tag]: true }, {}, {}, true),
      primaryPerFile: await scenario({ [primary]: false, [tag]: false, [main]: false }, {}, {}, true),
      githubPerFile: await scenario(
        { [primary]: 'unavailable', [tag]: false, [main]: false },
        {},
        {},
        true
      ),
    },
  };

  try {
    assertValidAdcpVersion('../main');
  } catch (error) {
    results.invalidVersion = error instanceof Error ? error.message : String(error);
  }
  try {
    assertBundleVersion('3.0.25', '3.0.23');
  } catch (error) {
    results.versionMismatch = error instanceof Error ? error.message : String(error);
  }

  const fetchBefore = globalThis.fetch;
  const head405Calls: string[] = [];
  try {
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      head405Calls.push(init?.method ?? 'GET');
      if (init?.method === 'HEAD') {
        return new Response(null, { status: 405, statusText: 'Method Not Allowed' });
      }
      return new Response('missing', { status: 404, statusText: 'Not Found' });
    }) as typeof fetch;
    await syncFromTarball('3.0.25', 'https://custom.example', false);
  } catch (error) {
    results.head405 = {
      calls: head405Calls,
      availability: error instanceof SchemaSyncAvailabilityError,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    globalThis.fetch = fetchBefore;
  }

  try {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'HEAD') return new Response(null, { status: 200 });
      if (String(input).endsWith('.sha256')) return new Response('unused');
      return {
        ok: true,
        arrayBuffer: async () => {
          throw new Error('socket reset');
        },
      } as Response;
    }) as typeof fetch;
    await syncFromTarball('3.0.25', 'https://body-reset.example', false);
  } catch (error) {
    results.bodyReset = {
      availability: error instanceof SchemaSyncAvailabilityError,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    globalThis.fetch = fetchBefore;
  }

  const bundle = 'not-needed-before-sidecar-check';
  try {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'HEAD') {
        if (url.endsWith('.tgz.sig')) return new Response(null, { status: 404 });
        if (url.endsWith('.tgz.crt')) return new Response(null, { status: 500 });
        return new Response(null, { status: 200 });
      }
      if (url.endsWith('.sha256')) {
        return new Response(createHash('sha256').update(bundle).digest('hex'));
      }
      return new Response(bundle);
    }) as typeof fetch;
    await syncFromTarball('3.0.25', 'https://partial-sidecars.example', false);
  } catch (error) {
    results.partialSidecars = {
      availability: error instanceof SchemaSyncAvailabilityError,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    globalThis.fetch = fetchBefore;
  }

  try {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'HEAD') return new Response(null, { status: 200 });
      if (url.endsWith('.sha256')) return new Response('missing', { status: 404 });
      return new Response(bundle);
    }) as typeof fetch;
    await syncFromTarball('3.0.25', 'https://missing-sha.example', false);
  } catch (error) {
    results.missingSha = {
      availability: error instanceof SchemaSyncAvailabilityError,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    globalThis.fetch = fetchBefore;
  }

  try {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'HEAD') return new Response(null, { status: 200 });
      if (String(input).endsWith('.sha256')) return new Response('0'.repeat(64));
      return new Response(bundle);
    }) as typeof fetch;
    await syncFromTarball('3.0.25', 'https://checksum-mismatch.example', false);
  } catch (error) {
    results.checksumMismatch = {
      availability: error instanceof SchemaSyncAvailabilityError,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    globalThis.fetch = fetchBefore;
  }

  const requireSignatureBefore = process.env.ADCP_REQUIRE_SIGNATURE;
  try {
    process.env.ADCP_REQUIRE_SIGNATURE = '1';
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'HEAD') {
        if (url.endsWith('.tgz.sig') || url.endsWith('.tgz.crt')) {
          return new Response(null, { status: 404 });
        }
        return new Response(null, { status: 200 });
      }
      if (url.endsWith('.sha256')) {
        return new Response(createHash('sha256').update(bundle).digest('hex'));
      }
      return new Response(bundle);
    }) as typeof fetch;
    await syncFromTarball('3.0.25', 'https://missing-signature.example', false);
  } catch (error) {
    results.missingSignature = {
      availability: error instanceof SchemaSyncAvailabilityError,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    globalThis.fetch = fetchBefore;
    if (requireSignatureBefore === undefined) delete process.env.ADCP_REQUIRE_SIGNATURE;
    else process.env.ADCP_REQUIRE_SIGNATURE = requireSignatureBefore;
  }

  const perFileBodyResetCalls: string[] = [];
  try {
    globalThis.fetch = (async () => {
      return {
        ok: true,
        text: async () => {
          throw new Error('index socket reset');
        },
      } as Response;
    }) as typeof fetch;
    await syncSchemasWithFallbacks(
      {
        version: '3.0.25',
        primaryBaseUrl: primary,
        includeSharedSurfaces: false,
        githubFallbackEnabled: true,
        requireSignature: false,
      },
      {
        async syncFromTarball(_version, baseUrl) {
          perFileBodyResetCalls.push('tarball:' + baseUrl);
          if (baseUrl === primary) throw new SchemaSyncAvailabilityError('primary offline');
          return false;
        },
        async syncSchemasPerFile(version, baseUrl, includeSharedSurfaces) {
          perFileBodyResetCalls.push('per-file:' + baseUrl);
          if (baseUrl === tag) {
            await syncSchemasPerFile(version, baseUrl, includeSharedSurfaces);
          }
        },
        warn() {},
      }
    );
  } finally {
    globalThis.fetch = fetchBefore;
  }
  results.perFileBodyResetCalls = perFileBodyResetCalls;

  writeFileSync(${JSON.stringify(output)}, JSON.stringify(results));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
`
  );
  try {
    const result = spawnSync(path.join(REPO_ROOT, 'node_modules/.bin/tsx'), [script], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `harness failed:\n${result.stderr}\n${result.stdout}`);
    return JSON.parse(fs.readFileSync(output, 'utf8'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('schema sync coordinates tagged, moving, per-file, and signed fallbacks', () => {
  const results = runHarness();
  const tag = 'https://raw.githubusercontent.com/adcontextprotocol/adcp/v3.0.25/dist';
  const main = 'https://raw.githubusercontent.com/adcontextprotocol/adcp/main/dist';
  const primary = 'https://primary.example';

  assert.deepEqual(results.urls, [tag, main]);
  assert.deepEqual(results.latestUrls, [main]);
  assert.deepEqual(results.primaryError, {
    calls: [`tarball:${primary}`, `tarball:${tag}`, `tarball:${main}`, `per-file:${tag}`],
  });
  assert.equal(results.sourceSelection.primary.source, 'primary');
  assert.equal(results.sourceSelection.github.source, 'github');
  assert.equal(results.sourceSelection.primaryPerFile.source, 'primary');
  assert.equal(results.sourceSelection.githubPerFile.source, 'github');
  assert.deepEqual(results.perFileMainSuccess, {
    calls: [`tarball:${primary}`, `tarball:${tag}`, `tarball:${main}`, `per-file:${tag}`, `per-file:${main}`],
  });
  assert.deepEqual(results.primaryMissing, {
    calls: [`tarball:${primary}`, `tarball:${tag}`, `tarball:${main}`, `per-file:${primary}`],
  });
  assert.deepEqual(results.mainSuccess, {
    calls: [`tarball:${primary}`, `tarball:${tag}`, `tarball:${main}`],
  });
  assert.deepEqual(results.optOut, {
    calls: [`tarball:${primary}`, `per-file:${primary}`],
  });
  assert.deepEqual(results.optOutError, {
    calls: [`tarball:${primary}`],
    error: 'offline',
  });
  assert.match(results.requireSignature.error, /refusing unsigned per-file schema fallback/);
  assert.equal(
    results.requireSignature.calls.some(call => call.startsWith('per-file:')),
    false
  );
  assert.deepEqual(results.integrityFailure, {
    calls: [`tarball:${primary}`, `tarball:${tag}`],
    error: 'checksum mismatch',
  });
  assert.deepEqual(results.head405.calls, ['HEAD', 'GET', 'GET']);
  assert.equal(results.head405.availability, true);
  assert.match(results.head405.error, /404 Not Found/);
  assert.equal(results.bodyReset.availability, true);
  assert.match(results.bodyReset.error, /socket reset/);
  assert.match(results.invalidVersion, /expected a semantic version or "latest"/);
  assert.match(results.versionMismatch, /requested 3\.0\.25, received 3\.0\.23/);
  assert.equal(results.partialSidecars.availability, true);
  assert.match(results.partialSidecars.error, /Incomplete cosign sidecars/);
  assert.equal(results.missingSha.availability, true);
  assert.match(results.missingSha.error, /404/);
  assert.equal(results.checksumMismatch.availability, false);
  assert.match(results.checksumMismatch.error, /sha256 mismatch/);
  assert.equal(results.missingSignature.availability, true);
  assert.match(results.missingSignature.error, /required.*not published/);
  assert.deepEqual(results.perFileBodyResetCalls, [
    `tarball:${primary}`,
    `tarball:${tag}`,
    `tarball:${main}`,
    `per-file:${tag}`,
    `per-file:${main}`,
  ]);
});
