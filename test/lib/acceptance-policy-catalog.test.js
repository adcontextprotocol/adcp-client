const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createHash } = require('node:crypto');

const {
  createAcceptancePolicyCatalogResolver,
  resolveAcceptancePolicyCatalog,
  resolveAcceptancePolicyProfiles,
  resolveVerifiedAcceptancePolicyProfiles,
} = require('../../dist/lib');
const { canonicalJsonSha256 } = require('../../dist/lib/utils/jcs');

const sha256 = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const bytes = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));

function localProfile(overrides = {}) {
  const profile = {
    profile_id: 'seller_default',
    version: '2026-09-21',
    content_digest: '',
    policy_refs: [
      {
        policy_id: 'seller_policy',
        version: '1.0.0',
        content_digest: `sha256:${'1'.repeat(64)}`,
      },
    ],
    coverage: 'partial',
    rules: [
      {
        rule_id: 'general_rule',
        subject_category: 'political_advertising',
        applies_to: ['media_buy'],
        disposition: 'allowed',
        policy_ids: ['seller_policy'],
      },
    ],
    ...overrides,
  };
  const { content_digest: _ignored, ...digestInput } = profile;
  profile.content_digest = `sha256:${canonicalJsonSha256(digestInput)}`;
  return profile;
}

function catalog(overrides = {}) {
  return { catalog_version: '2026-09-21', profiles: [localProfile()], ...overrides };
}

function registryFixture(overrides = {}) {
  const policyId = overrides.policyId ?? 'registry_policy';
  const policyVersion = overrides.policyVersion ?? '1.0.0';
  const profileId = overrides.profileId ?? 'registry_default';
  const profileVersion = overrides.profileVersion ?? '2026-09-21';
  const canonicalContent = overrides.canonicalContent ?? {
    policy_id: policyId,
    version: policyVersion,
    name: 'Pinned registry policy',
  };
  const policyDigest = `sha256:${canonicalJsonSha256(canonicalContent)}`;
  const profile = localProfile({
    profile_id: profileId,
    version: profileVersion,
    policy_refs: [{ policy_id: policyId, version: policyVersion, content_digest: policyDigest }],
    rules: [
      {
        rule_id: 'registry_rule',
        subject_category: 'political_advertising',
        applies_to: ['media_buy'],
        disposition: 'conditional',
        requirements: [{ kind: 'prior_authorization' }],
        policy_ids: [policyId],
      },
    ],
    ...overrides.profile,
  });
  const ref = {
    policy_id: policyId,
    policy_version: policyVersion,
    policy_digest: policyDigest,
    profile_id: profileId,
    profile_version: profileVersion,
    profile_digest: profile.content_digest,
    ...overrides.ref,
  };
  const policy = {
    policy_id: policyId,
    version: policyVersion,
    content_digest: policyDigest,
    canonical_content: canonicalContent,
    acceptance_profile: profile,
    ...overrides.policy,
  };
  return { ref, policy, profile };
}

let server;
let baseUrl;
const routes = new Map();
const requests = new Map();

