const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { build } = require('esbuild');
const { verifyProposalCommercialTerms: verify, proposalTermsDigest } = require('@adcp/sdk/negotiation/verification');
const { withExternalSchemaRoot, toReleasePrecisionWire } = require('../../dist/lib/validation/schema-loader.js');
const { ADCP_VERSION } = require('../../dist/lib/version.js');
const current = require('../fixtures/proposal-commercial-terms/current.json');
const beta8 = require('../fixtures/proposal-commercial-terms/beta8.json');
const candidate = terms => ({ commercial_terms: terms, terms_digest: proposalTermsDigest(terms) });

test('public CommonJS and ESM verifier entries work without constructing a client', async () => {
  const manifest = require('../../package.json');
  assert.deepEqual(manifest.typesVersions['*']['negotiation/verification'], ['dist/lib/negotiation/verification.d.ts']);
  for (const condition of Object.values(manifest.exports['./negotiation/verification'])) {
    for (const file of Object.values(condition)) assert.ok(fs.existsSync(path.resolve(__dirname, '../..', file)), file);
  }
  const esm = await import('@adcp/sdk/negotiation/verification');
  assert.deepEqual(verify(candidate(current), current), { ok: true, schemaVersion: ADCP_VERSION, mismatches: [] });
  assert.deepEqual(esm.verifyProposalCommercialTerms(candidate(current), current), verify(candidate(current), current));
  const bundled = await build({
    stdin: {
      contents: "export { verifyProposalCommercialTerms } from '@adcp/sdk/negotiation/verification'",
      resolveDir: process.cwd(),
      sourcefile: 'buyer.mjs',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    metafile: true,
  });
  assert.ok(
    Object.keys(bundled.metafile.inputs).every(
      file => !/protocols\/|TaskExecutor|AdCPClient|negotiation\/(buyer|seller|orchestrator)\./.test(file)
    )
  );
  assert.ok(!bundled.outputFiles[0].text.includes('function verifyRefineProposalsResponse'));
});

for (const field of ['start_time', 'end_time']) {
  test(`accepted purchases require resolved ${field} even when both snapshots omit it`, () => {
    const terms = structuredClone(current);
    delete terms.purchases[0][field];
    const result = verify(candidate(terms), terms);
    assert.equal(result.mismatches[0].kind, 'invalid_terms');
    assert.equal(result.mismatches[0].path, `/commercial_terms/purchases/0/${field}`);
  });
}

// Each mutation preserves JSON Schema validity, isolating exhaustive comparison
// from shape validation. The paths are a buyer-visible contract.
const changes = [
  [
    'price',
    t => {
      t.purchases[0].pricing.fixed_price = 9;
    },
    '/purchases/0/pricing/fixed_price',
  ],
  [
    'currency',
    t => {
      t.purchases[0].pricing.currency = 'EUR';
      t.total_budget.currency = 'EUR';
      for (const key of ['max_delta_amount', 'min_result_amount', 'max_result_amount'])
        t.change_terms[0].constraints[key].currency = 'EUR';
    },
    '/purchases/0/pricing/currency',
  ],
  [
    'flight start',
    t => {
      t.start_time = '2027-01-02T00:00:00Z';
    },
    '/start_time',
  ],
  [
    'flight end',
    t => {
      t.end_time = '2027-02-02T00:00:00Z';
    },
    '/end_time',
  ],
  [
    'package flight',
    t => {
      t.purchases[0].end_time = '2027-02-02T00:00:00Z';
    },
    '/purchases/0/end_time',
  ],
  [
    'package authorization',
    t => {
      t.purchases[0].agency_estimate_number = 'replacement';
    },
    '/purchases/0/agency_estimate_number',
  ],
  [
    'contract reference',
    t => {
      t.change_terms[0].terms_ref = 'other-contract';
    },
    '/change_terms/0/terms_ref',
  ],
  [
    'purchase order',
    t => {
      t.purchase_order_ref = 'other-order';
    },
    '/purchase_order_ref',
  ],
  [
    'mode',
    t => {
      t.change_terms[0].service_mode = 'seller_managed';
    },
    '/change_terms/0/service_mode',
  ],
  [
    'status scope',
    t => {
      t.change_terms[0].allowed_statuses[1] = 'pending_start';
    },
    '/change_terms/0/allowed_statuses/1',
  ],
  [
    'SLA',
    t => {
      t.change_terms[0].processing_sla.completion_max = 'P1D';
    },
    '/change_terms/0/processing_sla/completion_max',
  ],
  [
    'opaque condition',
    t => {
      t.change_terms[0].conditions[0] = 'different_condition';
    },
    '/change_terms/0/conditions/0',
  ],
  [
    'budget constraint',
    t => {
      t.change_terms[0].constraints.max_delta_percent = 30;
    },
    '/change_terms/0/constraints/max_delta_percent',
  ],
  [
    'flight constraint',
    t => {
      t.change_terms[1].constraints.max_change.interval = 8;
    },
    '/change_terms/1/constraints/max_change/interval',
  ],
  [
    'package count',
    t => {
      t.change_terms[2].constraints.max_result_count = 4;
    },
    '/change_terms/2/constraints/max_result_count',
  ],
  [
    'effective timing',
    t => {
      t.change_terms[3].constraints.minimum_notice.interval = 10;
    },
    '/change_terms/3/constraints/minimum_notice/interval',
  ],
  [
    'extension JSON Pointer escaping',
    t => {
      t.purchases[0].ext.vendor['binding/key~name'].rate = 2;
    },
    '/purchases/0/ext/vendor/binding~1key~0name/rate',
  ],
];
for (const [name, mutate, suffix] of changes) {
  test(`recursive comparison covers ${name}`, () => {
    const offered = structuredClone(current);
    mutate(offered);
    const result = verify(candidate(offered), current);
    assert.equal(result.ok, false);
    assert.ok(
      result.mismatches.some(m => m.kind === 'changed' && m.path === `/commercial_terms${suffix}`),
      JSON.stringify(result)
    );
  });
}

test('array order, added purchases, and removed rights are binding', () => {
  const offered = structuredClone(current);
  offered.purchases.push(structuredClone(offered.purchases[0]));
  offered.change_terms.pop();
  assert.deepEqual(
    verify(candidate(offered), current).mismatches.map(m => [m.kind, m.path]),
    [
      ['missing', '/commercial_terms/change_terms/3'],
      ['unexpected', '/commercial_terms/purchases/1'],
    ]
  );
  const reordered = structuredClone(current);
  reordered.change_terms.reverse();
  assert.equal(verify(candidate(reordered), current).ok, false);
});

test('unknown fields fail closed at root and nested scopes even in identical snapshots', () => {
  for (const mutate of [
    t => {
      t.future_contract = 'unknown';
    },
    t => {
      t.purchases[0].future_contract = 'unknown';
    },
    t => {
      t.change_terms[0].future_contract = 'unknown';
    },
  ]) {
    const terms = structuredClone(current);
    mutate(terms);
    const result = verify(candidate(terms), terms);
    assert.equal(result.ok, false);
    assert.equal(result.mismatches[0].kind, 'invalid_terms');
    assert.ok(result.mismatches[0].path.endsWith('/future_contract'));
  }
});

test('digest failure precedes schema selection and access to the expected snapshot', () => {
  const expected = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error('expected snapshot accessed');
      },
    }
  );
  const proposed = candidate(current);
  proposed.commercial_terms = { unknown_binding: true };
  assert.deepEqual(
    verify(proposed, expected, { adcpVersion: 'unknown' }).mismatches.map(m => m.kind),
    ['digest_mismatch']
  );
});

