const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  requestContextFromExpress,
  requestContextFromFetch,
  requestContextFromLambda,
} = require('../dist/lib/signing/index.js');

// Mock Express request — only the fields the helper reads.
function expressReq({ method = 'POST', protocol = 'https', host, originalUrl = '/adcp/get_products' } = {}) {
  return {
    method,
    protocol,
    originalUrl,
    get(name) {
      if (name === 'host') return host;
      throw new Error(`unexpected req.get(${name})`);
    },
  };
}

describe('requestContextFromExpress', () => {
  test('reconstructs an absolute URL from protocol + host + originalUrl', () => {
    const ctx = requestContextFromExpress(expressReq({ host: 'seller.example.com' }));
    assert.deepStrictEqual(ctx, {
      method: 'POST',
      url: 'https://seller.example.com/adcp/get_products',
    });
  });

  test('lowercases the host for canonical equivalence', () => {
    const ctx = requestContextFromExpress(expressReq({ host: 'Seller.Example.COM' }));
    assert.strictEqual(ctx.url, 'https://seller.example.com/adcp/get_products');
  });

  test('throws when Host header is missing', () => {
    assert.throws(() => requestContextFromExpress(expressReq({ host: undefined })), /Host header is missing/);
  });

  test('throws when host fails hostAllowlist check', () => {
    assert.throws(
      () =>
        requestContextFromExpress(expressReq({ host: 'attacker.example.com' }), {
          hostAllowlist: ['seller.example.com'],
        }),
      /not in hostAllowlist/
    );
  });

  test('accepts host that matches hostAllowlist case-insensitively', () => {
    const ctx = requestContextFromExpress(expressReq({ host: 'seller.example.com' }), {
      hostAllowlist: ['Seller.Example.COM'],
    });
    assert.strictEqual(ctx.url, 'https://seller.example.com/adcp/get_products');
  });

  test('throws when protocol is http (forceHttps default)', () => {
    assert.throws(
      () => requestContextFromExpress(expressReq({ protocol: 'http', host: 'seller.example.com' })),
      /protocol is "http"/
    );
  });

  test('forceHttps: false allows http for local dev', () => {
    const ctx = requestContextFromExpress(expressReq({ protocol: 'http', host: '127.0.0.1:3000' }), {
      forceHttps: false,
    });
    assert.strictEqual(ctx.url, 'http://127.0.0.1:3000/adcp/get_products');
  });

  test('preserves query string in originalUrl', () => {
    const ctx = requestContextFromExpress(
      expressReq({ host: 'seller.example.com', originalUrl: '/adcp/get_products?filter=video&limit=10' })
    );
    assert.strictEqual(ctx.url, 'https://seller.example.com/adcp/get_products?filter=video&limit=10');
  });
});

describe('requestContextFromFetch', () => {
  test('passes through method + absolute url', () => {
    const ctx = requestContextFromFetch({
      method: 'POST',
      url: 'https://seller.example.com/adcp/get_products',
    });
    assert.deepStrictEqual(ctx, {
      method: 'POST',
      url: 'https://seller.example.com/adcp/get_products',
    });
  });

  test('accepts a real WHATWG Request', () => {
    const req = new Request('https://seller.example.com/adcp/get_products', { method: 'POST' });
    const ctx = requestContextFromFetch(req);
    assert.strictEqual(ctx.url, 'https://seller.example.com/adcp/get_products');
    assert.strictEqual(ctx.method, 'POST');
  });
});

