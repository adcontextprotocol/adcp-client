/**
 * The Zod generator follows the source's `additionalProperties` instead of
 * asserting closure (AdCP 3.3 opens schemas that were closed by accident,
 * adcontextprotocol/adcp#8866). Each post-processor that restores strictness
 * is strict only where its source is closed. Sources here are inline fixtures
 * injected through the `readSource` parameters.
 */
const assert = require('node:assert/strict');
const test = require('node:test');
const { runHarness, EVIDENCE_SOURCES, evidenceSources, schemaBlock } = require('./helpers/codegen-source-closure');

const consumerStatusSource = require('./fixtures/reporting-consumer-status/canonical-rc3.json');

test('sourceUnknownKeyPolicy is strict only when the source sets additionalProperties: false', () => {
  const policies = runHarness(`
    const policy = __test__.sourceUnknownKeyPolicy;
    return {
      closed: policy({ additionalProperties: false }),
      open: policy({ additionalProperties: true }),
      absent: policy({ type: 'object' }),
      schema: policy({ additionalProperties: { type: 'string' } }),
    };
  `);
  assert.deepEqual(policies, {
    closed: '.strict()',
    open: '.passthrough()',
    absent: '.passthrough()',
    schema: '.passthrough()',
  });
});

test('openInlineObjectPointers reports open inline objects and skips closed objects and $ref nodes', () => {
  const schema = {
    type: 'object',
    properties: {
      closed: { type: 'object', additionalProperties: false },
      open: { type: 'object' },
      openByProperties: { properties: { a: { type: 'string' } } },
      explicitlyOpen: { type: 'object', additionalProperties: true },
      ref: { $ref: 'https://schemas.example/other.json' },
      primitive: { type: 'string' },
      'a/b~c': { type: 'object' },
      list: { type: 'array', items: { type: 'object' } },
      map: { type: 'object', additionalProperties: { type: 'object', additionalProperties: false } },
      choice: { oneOf: [{ type: 'object' }, { $ref: 'x.json' }, { type: 'object', additionalProperties: false }] },
      either: { anyOf: [{ type: 'object' }] },
      both: { allOf: [{ type: 'object' }] },
    },
  };
  const { root, prefixed, closedRoot } = runHarness(
    `
    const schema = data.schema;
    return {
      root: __test__.openInlineObjectPointers(schema),
      prefixed: __test__.openInlineObjectPointers(schema, '/oneOf/0'),
      closedRoot: __test__.openInlineObjectPointers({ type: 'object', additionalProperties: false, properties: { a: { type: 'object', additionalProperties: false } } }),
    };
  `,
    { schema }
  );
  const expected = [
    '/properties/open',
    '/properties/openByProperties',
    '/properties/explicitlyOpen',
    '/properties/a~1b~0c',
    '/properties/list/items',
    '/properties/map',
    '/properties/choice/oneOf/0',
    '/properties/either/anyOf/0',
    '/properties/both/allOf/0',
  ];
  assert.deepEqual([...root].sort(), [...expected].sort());
  assert.deepEqual([...prefixed].sort(), expected.map(pointer => `/oneOf/0${pointer}`).sort());
  assert.deepEqual(closedRoot, []);
});

test('reportingStatusClosedStructures keeps requiredFields and drops allowedFields only where the source is open', () => {
  const closedSource = () => ({
    properties: {
      scope: {
        additionalProperties: false,
        properties: {
          delivery_config_generations: {
            items: {
              additionalProperties: false,
              properties: { delivery_config_id: {}, delivery_config_version: {} },
              required: ['delivery_config_id'],
            },
          },
        },
        required: ['delivery_config_generations'],
      },
      obligation_counts: { additionalProperties: false, properties: { total: {}, waiting: {} }, required: ['total'] },
      pagination: { additionalProperties: false, properties: { has_more: {}, cursor: {} }, required: ['has_more'] },
    },
    oneOf: [
      {
        oneOf: [
          { properties: { view: { const: 'periods' }, pagination: { required: ['has_more', 'total_count'] } } },
          { properties: { view: { const: 'revision' }, pagination: { required: ['has_more', 'total_count'] } } },
        ],
      },
    ],
  });
  const open = (source, name) => {
    const target =
      name === 'generation'
        ? source.properties.scope.properties.delivery_config_generations.items
        : source.properties[name];
    // Both `true` and an absent keyword leave the object open.
    if (name === 'pagination') delete target.additionalProperties;
    else target.additionalProperties = true;
  };
  const variants = { closed: closedSource() };
  for (const name of ['scope', 'generation', 'obligation_counts', 'pagination']) {
    variants[name] = closedSource();
    open(variants[name], name);
  }
  variants.allOpen = closedSource();
  for (const name of ['scope', 'generation', 'obligation_counts', 'pagination']) open(variants.allOpen, name);

  const results = runHarness(
    `
    const out: Record<string, unknown> = {};
    for (const [name, source] of Object.entries(data.variants)) out[name] = attempt(() => __test__.reportingStatusClosedStructures(source));
    return out;
  `,
    { variants }
  );

  const structures = {
    scope: { allowedFields: ['delivery_config_generations'], requiredFields: ['delivery_config_generations'] },
    deliveryConfigGeneration: {
      allowedFields: ['delivery_config_id', 'delivery_config_version'],
      requiredFields: ['delivery_config_id'],
    },
    obligationCounts: { allowedFields: ['total', 'waiting'], requiredFields: ['total'] },
    pagination: { allowedFields: ['has_more', 'cursor'], requiredFields: ['has_more'] },
    paginationRequiredByView: { periods: ['has_more', 'total_count'], revision: ['has_more', 'total_count'] },
  };
  const withoutAllowed = (...names) => {
    const result = structuredClone(structures);
    for (const name of names) delete result[name].allowedFields;
    return result;
  };
  assert.deepEqual(results.closed, { value: structures });
  assert.deepEqual(results.scope, { value: withoutAllowed('scope') });
  assert.deepEqual(results.generation, { value: withoutAllowed('deliveryConfigGeneration') });
  assert.deepEqual(results.obligation_counts, { value: withoutAllowed('obligationCounts') });
  assert.deepEqual(results.pagination, { value: withoutAllowed('pagination') });
  assert.deepEqual(results.allOpen, {
    value: withoutAllowed('scope', 'deliveryConfigGeneration', 'obligationCounts', 'pagination'),
  });
});

