const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createHash } = require('node:crypto');

const {
  createAcceptancePolicyCatalogResolver,
  resolveAcceptancePolicyCatalog,
  resolveAcceptancePolicyProfiles,
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
    const incompleteFixtureOptIn = await resolveAcceptancePolicyCatalog(capability, { allowUnsafeHttp: true });

    assert.strictEqual(unboundedBody.ok, false);
    assert.strictEqual(unboundedBody.error.code, 'invalid_options');
    assert.strictEqual(invalidTimeout.ok, false);
    assert.strictEqual(invalidTimeout.error.code, 'invalid_options');
    assert.strictEqual(incompleteFixtureOptIn.ok, false);
    assert.strictEqual(incompleteFixtureOptIn.error.code, 'invalid_options');
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
