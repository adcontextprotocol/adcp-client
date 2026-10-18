const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizePropertyIdentifier,
  validatePublisherDomain,
  IdentifierValidationError,
} = require('../../dist/lib/registry');

test('identifier normalization reports repairs without broadening subdomain scope', () => {
  assert.deepEqual(normalizePropertyIdentifier('domain', ' https://WWW.Example.com/path '), {
    ok: true,
    value: 'www.example.com',
    rewrite: { from: ' https://WWW.Example.com/path ', to: 'www.example.com' },
  });
  assert.equal(normalizePropertyIdentifier('domain', '*.Example.com').value, '*.example.com');
  assert.equal(normalizePropertyIdentifier('subdomain', 'www.example.com').value, 'www.example.com');
  assert.equal(normalizePropertyIdentifier('subdomain', '*.example.com').ok, false);
  for (const invalid of [
    'not a domain',
    'example.com/path',
    'bad..example',
    'https://secret@example.com',
    'example.com\\evil',
  ]) {
    const result = normalizePropertyIdentifier('domain', invalid);
    assert.equal(result.ok, false, invalid);
    assert.ok(result.error instanceof IdentifierValidationError);
  }
});

test('app and CTV identifiers retain case, precision, and type-specific syntax', () => {
  for (const [type, value] of [
    ['ios_bundle', 'com.Example.App'],
    ['android_package', 'com.Example.app'],
    ['google_play_id', 'com.example.app'],
    ['apple_tv_bundle', 'com.Example.TV'],
    ['bundle_id', 'com.example.app'],
    ['apple_app_store_id', '12345678901234567890'],
    ['roku_store_id', '12345'],
    ['samsung_app_id', 'G123456789'],
    ['station_id', 'BBC Radio 4'],
  ]) {
    assert.deepEqual(normalizePropertyIdentifier(type, value), { ok: true, value });
  }
  assert.equal(normalizePropertyIdentifier('fire_tv_asin', 'b012345678').value, 'B012345678');
  for (const [type, value] of [
    ['android_package', 'not a package'],
    ['apple_app_store_id', '123x'],
    ['roku_store_id', ''],
    ['fire_tv_asin', 'short'],
  ]) {
    assert.equal(normalizePropertyIdentifier(type, value).ok, false);
  }
  assert.equal(normalizePropertyIdentifier('future_type', 'opaque').error.code, 'unsupported_identifier_type');
});

test('publisher registration validation rejects repairs accepted by identifier normalization', () => {
  assert.deepEqual(validatePublisherDomain('edition.example.com'), { ok: true, value: 'edition.example.com' });
  for (const value of [
    'https://example.com/path',
    '*.example.com',
    'Example.com',
    'example.com.',
    ' example.com',
    'example.com:443',
    '127.0.0.1',
    '127.1',
    '2130706433',
    '0x7f000001',
    '1.2.3',
    '-bad.example',
    'a'.repeat(64) + '.com',
  ]) {
    const result = validatePublisherDomain(value);
    assert.equal(result.ok, false, value);
    assert.equal(result.error.code, 'invalid_publisher_domain');
  }
});