test('get_reporting_status evidence refinement: closed output is the original text and rejects unknown keys; open output is neutral and accepts them', () => {
  const structures = (closed = { scope: true, generation: true, counts: true, pagination: true }) => {
    const object = (allowedFields, requiredFields, isClosed) =>
      isClosed ? { allowedFields, requiredFields } : { requiredFields };
    return {
      scope: object(['delivery_config_generations'], ['delivery_config_generations'], closed.scope),
      deliveryConfigGeneration: object(['delivery_config_id'], ['delivery_config_id'], closed.generation),
      obligationCounts: object(['total'], ['total'], closed.counts),
      pagination: object(['has_more'], ['has_more'], closed.pagination),
      paginationRequiredByView: { periods: ['has_more'], revision: ['has_more'] },
    };
  };
  const variants = {
    closed: structures(),
    open: structures({ scope: false, generation: false, counts: false, pagination: false }),
    // Only the scope is closed: its key set is enforced, the rest are not.
    mixed: structures({ scope: true, generation: false, counts: false, pagination: false }),
  };
  const results = runHarness(
    `
    const stubs = ['ReportingCoverage', 'ReportingStatusIssue', 'ReportingObligation', 'ReportingRevision', 'ReportingMaterialization', 'ReportingReceipt']
      .map(name => 'export const ' + name + 'Schema = z.object({}).passthrough();')
      .join('\\n\\n');
    const input = stubs + '\\n\\nexport const GetReportingStatusResponseSchema = z.object({}).passthrough();\\n';
    const out: Record<string, unknown> = {};
    for (const [name, structures] of Object.entries(data.variants)) {
      const output = __test__.postProcessGetReportingStatusEvidenceStrictness(input, structures);
      const { GetReportingStatusResponseSchema: schema } = await load('status_' + name, output);
      const accepts = (value: unknown) => schema.safeParse(value).success;
      out[name] = {
        output,
        scopeUnknown: accepts({ scope: { delivery_config_generations: [{ delivery_config_id: 'a' }], bogus: 1 } }),
        generationUnknown: accepts({ scope: { delivery_config_generations: [{ delivery_config_id: 'a', bogus: 1 }] } }),
        countsUnknown: accepts({ obligation_counts: { total: 1, bogus: 1 } }),
        paginationUnknown: accepts({ pagination: { has_more: true, bogus: 1 } }),
        countsMissingRequired: accepts({ obligation_counts: {} }),
        paginationMissingRequired: accepts({ pagination: { cursor: 'c' } }),
        validOpenShape: accepts({
          scope: { delivery_config_generations: [{ delivery_config_id: 'a' }] },
          obligation_counts: { total: 1 },
          pagination: { has_more: false },
        }),
      };
    }
    return out;
  `,
    { variants }
  );

  // Closed: the original emitted text, unchanged.
  const { closed, open, mixed } = results;
  assert.match(closed.output, /source-closed get_reporting_status object/);
  assert.match(closed.output, /allowedFields: readonly string\[\]; requiredFields: readonly string\[\]/);
  assert.match(closed.output, /if \(!structure\.allowedFields\.includes\(field\)\) \{/);
  assert.match(closed.output, /message: "Expected source-closed get_reporting_status object"/);
  assert.match(closed.output, /message: "Unexpected field in source-closed get_reporting_status object"/);
  assert.match(closed.output, /message: "Required by source-closed get_reporting_status object"/);
  assert.doesNotMatch(closed.output, /allowedFields\?:/);
  assert.doesNotMatch(closed.output, /allowedFields !== undefined/);
  assert.deepEqual(
    [closed.scopeUnknown, closed.generationUnknown, closed.countsUnknown, closed.paginationUnknown],
    [false, false, false, false]
  );

  // Open: optional key set, guarded check, neutral message.
  assert.match(open.output, /allowedFields\?: readonly string\[\]; requiredFields: readonly string\[\]/);
  assert.match(open.output, /structure\.allowedFields !== undefined && !structure\.allowedFields\.includes\(field\)/);
  assert.match(open.output, /message: "Expected get_reporting_status object"/);
  assert.match(open.output, /message: "Unexpected field in get_reporting_status object"/);
  assert.match(open.output, /message: "Required by get_reporting_status object"/);
  assert.doesNotMatch(open.output, /source-closed/);
  assert.deepEqual(
    [open.scopeUnknown, open.generationUnknown, open.countsUnknown, open.paginationUnknown],
    [true, true, true, true]
  );
  // Required-field checks still run on an open structure.
  assert.equal(open.countsMissingRequired, false);
  assert.equal(open.paginationMissingRequired, false);
  assert.equal(open.validOpenShape, true);

  // Any open structure switches the whole refinement to the neutral form;
  // each structure is still enforced only where its own source is closed.
  assert.doesNotMatch(mixed.output, /source-closed/);
  assert.deepEqual(
    [mixed.scopeUnknown, mixed.generationUnknown, mixed.countsUnknown, mixed.paginationUnknown],
    [false, true, true, true]
  );
  assert.equal(mixed.countsMissingRequired, false);
});

test('reporting evidence strictness: closed sources restore .strict(), open sources keep passthrough, both without throwing', () => {
  const names = EVIDENCE_SOURCES.map(([name]) => name);
  const results = runHarness(
    `
    const names: string[] = data.names;
    const input = names
      .map(name => 'export const ' + name + 'Schema = z.object({ nested: z.object({}).passthrough() }).passthrough();')
      .join('\\n\\n') + '\\n\\nexport const ExtensionFriendlySchema = z.object({}).passthrough();\\n';
    const out: Record<string, unknown> = { input };
    for (const [scenario, sources] of Object.entries(data.scenarios)) {
      const result = attempt(() => __test__.postProcessReportingEvidenceStrictness(input, reader(sources as Record<string, unknown>)));
      if ('error' in result) {
        out[scenario] = result;
        continue;
      }
      const output = result.value as string;
      const mod = await load('evidence_' + scenario, output);
      out[scenario] = {
        output,
        coverageExtraKey: mod.ReportingCoverageSchema.safeParse({ nested: {}, extra: 1 }).success,
        coverageNestedExtraKey: mod.ReportingCoverageSchema.safeParse({ nested: { extra: 1 } }).success,
        receiptExtraKey: mod.ReportingReceiptSchema.safeParse({ nested: {}, extra: 1 }).success,
      };
    }
    return out;
  `,
    {
      names,
      scenarios: {
        closed: evidenceSources(true),
        open: evidenceSources(false),
        // Only ReportingCoverage opened: the rest stay strict.
        mixedClosure: evidenceSources(true, {
          ReportingCoverage: { additionalProperties: true, properties: { nested: { type: 'object' } } },
        }),
        titleMismatch: evidenceSources(true, { ReportingCoverage: { title: 'Reporting Coverage Renamed' } }),
        closedRootOpenInline: evidenceSources(true, {
          ReportingReceipt: { properties: { nested: { type: 'object', additionalProperties: true } } },
        }),
        closedRootOpenInlineDeep: evidenceSources(true, {
          IntegerReportingControlTotal: {
            properties: { deep: { type: 'array', items: { type: 'object' } } },
          },
        }),
      },
    }
  );

  // Closed: the previous strict output, including nested objects; unrelated schemas untouched.
  const { closed, open } = results;
  for (const name of names) {
    assert.match(
      closed.output,
      new RegExp(`${name}Schema = z\\.object\\(\\{ nested: z\\.object\\(\\{\\}\\)\\.strict\\(\\) \\}\\)\\.strict\\(\\)`)
    );
  }
  assert.match(closed.output, /ExtensionFriendlySchema = z\.object\(\{\}\)\.passthrough\(\)/);
  assert.equal(closed.coverageExtraKey, false);
  assert.equal(closed.coverageNestedExtraKey, false);
  assert.equal(closed.receiptExtraKey, false);

  // Open (no additionalProperties keyword, nested open too): nothing changes, nothing throws.
  assert.equal(open.output, results.input);
  assert.equal(open.coverageExtraKey, true);
  assert.equal(open.coverageNestedExtraKey, true);
  assert.equal(open.receiptExtraKey, true);

  // Each schema follows its own source.
  const mixed = results.mixedClosure;
  assert.match(
    mixed.output,
    /ReportingCoverageSchema = z\.object\(\{ nested: z\.object\(\{\}\)\.passthrough\(\) \}\)\.passthrough\(\)/
  );
  assert.match(
    mixed.output,
    /ReportingReceiptSchema = z\.object\(\{ nested: z\.object\(\{\}\)\.strict\(\) \}\)\.strict\(\)/
  );
  assert.equal(mixed.coverageExtraKey, true);
  assert.equal(mixed.receiptExtraKey, false);

  // New failure modes.
  assert.match(
    results.titleMismatch.error,
    /postProcessReportingEvidenceStrictness: core\/reporting-coverage\.json# is no longer ReportingCoverageSchema\./
  );
  assert.match(
    results.closedRootOpenInline.error,
    /ReportingReceiptSchema is closed but keeps \/properties\/nested open\./
  );
  assert.match(
    results.closedRootOpenInlineDeep.error,
    /IntegerReportingControlTotalSchema is closed but keeps \/oneOf\/0\/properties\/deep\/items open\./
  );
});

test('consumer-status unknown-key checks are emitted per source object and enforced at runtime', () => {
  const digest = 'a'.repeat(64);
  const valid = {
    reporting_status_id: 'reporting-status-0001',
    delivery_config_id: 'config-1',
    delivery_config_version: 1,
    report_definition_id: 'report-1',
    period: { start: '2026-09-01T00:00:00Z', end: '2026-09-02T00:00:00Z', source_timezone: 'UTC' },
    status_as_of: '2026-09-03T00:00:00Z',
    consumer_status: 'content_mismatch',
    reporting_obligation_id: 'obligation-1',
    reporting_revision_id: 'revision-1',
    observed_revision_content_sha256: digest,
    mismatch_code: 'metric_missing',
  };
  const requestKeys = [
    'account',
    'idempotency_key',
    'statuses',
    'adcp_version',
    'adcp_major_version',
    'context',
    'ext',
  ];
  const requestSource = closed => ({
    ...(closed ? { additionalProperties: false } : {}),
    properties: Object.fromEntries(requestKeys.map(key => [key, {}])),
  });
  const mutated = mutate => {
    const source = structuredClone(consumerStatusSource);
    mutate(source);
    return source;
  };
  const variants = {
    allClosed: { source: consumerStatusSource, requestSource: requestSource(true) },
    allOpen: {
      source: mutated(source => {
        source.additionalProperties = true;
        source.properties.period.additionalProperties = true;
      }),
      requestSource: requestSource(false),
    },
    itemOpen: {
      source: mutated(source => {
        delete source.additionalProperties;
      }),
      requestSource: requestSource(true),
    },
    periodOpen: {
      source: mutated(source => {
        delete source.properties.period.additionalProperties;
      }),
      requestSource: requestSource(true),
    },
    requestOpen: { source: consumerStatusSource, requestSource: requestSource(false) },
  };
  const failures = {
    // A closed source whose key set no longer matches the emitted lists.
    periodKeysChanged: {
      source: mutated(source => {
        source.properties.period.properties.extra_zone = { type: 'string' };
      }),
      requestSource: requestSource(true),
    },
    requestKeysChanged: {
      source: consumerStatusSource,
      requestSource: { ...requestSource(true), properties: { ...requestSource(true).properties, extra_key: {} } },
    },
    // The same drift on an open object is not enforced, so it must not throw.
    openPeriodKeysChanged: {
      source: mutated(source => {
        source.properties.period.additionalProperties = true;
        source.properties.period.properties.extra_zone = { type: 'string' };
      }),
      requestSource: requestSource(true),
    },
    openRequestKeysChanged: {
      source: consumerStatusSource,
      requestSource: { properties: { ...requestSource(false).properties, extra_key: {} } },
    },
  };

  const results = runHarness(
    `
    import_types: {
    }
    const { compile } = await import('json-schema-to-typescript');
    const { generate } = await import('ts-to-zod');
    const { injectJsdocConstraints } = await import('../../scripts/schema-utils');
    // The production TypeScript projection flattens the conditional allOf arms.
    const { allOf, ...flat } = data.baseSource;
    const types = await compile(injectJsdocConstraints(flat), 'ReportingConsumerStatus', { bannerComment: '' });
    const declarations = types + '\\nexport interface SyncReportingStatusRequest { statuses: ReportingConsumerStatus[]; }\\nexport interface SyncReportingStatusResponse { status: "completed"; results: ({ result: "recorded" | "unchanged"; consumer_status: ReportingConsumerStatus } | { result: "failed"; errors: unknown[] })[]; }';
    const generated = generate({ sourceText: declarations, getSchemaName: name => name + 'Schema' }).getZodSchemasFile('./types');
    const passthrough = __test__.postProcessForPassthrough(generated);

    const out: Record<string, unknown> = {};
    for (const [name, variant] of Object.entries(data.variants) as Array<[string, any]>) {
      const output = __test__.postProcessReportingConsumerStatusConstraints(passthrough, variant.source, variant.requestSource);
      const { ReportingConsumerStatusSchema: schema, SyncReportingStatusRequestSchema: request } = await load('status_' + name, output);
      const accepts = (candidate: any, value: unknown) => candidate.safeParse(value).success;
      const withPeriod = (extra: Record<string, unknown>) => ({ ...data.valid, period: { ...data.valid.period, ...extra } });
      out[name] = {
        valid: accepts(schema, data.valid),
        itemUnknownKey: accepts(schema, { ...data.valid, bogus: 1 }),
        periodUnknownKey: accepts(schema, withPeriod({ bogus: 1 })),
        requestValid: accepts(request, { statuses: [data.valid] }),
        requestUnknownKey: accepts(request, { statuses: [data.valid], bogus: 1 }),
        itemCheck: output.includes('const allowed = new Set(' + JSON.stringify(Object.keys(variant.source.properties)) + ')'),
        periodCheck: output.includes('path: ["period", field]'),
        requestCheck: output.includes('canonical parity') && output.includes('"adcp_major_version", "context", "ext"'),
        // Required-field rules still run whatever the closure.
        missingRequired: accepts(schema, { ...data.valid, reporting_obligation_id: undefined }),
      };
    }
    const failures: Record<string, unknown> = {};
    for (const [name, variant] of Object.entries(data.failures) as Array<[string, any]>) {
      failures[name] = attempt(() => {
        __test__.postProcessReportingConsumerStatusConstraints(passthrough, variant.source, variant.requestSource);
        return 'ok';
      });
    }
    return { out, failures };
  `.replace('import_types: {\n    }\n', ''),
    { baseSource: consumerStatusSource, variants, failures: failures, valid }
  );

  const { out, failures: failed } = results;
  const checks = variant => [variant.itemCheck, variant.periodCheck, variant.requestCheck];
  const unknownKeyAccepted = variant => [variant.itemUnknownKey, variant.periodUnknownKey, variant.requestUnknownKey];

  // Closed everywhere: the previous output. Each unknown key is rejected.
  assert.deepEqual(checks(out.allClosed), [true, true, true]);
  assert.deepEqual(unknownKeyAccepted(out.allClosed), [false, false, false]);

  // Open everywhere: no unknown-key check is emitted and none is enforced.
  assert.deepEqual(checks(out.allOpen), [false, false, false]);
  assert.deepEqual(unknownKeyAccepted(out.allOpen), [true, true, true]);

  // Each check follows its own source object.
  assert.deepEqual(checks(out.itemOpen), [false, true, true]);
  assert.deepEqual(unknownKeyAccepted(out.itemOpen), [true, false, false]);
  assert.deepEqual(checks(out.periodOpen), [true, false, true]);
  assert.deepEqual(unknownKeyAccepted(out.periodOpen), [false, true, false]);
  assert.deepEqual(checks(out.requestOpen), [true, true, false]);
  assert.deepEqual(unknownKeyAccepted(out.requestOpen), [false, false, true]);

  for (const [name, variant] of Object.entries(out)) {
    assert.equal(variant.valid, true, `${name}: a valid status is accepted`);
    assert.equal(variant.requestValid, true, `${name}: a valid request is accepted`);
    assert.equal(variant.missingRequired, false, `${name}: required-field rules still run`);
  }

  assert.match(failed.periodKeysChanged.error, /the closed consumer-status period key set changed/);
  assert.match(failed.requestKeysChanged.error, /the closed sync_reporting_status request key set changed/);
  assert.deepEqual(failed.openPeriodKeysChanged, { value: 'ok' });
  assert.deepEqual(failed.openRequestKeysChanged, { value: 'ok' });
});

test('trusted-match privacy boundary request schemas are strict only while their source root is closed', () => {
  const contextFile = 'trusted-match/context-match-request.json#';
  const identityFile = 'trusted-match/identity-match-request.json#';
  const closedContext = {
    type: 'object',
    additionalProperties: false,
    properties: { a: { type: 'object', additionalProperties: false } },
  };
  const closedIdentity = {
    type: 'object',
    additionalProperties: false,
    properties: {
      identities: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            attestation: {
              type: 'object',
              additionalProperties: false,
              // Reviewed exception: scheme-specific proof material stays open.
              properties: { proof: { type: 'object', additionalProperties: true } },
            },
          },
        },
      },
    },
  };
  const openContext = { type: 'object', properties: { a: { type: 'object' } } };
  const openIdentity = { type: 'object', additionalProperties: true, properties: closedIdentity.properties };
  const scenarios = {
    closed: { [contextFile]: closedContext, [identityFile]: closedIdentity },
    contextOpen: { [contextFile]: openContext, [identityFile]: closedIdentity },
    identityOpen: { [contextFile]: closedContext, [identityFile]: openIdentity },
    bothOpen: { [contextFile]: openContext, [identityFile]: openIdentity },
    contextClosedOpenInline: {
      [contextFile]: { ...closedContext, properties: { a: { type: 'object' } } },
      [identityFile]: closedIdentity,
    },
    identityClosedOpenInline: {
      [contextFile]: closedContext,
      [identityFile]: {
        ...closedIdentity,
        properties: {
          identities: {
            type: 'array',
            items: {
              ...closedIdentity.properties.identities.items,
              properties: { attestation: { type: 'object', properties: { proof: { type: 'object' } } } },
            },
          },
        },
      },
    },
  };

  const results = runHarness(
    `
    const input = [
      'export const ContextMatchRequestSchema = z.object({ a: z.object({}).passthrough() }).passthrough();',
      // A response shape between the request and its next named neighbour.
      'export const TargetingKvsSchema = z.array(z.object({ key: z.string() }).passthrough());',
      'export const OfferPriceSchema = z.number();',
      'export const IdentityMatchRequestSchema = z.object({ identities: z.array(z.object({ attestation: z.object({ proof: z.object({}).passthrough() }).passthrough() }).passthrough()) }).passthrough();',
      'export const TMPXChunkSchema = z.string();',
    ].join('\\n\\n');
    const out: Record<string, unknown> = { input };
    for (const [name, sources] of Object.entries(data.scenarios)) {
      const result = attempt(() => __test__.postProcessTrustedMatchPrivacyBoundaryStrictness(input, reader(sources as Record<string, unknown>)));
      if ('error' in result) {
        out[name] = result;
        continue;
      }
      const output = result.value as string;
      const mod = await load('privacy_' + name, output);
      out[name] = {
        output,
        contextExtraKey: mod.ContextMatchRequestSchema.safeParse({ a: {}, extra: 1 }).success,
        contextNestedExtraKey: mod.ContextMatchRequestSchema.safeParse({ a: { extra: 1 } }).success,
        identityExtraKey: mod.IdentityMatchRequestSchema.safeParse({ identities: [], extra: 1 }).success,
        attestationExtraKey: mod.IdentityMatchRequestSchema.safeParse({ identities: [{ attestation: { proof: {}, extra: 1 } }] }).success,
        targetingKvsExtraKey: mod.TargetingKvsSchema.safeParse([{ key: 'k', extra: 1 }]).success,
        proofExtraKey: mod.IdentityMatchRequestSchema.safeParse({ identities: [{ attestation: { proof: { scheme: 'x' } } }] }).success,
      };
    }
    return out;
  `,
    { scenarios }
  );

  // Closed: strict, except the reviewed proof exception.
  const closed = results.closed;
  assert.match(
    schemaBlock(closed.output, 'ContextMatchRequestSchema'),
    /z\.object\(\{ a: z\.object\(\{\}\)\.strict\(\) \}\)\.strict\(\);$/
  );
  assert.match(schemaBlock(closed.output, 'IdentityMatchRequestSchema'), /proof: z\.object\(\{\}\)\.passthrough\(\)/);
  assert.equal(closed.contextExtraKey, false);
  assert.equal(closed.contextNestedExtraKey, false);
  assert.equal(closed.identityExtraKey, false);
  assert.equal(closed.attestationExtraKey, false);
  assert.equal(closed.proofExtraKey, true);

  // Only the request export is closed: the neighbouring response shape is untouched in every scenario.
  for (const name of ['closed', 'contextOpen', 'identityOpen', 'bothOpen']) {
    assert.equal(
      schemaBlock(results[name].output, 'TargetingKvsSchema'),
      schemaBlock(results.input, 'TargetingKvsSchema'),
      name
    );
    assert.equal(results[name].targetingKvsExtraKey, true, name);
  }

  // Each request follows its own source root.
  assert.equal(
    schemaBlock(results.contextOpen.output, 'ContextMatchRequestSchema'),
    schemaBlock(results.input, 'ContextMatchRequestSchema')
  );
  assert.equal(results.contextOpen.contextExtraKey, true);
  assert.equal(results.contextOpen.identityExtraKey, false);
  assert.equal(
    schemaBlock(results.identityOpen.output, 'IdentityMatchRequestSchema'),
    schemaBlock(results.input, 'IdentityMatchRequestSchema')
  );
  assert.equal(results.identityOpen.identityExtraKey, true);
  assert.equal(results.identityOpen.contextExtraKey, false);
  assert.equal(results.bothOpen.output, results.input);

  // A closed root with an open inline object is not silently closed.
  assert.match(
    results.contextClosedOpenInline.error,
    /postProcessTrustedMatchPrivacyBoundaryStrictness: trusted-match\/context-match-request\.json is closed but keeps \/properties\/a open\./
  );
  assert.match(
    results.identityClosedOpenInline.error,
    /trusted-match\/identity-match-request\.json is closed but keeps \/properties\/identities\/items\/properties\/attestation open\./
  );
});