test('3.1 has no canonical commercial envelope and cannot acquire 3.2 authority by projection', () => {
  assert.equal(verify(candidate(beta8), beta8, { adcpVersion: '3.1.18' }).mismatches[0].kind, 'schema_unavailable');
  // A proposal change term's terms_ref is a contract pointer, never its term_id.
  assert.notEqual(current.change_terms[0].terms_ref, current.change_terms[0].term_id);
  assert.equal(verify(candidate(current), current).ok, true);
});

test('an older 3.2 bundle admits its own envelope and rejects projected change rights', () => {
  // Fixture keeps this version test independent of optional caches on adopters' machines.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proposal-beta8-'));
  const documents = JSON.parse(
    require('node:zlib').gunzipSync(
      fs.readFileSync(path.resolve(__dirname, '../fixtures/proposal-commercial-terms/beta8-schema.json.gz'))
    )
  );
  try {
    for (const [ref, schema] of Object.entries(documents)) {
      const file = path.join(root, ref);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(schema));
    }
    withExternalSchemaRoot('3.2.0-beta.8', root, () => {
      assert.equal(verify(candidate(beta8), beta8, { adcpVersion: '3.2.0-beta.8' }).ok, true);
      const result = verify(candidate(current), current, { adcpVersion: '3.2.0-beta.8' });
      assert.equal(result.ok, false);
      assert.equal(result.mismatches[0].path, '/commercial_terms/change_terms');
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function withChangedSchema(change, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proposal-schema-'));
  try {
    fs.cpSync(path.resolve(__dirname, '../../schemas/cache', ADCP_VERSION), root, {
      recursive: true,
      filter: source => !['bundled', 'mcp'].includes(path.basename(source)),
    });
    const ref = 'media-buy/commercial-terms.json';
    const schema = JSON.parse(fs.readFileSync(path.join(root, ref), 'utf8'));
    change(schema, root);
    fs.writeFileSync(path.join(root, ref), JSON.stringify(schema));
    return withExternalSchemaRoot(ADCP_VERSION, root, () => run(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('new schema fields require an explicitly reviewed complete snapshot', () => {
  withChangedSchema(
    schema => {
      schema.properties.future_contract = {
        type: 'object',
        properties: { fee: { type: 'number' } },
        additionalProperties: false,
      };
    },
    () => {
      const terms = { ...current, future_contract: { fee: 123 } };
      assert.equal(verify(candidate(terms), current).mismatches[0].kind, 'unexpected');
      assert.equal(verify(candidate(terms), terms).ok, true);
      assert.equal(
        verify(candidate(terms), { ...terms, future_contract: { fee: 124 } }).mismatches[0].path,
        '/commercial_terms/future_contract/fee'
      );
    }
  );
});

test('release-precision external roots can use schema identity without an index', () => {
  withChangedSchema(
    (schema, root) => fs.rmSync(path.join(root, 'index.json')),
    root => {
      const release = toReleasePrecisionWire(ADCP_VERSION);
      const result = withExternalSchemaRoot(release, root, () =>
        verify(candidate(current), current, { adcpVersion: release })
      );
      assert.equal(result.ok, true);
      assert.equal(result.schemaVersion, ADCP_VERSION);
    }
  );
});

for (const kind of ['release-pinned latest', 'root-relative']) {
  test(`external bundles support ${kind} schema identities`, () => {
    const rewrite = value => {
      if (typeof value === 'string') {
        return kind === 'root-relative'
          ? value.replace('https://adcontextprotocol.org/schemas/', '/schemas/')
          : value.replace(`/schemas/${ADCP_VERSION}/`, '/schemas/latest/');
      }
      if (Array.isArray(value)) return value.map(rewrite);
      if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v)]));
      return value;
    };
    withChangedSchema(
      (schema, root) => {
        for (const file of fs.readdirSync(root, { recursive: true })) {
          if (!file.endsWith('.json')) continue;
          const target = path.join(root, file);
          fs.writeFileSync(target, JSON.stringify(rewrite(JSON.parse(fs.readFileSync(target, 'utf8')))));
        }
        Object.assign(schema, rewrite(schema));
      },
      () =>
        assert.deepEqual(verify(candidate(current), current), { ok: true, schemaVersion: ADCP_VERSION, mismatches: [] })
    );
  });
}

test('extensible taxonomies retain explicit enum membership for binding snapshots', () => {
  const terms = { ...current, advertiser_industry: 'pet_care.veterinary_services' };
  const result = verify(candidate(terms), terms);
  assert.equal(result.ok, false);
  assert.equal(result.mismatches[0].kind, 'invalid_terms');
  assert.equal(result.mismatches[0].path, '/commercial_terms/advertiser_industry');
});

test('schema audit caches use immutable documents and refresh with loader state', () => {
  const { getSchemaDocumentByRef, _resetValidationLoader } = require('../../dist/lib/validation/schema-loader.js');
  withChangedSchema(
    () => {},
    root => {
      const ref = 'media-buy/commercial-terms.json';
      const before = getSchemaDocumentByRef(ref).schema;
      assert.equal(verify(candidate(current), current).ok, true);
      assert.equal(getSchemaDocumentByRef(ref).schema, before);
      assert.equal(Object.isFrozen(before.properties.purchases), true);
      const changed = JSON.parse(fs.readFileSync(path.join(root, ref), 'utf8'));
      changed.properties.total_budget.futureBindingRule = true;
      fs.writeFileSync(path.join(root, ref), JSON.stringify(changed));
      _resetValidationLoader(ADCP_VERSION);
      assert.notEqual(getSchemaDocumentByRef(ref).schema, before);
      assert.equal(verify(candidate(current), current).mismatches[0].kind, 'unsupported_schema');
    }
  );
});

test('loader reset recompiles ordinary and keyword validators after a supported schema change', () => {
  const { getSchemaValidatorByRef, _resetValidationLoader } = require('../../dist/lib/validation/schema-loader.js');
  withChangedSchema(
    () => {},
    root => {
      const ref = 'media-buy/commercial-terms.json';
      assert.equal(getSchemaValidatorByRef(ref)(current), true);
      assert.equal(verify(candidate(current), current).ok, true);
      const schema = JSON.parse(fs.readFileSync(path.join(root, ref), 'utf8'));
      schema.properties.purchase_order_ref.maxLength = 1;
      fs.writeFileSync(path.join(root, ref), JSON.stringify(schema));
      _resetValidationLoader(ADCP_VERSION);
      assert.equal(getSchemaValidatorByRef(ref)(current), false);
      const result = verify(candidate(current), current);
      assert.equal(result.mismatches[0].kind, 'invalid_terms');
      assert.equal(result.mismatches[0].path, '/commercial_terms/purchase_order_ref');
    }
  );
});

test('rc.3 deliberately supports the revised accepted-snapshot contract without weakening rc.2', () => {
  const { getSchemaDocumentByRef } = require('../../dist/lib/validation/schema-loader.js');
  const { commercialTermsSchemaSupportError } = require('../../dist/lib/negotiation/commercial-terms-schema.js');
  const contract = require('../fixtures/proposal-commercial-terms/rc3-product-purchase-validation.json');
  for (const version of ['3.2.0-rc.2', '3.2.0-rc.4']) {
    const load = ref => {
      const source = getSchemaDocumentByRef(ref)?.schema;
      if (!source) return undefined;
      const document = JSON.parse(
        JSON.stringify(source).replaceAll(`/schemas/${ADCP_VERSION}/`, `/schemas/${version}/`)
      );
      if (ref === 'media-buy/product-purchase.json') document['x-adcp-validation'] = contract;
      return document;
    };
    const error = commercialTermsSchemaSupportError(load('media-buy/commercial-terms.json'), version, load);
    if (version === '3.2.0-rc.4') assert.equal(error, undefined);
    else assert.match(error, /unreviewed commercial-term validation semantics/);
  }
});

test('explanatory schema metadata edits do not change the accepted contract', () => {
  withChangedSchema(
    (schema, root) => {
      const file = path.join(root, 'core/targeting.json');
      const targeting = JSON.parse(fs.readFileSync(file, 'utf8'));
      targeting['x-adcp-validation'].description = 'Editorial clarification of the same structured rule.';
      targeting['x-adcp-validation'].spec = 'docs/updated-location.mdx';
      fs.writeFileSync(file, JSON.stringify(targeting));
    },
    () => assert.equal(verify(candidate(current), current).ok, true)
  );
});

test('a duplicate schema identity cannot shadow the audited document', () => {
  withChangedSchema(
    (schema, root) => {
      fs.writeFileSync(
        path.join(root, 'core/aaa-shadow.json'),
        JSON.stringify({
          $id: schema.properties.brand.$ref,
          type: 'object',
          additionalProperties: true,
        })
      );
    },
    () => {
      const result = verify(candidate(current), current);
      assert.equal(result.ok, false);
      assert.equal(result.mismatches[0].kind, 'unsupported_schema');
    }
  );
});

test('the support guard rejects a root identity inconsistent with the selected release', () => {
  const { getSchemaDocumentByRef } = require('../../dist/lib/validation/schema-loader.js');
  const { commercialTermsSchemaSupportError } = require('../../dist/lib/negotiation/commercial-terms-schema.js');
  const document = getSchemaDocumentByRef('media-buy/commercial-terms.json');
  assert.match(
    commercialTermsSchemaSupportError(document.schema, '3.1.18', () => {
      assert.fail('a mismatched root must fail before dependency traversal');
    }),
    /identity does not match the selected release/
  );
});

for (const [name, change] of [
  ...['x-extensible', 'x-pattern'].map(keyword => [
    `changed ${keyword} enum annotation`,
    (schema, root) => {
      const file = path.join(root, 'enums/advertiser-industry.json');
      const taxonomy = JSON.parse(fs.readFileSync(file, 'utf8'));
      delete taxonomy[keyword];
      fs.writeFileSync(file, JSON.stringify(taxonomy));
    },
  ]),
  [
    'removed semantic dependency',
    (schema, root) => {
      const file = path.join(root, 'core/targeting.json');
      const targeting = JSON.parse(fs.readFileSync(file, 'utf8'));
      targeting.properties.language.items = { type: 'string' };
      fs.writeFileSync(file, JSON.stringify(targeting));
    },
  ],
  [
    'boolean replacement of a reviewed contract',
    schema => {
      schema.properties.purchases = true;
    },
  ],
  [
    'deletion of a reviewed contract location',
    schema => {
      delete schema.properties.purchases;
      schema.required = schema.required.filter(key => key !== 'purchases');
    },
  ],
  [
    'removed validation contract',
    schema => {
      delete schema['x-adcp-validation'];
    },
  ],
  [
    'unknown format',
    schema => {
      schema.properties.end_time.format = 'future-binding-format';
    },
  ],
  [
    'new validation contract',
    schema => {
      schema.properties.total_budget['x-adcp-validation'] = { verifier_constraints: { future: 'reject' } };
    },
  ],
  [
    'unknown schema keyword',
    schema => {
      schema.properties.total_budget.futureBindingRule = true;
    },
  ],
  [
    'new dialect keyword',
    schema => {
      schema.unevaluatedProperties = false;
    },
  ],
  [
    'referenced schema drift',
    (schema, root) => {
      const file = path.join(root, 'media-buy/change-term-constraints.json');
      const dependency = JSON.parse(fs.readFileSync(file, 'utf8'));
      dependency.oneOf[0].properties.max_delta_percent.futureBindingRule = true;
      fs.writeFileSync(file, JSON.stringify(dependency));
    },
  ],
  [
    'cross-version reference',
    schema => {
      schema.properties.brand.$ref = schema.properties.brand.$ref.replace(ADCP_VERSION, '3.1.18');
    },
  ],
]) {
  test(`equal terms fail closed for ${name}`, () => {
    withChangedSchema(change, () => {
      const result = verify(candidate(current), current);
      assert.equal(result.ok, false);
      assert.equal(result.mismatches[0].kind, 'unsupported_schema');
    });
  });
}

const place = { country: 'US', system: 'geonames', place_type: 'city', values: ['5128581'] };
for (const [name, targeting, suffix] of [
  [
    'overlapping places',
    { geo_places: [place], geo_places_exclude: [{ ...place, system_version: 'another-catalog' }] },
    '/geo_places_exclude/0/values/0',
  ],
  ['overlapping regions', { geo_regions: ['US-NY'], geo_regions_exclude: ['US-NY'] }, '/geo_regions_exclude/0'],
  [
    'unknown place labels',
    { geo_places: [{ ...place, value_labels: { 'not/a~value': 'unbound label' } }] },
    '/geo_places/0/value_labels/not~1a~0value',
  ],
  ['duplicate language variants', { language: ['en-abcde-abcde'] }, '/language/0'],
]) {
  test(`equal snapshots reject ${name} with a precise schema-selected path`, () => {
    const terms = structuredClone(current);
    terms.purchases[0].targeting_overlay = targeting;
    const result = verify(candidate(terms), terms);
    assert.equal(result.ok, false);
    assert.equal(result.mismatches[0].keyword, 'x-adcp-validation');
    assert.equal(result.mismatches[0].path, `/commercial_terms/purchases/0/targeting_overlay${suffix}`);
  });
}

test('timezone semantics apply only to the matching schema branch', () => {
  for (const [zone, expected] of [
    ['UTC', true],
    ['inventory_local', true],
    ['Unknown/Timezone', false],
  ]) {
    const terms = structuredClone(current);
    terms.purchases[0].targeting_overlay = {
      daypart_targets: [{ days: ['monday'], start_hour: 6, end_hour: 10, timezone: zone }],
      language: ['en-US', 'x-private'],
    };
    assert.equal(verify(candidate(terms), terms).ok, expected, zone);
  }
});

test('commercial keyword validation cannot poison ordinary schema-ref validators', () => {
  const { getSchemaValidatorByRef } = require('../../dist/lib/validation/schema-loader.js');
  const raw = getSchemaValidatorByRef('media-buy/commercial-terms.json');
  const terms = structuredClone(current);
  terms.purchases[0].targeting_overlay = { geo_regions: ['US-NY'], geo_regions_exclude: ['US-NY'] };
  assert.equal(raw(terms), true);
  assert.equal(verify(candidate(terms), terms).ok, false);
  assert.equal(getSchemaValidatorByRef('media-buy/commercial-terms.json')(terms), true);
});
