/**
 * Tests for OAuth diagnostics utilities.
 *
 * Covers parseWWWAuthenticate, decodeAccessTokenClaims, validateTokenAudience,
 * and the MCP SDK error-type re-exports.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  parseWWWAuthenticate,
  decodeAccessTokenClaims,
  validateTokenAudience,
  InvalidTokenError,
  InsufficientScopeError,
} = require('../../dist/lib/auth/oauth');

// Minimal unsigned JWT constructor for test fixtures.
function makeJWT(header, claims, signature = 'sig') {
  const b64 = obj =>
    Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64(header)}.${b64(claims)}.${signature}`;
}

describe('parseWWWAuthenticate', () => {
  test('returns null for missing or empty input', () => {
    assert.strictEqual(parseWWWAuthenticate(null), null);
    assert.strictEqual(parseWWWAuthenticate(undefined), null);
    assert.strictEqual(parseWWWAuthenticate(''), null);
    assert.strictEqual(parseWWWAuthenticate('   '), null);
  });

  test('parses a bare scheme', () => {
    const c = parseWWWAuthenticate('Bearer');
    assert.strictEqual(c.scheme, 'bearer');
    assert.deepStrictEqual(c.params, {});
  });

  test('parses typical MCP Bearer challenge with resource_metadata', () => {
    const header =
      'Bearer realm="api", error="invalid_token", error_description="The access token expired", resource_metadata="https://api.example.com/.well-known/oauth-protected-resource"';
    const c = parseWWWAuthenticate(header);
    assert.strictEqual(c.scheme, 'bearer');
    assert.strictEqual(c.realm, 'api');
    assert.strictEqual(c.error, 'invalid_token');
    assert.strictEqual(c.error_description, 'The access token expired');
    assert.strictEqual(c.resource_metadata, 'https://api.example.com/.well-known/oauth-protected-resource');
  });

  test('lowercases scheme and param keys but preserves value casing', () => {
    const c = parseWWWAuthenticate('BEARER Realm="Protected Area"');
    assert.strictEqual(c.scheme, 'bearer');
    assert.strictEqual(c.realm, 'Protected Area');
    assert.ok('realm' in c.params);
  });

  test('parses unquoted token values', () => {
    const c = parseWWWAuthenticate('Bearer error=invalid_token, scope=read');
    assert.strictEqual(c.error, 'invalid_token');
    assert.strictEqual(c.scope, 'read');
  });

  test('unescapes backslash-escaped quotes in quoted-string values', () => {
    const c = parseWWWAuthenticate('Bearer error_description="quote: \\"oops\\""');
    assert.strictEqual(c.error_description, 'quote: "oops"');
  });

  test('preserves unknown auth-params under params', () => {
    const c = parseWWWAuthenticate('Bearer nonce="abc", algs="ES256 RS256"');
    assert.strictEqual(c.params.nonce, 'abc');
    assert.strictEqual(c.params.algs, 'ES256 RS256');
  });

  test('handles DPoP scheme', () => {
    const c = parseWWWAuthenticate('DPoP algs="ES256 RS256", error="invalid_token"');
    assert.strictEqual(c.scheme, 'dpop');
    assert.strictEqual(c.error, 'invalid_token');
  });

  test('tolerates extra whitespace and missing spaces', () => {
    const c = parseWWWAuthenticate('Bearer realm="api",error="invalid_token"');
    assert.strictEqual(c.realm, 'api');
    assert.strictEqual(c.error, 'invalid_token');
  });

  test('returns null for header that does not start with a valid scheme token', () => {
    assert.strictEqual(parseWWWAuthenticate('  ,="broken"'), null);
  });
});

describe('decodeAccessTokenClaims', () => {
  test('returns null for missing input', () => {
    assert.strictEqual(decodeAccessTokenClaims(null), null);
    assert.strictEqual(decodeAccessTokenClaims(undefined), null);
    assert.strictEqual(decodeAccessTokenClaims(''), null);
  });

  test('returns null for opaque (non-JWT) tokens', () => {
    assert.strictEqual(decodeAccessTokenClaims('not-a-jwt'), null);
    assert.strictEqual(decodeAccessTokenClaims('only.two'), null);
    assert.strictEqual(decodeAccessTokenClaims('a.b.c.d'), null);
  });

  test('returns null when segments are not valid JSON', () => {
    // Valid base64url but garbage content
    const bad = 'bm90LWpzb24.bm90LWpzb24.sig';
    assert.strictEqual(decodeAccessTokenClaims(bad), null);
  });

  test('decodes header, claims, and signature of a well-formed JWT', () => {
    const jwt = makeJWT(
      { alg: 'RS256', typ: 'JWT', kid: 'abc' },
      { iss: 'https://as.example.com', sub: 'user-1', aud: 'https://api.example.com', exp: 9999999999 }
    );
    const decoded = decodeAccessTokenClaims(jwt);
    assert.ok(decoded);
    assert.strictEqual(decoded.header.alg, 'RS256');
    assert.strictEqual(decoded.header.kid, 'abc');
    assert.strictEqual(decoded.claims.iss, 'https://as.example.com');
    assert.strictEqual(decoded.claims.sub, 'user-1');
    assert.strictEqual(decoded.claims.aud, 'https://api.example.com');
    assert.strictEqual(decoded.claims.exp, 9999999999);
    assert.strictEqual(decoded.signature, 'sig');
  });

  test('handles JWT with array aud claim', () => {
    const jwt = makeJWT({ alg: 'HS256' }, { aud: ['a', 'b'] });
    const decoded = decodeAccessTokenClaims(jwt);
    assert.deepStrictEqual(decoded.claims.aud, ['a', 'b']);
  });

  test('does NOT verify signature — even tampered tokens decode successfully', () => {
    const jwt = makeJWT({ alg: 'HS256' }, { sub: 'attacker' }, 'obviously-wrong');
    const decoded = decodeAccessTokenClaims(jwt);
    assert.ok(decoded);
    assert.strictEqual(decoded.claims.sub, 'attacker');
  });
});

describe('validateTokenAudience', () => {
  const expected = 'https://api.example.com/mcp';

  test('returns ok when aud is a string matching expected', () => {
    const jwt = makeJWT({ alg: 'HS256' }, { aud: 'https://api.example.com/mcp' });
    const res = validateTokenAudience(jwt, expected);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.actualAudience, 'https://api.example.com/mcp');
  });

  test('returns ok when aud is an array containing expected', () => {
    const jwt = makeJWT({ alg: 'HS256' }, { aud: ['other', 'https://api.example.com/mcp'] });
    const res = validateTokenAudience(jwt, expected);
    assert.strictEqual(res.ok, true);
  });

  test('normalizes URL differences (default port, trailing slash, host casing)', () => {
    const jwt = makeJWT({ alg: 'HS256' }, { aud: 'https://API.example.com:443/mcp/' });
    const res = validateTokenAudience(jwt, expected);
    assert.strictEqual(res.ok, true);
  });

  test('returns not-ok with reason when aud is missing', () => {
    const jwt = makeJWT({ alg: 'HS256' }, { sub: 'user-1' });
    const res = validateTokenAudience(jwt, expected);
    assert.strictEqual(res.ok, false);
    assert.match(res.reason, /no `aud` claim/);
  });

  test('returns not-ok with actual audience when mismatched', () => {
    const jwt = makeJWT({ alg: 'HS256' }, { aud: 'https://other.example.com' });
    const res = validateTokenAudience(jwt, expected);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.actualAudience, 'https://other.example.com');
    assert.match(res.reason, /does not match expected/);
  });

  test('returns not-ok for opaque tokens (cannot inspect)', () => {
    const res = validateTokenAudience('opaque-reference-token', expected);
    assert.strictEqual(res.ok, false);
    assert.match(res.reason, /opaque|not a valid JWT/);
  });
});

describe('MCP SDK error re-exports', () => {
  test('InvalidTokenError is exported and instantiable', () => {
    const err = new InvalidTokenError('expired');
    assert.ok(err instanceof Error);
    assert.strictEqual(err.errorCode, 'invalid_token');
  });

  test('InsufficientScopeError is exported and instantiable', () => {
    const err = new InsufficientScopeError('need read scope');
    assert.ok(err instanceof Error);
    assert.strictEqual(err.errorCode, 'insufficient_scope');
  });

  test('errors are discriminable by instanceof instead of string matching', () => {
    const err = new InvalidTokenError('expired');
    assert.ok(err instanceof InvalidTokenError);
    assert.ok(!(err instanceof InsufficientScopeError));
  });
});