test('trusted-match response schemas take each unknown-key policy from their own source file', () => {
  const key = (file, pointer = '') => `trusted-match/${file}#${pointer}`;
  const providersPointer = '/properties/tmpx_providers/additionalProperties';
  const kvsPointer = '/definitions/targeting_kvs/items';
  const sources = overrides => {
    const closed = {
      [key('tmpx-chunk.json')]: true,
      [key('provider-registration.json')]: true,
      [key('publisher-tmpx-config.json')]: true,
      [key('identity-match-response.json', providersPointer)]: true,
      [key('context-match-response.json', kvsPointer)]: true,
      [key('provider-context-match-response.json', kvsPointer)]: true,
      ...overrides,
    };
    return Object.fromEntries(
      Object.entries(closed).map(([file, isClosed]) => [
        file,
        { type: 'object', ...(isClosed ? { additionalProperties: false } : {}) },
      ])
    );
  };
  const scenarios = {
    closed: sources({}),
    open: sources({
      [key('tmpx-chunk.json')]: false,
      [key('provider-registration.json')]: false,
      [key('publisher-tmpx-config.json')]: false,
      [key('identity-match-response.json', providersPointer)]: false,
      [key('context-match-response.json', kvsPointer)]: false,
      [key('provider-context-match-response.json', kvsPointer)]: false,
    }),
    chunkOnlyOpen: sources({ [key('tmpx-chunk.json')]: false }),
    providersMapOnlyOpen: sources({ [key('identity-match-response.json', providersPointer)]: false }),
    kvsOnlyOpen: sources({
      [key('context-match-response.json', kvsPointer)]: false,
      [key('provider-context-match-response.json', kvsPointer)]: false,
    }),
    // The two context-match responses disagree on targeting_kvs.
    kvsDisagree: sources({ [key('provider-context-match-response.json', kvsPointer)]: false }),
    kvsDisagreeReversed: sources({ [key('context-match-response.json', kvsPointer)]: false }),
  };

  const results = runHarness(
    `
    const input = [
      'TMPXChunkSchema',
      'IdentityMatchResponseProviderRouterSchema',
      'TMPProviderRegistrationSchema',
      'PublisherTMPXMacroMappingSchema',
      'GroupImageAssetSchema',
      'IdentityMatchResponseSchema',
      'GetProductsResponseSchema',
    ].map(name => 'export const ' + name + ' = z.any();').join('\\n\\n') +
      '\\n\\nexport const TargetingKvsSchema = z.array(z.object({ key: z.string() }).passthrough());';
    const out: Record<string, unknown> = {};
    for (const [name, sources] of Object.entries(data.scenarios)) {
      const result = attempt(() => __test__.postProcessTrustedMatchResponseSchemas(input, reader(sources as Record<string, unknown>)));
      if ('error' in result) {
        out[name] = result;
        continue;
      }
      const output = result.value as string;
      const kvsSource = output.slice(output.indexOf('export const TargetingKvsSchema'));
      const { TargetingKvsSchema: kvs } = await load('kvs_' + name, kvsSource);
      const { TMPXChunkSchema: chunk } = await load('tmpx_' + name, output.slice(output.indexOf('export const TMPXChunkSchema'), output.indexOf('\\n\\nexport const IdentityMatchResponseProviderRouterSchema')));
      out[name] = {
        output,
        chunkExtraKey: chunk.safeParse({ slot_id: 'a', value: 'v', extra: 1 }).success,
        kvsExtraKey: kvs.safeParse([{ key: 'k', extra: 1 }]).success,
      };
    }
    return out;
  `,
    { scenarios }
  );

  const block = (output, name) => schemaBlock(output, name);
  const policiesOf = output => ({
    chunk: block(output, 'TMPXChunkSchema').match(/\}\)\.(strict|passthrough)\(\);$/)[1],
    registration: block(output, 'TMPProviderRegistrationSchema').match(
      /\}\)\.(strict|passthrough)\(\)\.superRefine/
    )[1],
    publisherConfig: block(output, 'PublisherTMPXMacroMappingSchema').match(/\}\)\.(strict|passthrough)\(\);$/)[1],
    providersMap: block(output, 'IdentityMatchResponseRouterPublisherSchema').match(
      /chunks: z\.array\(TMPXChunkSchema\)\.min\(1\)\.max\(2\) \}\)\.(strict|passthrough)\(\)/
    )[1],
    targetingKvs: block(output, 'TargetingKvsSchema').match(/\}\)\.(strict|passthrough)\(\)\);?$/)[1],
  });

  assert.deepEqual(policiesOf(results.closed.output), {
    chunk: 'strict',
    registration: 'strict',
    publisherConfig: 'strict',
    providersMap: 'strict',
    targetingKvs: 'strict',
  });
  assert.equal(results.closed.chunkExtraKey, false);
  assert.equal(results.closed.kvsExtraKey, false);
  assert.deepEqual(policiesOf(results.open.output), {
    chunk: 'passthrough',
    registration: 'passthrough',
    publisherConfig: 'passthrough',
    providersMap: 'passthrough',
    targetingKvs: 'passthrough',
  });
  assert.equal(results.open.chunkExtraKey, true);
  assert.equal(results.open.kvsExtraKey, true);
  assert.deepEqual(policiesOf(results.chunkOnlyOpen.output), {
    chunk: 'passthrough',
    registration: 'strict',
    publisherConfig: 'strict',
    providersMap: 'strict',
    targetingKvs: 'strict',
  });
  assert.deepEqual(policiesOf(results.providersMapOnlyOpen.output), {
    chunk: 'strict',
    registration: 'strict',
    publisherConfig: 'strict',
    providersMap: 'passthrough',
    targetingKvs: 'strict',
  });
  // targeting_kvs follows its own two sources, independent of the other schemas.
  assert.deepEqual(policiesOf(results.kvsOnlyOpen.output), {
    chunk: 'strict',
    registration: 'strict',
    publisherConfig: 'strict',
    providersMap: 'strict',
    targetingKvs: 'passthrough',
  });
  for (const name of ['kvsDisagree', 'kvsDisagreeReversed']) {
    assert.match(results[name].error, /the context-match responses disagree on targeting_kvs/, name);
  }
});

