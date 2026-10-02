const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AuthenticationRequiredError, is401Error } = require('../../dist/lib/errors');
const { wrapFetchWithSignedRequestRejection } = require('../../dist/lib/protocols/signedRequestRejection');

async function rejection(response, headers = { Signature: 'sig1=:value:' }, signal) {
  const wrapped = wrapFetchWithSignedRequestRejection(async () => response);
  try {
    await wrapped('https://user:password@seller.example/rpc?token=secret', { headers, signal });
    assert.fail('expected signed-request rejection');
  } catch (error) {
    assert.ok(error instanceof AuthenticationRequiredError);
    assert.equal(is401Error(error), true);
    return error;
  }
}

test('signed rejection redacts nested secrets, reflected headers, URLs, and bearer text', async () => {
  const reason = 'JWKS URI failed SSRF check';
  const error = await rejection(
    new Response(
      JSON.stringify({
        error: `${reason}: https://name:password@keys.example/jwks?token=hidden Bearer opaque-secret raw-custom-secret`,
        nested: { access_token: 'hidden-token', private_key: 'hidden-key' },
      }),
      { status: 401 }
    ),
    { Signature: 'sig1=:value:', 'X-Custom-Auth': 'raw-custom-secret' }
  );
  assert.match(error.responseBody, /JWKS URI failed SSRF check/);
  assert.doesNotMatch(error.responseBody, /hidden|opaque-secret|raw-custom-secret|password/);
  assert.doesNotMatch(error.message, /password|token=secret/);
  assert.equal(Object.getOwnPropertyDescriptor(error, 'responseBody').enumerable, false);
  assert.doesNotMatch(JSON.stringify(error), /JWKS URI|opaque-secret/);
});

test('JSON escaping cannot hide a reflected custom credential from redaction', async () => {
  const secret = 'opaque"custom\\secret';
  const error = await rejection(
    new Response(JSON.stringify({ [secret]: 'rejected', error: `Rejected ${secret}` }), { status: 401 }),
    {
      Signature: 'sig1=:value:',
      'X-Custom-Auth': secret,
    }
  );
  assert.doesNotMatch(error.responseBody, /opaque|custom|secret/);
});

test('reflected-key redaction cannot disguise sensitive fields or corrupt JSON delimiters', async () => {
  for (const secret of ['token', ':']) {
    const error = await rejection(
      new Response(JSON.stringify({ access_token: 'seller-private-value', [secret]: 'rejected' }), { status: 401 }),
      {
        Signature: 'sig1=:value:',
        'X-Custom-Auth': secret,
      }
    );
    assert.doesNotMatch(error.responseBody, /seller-private-value/);
    assert.doesNotThrow(() => JSON.parse(error.responseBody));
  }
});

test('generic bearer redaction cannot leave a suffix of a custom credential', async () => {
  const secret = 'opaque!secret';
  const error = await rejection(new Response(JSON.stringify({ error: `Rejected Bearer ${secret}` }), { status: 401 }), {
    Signature: 'sig1=:value:',
    'X-Custom-Auth': secret,
  });
  assert.doesNotMatch(error.responseBody, /opaque|!secret/);
});

test('scalar credential reflections are redacted even after JSON conversion', async () => {
  for (const secret of ['123456789', '1234567890123456789', 'true', 'false', 'null']) {
    const error = await rejection(new Response(`{"received":${secret}}`, { status: 401 }), {
      Signature: 'sig1=:value:',
      'X-Custom-Auth': secret,
    });
    assert.equal(JSON.parse(error.responseBody).received, '[redacted]');
  }
});

