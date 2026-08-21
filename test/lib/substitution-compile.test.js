const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { compileUniversalMacroTemplate } = require('../../dist/lib/index.js');

const DOCUMENTATION = [
  {
    title: 'Example vendor macro documentation',
    url: 'https://vendor.example/macros',
    retrieved_at: '2026-08-21',
  },
];

describe('compileUniversalMacroTemplate', () => {
  it('compiles exact vendor mappings and retains source offsets', () => {
    const template = 'https://pixel.example/i?device={{USER_ID}}&consent={{CONSENT}}&cb={CACHEBUSTER}';
    const result = compileUniversalMacroTemplate({
      template,
      source_dialect: 'example-vendor',
      mappings: [
        {
          source_token: '{{USER_ID}}',
          universal_macro: '{DEVICE_ID}',
          source_dialect: 'example-vendor',
          semantic: 'resettable_device_advertising_id',
          documentation: DOCUMENTATION,
        },
        {
          source_token: '{{CONSENT}}',
          universal_macro: '{GDPR_CONSENT}',
          source_dialect: 'example-vendor',
          documentation: DOCUMENTATION,
          requirements: [
            {
              kind: 'target_specific_consent_mapping',
              description: 'Use the recipient-approved consent expression.',
            },
          ],
        },
      ],
    });

    assert.equal(result.publishable, true);
    assert.equal(
      result.canonical_template,
      'https://pixel.example/i?device={DEVICE_ID}&consent={GDPR_CONSENT}&cb={CACHEBUSTER}'
    );
    assert.deepEqual(
      result.occurrences.map(({ source_token, status }) => ({ source_token, status })),
      [
        { source_token: '{{USER_ID}}', status: 'mapped' },
        { source_token: '{{CONSENT}}', status: 'mapped' },
        { source_token: '{CACHEBUSTER}', status: 'canonical' },
      ]
    );
    for (const occurrence of result.occurrences) {
      assert.equal(template.slice(occurrence.start, occurrence.end), occurrence.source_token);
    }
  });

  it('fails closed on unknown tokens without rewriting them', () => {
    const template = 'https://pixel.example/i?user={{USER_ID}}';
    const result = compileUniversalMacroTemplate({
      template,
      source_dialect: 'unknown-vendor',
      mappings: [],
    });

    assert.equal(result.publishable, false);
    assert.equal(result.canonical_template, template);
    const start = template.indexOf('{{USER_ID}}');
    assert.deepEqual(result.diagnostics, [
      {
        code: 'unknown_macro',
        severity: 'error',
        message: 'No unknown-vendor mapping exists for {{USER_ID}}',
        source_token: '{{USER_ID}}',
        start,
        end: start + '{{USER_ID}}'.length,
      },
    ]);
  });

  it('requires mapping provenance by default', () => {
    const result = compileUniversalMacroTemplate({
      template: 'https://pixel.example/i?device={{DEVICE}}',
      source_dialect: 'example-vendor',
      mappings: [
        {
          source_token: '{{DEVICE}}',
          universal_macro: '{DEVICE_ID}',
          source_dialect: 'example-vendor',
        },
      ],
    });

    assert.equal(result.publishable, false);
    assert.equal(result.canonical_template, result.source_template);
    assert.equal(result.diagnostics[0].code, 'mapping_provenance_required');
  });

  it('rejects unsupported AdCP macro targets', () => {
    const result = compileUniversalMacroTemplate({
      template: 'https://pixel.example/i?device={{DEVICE}}',
      source_dialect: 'example-vendor',
      mappings: [
        {
          source_token: '{{DEVICE}}',
          universal_macro: '{NOT_AN_ADCP_MACRO}',
          source_dialect: 'example-vendor',
          documentation: DOCUMENTATION,
        },
      ],
    });

    assert.equal(result.publishable, false);
    assert.equal(result.diagnostics[0].code, 'invalid_universal_macro');
  });

  it('treats a nested source expression as one exact token', () => {
    const nested = '${CONSENT_${VENDOR}}';
    const result = compileUniversalMacroTemplate({
      template: `https://pixel.example/i?consent=${nested}`,
      source_dialect: 'example-ad-server',
      mappings: [
        {
          source_token: nested,
          universal_macro: '{GDPR_CONSENT}',
          source_dialect: 'example-ad-server',
          documentation: DOCUMENTATION,
        },
      ],
    });

    assert.equal(result.publishable, true);
    assert.equal(result.canonical_template, 'https://pixel.example/i?consent={GDPR_CONSENT}');
    assert.equal(result.occurrences.length, 1);
  });

  it('rejects duplicate mappings for the selected dialect', () => {
    const mapping = {
      source_token: '{{DEVICE}}',
      universal_macro: '{DEVICE_ID}',
      source_dialect: 'example-vendor',
      documentation: DOCUMENTATION,
    };
    const result = compileUniversalMacroTemplate({
      template: 'https://pixel.example/i?device={{DEVICE}}',
      source_dialect: 'example-vendor',
      mappings: [mapping, { ...mapping, universal_macro: '{APP_BUNDLE}' }],
    });

    assert.equal(result.publishable, false);
    assert.equal(result.diagnostics[0].code, 'duplicate_mapping');
  });
});