test('placement-presentation schemas are strict per object, following core/placement-presentation.json', () => {
  const pointers = {
    rectangle: '/definitions/rectangle',
    text: '/definitions/text_decoration',
    imageRef: '/definitions/image_decoration/properties/image_ref',
    image: '/definitions/image_decoration',
    box: '/definitions/box_decoration',
    canvas: '/properties/canvas',
    slot: '/properties/creative_slot',
    root: '',
  };
  const sources = (openNames = []) =>
    Object.fromEntries(
      Object.entries(pointers).map(([name, pointer]) => [
        `core/placement-presentation.json#${pointer}`,
        { type: 'object', ...(openNames.includes(name) ? {} : { additionalProperties: false }) },
      ])
    );
  const scenarios = {
    closed: sources(),
    open: sources(Object.keys(pointers)),
    imageRefOpen: sources(['imageRef']),
    slotOpen: sources(['slot']),
    rootOpen: sources(['root']),
  };

  const results = runHarness(
    `
    const input = [
      ...['RectangleSchema', 'TextDecorationSchema', 'ImageDecorationSchema', 'BoxDecorationSchema', 'PlacementPresentationDocumentSchema'].map(name => 'export const ' + name + ' = z.any();'),
      // The pass also constrains these numeric fields, whatever the closure.
      'export const ImageAssetSchema = z.object({ file_size_bytes: z.number().optional() });',
      'export const CanonicalFormatHostedVideoSchema = z.object({ max_file_size_mb: z.number().min(1).optional() });',
      'export const CanonicalFormatHostedAudioSchema = z.object({ max_file_size_mb: z.number().optional() });',
      'export const TrailingSchema = z.any();',
    ].join('\\n\\n');
    const out: Record<string, unknown> = {};
    for (const [name, sources] of Object.entries(data.scenarios)) {
      const output = __test__.postProcessPlacementPresentationRuntimeConstraints(input, reader(sources as Record<string, unknown>));
      const prelude = 'const ColorSchema = z.string(); const LayerSchema = z.number();\\n';
      const rectangle = output.slice(output.indexOf('export const RectangleSchema'), output.indexOf('\\n\\nexport const TextDecorationSchema'));
      const { RectangleSchema: schema } = await load('placement_' + name, prelude + rectangle);
      out[name] = { output, rectangleExtraKey: schema.safeParse({ x: 0, y: 0, width: 1, height: 1, extra: 1 }).success };
    }
    return out;
  `,
    { scenarios }
  );

  const count = (text, policy) => text.split(`.${policy}()`).length - 1;
  const profile = output => ({
    rectangle: [
      count(schemaBlock(output, 'RectangleSchema'), 'strict'),
      count(schemaBlock(output, 'RectangleSchema'), 'passthrough'),
    ],
    text: [
      count(schemaBlock(output, 'TextDecorationSchema'), 'strict'),
      count(schemaBlock(output, 'TextDecorationSchema'), 'passthrough'),
    ],
    image: [
      count(schemaBlock(output, 'ImageDecorationSchema'), 'strict'),
      count(schemaBlock(output, 'ImageDecorationSchema'), 'passthrough'),
    ],
    box: [
      count(schemaBlock(output, 'BoxDecorationSchema'), 'strict'),
      count(schemaBlock(output, 'BoxDecorationSchema'), 'passthrough'),
    ],
    document: [
      count(schemaBlock(output, 'PlacementPresentationDocumentSchema'), 'strict'),
      count(schemaBlock(output, 'PlacementPresentationDocumentSchema'), 'passthrough'),
    ],
  });

  // [strict, passthrough] per schema; the document counts canvas, creative_slot and its root.
  assert.deepEqual(profile(results.closed.output), {
    rectangle: [1, 0],
    text: [1, 0],
    image: [2, 0],
    box: [1, 0],
    document: [3, 0],
  });
  assert.equal(results.closed.rectangleExtraKey, false);
  assert.deepEqual(profile(results.open.output), {
    rectangle: [0, 1],
    text: [0, 1],
    image: [0, 2],
    box: [0, 1],
    document: [0, 3],
  });
  assert.equal(results.open.rectangleExtraKey, true);

  // Nested objects follow their own pointer, not their parent.
  const imageRefOpen = schemaBlock(results.imageRefOpen.output, 'ImageDecorationSchema');
  assert.match(imageRefOpen, /image_ref: z\.object\(\{[\s\S]*?\}\)\.passthrough\(\),\s*fit:/);
  assert.match(imageRefOpen, /\}\)\.strict\(\);$/);
  const slotOpen = schemaBlock(results.slotOpen.output, 'PlacementPresentationDocumentSchema');
  assert.match(slotOpen, /canvas: z\.object\(\{[\s\S]*?\}\)\.strict\(\),\s*creative_slot:/);
  assert.match(slotOpen, /clip: z\.literal\(true\)\s*\}\)\.passthrough\(\),\s*decorations:/);
  assert.match(slotOpen, /\}\)\.strict\(\)\.superRefine/);
  const rootOpen = schemaBlock(results.rootOpen.output, 'PlacementPresentationDocumentSchema');
  assert.match(rootOpen, /\}\)\.passthrough\(\)\.superRefine/);
  assert.equal(count(rootOpen, 'strict'), 2);
});