test('overlapping header values cannot expose credential fragments in bodies or capture headers', async () => {
  const { withRawResponseCapture } = require('../../dist/lib/protocols/rawResponseCapture');
  for (const [publicValue, credential, reflected] of [
    ['3.2.1', 'opaque3.2.1secret', 'opaque3.2.1secret'],
    ['abc', 'bcdef', 'abcdef'],
    ['aaa', 'unused', 'aaaa'],
  ]) {
    await assert.rejects(
      withRawResponseCapture(async () => {
        throw await rejection(
          new Response(JSON.stringify({ error: `Rejected ${reflected}` }), {
            status: 401,
            headers: { 'X-Request-Id': reflected },
          }),
          { Signature: 'sig1=:value:', 'X-Custom-Key': publicValue, 'X-Custom-Auth': credential }
        );
      }),
      error => {
        assert.equal(JSON.parse(error.responseBody).error, 'Rejected [redacted]');
        assert.equal(error.captures[0].headers['x-request-id'], '[redacted]');
        return true;
      }
    );
  }
});

test('public protocol headers preserve version text and numeric diagnostic fields', async () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, error: 'requires AdCP 3.1.0 on 2025-06-18' });
  const error = await rejection(new Response(body, { status: 401 }), {
    Signature: 'sig1=:value:',
    'A2A-Version': '1.0',
    'MCP-Protocol-Version': '2025-06-18',
    'AdCP-Version': '3.1.0',
  });
  assert.equal(error.responseBody, body);
});

test('signed errors retain the configured agent identity when the RPC endpoint differs', async () => {
  const wrapped = wrapFetchWithSignedRequestRejection(
    async () => new Response('seller reason', { status: 401 }),
    'https://seller.example/agent'
  );
  await assert.rejects(wrapped('https://seller.example/rpc', { headers: { Signature: 'sig1=:value:' } }), error => {
    assert.equal(error.agentUrl, 'https://seller.example/agent');
    return true;
  });
});

test('raw response correlation headers cannot reflect an OAuth bearer credential', async () => {
  const { withRawResponseCapture } = require('../../dist/lib/protocols/rawResponseCapture');
  await assert.rejects(
    withRawResponseCapture(async () => {
      throw await rejection(new Response('reason', { status: 401, headers: { 'X-Request-Id': 'oauth-token' } }), {
        Signature: 'sig1=:value:',
        Authorization: 'Bearer oauth-token',
      });
    }),
    error => {
      assert.equal(error.captures[0].headers['x-request-id'], '[redacted]');
      assert.doesNotMatch(JSON.stringify(error.captures), /oauth-token/);
      return true;
    }
  );
});

test('raw capture shares the bounded read and redacts reflected credentials', async () => {
  const { withRawResponseCapture } = require('../../dist/lib/protocols/rawResponseCapture');
  const secret = 'custom"auth\\secret';
  const read = async response => {
    try {
      await withRawResponseCapture(async () => {
        throw await rejection(response, { Signature: 'sig1=:value:', 'X-Custom-Auth': secret });
      });
      assert.fail('expected rejection');
    } catch (error) {
      assert.equal(error.captures.length, 1);
      assert.equal(error.captures[0].status, 401);
      return error;
    }
  };
  const reflected = await read(
    new Response(JSON.stringify({ error: `Rejected ${secret}`, access_token: 'private-token' }), {
      status: 401,
      headers: { 'WWW-Authenticate': `Signature error_description="${secret}"`, 'X-Debug': secret },
    })
  );
  assert.doesNotMatch(reflected.captures[0].body, /custom|secret|private-token/);
  assert.doesNotMatch(JSON.stringify(reflected.captures), /custom|private-token|password|token=secret/);
  const oversized = await read(new Response('x'.repeat(20000), { status: 401 }));
  assert.equal(oversized.captures[0].bodyTruncated, true);
  assert.ok(oversized.captures[0].body.length < 2048);
  const started = Date.now();
  const stalled = await read(new Response(new ReadableStream(), { status: 401 }));
  assert.equal(stalled.captures[0].bodyTruncated, true);
  assert.equal(stalled.responseBody, undefined);
  assert.ok(Date.now() - started < 3000);
});