before(async () => {
  server = http.createServer((req, res) => {
    requests.set(req.url, (requests.get(req.url) ?? 0) + 1);
    const route = routes.get(req.url);
    if (!route) return res.writeHead(404).end();
    return route(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const unsafeFixtureOptions = { allowUnsafeHttp: true, allowPrivateNetwork: true };

function capability(path, body, defaults = ['seller_default']) {
  return {
    catalog_url: `${baseUrl}${path}`,
    catalog_digest: sha256(body),
    default_profile_ids: defaults,
  };
}

describe('acceptance-policy catalog resolution', () => {
  it('verifies exact bytes, schema, local profile digests, and advertised defaults', async () => {
    const body = bytes(catalog());
    routes.set('/valid.json', (_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(body));

    const result = await resolveAcceptancePolicyCatalog(capability('/valid.json', body), unsafeFixtureOptions);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.fromCache, false);
    assert.strictEqual(result.catalog.catalog_version, '2026-09-21');
    assert.deepStrictEqual(
      result.defaultProfiles.map(value => [value.source, value.resolution, value.profileId]),
      [['seller', 'resolved', 'seller_default']]
    );
    assert.strictEqual(result.defaultProfiles[0].profile, result.catalog.profiles[0]);
  });

  it('hard-fails a semantically identical body whose exact bytes differ', async () => {
    const compact = bytes(catalog());
    const spaced = bytes(`${JSON.stringify(catalog(), null, 2)}\n`);
    routes.set('/different-bytes.json', (_req, res) => res.writeHead(200).end(spaced));

    const result = await resolveAcceptancePolicyCatalog(
      capability('/different-bytes.json', compact),
      unsafeFixtureOptions
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'digest_mismatch');
  });

  it('rejects malformed UTF-8 before JSON parsing', async () => {
    const validBody = bytes(catalog({ profiles: [localProfile({ description: '\ufffd' })] }));
    const replacement = Buffer.from('\ufffd');
    const offset = validBody.indexOf(replacement);
    assert.notStrictEqual(offset, -1);
    const malformedBody = Buffer.concat([
      validBody.subarray(0, offset),
      Buffer.from([0xff]),
      validBody.subarray(offset + replacement.length),
    ]);
    routes.set('/invalid-utf8.json', (_req, res) => res.writeHead(200).end(malformedBody));

    const result = await resolveAcceptancePolicyCatalog(
      capability('/invalid-utf8.json', malformedBody),
      unsafeFixtureOptions
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'invalid_json');
  });

  it('rejects duplicate JSON object keys before profile canonicalization', async () => {
    const validBody = bytes(catalog());
    const ambiguousBody = Buffer.from(
      validBody
        .toString('utf8')
        .replace('"disposition":"allowed"', '"disposition":"prohibited","disposition":"allowed"')
    );
    routes.set('/duplicate-json-key.json', (_req, res) => res.writeHead(200).end(ambiguousBody));

    const result = await resolveAcceptancePolicyCatalog(
      capability('/duplicate-json-key.json', ambiguousBody),
      unsafeFixtureOptions
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'invalid_json');
  });

  it('rejects URL credentials before DNS and does not echo them', async () => {
    const result = await resolveAcceptancePolicyCatalog({
      catalog_url: 'https://secret:password@public.example/catalog.json',
      catalog_digest: `sha256:${'0'.repeat(64)}`,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'unsafe_url');
    assert.doesNotMatch(JSON.stringify(result), /secret|password/);
  });

  it('rejects private targets by default', async () => {
    const body = bytes(catalog());
    const result = await resolveAcceptancePolicyCatalog({
      catalog_url: `https://127.0.0.1:${server.address().port}/private.json`,
      catalog_digest: sha256(body),
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'unsafe_url');
  });

  it('rejects numeric options that could disable wall-time or body bounds', async () => {
    const capability = {
      catalog_url: 'https://public.example/catalog.json',
      catalog_digest: `sha256:${'0'.repeat(64)}`,
    };
    const unboundedBody = await resolveAcceptancePolicyCatalog(capability, { maxBodyBytes: Infinity });
    const invalidTimeout = await resolveAcceptancePolicyCatalog(capability, { timeoutMs: 0 });
    const invalidRegistryTimeout = await resolveAcceptancePolicyCatalog(capability, { registryTimeoutMs: 30_001 });
    const incompleteFixtureOptIn = await resolveAcceptancePolicyCatalog(capability, { allowUnsafeHttp: true });
    const invalidSignal = await resolveAcceptancePolicyCatalog(capability, { signal: 'not-a-signal' });
    const invalidProfileSignal = await resolveVerifiedAcceptancePolicyProfiles(catalog(), ['seller_default'], {
      registryResolver: { resolvePolicy: async () => null },
      signal: true,
    });
    const invalidResolverSignal = await createAcceptancePolicyCatalogResolver({ signal: 42 }).resolve(capability);

    assert.strictEqual(unboundedBody.ok, false);
    assert.strictEqual(unboundedBody.error.code, 'invalid_options');
    assert.strictEqual(invalidTimeout.ok, false);
    assert.strictEqual(invalidTimeout.error.code, 'invalid_options');
    assert.strictEqual(invalidRegistryTimeout.ok, false);
    assert.strictEqual(invalidRegistryTimeout.error.code, 'invalid_options');
    assert.strictEqual(incompleteFixtureOptIn.ok, false);
    assert.strictEqual(incompleteFixtureOptIn.error.code, 'invalid_options');
    assert.strictEqual(invalidSignal.ok, false);
    assert.strictEqual(invalidSignal.error.pointer, '/options/signal');
    assert.strictEqual(invalidProfileSignal.ok, false);
    assert.strictEqual(invalidProfileSignal.error.pointer, '/options/signal');
    assert.strictEqual(invalidResolverSignal.ok, false);
    assert.strictEqual(invalidResolverSignal.error.pointer, '/options/signal');
  });

  it('rejects an explicitly empty default profile list', async () => {
    const body = bytes(catalog());
    const result = await resolveAcceptancePolicyCatalog(capability('/unused.json', body, []), unsafeFixtureOptions);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'invalid_capability');
  });

  it('blocks redirects, oversized bodies, and timeouts with distinct diagnostics', async () => {
    const body = bytes(catalog());
    routes.set('/redirect.json', (_req, res) => res.writeHead(302, { location: '/valid.json' }).end());
    routes.set('/large.json', (_req, res) => res.writeHead(200).end(Buffer.alloc(2048, 0x41)));
    routes.set('/timeout.json', () => {});

    const redirect = await resolveAcceptancePolicyCatalog(capability('/redirect.json', body), unsafeFixtureOptions);
    const large = await resolveAcceptancePolicyCatalog(capability('/large.json', body), {
      ...unsafeFixtureOptions,
      maxBodyBytes: 512,
    });
    const timeout = await resolveAcceptancePolicyCatalog(capability('/timeout.json', body), {
      ...unsafeFixtureOptions,
      timeoutMs: 25,
    });

    assert.strictEqual(redirect.ok, false);
    assert.strictEqual(redirect.error.code, 'redirect_blocked');
    assert.strictEqual(large.ok, false);
    assert.strictEqual(large.error.code, 'body_too_large');
    assert.strictEqual(timeout.ok, false);
    assert.strictEqual(timeout.error.code, 'fetch_failed');
    assert.strictEqual(timeout.error.retryable, true);
  });

  it('propagates caller cancellation through catalog fetches', async () => {
    const body = bytes(catalog());
    routes.set('/abort.json', () => {});
    const controller = new AbortController();
    const reason = new Error('operator cancelled catalog verification');
    const pending = resolveAcceptancePolicyCatalog(capability('/abort.json', body), {
      ...unsafeFixtureOptions,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(reason), 10);

    await assert.rejects(pending, error => error === reason);
  });

  it('preserves HTTP status and retryability without exposing response content', async () => {
    const body = bytes(catalog());
    routes.set('/not-found.json', (_req, res) => res.writeHead(404).end('secret-not-found-body'));
    routes.set('/unavailable.json', (_req, res) => res.writeHead(503).end('secret-unavailable-body'));

    const notFound = await resolveAcceptancePolicyCatalog(capability('/not-found.json', body), unsafeFixtureOptions);
    const unavailable = await resolveAcceptancePolicyCatalog(
      capability('/unavailable.json', body),
      unsafeFixtureOptions
    );

    assert.deepStrictEqual(
      [notFound.error.code, notFound.error.httpStatus, notFound.error.retryable],
      ['http_error', 404, false]
    );
    assert.deepStrictEqual(
      [unavailable.error.code, unavailable.error.httpStatus, unavailable.error.retryable],
      ['http_error', 503, true]
    );
    assert.doesNotMatch(JSON.stringify([notFound, unavailable]), /secret-/);
  });

  it('distinguishes schema failures from semantic reference failures', async () => {
    const invalidSchemaBody = bytes({ profiles: [localProfile()] });
    routes.set('/schema-invalid.json', (_req, res) => res.writeHead(200).end(invalidSchemaBody));

    const duplicateProfile = localProfile();
    const duplicateBody = bytes(
      catalog({
        registry_profiles: [
          {
            policy_id: 'registry_policy',
            policy_version: '1',
            policy_digest: `sha256:${'2'.repeat(64)}`,
            profile_id: duplicateProfile.profile_id,
            profile_version: '1',
            profile_digest: `sha256:${'3'.repeat(64)}`,
          },
        ],
      })
    );
    routes.set('/duplicate.json', (_req, res) => res.writeHead(200).end(duplicateBody));

    const schemaResult = await resolveAcceptancePolicyCatalog(
      {
        catalog_url: `${baseUrl}/schema-invalid.json`,
        catalog_digest: sha256(invalidSchemaBody),
      },
      unsafeFixtureOptions
    );
    const duplicateResult = await resolveAcceptancePolicyCatalog(
      capability('/duplicate.json', duplicateBody),
      unsafeFixtureOptions
    );

    assert.strictEqual(schemaResult.ok, false);
    assert.strictEqual(schemaResult.error.code, 'schema_invalid');
    assert.strictEqual(schemaResult.error.pointer, '/');
    assert.strictEqual(duplicateResult.ok, false);
    assert.strictEqual(duplicateResult.error.code, 'duplicate_profile_id');
  });

  it('keeps registry pins explicitly unresolved until a trusted registry resolver verifies them', async () => {
    const registryRef = {
      policy_id: 'registry_policy',
      policy_version: '1',
      policy_digest: `sha256:${'2'.repeat(64)}`,
      profile_id: 'registry_default',
      profile_version: '1',
      profile_digest: `sha256:${'3'.repeat(64)}`,
    };
    const body = bytes(catalog({ profiles: undefined, registry_profiles: [registryRef] }));
    routes.set('/registry.json', (_req, res) => res.writeHead(200).end(body));

    const result = await resolveAcceptancePolicyCatalog(
      capability('/registry.json', body, ['registry_default']),
      unsafeFixtureOptions
    );

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.defaultProfiles[0], {
      source: 'registry',
      resolution: 'unresolved',
      profileId: 'registry_default',
      ref: registryRef,
    });
    assert.deepStrictEqual(resolveAcceptancePolicyProfiles(result.catalog, ['registry_default', 'missing']), [
      {
        source: 'registry',
        resolution: 'unresolved',
        profileId: 'registry_default',
        ref: result.catalog.registry_profiles[0],
      },
      { source: 'catalog', resolution: 'missing', profileId: 'missing' },
    ]);
  });

  it('resolves registry-backed defaults only after exact policy and profile verification', async () => {
    const fixture = registryFixture();
    const body = bytes(catalog({ profiles: undefined, registry_profiles: [fixture.ref] }));
    routes.set('/verified-registry.json', (_req, res) => res.writeHead(200).end(body));
    const calls = [];
    const registryResolver = {
      async resolvePolicy(params) {
        calls.push(params);
        return structuredClone(fixture.policy);
      },
    };

    const result = await resolveAcceptancePolicyCatalog(
      capability('/verified-registry.json', body, [fixture.ref.profile_id]),
      { ...unsafeFixtureOptions, registryResolver }
    );

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(
      calls.map(({ signal: _signal, ...params }) => params),
      [{ policy_id: 'registry_policy', version: '1.0.0' }]
    );
    assert.ok(calls[0].signal instanceof AbortSignal);
    assert.deepStrictEqual(
      result.defaultProfiles.map(value => [value.source, value.resolution, value.profileId]),
      [['registry', 'resolved', 'registry_default']]
    );
    assert.deepStrictEqual(result.defaultProfiles[0].profile, fixture.profile);
    assert.notStrictEqual(result.defaultProfiles[0].profile, fixture.policy.acceptance_profile);
    assert.strictEqual(result.defaultProfiles[0].ref, result.catalog.registry_profiles[0]);
  });

  it('resolves selected product profiles and coalesces duplicate registry IDs', async () => {
    const fixture = registryFixture();
    const value = catalog({ registry_profiles: [fixture.ref] });
    let calls = 0;

    const result = await resolveVerifiedAcceptancePolicyProfiles(
      value,
      ['seller_default', 'registry_default', 'registry_default', 'missing'],
      {
        registryResolver: {
          async resolvePolicy() {
            calls += 1;
            return structuredClone(fixture.policy);
          },
        },
      }
    );

    assert.strictEqual(result.ok, true);
    assert.strictEqual(calls, 1);
    assert.deepStrictEqual(
      result.profiles.map(profile => [profile.source, profile.resolution, profile.profileId]),
      [
        ['seller', 'resolved', 'seller_default'],
        ['registry', 'resolved', 'registry_default'],
        ['registry', 'resolved', 'registry_default'],
        ['catalog', 'missing', 'missing'],
      ]
    );
    assert.strictEqual(result.profiles[1], result.profiles[2]);
  });

  it('accepts a pinned embedded profile that references a separate policy set', async () => {
    const referencedPolicy = {
      policy_id: 'profile_policy',
      version: '2.0.0',
      content_digest: `sha256:${'4'.repeat(64)}`,
    };
    const fixture = registryFixture({
      profile: {
        policy_refs: [referencedPolicy],
        rules: [
          {
            rule_id: 'separate_policy_rule',
            subject_category: 'political_advertising',
            applies_to: ['media_buy'],
            disposition: 'conditional',
            requirements: [{ kind: 'prior_authorization' }],
            policy_ids: ['profile_policy'],
          },
        ],
      },
    });

    const result = await resolveVerifiedAcceptancePolicyProfiles(
      catalog({ profiles: undefined, registry_profiles: [fixture.ref] }),
      ['registry_default'],
      { registryResolver: { resolvePolicy: async () => structuredClone(fixture.policy) } }
    );

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.profiles[0].resolution, 'resolved');
    assert.strictEqual(result.issues, undefined);
  });

  it('revalidates seller-local profiles at the standalone verified-helper boundary', async () => {
    const tampered = localProfile();
    tampered.rules[0].disposition = 'prohibited';

    const result = await resolveVerifiedAcceptancePolicyProfiles(
      catalog({ profiles: [tampered] }),
      ['seller_default'],
      { registryResolver: { resolvePolicy: async () => null } }
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'profile_digest_mismatch');
    assert.strictEqual(result.error.pointer, '/profiles/0/content_digest');
  });

  it('applies one overall deadline to registry resolution', async () => {
    const fixture = registryFixture();
    const value = catalog({ profiles: undefined, registry_profiles: [fixture.ref] });
    const startedAt = Date.now();

    const result = await resolveVerifiedAcceptancePolicyProfiles(value, ['registry_default'], {
      registryResolver: {
        resolvePolicy: ({ signal }) =>
          new Promise(resolve => {
            signal.addEventListener('abort', () => resolve(structuredClone(fixture.policy)), { once: true });
          }),
      },
      timeoutMs: 20,
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.profiles[0].resolution, 'unresolved');
    assert.strictEqual(result.issues[0].code, 'registry_timeout');
    assert.strictEqual(result.issues[0].retryable, true);
    assert.ok(Date.now() - startedAt < 1_000);
  });

  it('propagates caller cancellation through registry resolution', async () => {
    const fixture = registryFixture();
    const controller = new AbortController();
    const reason = new Error('operator cancelled registry verification');
    const pending = resolveVerifiedAcceptancePolicyProfiles(
      catalog({ profiles: undefined, registry_profiles: [fixture.ref] }),
      ['registry_default'],
      {
        registryResolver: {
          resolvePolicy: ({ signal }) =>
            new Promise((_, reject) => {
              signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            }),
        },
        signal: controller.signal,
      }
    );
    setTimeout(() => controller.abort(reason), 10);

    await assert.rejects(pending, error => error === reason);
  });

  it('propagates caller cancellation when a registry resolver ignores its signal', async () => {
    const fixture = registryFixture();
    const controller = new AbortController();
    const reason = new Error('operator cancelled an uncooperative registry resolver');
    const startedAt = Date.now();
    const pending = resolveVerifiedAcceptancePolicyProfiles(
      catalog({ profiles: undefined, registry_profiles: [fixture.ref] }),
      ['registry_default'],
      {
        registryResolver: { resolvePolicy: () => new Promise(() => {}) },
        signal: controller.signal,
      }
    );
    setTimeout(() => controller.abort(reason), 10);

    await assert.rejects(pending, error => error === reason);
    assert.ok(Date.now() - startedAt < 1_000);
  });

  it('cancels only the active worker set and starts no queued lookups after the batch deadline', async () => {
    const fixtures = Array.from({ length: 6 }, (_, index) =>
      registryFixture({ policyId: `deadline_policy_${index}`, profileId: `deadline_profile_${index}` })
    );
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    let aborted = 0;
    const startedAt = Date.now();

    const result = await resolveVerifiedAcceptancePolicyProfiles(
      catalog({ profiles: undefined, registry_profiles: fixtures.map(fixture => fixture.ref) }),
      fixtures.map(fixture => fixture.ref.profile_id),
      {
        registryResolver: {
          resolvePolicy: ({ signal }) => {
            calls += 1;
            active += 1;
            maxActive = Math.max(maxActive, active);
            return new Promise((_, reject) => {
              signal.addEventListener(
                'abort',
                () => {
                  aborted += 1;
                  active -= 1;
                  reject(signal.reason);
                },
                { once: true }
              );
            });
          },
        },
        timeoutMs: 20,
      }
    );

    assert.strictEqual(result.ok, true);
    assert.ok(result.profiles.every(profile => profile.resolution === 'unresolved'));
    assert.ok(result.issues.every(value => value.code === 'registry_timeout'));
    assert.strictEqual(calls, 4);
    assert.strictEqual(maxActive, 4);
    assert.strictEqual(aborted, 4);
    assert.strictEqual(active, 0);
    assert.ok(Date.now() - startedAt < 1_000);
  });

  it('enforces the batch deadline when active registry lookups ignore cancellation', async () => {
    const fixtures = Array.from({ length: 6 }, (_, index) =>
      registryFixture({ policyId: `hung_policy_${index}`, profileId: `hung_profile_${index}` })
    );
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    const startedAt = Date.now();

    const result = await resolveVerifiedAcceptancePolicyProfiles(
      catalog({ profiles: undefined, registry_profiles: fixtures.map(fixture => fixture.ref) }),
      fixtures.map(fixture => fixture.ref.profile_id),
      {
        registryResolver: {
          resolvePolicy: () => {
            calls += 1;
            active += 1;
            maxActive = Math.max(maxActive, active);
            return new Promise(() => {});
          },
        },
        timeoutMs: 20,
      }
    );

    assert.strictEqual(result.ok, true);
    assert.ok(result.profiles.every(profile => profile.resolution === 'unresolved'));
    assert.ok(result.issues.every(value => value.code === 'registry_timeout'));
    assert.strictEqual(calls, 4);
    assert.strictEqual(maxActive, 4);
    assert.ok(Date.now() - startedAt < 1_000);
  });

  it('snapshots standalone helper options before an in-flight registry batch', async () => {
    const fixtures = Array.from({ length: 5 }, (_, index) =>
      registryFixture({ policyId: `policy_${index}`, profileId: `profile_${index}` })
    );
    const policies = new Map(fixtures.map(fixture => [fixture.policy.policy_id, fixture.policy]));
    let releaseFirstWave;
    const firstWave = new Promise(resolve => {
      releaseFirstWave = resolve;
    });
    let markFirstWaveReady;
    const firstWaveReady = new Promise(resolve => {
      markFirstWaveReady = resolve;
    });
    let originalCalls = 0;
    let replacementCalls = 0;
    const options = {
      registryResolver: {
        async resolvePolicy({ policy_id }) {
          originalCalls += 1;
          if (originalCalls <= 4) {
            if (originalCalls === 4) markFirstWaveReady();
            await firstWave;
          }
          return structuredClone(policies.get(policy_id));
        },
      },
    };
    const pending = resolveVerifiedAcceptancePolicyProfiles(
      catalog({ profiles: undefined, registry_profiles: fixtures.map(fixture => fixture.ref) }),
      fixtures.map(fixture => fixture.ref.profile_id),
      options
    );

    await firstWaveReady;
    options.adcpVersion = 'mutated-version';
    options.registryResolver = {
      async resolvePolicy() {
        replacementCalls += 1;
        return null;
      },
    };
    releaseFirstWave();
    const result = await pending;

    assert.strictEqual(result.ok, true);
    assert.ok(result.profiles.every(profile => profile.resolution === 'resolved'));
    assert.strictEqual(originalCalls, 5);
    assert.strictEqual(replacementCalls, 0);
  });

  it('bounds distinct registry lookups before contacting the registry', async () => {
    const first = registryFixture({ policyId: 'policy_a', profileId: 'profile_a' });
    const second = registryFixture({ policyId: 'policy_b', profileId: 'profile_b' });
    let calls = 0;

    const result = await resolveVerifiedAcceptancePolicyProfiles(
      catalog({ profiles: undefined, registry_profiles: [first.ref, second.ref] }),
      ['profile_a', 'profile_b'],
      {
        registryResolver: {
          async resolvePolicy() {
            calls += 1;
            return null;
          },
        },
        maxRegistryProfiles: 1,
      }
    );

    assert.strictEqual(result.ok, true);
    assert.ok(result.profiles.every(profile => profile.resolution === 'unresolved'));
    assert.strictEqual(result.issues[0].code, 'registry_resolution_limit_exceeded');
    assert.strictEqual(calls, 0);
  });

  it('bounds the selected profile output before registry work', async () => {
    const fixture = registryFixture();
    let calls = 0;
    const result = await resolveVerifiedAcceptancePolicyProfiles(
      catalog({ profiles: undefined, registry_profiles: [fixture.ref] }),
      Array.from({ length: 1025 }, () => 'registry_default'),
      {
        registryResolver: {
          async resolvePolicy() {
            calls += 1;
            return fixture.policy;
          },
        },
      }
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'invalid_options');
    assert.strictEqual(calls, 0);
  });

  it('rejects cyclic registry and catalog objects without recursive canonicalization', async () => {
    const fixture = registryFixture();
    const cyclicPolicy = structuredClone(fixture.policy);
    cyclicPolicy.canonical_content.self = cyclicPolicy.canonical_content;
    const registryResult = await resolveVerifiedAcceptancePolicyProfiles(
      catalog({ profiles: undefined, registry_profiles: [fixture.ref] }),
      ['registry_default'],
      { registryResolver: { resolvePolicy: async () => cyclicPolicy } }
    );

    const cyclicCatalog = catalog();
    cyclicCatalog.ext = { vendor: {} };
    cyclicCatalog.ext.vendor.self = cyclicCatalog.ext.vendor;
    const catalogResult = await resolveVerifiedAcceptancePolicyProfiles(cyclicCatalog, ['seller_default'], {
      registryResolver: { resolvePolicy: async () => null },
    });

    assert.strictEqual(registryResult.ok, true);
    assert.strictEqual(registryResult.profiles[0].resolution, 'unresolved');
    assert.strictEqual(registryResult.issues[0].code, 'registry_policy_unverifiable');
    assert.strictEqual(catalogResult.ok, false);
    assert.strictEqual(catalogResult.error.code, 'catalog_document_invalid');
  });

  it('fails closed with distinct registry fetch, resolution, and identity diagnostics', async () => {
    const fixture = registryFixture();
    const value = catalog({ profiles: undefined, registry_profiles: [fixture.ref] });
    const cases = [
      {
        code: 'registry_fetch_failed',
        resolvePolicy: async () => {
          throw new Error('SECRET_REGISTRY_FAILURE');
        },
      },
      { code: 'registry_reference_unresolved', resolvePolicy: async () => null },
      {
        code: 'registry_policy_mismatch',
        resolvePolicy: async () => ({ ...structuredClone(fixture.policy), version: 'other' }),
      },
    ];

    for (const testCase of cases) {
      const result = await resolveVerifiedAcceptancePolicyProfiles(value, ['registry_default'], {
        registryResolver: { resolvePolicy: testCase.resolvePolicy },
      });
      assert.strictEqual(result.ok, true, testCase.code);
      assert.strictEqual(result.profiles[0].resolution, 'unresolved');
      assert.strictEqual(result.issues[0].code, testCase.code);
      assert.strictEqual(result.issues[0].pointer, '/registry_profiles/0');
      assert.doesNotMatch(JSON.stringify(result), /SECRET_REGISTRY_FAILURE|other/);
    }
  });

  it('rejects registry policy and profile digest substitution', async () => {
    const fixture = registryFixture();
    const value = catalog({ profiles: undefined, registry_profiles: [fixture.ref] });
    const badPolicyContent = structuredClone(fixture.policy);
    badPolicyContent.canonical_content.name = 'mutated';
    const badProfileContent = structuredClone(fixture.policy);
    badProfileContent.acceptance_profile.rules[0].disposition = 'prohibited';
    const badProfilePin = structuredClone(fixture.policy);
    badProfilePin.acceptance_profile.content_digest = `sha256:${'9'.repeat(64)}`;
    const cases = [
      { code: 'registry_policy_digest_mismatch', policy: badPolicyContent },
      { code: 'registry_profile_digest_mismatch', policy: badProfileContent },
      { code: 'registry_profile_digest_mismatch', policy: badProfilePin },
    ];

    for (const testCase of cases) {
      const result = await resolveVerifiedAcceptancePolicyProfiles(value, ['registry_default'], {
        registryResolver: { resolvePolicy: async () => testCase.policy },
      });
      assert.strictEqual(result.ok, true, testCase.code);
      assert.strictEqual(result.profiles[0].resolution, 'unresolved');
      assert.strictEqual(result.issues[0].code, testCase.code);
      assert.strictEqual(result.issues[0].pointer, '/registry_profiles/0');
    }
  });

  it('rejects mismatched, malformed, and semantically invalid embedded registry profiles', async () => {
    const fixture = registryFixture();
    const value = catalog({ profiles: undefined, registry_profiles: [fixture.ref] });
    const mismatched = structuredClone(fixture.policy);
    mismatched.acceptance_profile.profile_id = 'other_profile';
    const malformed = structuredClone(fixture.policy);
    delete malformed.acceptance_profile.coverage;
    const invalidReferenceFixture = registryFixture({
      profile: {
        rules: [
          {
            rule_id: 'bad_reference',
            subject_category: 'political_advertising',
            applies_to: ['media_buy'],
            disposition: 'conditional',
            requirements: [{ kind: 'prior_authorization' }],
            policy_ids: ['not_referenced'],
          },
        ],
      },
    });
    const cases = [
      { code: 'registry_profile_mismatch', policy: mismatched, catalog: value },
      { code: 'registry_profile_schema_invalid', policy: malformed, catalog: value },
      {
        code: 'registry_profile_invalid',
        policy: invalidReferenceFixture.policy,
        catalog: catalog({ profiles: undefined, registry_profiles: [invalidReferenceFixture.ref] }),
      },
    ];

    for (const testCase of cases) {
      const result = await resolveVerifiedAcceptancePolicyProfiles(testCase.catalog, ['registry_default'], {
        registryResolver: { resolvePolicy: async () => testCase.policy },
      });
      assert.strictEqual(result.ok, true, testCase.code);
      assert.strictEqual(result.profiles[0].resolution, 'unresolved');
      assert.strictEqual(result.issues[0].code, testCase.code);
      assert.strictEqual(result.issues[0].pointer, '/registry_profiles/0');
    }
  });

  it('preserves verified registry defaults across capability-lifetime cache clones', async () => {
    const fixture = registryFixture();
    const body = bytes(catalog({ profiles: undefined, registry_profiles: [fixture.ref] }));
    routes.set('/verified-registry-cache.json', (_req, res) => res.writeHead(200).end(body));
    let calls = 0;
    const resolver = createAcceptancePolicyCatalogResolver({
      ...unsafeFixtureOptions,
      registryResolver: {
        async resolvePolicy() {
          calls += 1;
          return structuredClone(fixture.policy);
        },
      },
    });
    const advertised = capability('/verified-registry-cache.json', body, ['registry_default']);

    const first = await resolver.resolve(advertised);
    first.defaultProfiles[0].profile.rules[0].disposition = 'allowed';
    const cached = await resolver.resolve(advertised);

    assert.strictEqual(first.ok, true);
    assert.strictEqual(cached.ok, true);
    assert.strictEqual(cached.fromCache, true);
    assert.strictEqual(cached.defaultProfiles[0].resolution, 'resolved');
    assert.strictEqual(cached.defaultProfiles[0].profile.rules[0].disposition, 'conditional');
    assert.strictEqual(calls, 1);
  });

  it('keeps verified seller defaults and caches unresolved registry diagnostics', async () => {
    const fixture = registryFixture();
    const body = bytes(catalog({ registry_profiles: [fixture.ref] }));
    routes.set('/registry-outage-cache.json', (_req, res) => res.writeHead(200).end(body));
    const advertised = capability('/registry-outage-cache.json', body, ['seller_default', 'registry_default']);
    const oneShot = await resolveAcceptancePolicyCatalog(advertised, {
      ...unsafeFixtureOptions,
      registryResolver: {
        async resolvePolicy() {
          throw new Error('registry unavailable');
        },
      },
    });

    assert.strictEqual(oneShot.ok, true);
    assert.strictEqual(oneShot.issues[0].code, 'registry_fetch_failed');
    assert.strictEqual(oneShot.issues[0].retryable, true);

    let calls = 0;
    const resolver = createAcceptancePolicyCatalogResolver({
      ...unsafeFixtureOptions,
      registryResolver: {
        async resolvePolicy() {
          calls += 1;
          throw new Error('registry unavailable');
        },
      },
    });

    const first = await resolver.resolve(advertised);
    const cached = await resolver.resolve(advertised);

    assert.strictEqual(first.ok, true);
    assert.deepStrictEqual(
      first.defaultProfiles.map(value => [value.source, value.resolution]),
      [
        ['seller', 'resolved'],
        ['registry', 'unresolved'],
      ]
    );
    assert.strictEqual(first.issues[0].code, 'registry_fetch_failed');
    assert.strictEqual(first.issues[0].retryable, false);
    assert.strictEqual(cached.ok, true);
    assert.strictEqual(cached.fromCache, true);
    assert.strictEqual(cached.issues[0].code, 'registry_fetch_failed');
    assert.strictEqual(cached.issues[0].retryable, false);
    assert.strictEqual(calls, 1);
  });

  it('bounds and sanitizes schema pointers derived from hostile property names', async () => {
    const hostileName = 'BUYER_SECRET_123';
    const body = bytes(catalog({ profiles: [localProfile({ region_aliases: { [hostileName]: 'not-an-array' } })] }));
    const numericSecret = '123456789';
    const numericBody = bytes(
      catalog({ profiles: [localProfile({ region_aliases: { [numericSecret]: 'not-an-array' } })] })
    );
    routes.set('/hostile-pointer.json', (_req, res) => res.writeHead(200).end(body));
    routes.set('/numeric-pointer.json', (_req, res) => res.writeHead(200).end(numericBody));

    const result = await resolveAcceptancePolicyCatalog(
      capability('/hostile-pointer.json', body),
      unsafeFixtureOptions
    );
    const numericResult = await resolveAcceptancePolicyCatalog(
      capability('/numeric-pointer.json', numericBody),
      unsafeFixtureOptions
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'schema_invalid');
    assert.doesNotMatch(JSON.stringify(result), /BUYER_SECRET_123/);
    assert.match(result.error.pointer, /<property>/);
    assert.ok(result.error.pointer.length <= 256);
    assert.strictEqual(numericResult.ok, false);
    assert.doesNotMatch(JSON.stringify(numericResult), /123456789/);
  });

  it('rejects unresolved defaults and bad local profile digests', async () => {
    const validBody = bytes(catalog());
    routes.set('/unresolved.json', (_req, res) => res.writeHead(200).end(validBody));

    const badProfile = localProfile({ content_digest: `sha256:${'9'.repeat(64)}` });
    badProfile.content_digest = `sha256:${'9'.repeat(64)}`;
    const badDigestBody = bytes(catalog({ profiles: [badProfile] }));
    routes.set('/bad-profile-digest.json', (_req, res) => res.writeHead(200).end(badDigestBody));

    const unresolved = await resolveAcceptancePolicyCatalog(
      capability('/unresolved.json', validBody, ['missing']),
      unsafeFixtureOptions
    );
    const digest = await resolveAcceptancePolicyCatalog(
      capability('/bad-profile-digest.json', badDigestBody),
      unsafeFixtureOptions
    );

    assert.strictEqual(unresolved.ok, false);
    assert.strictEqual(unresolved.error.code, 'unresolved_profile_id');
    assert.strictEqual(digest.ok, false);
    assert.strictEqual(digest.error.code, 'profile_digest_mismatch');
  });

  it('validates duplicate and unresolved profile references independently', async () => {
    const basePolicyRef = {
      policy_id: 'seller_policy',
      version: '1.0.0',
      content_digest: `sha256:${'1'.repeat(64)}`,
    };
    const cases = [
      {
        name: 'duplicate-policy',
        profile: localProfile({
          policy_refs: [
            basePolicyRef,
            { ...basePolicyRef, version: '2.0.0', content_digest: `sha256:${'2'.repeat(64)}` },
          ],
        }),
        pointer: '/profiles/0/policy_refs/1/policy_id',
      },
      {
        name: 'duplicate-rule',
        profile: localProfile({
          rules: [
            {
              rule_id: 'duplicate',
              subject_category: 'political_advertising',
              applies_to: ['media_buy'],
              disposition: 'allowed',
            },
            {
              rule_id: 'duplicate',
              subject_category: 'political_advertising',
              applies_to: ['media_buy'],
              disposition: 'prohibited',
            },
          ],
        }),
        pointer: '/profiles/0/rules/1/rule_id',
      },
      {
        name: 'missing-policy',
        profile: localProfile({
          rules: [
            {
              rule_id: 'missing_policy',
              subject_category: 'political_advertising',
              applies_to: ['media_buy'],
              disposition: 'allowed',
              policy_ids: ['not_referenced'],
            },
          ],
        }),
        pointer: '/profiles/0/rules/0/policy_ids/0',
      },
      {
        name: 'missing-region-group',
        profile: localProfile({
          region_aliases: { KNOWN: ['US'] },
          rules: [
            {
              rule_id: 'missing_group',
              subject_category: 'political_advertising',
              jurisdiction_groups: ['MISSING'],
              applies_to: ['media_buy'],
              disposition: 'allowed',
            },
          ],
        }),
        pointer: '/profiles/0/rules/0/jurisdiction_groups/0',
      },
    ];

    for (const value of cases) {
      const body = bytes(catalog({ profiles: [value.profile] }));
      routes.set(`/${value.name}.json`, (_req, res) => res.writeHead(200).end(body));
      const result = await resolveAcceptancePolicyCatalog(
        capability(`/${value.name}.json`, body),
        unsafeFixtureOptions
      );
      assert.strictEqual(result.ok, false, value.name);
      assert.strictEqual(result.error.code, 'reference_invalid', value.name);
      assert.strictEqual(result.error.pointer, value.pointer, value.name);
    }
  });

  it('rejects unresolved scope aliases and non-I-JSON profile content', async () => {
    const unresolvedScopeProfile = localProfile({
      coverage: 'complete',
      scope: {
        subject_categories: ['political_advertising'],
        applies_to: ['media_buy'],
        jurisdiction_groups: ['UNDECLARED'],
      },
    });
    const scopeBody = bytes(catalog({ profiles: [unresolvedScopeProfile] }));
    routes.set('/bad-scope.json', (_req, res) => res.writeHead(200).end(scopeBody));

    const infiniteProfile = localProfile({ ext: { vendor: { count: 0 } } });
    const infiniteBody = bytes(
      JSON.stringify(catalog({ profiles: [infiniteProfile] })).replace('"count":0', '"count":1e400')
    );
    routes.set('/infinite.json', (_req, res) => res.writeHead(200).end(infiniteBody));

    const unicodeProfile = localProfile({ description: '\ud800' });
    const unicodeBody = bytes(catalog({ profiles: [unicodeProfile] }));
    routes.set('/unicode.json', (_req, res) => res.writeHead(200).end(unicodeBody));

    const deepValue = {};
    let cursor = deepValue;
    for (let depth = 0; depth < 140; depth += 1) {
      cursor.child = {};
      cursor = cursor.child;
    }
    const deepProfile = localProfile({ ext: { vendor: deepValue } });
    const deepBody = bytes(catalog({ profiles: [deepProfile] }));
    routes.set('/deep.json', (_req, res) => res.writeHead(200).end(deepBody));

    const scope = await resolveAcceptancePolicyCatalog(capability('/bad-scope.json', scopeBody), unsafeFixtureOptions);
    const infinite = await resolveAcceptancePolicyCatalog(
      capability('/infinite.json', infiniteBody),
      unsafeFixtureOptions
    );
    const unicode = await resolveAcceptancePolicyCatalog(
      capability('/unicode.json', unicodeBody),
      unsafeFixtureOptions
    );
    const deep = await resolveAcceptancePolicyCatalog(capability('/deep.json', deepBody), unsafeFixtureOptions);

    assert.strictEqual(scope.ok, false);
    assert.strictEqual(scope.error.code, 'reference_invalid');
    assert.strictEqual(scope.error.pointer, '/profiles/0/scope/jurisdiction_groups/0');
    assert.strictEqual(infinite.ok, false);
    assert.strictEqual(infinite.error.code, 'profile_canonicalization_invalid');
    assert.strictEqual(unicode.ok, false);
    assert.strictEqual(unicode.error.code, 'profile_canonicalization_invalid');
    assert.strictEqual(deep.ok, false);
    assert.strictEqual(deep.error.code, 'profile_canonicalization_invalid');
  });

  it('returns a structured failure for an extremely deep catalog and remains usable', async () => {
    const nesting = 3_000;
    const deepBody = bytes(
      `{"catalog_version":"deep","ext":{"vendor":${'{"child":'.repeat(nesting)}null${'}'.repeat(nesting)}}}`
    );
    const validBody = bytes(catalog({ catalog_version: 'after-deep' }));
    routes.set('/extremely-deep.json', (_req, res) => res.writeHead(200).end(deepBody));
    routes.set('/after-deep.json', (_req, res) => res.writeHead(200).end(validBody));
    const resolver = createAcceptancePolicyCatalogResolver(unsafeFixtureOptions);

    const deep = await resolver.resolve(capability('/extremely-deep.json', deepBody, ['seller_default']));
    const after = await resolver.resolve(capability('/after-deep.json', validBody));

    assert.strictEqual(deep.ok, false);
    assert.strictEqual(deep.error.code, 'catalog_document_invalid');
    assert.strictEqual(after.ok, true);
    assert.strictEqual(after.catalog.catalog_version, 'after-deep');
  });

  it('caches only the active capability and invalidates on changes or notification', async () => {
    const firstBody = bytes(catalog());
    const secondBody = bytes(catalog({ catalog_version: '2026-09-22' }));
    routes.set('/cache-a.json', (_req, res) => res.writeHead(200).end(firstBody));
    routes.set('/cache-b.json', (_req, res) => res.writeHead(200).end(secondBody));
    const resolver = createAcceptancePolicyCatalogResolver(unsafeFixtureOptions);
    const firstCapability = capability('/cache-a.json', firstBody);
    const secondCapability = capability('/cache-b.json', secondBody);

    const first = await resolver.resolve(firstCapability);
    const cached = await resolver.resolve(firstCapability);
    const changed = await resolver.resolve(secondCapability);
    resolver.invalidate();
    const invalidated = await resolver.resolve(secondCapability);

    assert.strictEqual(first.ok && first.fromCache, false);
    assert.strictEqual(cached.ok && cached.fromCache, true);
    assert.strictEqual(changed.ok && changed.fromCache, false);
    assert.strictEqual(invalidated.ok && invalidated.fromCache, false);
    assert.strictEqual(requests.get('/cache-a.json'), 1);
    assert.strictEqual(requests.get('/cache-b.json'), 2);
  });

  it('fences stale in-flight results after a capability change', async () => {
    const firstBody = bytes(catalog({ catalog_version: 'race-a' }));
    const secondBody = bytes(catalog({ catalog_version: 'race-b' }));
    let releaseFirst;
    let releaseSecond;
    let markFirstStarted;
    let markSecondStarted;
    const firstStarted = new Promise(resolve => {
      markFirstStarted = resolve;
    });
    const secondStarted = new Promise(resolve => {
      markSecondStarted = resolve;
    });
    routes.set('/race-a.json', (_req, res) => {
      releaseFirst = () => res.writeHead(200).end(firstBody);
      markFirstStarted();
    });
    routes.set('/race-b.json', (_req, res) => {
      releaseSecond = () => res.writeHead(200).end(secondBody);
      markSecondStarted();
    });
    const resolver = createAcceptancePolicyCatalogResolver(unsafeFixtureOptions);
    const firstCapability = capability('/race-a.json', firstBody);
    const secondCapability = capability('/race-b.json', secondBody);

    const first = resolver.resolve(firstCapability);
    await firstStarted;
    const second = resolver.resolve(secondCapability);
    await secondStarted;
    releaseSecond();
    const secondResult = await second;
    releaseFirst();
    const firstResult = await first;
    const cachedSecond = await resolver.resolve(secondCapability);

    assert.strictEqual(firstResult.ok, true);
    assert.strictEqual(secondResult.ok, true);
    assert.strictEqual(cachedSecond.ok, true);
    assert.strictEqual(cachedSecond.fromCache, true);
    assert.strictEqual(cachedSecond.catalog.catalog_version, 'race-b');
  });

  it('snapshots mutable capability inputs before an in-flight fetch', async () => {
    const registryRef = profileId => ({
      policy_id: `policy_${profileId}`,
      policy_version: '1',
      policy_digest: `sha256:${'2'.repeat(64)}`,
      profile_id: profileId,
      profile_version: '1',
      profile_digest: `sha256:${'3'.repeat(64)}`,
    });
    const body = bytes(
      catalog({ profiles: undefined, registry_profiles: [registryRef('profile_a'), registryRef('profile_b')] })
    );
    let release;
    let markStarted;
    const started = new Promise(resolve => {
      markStarted = resolve;
    });
    routes.set('/mutable-capability.json', (_req, res) => {
      release = () => res.writeHead(200).end(body);
      markStarted();
    });
    const resolver = createAcceptancePolicyCatalogResolver(unsafeFixtureOptions);
    const advertised = capability('/mutable-capability.json', body, ['profile_a']);
    const original = structuredClone(advertised);

    const pending = resolver.resolve(advertised);
    await started;
    advertised.default_profile_ids[0] = 'profile_b';
    release();
    const result = await pending;
    const cached = await resolver.resolve(original);

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(
      result.defaultProfiles.map(value => value.profileId),
      ['profile_a']
    );
    assert.strictEqual(cached.ok, true);
    assert.strictEqual(cached.fromCache, true);
    assert.deepStrictEqual(
      cached.defaultProfiles.map(value => value.profileId),
      ['profile_a']
    );
  });

  it('snapshots one-shot capability and option inputs before an in-flight fetch', async () => {
    const registryRef = profileId => ({
      policy_id: `policy_${profileId}`,
      policy_version: '1',
      policy_digest: `sha256:${'4'.repeat(64)}`,
      profile_id: profileId,
      profile_version: '1',
      profile_digest: `sha256:${'5'.repeat(64)}`,
    });
    const body = bytes(
      catalog({ profiles: undefined, registry_profiles: [registryRef('profile_a'), registryRef('profile_b')] })
    );
    let release;
    let markStarted;
    const started = new Promise(resolve => {
      markStarted = resolve;
    });
    routes.set('/mutable-one-shot.json', (_req, res) => {
      release = () => res.writeHead(200).end(body);
      markStarted();
    });
    const advertised = capability('/mutable-one-shot.json', body, ['profile_a']);
    const options = { ...unsafeFixtureOptions };

    const pending = resolveAcceptancePolicyCatalog(advertised, options);
    await started;
    advertised.default_profile_ids[0] = 'profile_b';
    options.adcpVersion = 'invalid-version';
    release();
    const result = await pending;

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(
      result.defaultProfiles.map(value => value.profileId),
      ['profile_a']
    );
  });

  it('coalesces concurrent resolutions of the same capability', async () => {
    const body = bytes(catalog({ catalog_version: 'coalesced' }));
    let release;
    let markStarted;
    const started = new Promise(resolve => {
      markStarted = resolve;
    });
    routes.set('/coalesced.json', (_req, res) => {
      release = () => res.writeHead(200).end(body);
      markStarted();
    });
    const resolver = createAcceptancePolicyCatalogResolver(unsafeFixtureOptions);
    const advertised = capability('/coalesced.json', body);

    const first = resolver.resolve(advertised);
    await started;
    const second = resolver.resolve(advertised);
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.strictEqual(firstResult.ok, true);
    assert.strictEqual(secondResult.ok, true);
    assert.strictEqual(requests.get('/coalesced.json'), 1);
  });
});