test('beta.6 canonical metric qualifier follows core/canonical-metric-qualifier.json', () => {
  const qualifierBody = indent =>
    [
      'z.object({',
      `${indent}    viewability_standard: ViewabilityStandardSchema.optional(),`,
      `${indent}    completion_source: CompletionSourceSchema.optional(),`,
      `${indent}    attribution_methodology: AttributionMethodologySchema.optional(),`,
      `${indent}    attribution_window: DurationSchema.optional(),`,
      `${indent}    lift_dimension: LiftDimensionSchema.optional()`,
      `${indent}}).passthrough()`,
    ].join('\n');
  const input = [
    'export const DeliveryMetricsSchema = z.object({\n    requested_metrics: z.array(AvailableMetricSchema).optional(),\n    threshold_seconds: z.number(),\n}).passthrough();',
    `export const CanonicalMetricQualifierSchema = ${qualifierBody('    ')};`,
    `export const VendorMetricValueSchema = z.object({\n    qualifier: ${qualifierBody('    ')}.optional()\n}).passthrough();`,
    `export const DeliveryMetricAggregateSchema = z.object({\n    first: ${qualifierBody('        ')},\n    second: ${qualifierBody('        ')}\n}).passthrough();`,
  ].join('\n\n');
  const source = closed => ({ type: 'object', ...(closed ? { additionalProperties: false } : {}) });
  const results = runHarness(
    `
    const out: Record<string, unknown> = {};
    for (const [name, sources] of Object.entries(data.scenarios)) {
      out[name] = __test__.postProcessBeta6ReportingConstraints(data.input, reader(sources as Record<string, unknown>));
    }
    return out;
  `,
    {
      input,
      scenarios: {
        closed: { 'core/canonical-metric-qualifier.json#': source(true) },
        open: { 'core/canonical-metric-qualifier.json#': source(false) },
      },
    }
  );

  for (const [name, policy] of [
    ['closed', 'strict'],
    ['open', 'passthrough'],
  ]) {
    const output = results[name];
    assert.match(schemaBlock(output, 'CanonicalMetricQualifierSchema'), new RegExp(`\\}\\)\\.${policy}\\(\\);$`), name);
    // The other beta.6 rewrites are independent of closure.
    assert.match(output, /requested_metrics: z\.array\(AvailableMetricSchema\)\.min\(1\)/, name);
    assert.match(output, /threshold_seconds: z\.number\(\)\.gt\(0\)/, name);
    assert.match(
      schemaBlock(output, 'VendorMetricValueSchema'),
      /qualifier: CanonicalMetricQualifierSchema\.optional\(\)/,
      name
    );
    assert.equal(
      schemaBlock(output, 'DeliveryMetricAggregateSchema').split('CanonicalMetricQualifierSchema').length - 1,
      2,
      name
    );
  }
});