test('only allowlisted Signature error codes enter the error envelope', async () => {
  const error = await rejection(
    new Response('diagnostic', {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Signature error="attacker-text", error_description="secret", realm="secret"',
      },
    })
  );
  assert.equal(error.code, 'AUTHENTICATION_REQUIRED');
  assert.deepEqual(error.challenge, { scheme: 'signature' });
  assert.doesNotMatch(JSON.stringify(error), /attacker-text|secret/);
});

test('response capture bounds large bodies and excerpts after redaction', async () => {
  const excerpt = await rejection(
    new Response(JSON.stringify({ error: 'reason '.repeat(1000), token: 'secret' }), { status: 401 })
  );
  assert.equal(excerpt.responseBody.length, 2048);
  const oversized = await rejection(new Response('x'.repeat(20000), { status: 401 }));
  assert.match(oversized.responseBody, /exceeds diagnostic capture limit/);
});

test('a stalled response body cannot delay the 401 indefinitely', async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
    { status: 401 }
  );
  const started = Date.now();
  const error = await rejection(response);
  assert.equal(error.responseBody, undefined);
  assert.equal(cancelled, true);
  assert.ok(Date.now() - started < 3000);
});

test('aborting capture drops incomplete text and preserves the signed 401', async () => {
  const controller = new AbortController();
  const response = new Response(
    new ReadableStream({
      start(stream) {
        stream.enqueue(new TextEncoder().encode('{"access_token":"incomplete-secret'));
      },
    }),
    { status: 401 }
  );
  const pending = rejection(response, undefined, controller.signal);
  controller.abort();
  const error = await pending;
  assert.equal(error.responseBody, undefined);
});

test('unsigned 401 and signed non-401 responses pass through untouched', async () => {
  for (const [status, headers] of [
    [401, {}],
    [403, { Signature: 'sig1=:value:' }],
    [200, { Signature: 'sig1=:value:' }],
  ]) {
    const response = new Response('original body', { status });
    const wrapped = wrapFetchWithSignedRequestRejection(async () => response);
    assert.equal(await wrapped('https://seller.example/rpc', { headers }), response);
    assert.equal(await response.text(), 'original body');
  }
});

test('explicit non-Signature challenges preserve gateway and OAuth recovery', async () => {
  for (const challenge of ['Bearer error="invalid_token"', 'Basic realm="gateway"', 'vendor-scheme']) {
    const response = new Response('original body', { status: 401, headers: { 'WWW-Authenticate': challenge } });
    const wrapped = wrapFetchWithSignedRequestRejection(async () => response);
    assert.equal(await wrapped('https://seller.example/rpc', { headers: { Signature: 'sig1=:value:' } }), response);
    assert.equal(await response.text(), 'original body');
  }
});

test('raw response capture retains signed 401 evidence and deduplicates successful responses', async () => {
  const { withRawResponseCapture, wrapFetchWithCapture } = require('../../dist/lib/protocols/rawResponseCapture');
  await assert.rejects(
    withRawResponseCapture(() =>
      rejection(new Response('seller reason', { status: 401 })).then(error => {
        throw error;
      })
    ),
    error => {
      assert.equal(error.captures.length, 1);
      assert.equal(error.captures[0].status, 401);
      assert.equal(error.captures[0].body, 'seller reason');
      return true;
    }
  );
  const wrapped = wrapFetchWithCapture(wrapFetchWithSignedRequestRejection(async () => new Response('ok')));
  const { captures } = await withRawResponseCapture(() =>
    wrapped('https://seller.example/rpc', { headers: { Signature: 'sig1=:value:' } })
  );
  assert.equal(captures.length, 1);
});

test('Signature challenges provide the existing per-code repair guidance', () => {
  const error = new AuthenticationRequiredError('https://seller.example', undefined, undefined, {
    scheme: 'signature',
    error: 'request_signature_jwks_untrusted',
  });
  assert.match(error.message, /request_signature_jwks_untrusted/);
  assert.match(error.message, /trusted HTTPS JWKS/);
  assert.doesNotMatch(error.message, /not natively supported|auth_token/);
});
