const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { compileUniversalMacroTemplate, translateUniversalMacros } = require('../../dist/lib/index.js');

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
      source_syntaxes: ['double_brace'],
      allow_canonical_macros: true,
      satisfied_requirements: [{ kind: 'target_specific_consent_mapping' }],
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
      source_syntaxes: ['double_brace'],
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
      source_syntaxes: ['double_brace'],
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
      source_syntaxes: ['double_brace'],
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
      source_syntaxes: ['dollar_brace'],
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
      source_syntaxes: ['double_brace'],
      mappings: [mapping, { ...mapping, universal_macro: '{APP_BUNDLE}' }],
    });

    assert.equal(result.publishable, false);
    assert.equal(result.diagnostics[0].code, 'duplicate_mapping');
    assert.equal(result.canonical_template, result.source_template);
    assert.equal(result.occurrences[0].status, 'unresolved');
  });

  it('limits unknown-token scanning to the selected dialect syntaxes', () => {
    const template =
      'https://[fe80::1]/collect/{path}?filter[status]=active&device={{DEVICE}}#javascript=${expression}';
    const result = compileUniversalMacroTemplate({
      template,
      source_dialect: 'double-brace-vendor',
      source_syntaxes: ['double_brace'],
      mappings: [
        {
          source_token: '{{DEVICE}}',
          universal_macro: '{DEVICE_ID}',
          source_dialect: 'double-brace-vendor',
          documentation: DOCUMENTATION,
        },
      ],
    });

    assert.equal(result.publishable, true);
    assert.equal(
      result.canonical_template,
      'https://[fe80::1]/collect/{path}?filter[status]=active&device={DEVICE_ID}#javascript=${expression}'
    );
    assert.deepEqual(
      result.occurrences.map(occurrence => occurrence.source_token),
      ['{{DEVICE}}']
    );
  });

  it('recognizes upper-snake bracket macros without treating URL brackets as macros', () => {
    const template = 'https://[FE80::1]/i?filter[status]=active&cb=[CACHEBUSTER]';
    const result = compileUniversalMacroTemplate({
      template,
      source_dialect: 'bracket-vendor',
      source_syntaxes: ['bracket'],
      mappings: [
        {
          source_token: '[CACHEBUSTER]',
          universal_macro: '{CACHEBUSTER}',
          source_dialect: 'bracket-vendor',
          documentation: DOCUMENTATION,
        },
      ],
    });

    assert.equal(result.publishable, true);
    assert.equal(result.canonical_template, 'https://[FE80::1]/i?filter[status]=active&cb={CACHEBUSTER}');
    assert.deepEqual(
      result.occurrences.map(occurrence => occurrence.source_token),
      ['[CACHEBUSTER]']
    );
  });

  it('supports exact evidence-backed tokens with custom delimiters', () => {
    const result = compileUniversalMacroTemplate({
      template: 'https://pixel.example/i?device=##DEVICE##',
      source_dialect: 'custom-vendor',
      source_syntaxes: [{ name: 'hash', open: '##', close: '##' }],
      mappings: [
        {
          source_token: '##DEVICE##',
          universal_macro: '{DEVICE_ID}',
          source_dialect: 'custom-vendor',
          documentation: DOCUMENTATION,
        },
      ],
    });

    assert.equal(result.publishable, true);
    assert.equal(result.canonical_template, 'https://pixel.example/i?device={DEVICE_ID}');
    assert.equal(result.occurrences[0].syntax, 'custom:hash');
  });

  it('fails closed on unknown tokens even when the mapping list is empty', () => {
    const result = compileUniversalMacroTemplate({
      template: 'https://pixel.example/i?device=%%UNREGISTERED%%',
      source_dialect: 'percent-vendor',
      source_syntaxes: ['percent'],
      mappings: [],
    });

    assert.equal(result.publishable, false);
    assert.equal(result.diagnostics[0].code, 'unknown_macro');
  });

  it('requires source syntax declarations at runtime', () => {
    const result = compileUniversalMacroTemplate({
      template: 'https://pixel.example/i?device={{DEVICE}}',
      source_dialect: 'example-vendor',
      mappings: [],
    });

    assert.equal(result.publishable, false);
    assert.equal(result.diagnostics[0].code, 'source_syntax_required');
  });

  it('does not trust canonical-looking tokens unless the caller opts in', () => {
    const input = {
      template: 'https://pixel.example/i?device={DEVICE_ID}',
      source_dialect: 'single-brace-vendor',
      source_syntaxes: ['adcp'],
      mappings: [],
    };

    const untrusted = compileUniversalMacroTemplate(input);
    assert.equal(untrusted.publishable, false);
    assert.equal(untrusted.diagnostics[0].code, 'unknown_macro');

    const trusted = compileUniversalMacroTemplate({ ...input, allow_canonical_macros: true });
    assert.equal(trusted.publishable, true);
    assert.equal(trusted.occurrences[0].status, 'canonical');
  });

  it('gives exact mappings precedence over canonical-looking tokens', () => {
    const result = compileUniversalMacroTemplate({
      template: 'https://pixel.example/i?id={DEVICE_ID}',
      source_dialect: 'single-brace-vendor',
      source_syntaxes: ['adcp'],
      allow_canonical_macros: true,
      mappings: [
        {
          source_token: '{DEVICE_ID}',
          universal_macro: '{IMPRESSION_ID}',
          source_dialect: 'single-brace-vendor',
          documentation: DOCUMENTATION,
        },
      ],
    });

    assert.equal(result.publishable, true);
    assert.equal(result.canonical_template, 'https://pixel.example/i?id={IMPRESSION_ID}');
    assert.equal(result.occurrences[0].status, 'mapped');
  });

  it('validates documentation and requirements at runtime', () => {
    const result = compileUniversalMacroTemplate({
      template: 'https://pixel.example/i?device={{DEVICE}}',
      source_dialect: 'example-vendor',
      source_syntaxes: ['double_brace'],
      mappings: [
        {
          source_token: '{{DEVICE}}',
          universal_macro: '{DEVICE_ID}',
          source_dialect: 'example-vendor',
          documentation: [{ title: '', url: 'not-a-url' }],
          requirements: [{ kind: '', description: '' }],
        },
      ],
    });

    assert.equal(result.publishable, false);
    assert.deepEqual(
      result.diagnostics.map(diagnostic => diagnostic.code),
      ['invalid_mapping_provenance', 'invalid_mapping_requirement']
    );
    assert.equal(result.canonical_template, result.source_template);
  });

  it('validates the selected mapping registry even when an entry is unused', () => {
    const result = compileUniversalMacroTemplate({
      template: 'https://pixel.example/i',
      source_dialect: 'example-vendor',
      source_syntaxes: ['double_brace'],
      mappings: [
        {
          source_token: '{{BROKEN}}',
          universal_macro: '{NOT_AN_ADCP_MACRO}',
          source_dialect: 'example-vendor',
          documentation: DOCUMENTATION,
        },
      ],
    });

    assert.equal(result.publishable, false);
    assert.equal(result.diagnostics[0].code, 'invalid_universal_macro');
    assert.equal(result.occurrences.length, 0);
  });

  it('applies replacements once without expanding replacement output', () => {
    const result = compileUniversalMacroTemplate({
      template: '{{FIRST}}',
      source_dialect: 'example-vendor',
      source_syntaxes: ['double_brace', 'adcp'],
      mappings: [
        {
          source_token: '{{FIRST}}',
          universal_macro: '{DEVICE_ID}',
          source_dialect: 'example-vendor',
          documentation: DOCUMENTATION,
        },
        {
          source_token: '{DEVICE_ID}',
          universal_macro: '{IMPRESSION_ID}',
          source_dialect: 'example-vendor',
          documentation: DOCUMENTATION,
        },
      ],
    });

    assert.equal(result.publishable, true);
    assert.equal(result.canonical_template, '{DEVICE_ID}');
    assert.equal(result.occurrences.length, 1);
  });

  it('fails closed on unknown tokens in caller-declared custom syntax', () => {
    const result = compileUniversalMacroTemplate({
      template: 'https://pixel.example/i?known=##DEVICE##&unknown=##USER##',
      source_dialect: 'custom-vendor',
      source_syntaxes: [{ name: 'hash', open: '##', close: '##' }],
      mappings: [
        {
          source_token: '##DEVICE##',
          universal_macro: '{DEVICE_ID}',
          source_dialect: 'custom-vendor',
          documentation: DOCUMENTATION,
        },
      ],
    });

    assert.equal(result.publishable, false);
    assert.equal(result.canonical_template.endsWith('unknown=##USER##'), true);
    assert.equal(result.diagnostics.at(-1).code, 'unknown_macro');
  });

  it('rejects supported and unsupported canonical-shaped tokens unless explicitly trusted', () => {
    const base = {
      source_dialect: 'double-brace-vendor',
      source_syntaxes: ['double_brace'],
      mappings: [],
    };
    const supported = compileUniversalMacroTemplate({ ...base, template: '{DEVICE_ID}' });
    const unsupported = compileUniversalMacroTemplate({
      ...base,
      template: '{NOT_AN_ADCP_MACRO}',
      allow_canonical_macros: true,
    });

    assert.equal(supported.publishable, false);
    assert.equal(supported.diagnostics[0].code, 'unknown_macro');
    assert.equal(unsupported.publishable, false);
    assert.equal(unsupported.diagnostics[0].code, 'unknown_macro');
  });

  it('surfaces delivery-active canonical macros inside unrelated outer expressions', () => {
    const result = compileUniversalMacroTemplate({
      template: 'script=${DEVICE_ID}&template={{DEVICE_ID}}&device={{DEVICE}}',
      source_dialect: 'double-brace-vendor',
      source_syntaxes: ['double_brace'],
      allow_canonical_macros: true,
      mappings: [
        {
          source_token: '{{DEVICE}}',
          universal_macro: '{DEVICE_ID}',
          source_dialect: 'double-brace-vendor',
          documentation: DOCUMENTATION,
        },
      ],
    });

    assert.equal(result.publishable, false);
    assert.deepEqual(
      result.occurrences.map(occurrence => occurrence.source_token),
      ['${DEVICE_ID}', '{{DEVICE_ID}}', '{{DEVICE}}']
    );
    assert.equal(result.canonical_template, 'script=${DEVICE_ID}&template={{DEVICE_ID}}&device={DEVICE_ID}');
  });

  it('rejects malformed bracket and single-brace macros before URL punctuation', () => {
    for (const [source_syntaxes, token] of [
      [['bracket'], '[CACHEBUSTER&next=1'],
      [['adcp'], '{DEVICE_ID#fragment'],
    ]) {
      const result = compileUniversalMacroTemplate({
        template: `https://pixel.example/i?value=${token}`,
        source_dialect: 'example-vendor',
        source_syntaxes,
        mappings: [],
      });
      assert.equal(result.publishable, false);
      assert.equal(result.diagnostics[0].code, 'malformed_macro');
    }
  });

  it('returns fail-closed diagnostics for invalid top-level JavaScript inputs', () => {
    for (const input of [null, {}, { template: null, source_dialect: 'x', source_syntaxes: [], mappings: [] }]) {
      const result = compileUniversalMacroTemplate(input);
      assert.equal(result.publishable, false);
      assert.equal(
        result.diagnostics.some(diagnostic => diagnostic.code === 'invalid_input'),
        true
      );
    }
    const invalidBoolean = compileUniversalMacroTemplate({
      template: 'literal',
      source_dialect: 'x',
      source_syntaxes: ['double_brace'],
      mappings: [],
      require_documentation: 0,
    });
    assert.equal(invalidBoolean.publishable, false);
    assert.equal(invalidBoolean.diagnostics[0].code, 'invalid_input');
  });

  it('gates publication on declared runtime requirements', () => {
    const input = {
      template: '{{CONSENT}}',
      source_dialect: 'example-vendor',
      source_syntaxes: ['double_brace'],
      mappings: [
        {
          source_token: '{{CONSENT}}',
          universal_macro: '{GDPR_CONSENT}',
          source_dialect: 'example-vendor',
          documentation: DOCUMENTATION,
          requirements: [{ kind: 'recipient_consent_mapping', value: 'iab', description: 'Resolve consent.' }],
        },
      ],
    };

    const unmet = compileUniversalMacroTemplate(input);
    assert.equal(unmet.publishable, false);
    assert.equal(unmet.diagnostics.at(-1).code, 'unsatisfied_requirement');

    const met = compileUniversalMacroTemplate({
      ...input,
      satisfied_requirements: [{ kind: 'recipient_consent_mapping', value: 'iab' }],
    });
    assert.equal(met.publishable, true);
    assert.equal(met.canonical_template, '{GDPR_CONSENT}');
  });

  it('round-trips compiled query-value macros through delivery translation', () => {
    const compiled = compileUniversalMacroTemplate({
      template: 'https://pixel.example/i?device={{DEVICE}}',
      source_dialect: 'example-vendor',
      source_syntaxes: ['double_brace'],
      mappings: [
        {
          source_token: '{{DEVICE}}',
          universal_macro: '{DEVICE_ID}',
          source_dialect: 'example-vendor',
          documentation: DOCUMENTATION,
        },
      ],
    });
    const delivered = translateUniversalMacros(compiled.canonical_template, {
      '{DEVICE_ID}': { native: '%%DEVICE%%' },
    });

    assert.equal(compiled.publishable, true);
    assert.equal(delivered.url, 'https://pixel.example/i?device=%%DEVICE%%');
  });

  it('supports percent mappings without documentation only when explicitly disabled', () => {
    const result = compileUniversalMacroTemplate({
      template: '%%CACHE%%',
      source_dialect: 'percent-vendor',
      source_syntaxes: ['percent'],
      require_documentation: false,
      mappings: [
        {
          source_token: '%%CACHE%%',
          universal_macro: '{CACHEBUSTER}',
          source_dialect: 'percent-vendor',
        },
      ],
    });
    assert.equal(result.publishable, true);
    assert.equal(result.canonical_template, '{CACHEBUSTER}');
  });

  it('blocks delivery-active canonical tokens inside unselected outer expressions', () => {
    const result = compileUniversalMacroTemplate({
      template: 'https://pixel.example/i?js=${DEVICE_ID}&mustache={{DEVICE_ID}}',
      source_dialect: 'percent-vendor',
      source_syntaxes: ['percent'],
      mappings: [],
    });

    assert.equal(result.publishable, false);
    assert.deepEqual(
      result.occurrences.map(occurrence => [occurrence.source_token, occurrence.syntax]),
      [
        ['${DEVICE_ID}', 'embedded'],
        ['{{DEVICE_ID}}', 'embedded'],
      ]
    );
  });

  it('does not classify ordinary uppercase host-language blocks as malformed canonical macros', () => {
    const result = compileUniversalMacroTemplate({
      template: 'const x = {DEVICE_ID: value}; .x{COLOR:red}',
      source_dialect: 'double-brace-vendor',
      source_syntaxes: ['double_brace'],
      mappings: [],
    });

    assert.equal(result.publishable, true);
    assert.equal(result.diagnostics.length, 0);
  });

  it('rejects exact mappings that span multiple dialect tokens', () => {
    const result = compileUniversalMacroTemplate({
      template: '{{KNOWN}}{{UNKNOWN}}',
      source_dialect: 'example-vendor',
      source_syntaxes: ['double_brace'],
      mappings: [
        {
          source_token: '{{KNOWN}}{{UNKNOWN}}',
          universal_macro: '{DEVICE_ID}',
          source_dialect: 'example-vendor',
          documentation: DOCUMENTATION,
        },
      ],
    });

    assert.equal(result.publishable, false);
    assert.equal(result.diagnostics[0].code, 'mapping_syntax_not_declared');
  });

  it('uses collision-safe requirement identities and preserves absent versus empty values', () => {
    const input = {
      template: '{{DEVICE}}',
      source_dialect: 'example-vendor',
      source_syntaxes: ['double_brace'],
      mappings: [
        {
          source_token: '{{DEVICE}}',
          universal_macro: '{DEVICE_ID}',
          source_dialect: 'example-vendor',
          documentation: DOCUMENTATION,
          requirements: [{ kind: 'a\u0000b', description: 'Exact tuple required.' }],
        },
      ],
    };

    const collision = compileUniversalMacroTemplate({
      ...input,
      satisfied_requirements: [{ kind: 'a', value: 'b\u0000' }],
    });
    const emptyValue = compileUniversalMacroTemplate({
      ...input,
      satisfied_requirements: [{ kind: 'a\u0000b', value: '' }],
    });

    assert.equal(collision.publishable, false);
    assert.equal(emptyValue.publishable, false);
  });
});