test('compatibility purchase continuation input follows media-buy/legacy-purchase-continuation-input.json', () => {
  const file = 'media-buy/legacy-purchase-continuation-input.json#';
  const scenarios = {
    closed: { [file]: { type: 'object', additionalProperties: false } },
    open: { [file]: { type: 'object', additionalProperties: true } },
    absent: { [file]: { type: 'object' } },
  };
  const results = runHarness(
    `
    const input = 'export const CompatibilityPurchaseCoordinatorInputSchema = z.any();\\n\\nexport const OutcomeTargetSchema = z.any();';
    const valid = {
      idempotency_key: '123e4567-e89b-42d3-a456-426614174000',
      continuation_token: 'a'.repeat(16),
      account: {},
      selected_product_ids: ['product-1'],
      accepted_losses: ['feed_version_not_atomic', 'pricing_version_not_atomic'],
      legacy_create_request: { any: 'thing' },
    };
    const out: Record<string, unknown> = {};
    for (const [name, sources] of Object.entries(data.scenarios)) {
      const output = __test__.postProcessCompatibilityPurchaseCoordinatorInput(input, reader(sources as Record<string, unknown>));
      const mod = await load('compat_' + name, 'const AccountReferenceSchema = z.object({}).passthrough();\\n' + output);
      const schema = mod.CompatibilityPurchaseCoordinatorInputSchema;
      out[name] = {
        output,
        valid: schema.safeParse(valid).success,
        unknownKey: schema.safeParse({ ...valid, extra: 1 }).success,
      };
    }
    return out;
  `,
    { scenarios }
  );

  assert.match(results.closed.output, /legacy_create_request must not be empty"\)\n\}\)\.strict\(\);/);
  assert.deepEqual([results.closed.valid, results.closed.unknownKey], [true, false]);
  for (const name of ['open', 'absent']) {
    assert.match(results[name].output, /legacy_create_request must not be empty"\)\n\}\)\.passthrough\(\);/);
    assert.deepEqual([results[name].valid, results[name].unknownKey], [true, true], name);
  }
  // The following export survives either way.
  assert.match(results.open.output, /export const OutcomeTargetSchema = z\.any\(\);/);
});