describe('requestContextFromLambda', () => {
  test('v2 event: reads requestContext.http.method + domainName + rawPath + rawQueryString', () => {
    const ctx = requestContextFromLambda({
      requestContext: {
        domainName: 'api.example.com',
        http: { method: 'POST' },
      },
      rawPath: '/adcp/get_products',
      rawQueryString: 'filter=video&limit=10',
    });
    assert.deepStrictEqual(ctx, {
      method: 'POST',
      url: 'https://api.example.com/adcp/get_products?filter=video&limit=10',
    });
  });

  test('v1 event: falls back to httpMethod + path + queryStringParameters', () => {
    const ctx = requestContextFromLambda({
      requestContext: { domainName: 'api.example.com', httpMethod: 'POST' },
      path: '/adcp/get_products',
      httpMethod: 'POST',
      queryStringParameters: { filter: 'video', limit: '10' },
    });
    assert.strictEqual(ctx.method, 'POST');
    // Order isn't guaranteed by Object.entries on plain objects spec-wise,
    // but Node's V8 iterates string-keyed props in insertion order — both
    // params are present and properly URL-encoded.
    assert.match(ctx.url, /^https:\/\/api\.example\.com\/adcp\/get_products\?/);
    assert.match(ctx.url, /filter=video/);
    assert.match(ctx.url, /limit=10/);
  });

  test('throws when domainName is missing', () => {
    assert.throws(
      () =>
        requestContextFromLambda({
          requestContext: { http: { method: 'POST' } },
          rawPath: '/foo',
        }),
      /domainName is missing/
    );
  });

  test('throws when domainName fails hostAllowlist check', () => {
    assert.throws(
      () =>
        requestContextFromLambda(
          {
            requestContext: { domainName: 'rogue.example.com', http: { method: 'POST' } },
            rawPath: '/foo',
          },
          { hostAllowlist: ['api.example.com'] }
        ),
      /not in hostAllowlist/
    );
  });

  test('always emits https:// (no http override needed; Lambda is not http-addressable)', () => {
    const ctx = requestContextFromLambda({
      requestContext: { domainName: 'api.example.com', http: { method: 'GET' } },
      rawPath: '/',
    });
    assert.ok(ctx.url.startsWith('https://'));
  });

  test('throws when method cannot be determined', () => {
    assert.throws(
      () =>
        requestContextFromLambda({
          requestContext: { domainName: 'api.example.com' },
          rawPath: '/foo',
        }),
      /HTTP method is missing/
    );
  });

  test('URL-encodes special characters in queryStringParameters', () => {
    const ctx = requestContextFromLambda({
      requestContext: { domainName: 'api.example.com', http: { method: 'POST' } },
      rawPath: '/search',
      queryStringParameters: { q: 'hello world & friends' },
    });
    assert.match(ctx.url, /q=hello%20world%20%26%20friends/);
  });
});

describe('hostAllowlist hardening (trailing-dot bypass)', () => {
  test('Express helper: trailing-dot Host matches a non-trailing-dot allowlist entry', () => {
    const ctx = requestContextFromExpress(expressReq({ host: 'seller.example.com.' }), {
      hostAllowlist: ['seller.example.com'],
    });
    assert.strictEqual(ctx.url, 'https://seller.example.com/adcp/get_products');
  });

  test('Express helper: trailing-dot allowlist entry matches a non-trailing-dot Host', () => {
    const ctx = requestContextFromExpress(expressReq({ host: 'seller.example.com' }), {
      hostAllowlist: ['seller.example.com.'],
    });
    assert.strictEqual(ctx.url, 'https://seller.example.com/adcp/get_products');
  });

  test('Lambda helper: same trailing-dot normalization', () => {
    const ctx = requestContextFromLambda(
      {
        requestContext: { domainName: 'api.example.com.', http: { method: 'POST' } },
        rawPath: '/foo',
      },
      { hostAllowlist: ['api.example.com'] }
    );
    assert.ok(ctx.url.startsWith('https://api.example.com/'));
  });
});

describe('userinfo rejection (signature-namespace confusion vector)', () => {
  test('Fetch helper: rejects URL with username', () => {
    assert.throws(
      () => requestContextFromFetch({ method: 'POST', url: 'https://attacker@seller.example.com/path' }),
      /userinfo/
    );
  });

  test('Fetch helper: rejects URL with password', () => {
    assert.throws(
      () => requestContextFromFetch({ method: 'POST', url: 'https://user:pw@seller.example.com/path' }),
      /userinfo/
    );
  });

  test('Fetch helper: rejects non-parseable URL', () => {
    assert.throws(() => requestContextFromFetch({ method: 'POST', url: 'not-a-url' }), /not a parseable URL/);
  });

  test('Express helper: rejects originalUrl with @ in path', () => {
    assert.throws(
      () => requestContextFromExpress(expressReq({ host: 'seller.example.com', originalUrl: '/path/with@injection' })),
      /userinfo/
    );
  });
});
