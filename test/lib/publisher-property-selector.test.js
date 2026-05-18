/**
 * `publisher-property-selector.json` parser, validator, and fanout helpers
 * (adcp-client#1737 / adcontextprotocol/adcp#4504).
 *
 * Pins:
 *   - XOR between `publisher_domain` and `publisher_domains` per-selector.
 *   - `by_id` cannot use the compact `publisher_domains[]` form
 *     (property IDs are publisher-scoped — fanout has no defined semantics).
 *   - Fanout produces N singular selectors per compact entry, lowercased
 *     and de-duped, preserving input order.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const {
  parsePublisherPropertySelector,
  expandPublisherPropertySelector,
  expandPublisherPropertySelectors,
  isCompactPublisherPropertySelector,
  publisherDomainsCoveredBySelectors,
  isDomainStringValid,
  PublisherPropertySelectorParseError,
  MAX_PUBLISHER_DOMAINS_PER_SELECTOR,
} = require('../../dist/lib/discovery/publisher-property-selector.js');

function expectParseError(input, code) {
  try {
    parsePublisherPropertySelector(input);
    assert.fail(`expected parse to throw with code ${code}, but it returned`);
  } catch (err) {
    assert.ok(
      err instanceof PublisherPropertySelectorParseError,
      `expected PublisherPropertySelectorParseError, got ${err?.constructor?.name}`
    );
    assert.strictEqual(err.code, code);
  }
}

describe('parsePublisherPropertySelector — happy paths', () => {
  test('accepts singular form for selection_type=all', () => {
    const sel = parsePublisherPropertySelector({ publisher_domain: 'cnn.com', selection_type: 'all' });
    assert.strictEqual(sel.selection_type, 'all');
    assert.strictEqual(sel.publisher_domain, 'cnn.com');
  });

  test('accepts singular form for selection_type=by_id with property_ids', () => {
    const sel = parsePublisherPropertySelector({
      publisher_domain: 'cnn.com',
      selection_type: 'by_id',
      property_ids: ['cnn_ctv_app'],
    });
    assert.deepStrictEqual(sel.property_ids, ['cnn_ctv_app']);
  });

  test('accepts singular form for selection_type=by_tag with property_tags', () => {
    const sel = parsePublisherPropertySelector({
      publisher_domain: 'cnn.com',
      selection_type: 'by_tag',
      property_tags: ['ctv'],
    });
    assert.deepStrictEqual(sel.property_tags, ['ctv']);
  });

  test('accepts compact form for selection_type=all', () => {
    const sel = parsePublisherPropertySelector({
      publisher_domains: ['a.example', 'b.example', 'c.example'],
      selection_type: 'all',
    });
    assert.deepStrictEqual(sel.publisher_domains, ['a.example', 'b.example', 'c.example']);
  });

  test('accepts compact form for selection_type=by_tag', () => {
    const sel = parsePublisherPropertySelector({
      publisher_domains: ['a.example', 'b.example'],
      selection_type: 'by_tag',
      property_tags: ['premium'],
    });
    assert.deepStrictEqual(sel.publisher_domains, ['a.example', 'b.example']);
    assert.deepStrictEqual(sel.property_tags, ['premium']);
  });
});

describe('parsePublisherPropertySelector — XOR validation', () => {
  test('rejects when both publisher_domain and publisher_domains are present', () => {
    expectParseError(
      {
        publisher_domain: 'cnn.com',
        publisher_domains: ['cnn.com'],
        selection_type: 'all',
      },
      'both_publisher_domain_and_domains'
    );
  });

  test('rejects when neither publisher_domain nor publisher_domains is present', () => {
    expectParseError({ selection_type: 'all' }, 'missing_publisher_domain');
  });

  test('rejects when publisher_domain is the wrong type', () => {
    expectParseError({ publisher_domain: 123, selection_type: 'all' }, 'missing_publisher_domain');
  });
});

describe('parsePublisherPropertySelector — by_id excluded from compact form', () => {
  test('rejects publisher_domains with selection_type=by_id', () => {
    expectParseError(
      {
        publisher_domains: ['a.example', 'b.example'],
        selection_type: 'by_id',
        property_ids: ['x'],
      },
      'compact_form_not_allowed_for_by_id'
    );
  });
});

describe('parsePublisherPropertySelector — witness-not-translator (strict mode)', () => {
  test('rejects mixed-case domain in publisher_domain (singular)', () => {
    expectParseError({ publisher_domain: 'Cnn.com', selection_type: 'all' }, 'publisher_domain_not_lowercase');
  });

  test('rejects mixed-case entry inside publisher_domains[]', () => {
    expectParseError(
      { publisher_domains: ['a.example', 'B.Example'], selection_type: 'all' },
      'publisher_domain_not_lowercase'
    );
  });

  test('rejects duplicate entries inside publisher_domains[]', () => {
    expectParseError(
      { publisher_domains: ['a.example', 'a.example'], selection_type: 'all' },
      'publisher_domains_duplicate_entry'
    );
  });

  test('rejects domain containing control chars', () => {
    expectParseError(
      { publisher_domain: 'a.example\nSet-Cookie:foo', selection_type: 'all' },
      'publisher_domain_contains_invalid_chars'
    );
    expectParseError(
      { publisher_domain: 'a.\x00null.example', selection_type: 'all' },
      'publisher_domain_contains_invalid_chars'
    );
  });

  test('rejects publisher_domains[] entries with whitespace or control chars', () => {
    expectParseError(
      { publisher_domains: ['a.example', 'b.example\tfoo'], selection_type: 'all' },
      'publisher_domain_contains_invalid_chars'
    );
  });

  test('rejects publisher_domains[] longer than MAX cap', () => {
    const tooMany = Array.from({ length: MAX_PUBLISHER_DOMAINS_PER_SELECTOR + 1 }, (_, i) => `site${i}.example`);
    expectParseError({ publisher_domains: tooMany, selection_type: 'all' }, 'publisher_domains_too_many');
  });
});

describe('isCompactPublisherPropertySelector — fail-closed on malformed shapes', () => {
  test('false when publisher_domains is a non-array (string)', () => {
    assert.strictEqual(isCompactPublisherPropertySelector({ publisher_domains: 'evil', selection_type: 'all' }), false);
  });

  test('false when publisher_domains is null', () => {
    assert.strictEqual(isCompactPublisherPropertySelector({ publisher_domains: null, selection_type: 'all' }), false);
  });

  test('false when publisher_domains contains a non-string entry', () => {
    assert.strictEqual(
      isCompactPublisherPropertySelector({ publisher_domains: ['ok.example', 42], selection_type: 'all' }),
      false
    );
  });

  test('false on empty publisher_domains[]', () => {
    assert.strictEqual(isCompactPublisherPropertySelector({ publisher_domains: [], selection_type: 'all' }), false);
  });
});

describe('expandPublisherPropertySelector — fail-closed on counterparty malformed input', () => {
  test('returns [] when publisher_domains is a non-array (no fan to per-char)', () => {
    const sel = { publisher_domains: 'evil-string', selection_type: 'all' };
    const out = expandPublisherPropertySelector(sel);
    assert.deepStrictEqual(out, []);
  });

  test('returns [] when singular publisher_domain is missing or wrong type', () => {
    assert.deepStrictEqual(expandPublisherPropertySelector({ selection_type: 'all' }), []);
    assert.deepStrictEqual(expandPublisherPropertySelector({ publisher_domain: 42, selection_type: 'all' }), []);
  });

  test('drops control-char entries from compact list', () => {
    const sel = {
      publisher_domains: ['ok.example', 'evil.example\nSet-Cookie:x', 'fine.example'],
      selection_type: 'all',
    };
    const out = expandPublisherPropertySelector(sel);
    assert.deepStrictEqual(
      out.map(e => e.publisher_domain),
      ['ok.example', 'fine.example']
    );
  });
});

describe('isDomainStringValid', () => {
  test('accepts plain lowercased domains', () => {
    assert.strictEqual(isDomainStringValid('cnn.com'), true);
    assert.strictEqual(isDomainStringValid('news.example.com'), true);
  });

  test('rejects control chars, whitespace, NULL', () => {
    assert.strictEqual(isDomainStringValid('a.\x00b.example'), false);
    assert.strictEqual(isDomainStringValid('a.b\n.example'), false);
    assert.strictEqual(isDomainStringValid('a.b .example'), false);
  });

  test('rejects strings over 253 chars (RFC 1035 cap)', () => {
    assert.strictEqual(isDomainStringValid('a'.repeat(254)), false);
    assert.strictEqual(isDomainStringValid('a'.repeat(253)), true);
  });

  test('rejects non-strings', () => {
    assert.strictEqual(isDomainStringValid(undefined), false);
    assert.strictEqual(isDomainStringValid(null), false);
    assert.strictEqual(isDomainStringValid(42), false);
  });
});

describe('parsePublisherPropertySelector — selector field validation', () => {
  test('rejects selection_type=by_id without property_ids', () => {
    expectParseError({ publisher_domain: 'cnn.com', selection_type: 'by_id' }, 'missing_property_ids');
  });

  test('rejects selection_type=by_tag without property_tags', () => {
    expectParseError({ publisher_domain: 'cnn.com', selection_type: 'by_tag' }, 'missing_property_tags');
  });

  test('rejects empty publisher_domains', () => {
    expectParseError({ publisher_domains: [], selection_type: 'all' }, 'publisher_domains_empty');
  });

  test('rejects publisher_domains with non-string entries', () => {
    expectParseError(
      { publisher_domains: ['ok.example', 42], selection_type: 'all' },
      'publisher_domains_not_string_array'
    );
  });

  test('rejects unknown selection_type', () => {
    expectParseError({ publisher_domain: 'cnn.com', selection_type: 'weird' }, 'unknown_selection_type');
  });

  test('rejects non-object input', () => {
    expectParseError('not a selector', 'not_an_object');
    expectParseError(null, 'not_an_object');
    expectParseError([], 'not_an_object');
  });
});

describe('isCompactPublisherPropertySelector', () => {
  test('true for compact form', () => {
    assert.strictEqual(
      isCompactPublisherPropertySelector({ publisher_domains: ['a.example'], selection_type: 'all' }),
      true
    );
  });
  test('false for singular form', () => {
    assert.strictEqual(
      isCompactPublisherPropertySelector({ publisher_domain: 'a.example', selection_type: 'all' }),
      false
    );
  });
});

describe('expandPublisherPropertySelector', () => {
  test('singular passes through as a one-element array', () => {
    const sel = { publisher_domain: 'cnn.com', selection_type: 'all' };
    const out = expandPublisherPropertySelector(sel);
    assert.strictEqual(out.length, 1);
    assert.deepStrictEqual(out[0], sel);
  });

  test('compact form (all) expands to one singular per domain', () => {
    const sel = { publisher_domains: ['a.example', 'b.example', 'c.example'], selection_type: 'all' };
    const out = expandPublisherPropertySelector(sel);
    assert.deepStrictEqual(out, [
      { selection_type: 'all', publisher_domain: 'a.example' },
      { selection_type: 'all', publisher_domain: 'b.example' },
      { selection_type: 'all', publisher_domain: 'c.example' },
    ]);
  });

  test('compact form (by_tag) carries property_tags into each fanned-out entry', () => {
    const sel = {
      publisher_domains: ['a.example', 'b.example'],
      selection_type: 'by_tag',
      property_tags: ['premium', 'ctv'],
    };
    const out = expandPublisherPropertySelector(sel);
    assert.strictEqual(out.length, 2);
    for (const entry of out) {
      assert.strictEqual(entry.selection_type, 'by_tag');
      assert.deepStrictEqual(entry.property_tags, ['premium', 'ctv']);
    }
    assert.deepStrictEqual(
      out.map(e => e.publisher_domain),
      ['a.example', 'b.example']
    );
  });

  test('still lowercases + de-dupes inside expand (defensive backstop)', () => {
    // parsePublisherPropertySelector rejects mixed-case + duplicates per
    // the spec's lowercase pattern, but expandPublisherPropertySelector
    // is the indexing helper called directly on counterparty input by
    // resolveAgentProperties (without a parse first), so the fanout
    // path keeps a defensive backstop. Validates both: mixed-case
    // gets lowercased, in-list duplicates collapse.
    const sel = { publisher_domains: ['a.example', 'A.EXAMPLE', 'b.example'], selection_type: 'all' };
    const out = expandPublisherPropertySelector(sel);
    assert.deepStrictEqual(
      out.map(e => e.publisher_domain),
      ['a.example', 'b.example']
    );
  });
});

describe('expandPublisherPropertySelectors (array)', () => {
  test('preserves input order, then per-selector domain order', () => {
    const selectors = [
      { publisher_domain: 'first.example', selection_type: 'all' },
      { publisher_domains: ['c.example', 'b.example'], selection_type: 'all' },
      { publisher_domain: 'last.example', selection_type: 'all' },
    ];
    const out = expandPublisherPropertySelectors(selectors);
    assert.deepStrictEqual(
      out.map(e => e.publisher_domain),
      ['first.example', 'c.example', 'b.example', 'last.example']
    );
  });
});

describe('publisherDomainsCoveredBySelectors', () => {
  test('collects domains from both singular and compact entries (lowercased)', () => {
    const selectors = [
      { publisher_domain: 'Cnn.com', selection_type: 'all' },
      { publisher_domains: ['ESPN.com', 'mlb.com'], selection_type: 'by_tag', property_tags: ['ctv'] },
    ];
    const set = publisherDomainsCoveredBySelectors(selectors);
    assert.deepStrictEqual([...set].sort(), ['cnn.com', 'espn.com', 'mlb.com']);
  });
});
