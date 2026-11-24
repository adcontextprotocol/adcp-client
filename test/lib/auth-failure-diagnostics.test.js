const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { AuthenticationRequiredError } = require('../../dist/lib/errors');
const { wrapFetchWithSignedRequestRejection } = require('../../dist/lib/protocols/signedRequestRejection');
const {
  withTransportDiagnostics,
  wrapFetchWithTransportDiagnostics,
} = require('../../dist/lib/protocols/transportDiagnostics');
const { withRawResponseCapture } = require('../../dist/lib/protocols/rawResponseCapture');
const { signingContextStorage } = require('../../dist/lib/signing/agent-context');

// A realistic Ed25519-sized signature whose std and url Base64 alphabets differ.
function makeSignature() {
  for (;;) {
    const bytes = crypto.randomBytes(64);
    const std = bytes.toString('base64');
    const url = bytes.toString('base64url');
    if (/[+/]/.test(std) && /[-_]/.test(url)) return { std, url, stdBare: std.replace(/=+$/, '') };
  }
}

const SIG = makeSignature();
const NONCE = 'nonce-' + crypto.randomBytes(12).toString('base64url');
const BEARER = 'bearer-' + crypto.randomBytes(18).toString('hex');
const API_KEY = 'apikey-' + crypto.randomBytes(18).toString('hex');
const CUSTOM = 'custom-' + crypto.randomBytes(18).toString('hex');
const WEBHOOK_SECRET = 'webhook-secret-' + crypto.randomBytes(12).toString('hex');
const BODY_FIELD = 'brief-' + crypto.randomBytes(12).toString('hex');
const DIGEST = 'sha-256=:' + crypto.randomBytes(32).toString('base64') + ':';
const SIGNATURE_INPUT = `sig1=("@method" "@target-uri" "content-digest");created=1700000000;expires=1700000300;nonce="${NONCE}";keyid="seller-key-1";alg="ed25519";tag="adcp/request-signing/v1"`;
const REQUEST_BODY = JSON.stringify({
  brief: BODY_FIELD,
  push_notification_config: { authentication: { credentials: WEBHOOK_SECRET } },
});

function signedHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${BEARER}`,
    'x-api-key': API_KEY,
    'X-Custom-Auth': CUSTOM,
    'Content-Type': 'application/json',
    'Content-Digest': DIGEST,
    'Signature-Input': SIGNATURE_INPUT,
    Signature: `sig1=:${SIG.std}:`,
    ...extra,
  };
}

async function rejection(response, headers = signedHeaders()) {
  const wrapped = wrapFetchWithSignedRequestRejection(async () => response);
  try {
    await wrapped('https://seller.example/rpc', { method: 'POST', headers, body: REQUEST_BODY });
    assert.fail('expected signed-request rejection');
  } catch (error) {
    assert.ok(error instanceof AuthenticationRequiredError);
    return error;
  }
}

const challenge = value => ({ status: 401, headers: { 'WWW-Authenticate': value } });

const SECRETS = {
  'bearer token': [BEARER],
  'x-api-key': [API_KEY],
  'custom credential header': [CUSTOM],
  'signature bytes (std, padded)': [SIG.std],
  'signature bytes (std, unpadded)': [SIG.stdBare],
  'signature bytes (url, padded)': [SIG.std.replace(/\+/g, '-').replace(/\//g, '_')],
  'signature bytes (url, unpadded)': [SIG.url],
  'sig1=:...: value': [`sig1=:${SIG.std}:`],
  'nonce value': [NONCE],
  'webhook secret in request body': [WEBHOOK_SECRET],
  'request body field': [BODY_FIELD],
};

test('signed 401 exposes exact structured diagnostics with a non-enumerable realm', async () => {
  const error = await signingContextStorage.run({ adcpVersion: '3.1' }, () =>
    rejection(
      new Response('seller text', {
        ...challenge('Signature realm="seller.example", error="request_signature_required"'),
      })
    )
  );
  const { realm, ...visibleWww } = error.authDiagnostics.wwwAuthenticate;
  assert.equal(realm, 'seller.example');
  assert.deepEqual(error.authDiagnostics, {
    status: 401,
    requestSignature: {
      label: 'sig1',
      keyid: 'seller-key-1',
      alg: 'ed25519',
      created: 1700000000,
      expires: 1700000300,
      noncePresent: true,
      tag: 'adcp/request-signing/v1',
      components: ['@method', '@target-uri', 'content-digest'],
    },
    contentDigest: DIGEST,
    wwwAuthenticate: { scheme: 'signature', error: 'request_signature_required' },
    adcpVersion: '3.1',
  });
  assert.deepEqual(visibleWww, { scheme: 'signature', error: 'request_signature_required' });
  assert.deepEqual({ ...error.authDiagnostics.wwwAuthenticate }, visibleWww);
  assert.equal(Object.getOwnPropertyDescriptor(error.authDiagnostics.wwwAuthenticate, 'realm').enumerable, false);
  assert.doesNotMatch(JSON.stringify(error), /seller\.example"|realm/);
  assert.equal(Object.getOwnPropertyDescriptor(error, 'authDiagnostics').enumerable, true);

  // Existing fields are unchanged.
  assert.equal(error.signatureErrorCode, 'request_signature_required');
  assert.deepEqual(error.challenge, { scheme: 'signature', error: 'request_signature_required' });
  assert.equal(error.responseBody, 'seller text');
  assert.equal(Object.getOwnPropertyDescriptor(error, 'responseBody').enumerable, false);
  assert.deepEqual(error.details, {
    agentUrl: 'https://seller.example/rpc',
    challenge: error.challenge,
    requestSigned: true,
    status: 401,
  });
  assert.match(error.message, /seller\.example/);
});

test('adcpVersion is absent without a signing context', async () => {
  const error = await rejection(new Response('', challenge('Signature error="request_signature_required"')));
  assert.equal('adcpVersion' in error.authDiagnostics, false);
});

for (const [name, secrets] of Object.entries(SECRETS)) {
  test(`absence: ${name} never appears in error surfaces or transport events`, async () => {
    // The seller hostilely echoes everything it can see in body and headers.
    // Seller text reflecting request-header credentials. Nonce and request-body values are
    // not header secrets, so a seller echoing them in prose is outside the redaction contract.
    const echo = [BEARER, API_KEY, CUSTOM, SIG.std, SIG.url].join(' ');
    const error = await signingContextStorage.run({ adcpVersion: '3.1' }, () =>
      rejection(
        new Response(JSON.stringify({ error: echo }), {
          status: 401,
          headers: {
            'WWW-Authenticate': `Signature realm="${BEARER}", error="request_signature_required", error_description="${echo}"`,
            'X-Echo': echo,
          },
        })
      )
    );
    const events = [];
    const fetchImpl = wrapFetchWithTransportDiagnostics(
      async () =>
        new Response(JSON.stringify({ error: echo }), {
          status: 401,
          headers: {
            'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(JSON.stringify({ error: echo }))),
            'WWW-Authenticate': `Signature realm="seller.example", error="request_signature_required", error_description="${echo}"`,
          },
        })
    );
    await withTransportDiagnostics(
      { agentId: 'a', protocol: 'mcp', adcpVersion: '3.1', onTransportActivity: e => events.push(e) },
      () => fetchImpl('https://seller.example/rpc', { method: 'POST', headers: signedHeaders(), body: REQUEST_BODY })
    );
    for (let i = 0; i < 200 && !events.some(e => e.type === 'response_received'); i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.ok(events.some(e => e.type === 'response_received'));
    const isSignature = /signature|sig1/.test(name);
    const surfaces = {
      error: JSON.stringify(error),
      diagnostics: JSON.stringify(error.authDiagnostics),
      realmField: String(error.authDiagnostics.wwwAuthenticate.realm ?? ''),
      message: error.message,
      responseBody: error.responseBody,
      // Transport response bodies only mask Signature echoes (pre-existing); bearer/custom echoes
      // are checked on the structured diagnostics, which this change introduces.
      eventDiagnostics: JSON.stringify(events.map(e => e.authDiagnostics ?? null)),
      eventsRequestHeaders: JSON.stringify(events.map(e => e.requestHeaders)),
      ...(isSignature && { events: JSON.stringify(events.map(e => ({ ...e, requestBody: undefined }))) }),
    };
    // The `events` surface omits requestBody, which has its own redaction contract.
    for (const secret of secrets) {
      for (const [surface, text] of Object.entries(surfaces)) {
        assert.equal(text.includes(secret), false, `${name} leaked into ${surface}`);
      }
    }
  });
}

test('error_description, non-token realms and realms reflecting credentials are dropped', async () => {
  const cases = [
    [`Signature realm="two words", error="request_signature_required", error_description="read me"`, 'two words'],
    [`Signature realm="${BEARER}", error="request_signature_required"`, BEARER],
    [`Signature realm="x${BEARER}y", error="request_signature_required"`, BEARER],
    [`Signature realm="${NONCE}x", error="request_signature_required"`, NONCE],
  ];
  for (const [header, leaked] of cases) {
    const error = await rejection(new Response('', challenge(header)));
    const www = error.authDiagnostics.wwwAuthenticate;
    assert.equal('error_description' in www, false);
    assert.equal(JSON.stringify(www).includes('read me'), false);
    if (leaked) assert.equal(www.realm, undefined, header);
  }
  // Public realm text that shares nothing with a credential survives.
  const ok = await rejection(new Response('', challenge('Signature realm="seller.example"')));
  assert.equal(ok.authDiagnostics.wwwAuthenticate.realm, 'seller.example');
  // Over-long realms are dropped.
  const long = await rejection(new Response('', challenge(`Signature realm="${'a'.repeat(129)}"`)));
  assert.equal(long.authDiagnostics.wwwAuthenticate.realm, undefined);
});

test('a realm reflecting the signature nonce is dropped', async () => {
  const error = await rejection(
    new Response('', challenge(`Signature realm="${NONCE}", error="request_signature_required"`))
  );
  assert.equal(error.authDiagnostics.wwwAuthenticate.realm, undefined, 'nonce echoed via realm must not surface');
  assert.equal(JSON.stringify(error.authDiagnostics).includes(NONCE), false);
});

test('unrecognized challenge error codes are dropped; bearer codes are kept', async () => {
  const bad = await rejection(new Response('', challenge('Signature error="attacker-text"')));
  assert.equal(bad.authDiagnostics.wwwAuthenticate.error, undefined);
  assert.equal(bad.authDiagnostics.wwwAuthenticate.scheme, 'signature');

  const events = [];
  const fetchImpl = wrapFetchWithTransportDiagnostics(
    async () => new Response('', { status: 403, headers: { 'WWW-Authenticate': 'Bearer error="insufficient_scope"' } })
  );
  await withTransportDiagnostics({ agentId: 'a', protocol: 'mcp', onTransportActivity: e => events.push(e) }, () =>
    fetchImpl('https://seller.example/rpc', { headers: { Authorization: `Bearer ${BEARER}` } })
  );
  const received = events.find(e => e.type === 'response_received');
  assert.deepEqual(received.authDiagnostics.wwwAuthenticate, { scheme: 'bearer', error: 'insufficient_scope' });

  const events2 = [];
  const f2 = wrapFetchWithTransportDiagnostics(
    async () => new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Bearer error="attacker-text"' } })
  );
  await withTransportDiagnostics({ agentId: 'a', protocol: 'mcp', onTransportActivity: e => events2.push(e) }, () =>
    f2('https://seller.example/rpc')
  );
  assert.equal(events2.find(e => e.type === 'response_received').authDiagnostics.wwwAuthenticate.error, undefined);
});

test('malformed Signature-Input and non-digest Content-Digest are omitted without throwing', async () => {
  const error = await rejection(
    new Response('', challenge('Signature error="request_signature_required"')),
    signedHeaders({ 'Signature-Input': 'not a dictionary((', 'Content-Digest': 'definitely not a digest!' })
  );
  assert.equal(error.authDiagnostics.requestSignature, undefined);
  assert.equal(error.authDiagnostics.contentDigest, undefined);
  assert.equal(error.authDiagnostics.status, 401);
});

test('seller echo of Signature is masked in responseBody and raw capture; Signature-Input stays visible', async () => {
  const urlPadded = SIG.std.replace(/\+/g, '-').replace(/\//g, '_');
  const bodies = {
    'json std': JSON.stringify({ error: `bad signature ${SIG.std}`, input: SIGNATURE_INPUT }),
    'json url': JSON.stringify({ error: `bad signature ${SIG.url}`, input: SIGNATURE_INPUT }),
    'json url padded': JSON.stringify({ error: `bad ${urlPadded}`, input: SIGNATURE_INPUT }),
    'json escaped slashes': JSON.stringify({ error: `bad ${SIG.std}`, input: SIGNATURE_INPUT }).replace(/\//g, '\\/'),
    'plain std': `bad signature ${SIG.std} for ${SIGNATURE_INPUT}`,
    'plain url': `bad signature ${SIG.url} for ${SIGNATURE_INPUT}`,
    'plain header form': `bad Signature: sig1=:${SIG.std}: for ${SIGNATURE_INPUT}`,
  };
  for (const [name, body] of Object.entries(bodies)) {
    await assert.rejects(
      withRawResponseCapture(async () => {
        throw await rejection(
          new Response(body, {
            status: 401,
            headers: { 'X-Request-Id': `sig1=:${SIG.std}:` },
          })
        );
      }),
      error => {
        for (const form of [SIG.std, SIG.stdBare, SIG.url, urlPadded, SIG.std.replaceAll('/', '\\/')]) {
          assert.equal(error.responseBody.includes(form), false, `${name}: responseBody`);
          assert.equal(JSON.stringify(error.captures).includes(form), false, `${name}: capture`);
        }
        assert.match(error.responseBody, /\[redacted\]/, name);
        assert.ok(error.responseBody.includes('keyid='), `${name}: Signature-Input stays visible`);
        assert.equal(error.captures[0].headers['x-request-id'], '[redacted]');
        return true;
      }
    );
  }
});

test('existing bearer redaction still masks an echoed token', async () => {
  const error = await rejection(new Response(JSON.stringify({ error: `Bearer ${BEARER}` }), { status: 401 }));
  assert.doesNotMatch(error.responseBody, new RegExp(BEARER));
  assert.match(error.responseBody, /\[redacted\]/);
});

async function runTransport(status, { headers = {}, body = '', adcpVersion = '3.1' } = {}) {
  const events = [];
  const fetchImpl = wrapFetchWithTransportDiagnostics(
    async () =>
      new Response(body, {
        status,
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
          ...headers,
        },
      })
  );
  await withTransportDiagnostics(
    { agentId: 'a', protocol: 'mcp', adcpVersion, onTransportActivity: e => events.push(e) },
    () => fetchImpl('https://seller.example/mcp', { method: 'POST', headers: signedHeaders(), body: REQUEST_BODY })
  );
  for (let i = 0; i < 200 && !events.some(e => e.type === 'response_received'); i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return events;
}

test('transport events carry authDiagnostics on 401/403 only', async () => {
  for (const status of [401, 403]) {
    const events = await runTransport(status, {
      headers: { 'WWW-Authenticate': 'Signature realm="seller.example", error="request_signature_invalid"' },
    });
    const received = events.find(e => e.type === 'response_received');
    assert.equal(received.authDiagnostics.status, status);
    assert.equal(received.authDiagnostics.adcpVersion, '3.1');
    assert.equal(received.authDiagnostics.requestSignature.keyid, 'seller-key-1');
    assert.equal(received.authDiagnostics.requestSignature.noncePresent, true);
    assert.equal(received.authDiagnostics.contentDigest, DIGEST);
    assert.equal(received.authDiagnostics.wwwAuthenticate.error, 'request_signature_invalid');
    for (const other of events.filter(e => e.type !== 'response_received')) {
      assert.equal('authDiagnostics' in other, false, `${other.type} must not carry authDiagnostics`);
    }
    assert.equal(received.requestHeaders['signature'], '[redacted]');
    assert.equal(received.requestHeaders['signature-input'], '[redacted]');
  }
  for (const status of [200, 500]) {
    const events = await runTransport(status);
    const received = events.find(e => e.type === 'response_received');
    assert.equal('authDiagnostics' in received, false, `status ${status}`);
  }
});

async function transportDiagnosticsFor(requestHeaders, responseHeaders, status = 401) {
  const events = [];
  const fetchImpl = wrapFetchWithTransportDiagnostics(
    async () => new Response('', { status, headers: responseHeaders })
  );
  await withTransportDiagnostics({ agentId: 'a', protocol: 'mcp', onTransportActivity: e => events.push(e) }, () =>
    fetchImpl('https://seller.example/mcp', { method: 'POST', headers: requestHeaders, body: REQUEST_BODY })
  );
  return events.find(e => e.type === 'response_received').authDiagnostics;
}

test('a seller scheme reflecting a credential reads other; registered and vendor schemes pass', async () => {
  // Long reflections hit the length cap; short ones, in any case, the overlap check.
  const SHORT = 'Tok12345Abcd';
  for (const scheme of [BEARER, `x${API_KEY}`, CUSTOM.slice(0, 20), SHORT, SHORT.toUpperCase()]) {
    const diagnostics = await transportDiagnosticsFor(signedHeaders({ 'X-Short-Key': SHORT }), {
      'WWW-Authenticate': `${scheme} realm="r"`,
    });
    assert.equal(diagnostics.wwwAuthenticate.scheme, 'other', scheme);
    assert.equal(JSON.stringify(diagnostics).toLowerCase().includes(scheme.toLowerCase()), false);
  }
  for (const [header, scheme] of [
    ['Bearer error="invalid_token"', 'bearer'],
    ['Basic realm="gw"', 'basic'],
    ['Apigee-Key realm="gw"', 'apigee-key'],
  ]) {
    const diagnostics = await transportDiagnosticsFor(signedHeaders(), { 'WWW-Authenticate': header });
    assert.equal(diagnostics.wwwAuthenticate.scheme, scheme);
  }
});

test('caller-supplied Signature-Input and Content-Digest on an unsigned request are not reported', async () => {
  const { Signature: _signature, ...unsigned } = signedHeaders();
  const diagnostics = await transportDiagnosticsFor(unsigned, { 'WWW-Authenticate': 'Bearer error="invalid_token"' });
  assert.equal(diagnostics.requestSignature, undefined);
  assert.equal(diagnostics.contentDigest, undefined);
  assert.equal(diagnostics.wwwAuthenticate.error, 'invalid_token');
});

test('Content-Digest is reported only when the signature covered it', async () => {
  const uncovered = signedHeaders({ 'Signature-Input': SIGNATURE_INPUT.replace(' "content-digest"', '') });
  const diagnostics = await transportDiagnosticsFor(uncovered, {});
  assert.deepEqual(diagnostics.requestSignature.components, ['@method', '@target-uri']);
  assert.equal(diagnostics.contentDigest, undefined);
});

test('outbound Signature-Input strings and Content-Digest are screened for protected values', async () => {
  const headers = signedHeaders({
    'Signature-Input': `sig1=("@method" "content-digest");keyid="${BEARER}";tag="${NONCE}";alg="ed25519";nonce="${NONCE}"`,
    'Content-Digest': `sha-512=:${SIG.std}:`,
  });
  const diagnostics = await transportDiagnosticsFor(headers, {});
  assert.equal(diagnostics.requestSignature.keyid, '[redacted]');
  assert.equal(diagnostics.requestSignature.tag, '[redacted]');
  assert.equal(diagnostics.requestSignature.alg, 'ed25519');
  assert.equal(diagnostics.contentDigest, undefined);
  for (const secret of [BEARER, NONCE, SIG.std, SIG.stdBare]) {
    assert.equal(JSON.stringify(diagnostics).includes(secret), false);
  }
  // A short incidental header value does not blank out a legitimate key id.
  const benign = await transportDiagnosticsFor(signedHeaders({ 'X-Tenant': 'seller' }), {});
  assert.equal(benign.requestSignature.keyid, 'seller-key-1');
});

test('diagnostics use the headers fetch sends: init.headers replaces Request headers', async () => {
  const events = [];
  const fetchImpl = wrapFetchWithTransportDiagnostics(
    async () =>
      new Response('', { status: 403, headers: { 'WWW-Authenticate': 'Signature error="request_signature_required"' } })
  );
  const request = new Request('https://seller.example/mcp', { method: 'POST', headers: signedHeaders() });
  await withTransportDiagnostics({ agentId: 'a', protocol: 'mcp', onTransportActivity: e => events.push(e) }, () =>
    fetchImpl(request, { headers: { 'Content-Type': 'application/json' } })
  );
  const diagnostics = events.find(e => e.type === 'response_received').authDiagnostics;
  assert.equal(diagnostics.requestSignature, undefined);
  assert.equal(diagnostics.contentDigest, undefined);
  assert.equal(diagnostics.wwwAuthenticate.error, 'request_signature_required');

  // Without init.headers, the Request's own headers are what fetch sends.
  const events2 = [];
  await withTransportDiagnostics({ agentId: 'a', protocol: 'mcp', onTransportActivity: e => events2.push(e) }, () =>
    fetchImpl(new Request('https://seller.example/mcp', { method: 'POST', headers: signedHeaders() }))
  );
  assert.equal(
    events2.find(e => e.type === 'response_received').authDiagnostics.requestSignature.keyid,
    'seller-key-1'
  );
});

test('transport response body masks an echoed signature', async () => {
  const body = JSON.stringify({ error: `rejected ${SIG.url} and ${SIG.std}`, hdr: `sig1=:${SIG.std}:` });
  const events = await runTransport(401, { body });
  const received = events.find(e => e.type === 'response_received');
  assert.ok(received.responseBody, 'body captured');
  for (const form of [SIG.std, SIG.stdBare, SIG.url]) assert.equal(received.responseBody.includes(form), false);
  assert.match(received.responseBody, /\[redacted\]/);
});
