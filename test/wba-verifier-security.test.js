/**
 * Security boundaries of the experimental Web Bot Auth verifier and key
 * discovery. Ports the regression set of adcp-client-python#1502.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, sign } = require('node:crypto');
const {
  InMemoryReplayStore,
  StaticJwksResolver,
  StaticWebBotAuthKeys,
  WebBotAuthKeyDirectoryResolver,
  WebBotAuthError,
  WebBotAuthAuthorizationError,
  verifyKeyDirectoryResponse,
  verifyWebBotAuthRequest,
  usesWebBotAuth,
  verifyRequestSignature,
  InMemoryRevocationStore,
  RequestSignatureError,
  publicDirectoryKey,
  signKeyDirectory,
} = require('../dist/lib/signing/server.js');
const { signWebBotAuthRequest } = require('../dist/lib/signing/client.js');
const { parseStrictDictionary, wbaSignatureBase } = require('../dist/lib/signing/wba/structured.js');
const { serializeDictionary } = require('structured-headers');

const SELLER = 'https://seller.example.com/mcp';
const BUYER = 'https://buyer.example.com';
const notRevoked = async () => false;
const ed = () => generateKeyPairSync('ed25519').privateKey;

function signed(privateKey, { body = '{"a":1}', origin = BUYER, created = 1000, nonce, headers = {} } = {}) {
  const request = { method: 'POST', url: SELLER, headers: { 'Content-Type': 'application/json', ...headers }, body };
  const result = signWebBotAuthRequest(
    request,
    { privateKey },
    { agentOrigin: origin, created, ...(nonce && { nonce }) }
  );
  return { method: 'POST', url: SELLER, headers: result.headers, body };
}

function verify(request, { keys, replayStore = new InMemoryReplayStore(), revocation = notRevoked, now = 1001 } = {}) {
  return verifyWebBotAuthRequest(request, { keys, replayStore, revocation, now: () => now });
}

const status = code => error => {
  assert.ok(error instanceof WebBotAuthError, `expected WebBotAuthError, got ${error}`);
  assert.equal(error.status, code, error.reason);
  return true;
};

describe('Web Bot Auth key discovery', () => {
  it('binds (origin, thumbprint), caches up to five minutes, and treats a fresh directory as evidence of removal', async () => {
    const key = ed();
    const kid = publicDirectoryKey(key).kid;
    let now = 1000;
    const calls = [];
    const responses = {
      'https://buyer.example.com': signKeyDirectory({
        agentOrigin: 'https://buyer.example.com',
        privateKeys: [key],
        created: 1000,
      }),
      'https://other.example.com': signKeyDirectory({
        agentOrigin: 'https://other.example.com',
        privateKeys: [key],
        created: 1000,
      }),
    };
    const resolver = new WebBotAuthKeyDirectoryResolver({
      now: () => now,
      fetch: async url => {
        calls.push(url);
        return responses[new URL(url).origin];
      },
    });
    const first = await resolver.resolveWithMetadata(kid, 'https://buyer.example.com');
    const second = await resolver.resolveWithMetadata(kid, 'https://Other.Example.COM.:443/x');
    assert.equal(first.agentUrl, 'https://buyer.example.com');
    assert.equal(second.agentUrl, 'https://other.example.com');
    assert.equal((await resolver.resolveWithMetadata('x'.repeat(43), 'https://buyer.example.com')).jwk, null);
    assert.equal(await resolver.resolve(kid), null, 'context-free lookups never reach WBA directories');
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], 'https://buyer.example.com/.well-known/http-message-signatures-directory');
    assert.ok(resolver.directoryRecord('https://buyer.example.com').headers['Signature-Input']);
    responses['https://buyer.example.com'] = signKeyDirectory({
      agentOrigin: 'https://buyer.example.com',
      privateKeys: [ed()],
      created: 1301,
    });
    now = 1301;
    assert.equal(await resolver.resolve(kid, 'https://buyer.example.com'), null);
    assert.equal(calls.length, 3);
  });

  it('never caches a directory past its signatures', async () => {
    const key = ed();
    const kid = publicDirectoryKey(key).kid;
    let now = 1000;
    let fetches = 0;
    const resolver = new WebBotAuthKeyDirectoryResolver({
      now: () => now,
      fetch: async () => {
        fetches++;
        return signKeyDirectory({ agentOrigin: BUYER, privateKeys: [key], created: now, expiresInSeconds: 30 });
      },
    });
    await resolver.resolve(kid, BUYER);
    now = 1031;
    await resolver.resolve(kid, BUYER);
    assert.equal(fetches, 2);
  });

  it('negatively caches a failed discovery with no prior evidence for 60 seconds', async () => {
    let now = 1000;
    const calls = [];
    const resolver = new WebBotAuthKeyDirectoryResolver({
      now: () => now,
      fetch: async url => {
        calls.push(url);
        throw new Error('offline');
      },
    });
    for (let i = 0; i < 2; i++) await assert.rejects(resolver.resolve('k'.repeat(43), BUYER), status(403));
    assert.equal(calls.length, 1);
    now = 1061;
    await assert.rejects(resolver.resolve('k'.repeat(43), BUYER), status(403));
    assert.equal(calls.length, 2);
  });

  it('keeps serving signed evidence through a refresh failure until its signatures expire', async () => {
    const key = ed();
    const kid = publicDirectoryKey(key).kid;
    let now = 1000;
    let fail = false;
    const resolver = new WebBotAuthKeyDirectoryResolver({
      now: () => now,
      fetch: async () => {
        if (fail) throw new Error('offline');
        return signKeyDirectory({ agentOrigin: BUYER, privateKeys: [key], created: 1000, expiresInSeconds: 3600 });
      },
    });
    await resolver.resolve(kid, BUYER);
    fail = true;
    now = 1301; // past the five-minute positive cache
    assert.equal((await resolver.resolve(kid, BUYER)).kid, kid, 'a failed fetch is not evidence of removal');
    assert.ok(resolver.directoryRecord(BUYER), 'the signed response stays on record');
    now = 4601; // past the signatures' expires
    await assert.rejects(resolver.resolve(kid, BUYER), status(403));
  });

  it('never lets failing origins evict a good cached directory', async () => {
    const key = ed();
    const kid = publicDirectoryKey(key).kid;
    const calls = [];
    const resolver = new WebBotAuthKeyDirectoryResolver({
      now: () => 1000,
      maxOrigins: 2,
      fetch: async url => {
        calls.push(new URL(url).origin);
        if (new URL(url).origin !== BUYER) throw new Error('offline');
        return signKeyDirectory({ agentOrigin: BUYER, privateKeys: [key], created: 1000 });
      },
    });
    await resolver.resolve(kid, BUYER);
    for (let i = 0; i < 5; i++) await assert.rejects(resolver.resolve(kid, `https://bad${i}.attacker.com`));
    await resolver.resolve(kid, BUYER);
    assert.equal(calls.filter(origin => origin === BUYER).length, 1);
  });

  it('bounds concurrent discoveries per operator without blocking another operator', async () => {
    const key = ed();
    const kid = publicDirectoryKey(key).kid;
    const resolver = new WebBotAuthKeyDirectoryResolver({
      now: () => 1000,
      maxPendingPerOperator: 1,
      fetch: url =>
        new URL(url).hostname.endsWith('slow.com')
          ? new Promise(() => {})
          : Promise.resolve(signKeyDirectory({ agentOrigin: new URL(url).origin, privateKeys: [key], created: 1000 })),
    });
    resolver.resolve(kid, 'https://a.slow.com').catch(() => {});
    await assert.rejects(resolver.resolve(kid, 'https://b.slow.com'), status(429));
    assert.equal((await resolver.resolve(kid, 'https://fast.com')).kid, kid);
  });

  it('recovers from a fetcher that throws synchronously', async () => {
    const key = ed();
    const kid = publicDirectoryKey(key).kid;
    let now = 1000;
    let fail = true;
    const resolver = new WebBotAuthKeyDirectoryResolver({
      now: () => now,
      fetch: () => {
        if (fail) throw new Error('sync boom');
        return Promise.resolve(signKeyDirectory({ agentOrigin: BUYER, privateKeys: [key], created: now }));
      },
    });
    await assert.rejects(resolver.resolve(kid, BUYER), status(403));
    fail = false;
    now = 1061;
    assert.equal((await resolver.resolve(kid, BUYER)).kid, kid);
  });

  it('refuses IP-literal, single-label and localhost signer origins before fetching', async () => {
    let fetched = false;
    const resolver = new WebBotAuthKeyDirectoryResolver({
      fetch: async () => {
        fetched = true;
        throw new Error('unreachable');
      },
    });
    for (const origin of ['https://127.0.0.1', 'https://[::1]', 'https://localhost', 'https://intranet']) {
      await assert.rejects(resolver.resolve('k'.repeat(43), origin), status(403), origin);
    }
    assert.equal(fetched, false);
  });

  it('requires the exact "content-digest" component in a directory signature', () => {
    const key = ed();
    const response = signKeyDirectory({ agentOrigin: BUYER, privateKeys: [key], created: 1000 });
    const jwk = publicDirectoryKey(key);
    response.headers['Content-Digest'] += ', sha-512=:' + Buffer.alloc(64).toString('base64') + ':';
    const member = [
      [
        ['@authority', new Map([['req', true]])],
        ['content-digest', new Map([['key', 'sha-512']])],
      ],
      new Map([
        ['created', 1000],
        ['expires', 2000],
        ['keyid', jwk.kid],
        ['tag', 'http-message-signatures-directory'],
      ]),
    ];
    response.headers['Signature-Input'] = serializeDictionary(new Map([['key1', member]]));
    const base = wbaSignatureBase(
      { method: 'GET', url: BUYER + '/.well-known/http-message-signatures-directory', headers: response.headers },
      member,
      { directoryResponse: true }
    );
    response.headers['Signature'] = `key1=:${sign(null, Buffer.from(base), key).toString('base64')}:`;
    assert.throws(() => verifyKeyDirectoryResponse(BUYER, response, { now: 1001 }), /bind authority and digest/);
  });

  it('coalesces per origin without blocking other signers', async () => {
    const key = ed();
    const kid = publicDirectoryKey(key).kid;
    let release;
    const gate = new Promise(resolve => (release = resolve));
    const calls = [];
    const resolver = new WebBotAuthKeyDirectoryResolver({
      now: () => 1000,
      fetch: async url => {
        const origin = new URL(url).origin;
        calls.push(origin);
        if (origin === 'https://slow.example.com') await gate;
        return signKeyDirectory({ agentOrigin: origin, privateKeys: [key], created: 1000 });
      },
    });
    const a = resolver.resolve(kid, 'https://slow.example.com');
    const b = resolver.resolve(kid, 'https://slow.example.com');
    const fast = await resolver.resolveWithMetadata(kid, 'https://fast.example.com');
    assert.equal(fast.agentUrl, 'https://fast.example.com');
    release();
    assert.deepEqual(await a, await b);
    assert.equal(calls.filter(origin => origin === 'https://slow.example.com').length, 1);
  });

  it('bounds concurrent discoveries with 429', async () => {
    const resolver = new WebBotAuthKeyDirectoryResolver({
      maxOrigins: 1,
      now: () => 1000,
      fetch: () => new Promise(() => {}),
    });
    resolver.resolve('k'.repeat(43), 'https://a.example.com').catch(() => {});
    await assert.rejects(resolver.resolve('k'.repeat(43), 'https://b.example.com'), status(429));
  });

  it('never falls back from a failed WBA discovery to legacy keys', async () => {
    const key = ed();
    const jwk = publicDirectoryKey(key);
    const legacy = new StaticJwksResolver([jwk]);
    const resolver = new WebBotAuthKeyDirectoryResolver({
      legacy,
      fetch: async () => {
        throw new Error('offline');
      },
    });
    assert.equal((await resolver.resolve(jwk.kid)).kid, jwk.kid, 'RFC 9421 lookups use the legacy resolver');
    await assert.rejects(resolver.resolve(jwk.kid, BUYER), status(403));
  });

  it('rejects malformed or non-HTTPS signer origins before fetching', async () => {
    let fetched = false;
    const resolver = new WebBotAuthKeyDirectoryResolver({
      fetch: async () => {
        fetched = true;
        throw new Error('unreachable');
      },
    });
    for (const origin of [
      'http://buyer.example.com',
      'https://user@buyer.example.com',
      'https://b%C3%BCcher.de',
      'ftp://x',
    ]) {
      await assert.rejects(resolver.resolve('k'.repeat(43), origin), status(403), origin);
    }
    assert.equal(fetched, false);
  });

  for (const tamper of ['body', 'authority', 'future', 'unsigned_key', 'kid', 'media_type', 'private_material']) {
    it(`rejects a tampered signed directory (${tamper})`, () => {
      let origin = BUYER;
      let now = 1001;
      const response = signKeyDirectory({ agentOrigin: BUYER, privateKeys: [ed()], created: 1000 });
      if (tamper === 'body') response.body += ' ';
      else if (tamper === 'authority') origin = 'https://attacker.example.com';
      else if (tamper === 'future') now = 999;
      else if (tamper === 'media_type') response.headers['Content-Type'] = 'application/json';
      else {
        const document = JSON.parse(response.body);
        if (tamper === 'kid') document.keys[0].kid = 'x'.repeat(43);
        else if (tamper === 'private_material') document.keys[0].d = 'secret';
        else document.keys.push(publicDirectoryKey(ed()));
        response.body = JSON.stringify(document);
      }
      assert.throws(() => verifyKeyDirectoryResponse(origin, response, { now }), status(403));
    });
  }

  it('signs and verifies a multi-key directory and derives P-256 when alg is absent', async () => {
    const edKey = ed();
    const ecKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    const directory = signKeyDirectory({ agentOrigin: BUYER, privateKeys: [edKey, ecKey], created: 1000 });
    const keys = verifyKeyDirectoryResponse(BUYER, directory, { now: 1001 });
    assert.equal(keys.size, 2);
    const request = signed(ecKey);
    const inputs = parseStrictDictionary(request.headers['Signature-Input'], 'Signature-Input');
    const member = inputs.get('sig1');
    member[1].delete('alg');
    request.headers['Signature-Input'] = serializeDictionary(inputs);
    const base = wbaSignatureBase(request, member);
    const signature = sign('sha256', Buffer.from(base), { key: ecKey, dsaEncoding: 'ieee-p1363' });
    request.headers['Signature'] = `sig1=:${signature.toString('base64')}:`;
    const [signer] = await verify(request, { keys: new StaticWebBotAuthKeys({ [BUYER]: [...keys.values()] }) });
    assert.equal(signer.alg, 'ecdsa-p256-sha256');
  });
});

describe('Web Bot Auth request verification', () => {
  const key = ed();
  const keys = new StaticWebBotAuthKeys({ [BUYER]: [publicDirectoryKey(key)] });

  it('requires a replay store, a revocation check, and an origin-aware resolver', async () => {
    const request = signed(key);
    await assert.rejects(verifyWebBotAuthRequest(request, { keys, revocation: notRevoked }), /replay store/);
    await assert.rejects(
      verifyWebBotAuthRequest(request, { keys, replayStore: new InMemoryReplayStore() }),
      /revocation/
    );
    await assert.rejects(
      verifyWebBotAuthRequest(request, {
        keys: new StaticJwksResolver([publicDirectoryKey(key)]),
        replayStore: new InMemoryReplayStore(),
        revocation: notRevoked,
      }),
      /origin-aware/
    );
  });

  it('refuses a resolver that returns a key from another origin (kid-only lookup)', async () => {
    const foreign = {
      resolve: async () => publicDirectoryKey(key),
      resolveWithMetadata: async () => ({ jwk: publicDirectoryKey(key), agentUrl: 'https://attacker.example.com' }),
    };
    await assert.rejects(verify(signed(key), { keys: foreign }), status(403));
    const noMetadata = {
      resolve: async () => publicDirectoryKey(key),
      resolveWithMetadata: async () => ({ jwk: publicDirectoryKey(key) }),
    };
    await assert.rejects(verify(signed(key), { keys: noMetadata }), status(403));
  });

  it('keeps replay state per origin across key rotation', async () => {
    const [first, second] = [ed(), ed()];
    const rotating = new StaticWebBotAuthKeys({ [BUYER]: [publicDirectoryKey(first), publicDirectoryKey(second)] });
    const replayStore = new InMemoryReplayStore();
    const nonce = 'n'.repeat(43);
    await verify(signed(first, { nonce }), { keys: rotating, replayStore });
    await assert.rejects(verify(signed(second, { nonce }), { keys: rotating, replayStore }), error => {
      assert.ok(status(403)(error));
      assert.match(error.headers['Accept-Signature'], /;nonce="[A-Za-z0-9_-]{43}"/);
      return true;
    });
  });

  it('answers 429 when the replay cache is at capacity', async () => {
    const replayStore = new InMemoryReplayStore({ maxEntriesPerKeyid: 1 });
    await verify(signed(key), { keys, replayStore });
    await assert.rejects(verify(signed(key), { keys, replayStore }), status(429));
  });

  it('rejects duplicate dictionary members and parameters before an RFC 8941 parser hides them', () => {
    for (const field of [
      'sig1=("@method");created=1;created=2',
      'sig1=("signature-agent";key="sig1";key="other");created=1',
      'sig1="https://buyer.com";type="directory";type="other"',
      'sig1="https://a.example", sig1="https://b.example"',
    ]) {
      assert.throws(() => parseStrictDictionary(field, 'Signature-Input'), status(400), field);
    }
  });

  it('overwrites a stale caller digest case-insensitively and authenticates the body', async () => {
    const request = signed(key, { headers: { 'content-digest': 'sha-256=:stale:' } });
    assert.equal(Object.keys(request.headers).filter(name => name.toLowerCase() === 'content-digest').length, 1);
    const [signer] = await verify(request, { keys });
    assert.equal(signer.body_authenticated, true);
  });

  it('requires a relay to cover every component of the earlier signature, including application fields', async () => {
    const relayKey = ed();
    const RELAY = 'https://relay.agency.example.com';
    const both = new StaticWebBotAuthKeys({
      [BUYER]: [publicDirectoryKey(key)],
      [RELAY]: [publicDirectoryKey(relayKey)],
    });
    const build = coverExtra => {
      const request = signed(key, { headers: { 'X-Buyer-Reference': 'campaign-123' } });
      const brandInputs = parseStrictDictionary(request.headers['Signature-Input'], 'Signature-Input');
      const brand = brandInputs.get('sig1');
      brand[0].push(['x-buyer-reference', new Map()]);
      request.headers['Signature-Input'] = serializeDictionary(brandInputs);
      const brandSig = sign(null, Buffer.from(wbaSignatureBase(request, brand)), key);
      request.headers['Signature'] = `sig1=:${brandSig.toString('base64')}:`;
      request.headers['Signature-Agent'] = `sig1="${BUYER}", relay="${RELAY}"`;
      const relayComponents = [
        '@method',
        '@target-uri',
        '@authority',
        'content-type',
        'content-digest',
        ['signature-agent', 'relay'],
        ['signature-agent', 'sig1'],
        ['signature-input', 'sig1'],
        ['signature', 'sig1'],
        ...(coverExtra ? ['x-buyer-reference'] : []),
      ].map(c => (typeof c === 'string' ? [c, new Map()] : [c[0], new Map([['key', c[1]]])]));
      const relay = [
        relayComponents,
        new Map([
          ['created', 1000],
          ['expires', 1300],
          ['nonce', 'r'.repeat(43)],
          ['keyid', publicDirectoryKey(relayKey).kid],
          ['tag', 'web-bot-auth'],
        ]),
      ];
      brandInputs.set('relay', relay);
      request.headers['Signature-Input'] = serializeDictionary(brandInputs);
      const relaySig = sign(null, Buffer.from(wbaSignatureBase(request, relay)), relayKey);
      request.headers['Signature'] += `, relay=:${relaySig.toString('base64')}:`;
      return request;
    };
    const signers = await verify(build(true), { keys: both });
    assert.deepEqual(
      signers.map(s => s.origin),
      [BUYER, RELAY]
    );
    await assert.rejects(verify(build(false), { keys: both }), status(403));
  });

  it('rejects a Signature-Agent member of another type, for another label, or not an HTTPS origin', async () => {
    const typed = signed(key);
    typed.headers['Signature-Agent'] = `sig1="${BUYER}";type="jwks"`;
    await assert.rejects(verify(typed, { keys }), status(403));
    const plainHttp = signed(key);
    plainHttp.headers['Signature-Agent'] = 'sig1="http://buyer.example.com"';
    await assert.rejects(verify(plainHttp, { keys }), status(403));
    const missing = signed(key);
    missing.headers['Signature-Agent'] = `other="${BUYER}"`;
    await assert.rejects(verify(missing, { keys }), status(403));
  });

  it('enforces the 300 s lifetime and 60 s skew', async () => {
    await assert.rejects(verify(signed(key, { created: 1000 }), { keys, now: 1361 }), status(403));
    await assert.rejects(verify(signed(key, { created: 1100 }), { keys, now: 1000 }), status(403));
    await verify(signed(key, { created: 1050 }), { keys, now: 1000 });
  });

  it('rejects a hand-built signature whose lifetime exceeds 300 s', async () => {
    const request = signed(key);
    const inputs = parseStrictDictionary(request.headers['Signature-Input'], 'Signature-Input');
    const member = inputs.get('sig1');
    member[1].set('expires', 1301);
    request.headers['Signature-Input'] = serializeDictionary(inputs);
    request.headers['Signature'] =
      `sig1=:${sign(null, Buffer.from(wbaSignatureBase(request, member)), key).toString('base64')}:`;
    await assert.rejects(verify(request, { keys }), status(403));
  });

  it('rejects a replay at exactly expires + 60 s', async () => {
    const replayStore = new InMemoryReplayStore();
    const request = signed(key, { created: 1000 });
    await verify(request, { keys, replayStore, now: 1000 });
    await assert.rejects(verify(request, { keys, replayStore, now: 1360 }), status(403));
  });

  it('does not consult revocation when the signature bytes are wrong', async () => {
    let checked = false;
    const request = signed(key);
    request.headers['Signature'] = request.headers['Signature'].replace(/:(.)/, (_m, c) => `:${c === 'A' ? 'B' : 'A'}`);
    await assert.rejects(
      verify(request, {
        keys,
        revocation: async () => {
          checked = true;
          return false;
        },
      }),
      status(403)
    );
    assert.equal(checked, false);
  });

  it('can treat unavailable revocation status as not revoked for reads', async () => {
    const [signer] = await verifyWebBotAuthRequest(signed(key), {
      keys,
      replayStore: new InMemoryReplayStore(),
      revocation: async () => {
        throw new Error('no list published');
      },
      requireRevocationStatus: false,
      now: () => 1001,
    });
    assert.equal(signer.origin, BUYER);
  });

  it('rejects a non-strict JSON body after the digest verifies', async () => {
    await assert.rejects(verify(signed(key, { body: '{"a":1,"a":2}' }), { keys }), status(400));
  });

  it('rejects repeated signature header lines when raw headers are available', async () => {
    const request = signed(key);
    request.rawHeaders = ['Signature-Agent', `sig1="${BUYER}"`, 'Signature-Agent', 'sig2="https://x.example"'];
    await assert.rejects(verify(request, { keys }), status(400));
  });

  it('gives a revoked key an authorization error without Accept-Signature', async () => {
    await assert.rejects(verify(signed(key), { keys, revocation: async () => true }), error => {
      assert.ok(error instanceof WebBotAuthAuthorizationError);
      assert.equal(error.status, 403);
      assert.deepEqual(error.headers, {});
      assert.equal(error.responseBody().errors[0].code, 'PERMISSION_DENIED');
      return true;
    });
  });

  it('fails closed when revocation status is unavailable', async () => {
    await assert.rejects(
      verify(signed(key), {
        keys,
        revocation: async () => {
          throw new Error('offline');
        },
      }),
      error => {
        assert.ok(error instanceof WebBotAuthAuthorizationError, 're-signing cannot help');
        assert.deepEqual(error.headers, {});
        return true;
      }
    );
  });

  it('checks revocation only after the signature verifies', async () => {
    let checked = false;
    const request = signed(key);
    request.body = '{"a":2}';
    await assert.rejects(
      verify(request, {
        keys,
        revocation: async () => {
          checked = true;
          return false;
        },
      }),
      status(403)
    );
    assert.equal(checked, false);
  });
});

describe('profile selection', () => {
  it('selects WBA from Signature-Agent or the tag, including when malformed', () => {
    assert.equal(usesWebBotAuth({ 'Signature-Agent': 'sig1="https://buyer.com"' }), true);
    assert.equal(usesWebBotAuth({ 'signature-input': 'sig1=("@method");tag="web-bot-auth"' }), true);
    assert.equal(usesWebBotAuth({ 'signature-input': 'sig1=("@method";tag="web-bot-auth"' }), true);
    assert.equal(usesWebBotAuth({ 'signature-input': 'sig1=("@method");tag="adcp/request-signing/v1"' }), false);
    assert.equal(usesWebBotAuth({}), false);
  });

  it('leaves the standalone RFC 9421 verifier unchanged: a WBA signature fails its tag check', async () => {
    const key = ed();
    const request = signed(key);
    await assert.rejects(
      verifyRequestSignature(request, {
        capability: { supported: true, covers_content_digest: 'either', required_for: [] },
        jwks: new StaticJwksResolver([
          { ...publicDirectoryKey(key), adcp_use: 'request-signing', alg: 'EdDSA', key_ops: ['verify'] },
        ]),
        replayStore: new InMemoryReplayStore(),
        revocationStore: new InMemoryRevocationStore(),
        now: () => 1001,
      }),
      error => error instanceof RequestSignatureError && error.code === 'request_signature_tag_invalid'
    );
  });

  it('does not emit Signature-Agent from the RFC 9421 signer', () => {
    const { signRequest } = require('../dist/lib/signing/signer.js');
    const { privateKey } = generateKeyPairSync('ed25519');
    const jwk = { ...privateKey.export({ format: 'jwk' }), kid: 'k', adcp_use: 'request-signing' };
    const result = signRequest(
      { method: 'POST', url: SELLER, headers: { 'content-type': 'application/json' }, body: '{}' },
      { keyid: 'k', alg: 'ed25519', privateKey: jwk },
      { binaryEncoding: 'rfc8941-base64' }
    );
    assert.equal(
      Object.keys(result.headers).some(name => name.toLowerCase() === 'signature-agent'),
      false
    );
    assert.doesNotMatch(result.headers['Signature-Input'], /signature-agent/);
  });
});

describe('createExpressVerifier({ webBotAuth })', () => {
  const { createExpressVerifier, OriginBindings, TrustRecordEvaluator } = require('../dist/lib/signing/server.js');
  const key = ed();
  // A real registrable domain: binding re-evaluates the operator's trust record.
  const AGENCY = 'https://buyer.agency.com';
  const keys = new StaticWebBotAuthKeys({ [AGENCY]: [publicDirectoryKey(key)] });
  const signedBy = body => signed(key, { body, origin: AGENCY });

  function run(verifier, request) {
    return new Promise(resolve => {
      const req = {
        method: request.method,
        url: '/mcp',
        originalUrl: '/mcp',
        headers: Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), v])),
        rawBody: request.body,
        protocol: 'https',
        get: name => (name.toLowerCase() === 'host' ? 'seller.example.com' : undefined),
      };
      const res = {
        status: code => ({
          set: (name, value) => ({ json: body => resolve({ status: code, header: [name, value], body }) }),
        }),
      };
      verifier(req, res, error => resolve({ next: true, error, signer: req.verifiedSigner }));
    });
  }

  const rpc = method => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} });
  const base = (webBotAuth, jwks = new StaticJwksResolver([])) =>
    createExpressVerifier({
      capability: { supported: true, covers_content_digest: 'either', required_for: [] },
      jwks,
      resolveOperation: () => undefined,
      now: () => 1001,
      webBotAuth: { keys, revocation: notRevoked, ...webBotAuth },
    });

  it('attaches identity on unboundFor JSON-RPC methods and is anonymous elsewhere', async () => {
    const allowed = await run(base({ unboundFor: ['tools/list'] }), signedBy(rpc('tools/list')));
    assert.equal(allowed.next, true);
    assert.equal(allowed.signer.profile, 'web-bot-auth');
    assert.equal(allowed.signer.principal_id, undefined);
    // Outside unboundFor an unbound origin proceeds as an anonymous caller.
    const anonymous = await run(base({ unboundFor: [] }), signedBy(rpc('tools/list')));
    assert.equal(anonymous.next, true);
    assert.equal(anonymous.signer, undefined);
    const rejected = await run(base({ unboundFor: [], unbound: 'reject' }), signedBy(rpc('tools/list')));
    assert.equal(rejected.status, 403);
    assert.equal(rejected.body.errors[0].code, 'PERMISSION_DENIED');
  });

  it('answers a body that does not resolve to one operation with 400', async () => {
    const { UNRESOLVABLE_OPERATION } = require('../dist/lib/signing/server.js');
    const verifier = createExpressVerifier({
      capability: { supported: true, covers_content_digest: 'either', required_for: [] },
      jwks: new StaticJwksResolver([]),
      resolveOperation: () => UNRESOLVABLE_OPERATION,
      now: () => 1001,
      webBotAuth: { keys, revocation: notRevoked },
    });
    const result = await run(verifier, signedBy('[1]'));
    assert.equal(result.status, 400);
  });

  it('binds only while the operator lists the origin', async () => {
    const bindings = new OriginBindings();
    bindings.bindSync(AGENCY, 'principal-1');
    let listed = true;
    let clock = 1001;
    const trustRecords = new TrustRecordEvaluator({
      now: () => clock,
      fetch: async () => ({
        status: 200,
        body: JSON.stringify({ agents: listed ? [{ url: AGENCY, roles: ['adcp:buying'] }] : [] }),
      }),
    });
    const verifier = base({ bindings, trustRecords });
    const ok = await run(verifier, signedBy(rpc('tools/call')));
    assert.equal(ok.signer.principal_id, 'principal-1');
    listed = false;
    clock += 61; // past the polling-interval cache
    const denied = await run(verifier, signedBy(rpc('tools/call')));
    assert.equal(denied.status, 403);
    assert.deepEqual(denied.header, ['Cache-Control', 'no-store'], 'authorization errors carry no Accept-Signature');
  });

  it('applies the unsigned-request rules to an anonymous (unbound) caller', async () => {
    const verifier = createExpressVerifier({
      capability: { supported: true, covers_content_digest: 'either', required_for: ['create_media_buy'] },
      jwks: new StaticJwksResolver([]),
      resolveOperation: () => 'create_media_buy',
      now: () => 1001,
      webBotAuth: { keys, revocation: notRevoked },
    });
    const result = await run(verifier, signedBy(rpc('tools/call')));
    assert.equal(result.status, 403);
    assert.equal(result.body.errors[0].code, 'PERMISSION_DENIED');
  });

  it('does not take a JSON-RPC method from a non-POST or non-envelope body', async () => {
    const { jsonRpcMethod } = require('../dist/lib/signing/wba/authorize.js');
    assert.equal(jsonRpcMethod('POST', rpc('get_adcp_capabilities')), 'get_adcp_capabilities');
    assert.equal(jsonRpcMethod('PUT', rpc('get_adcp_capabilities')), undefined);
    assert.equal(jsonRpcMethod('POST', '{"method":"get_adcp_capabilities"}'), undefined);
  });

  it('lets an unbound origin without a revocation list proceed as anonymous, but not a bound one', async () => {
    const unavailable = async () => {
      throw new Error('404: no list published');
    };
    const verifier = (bindings, operation) =>
      createExpressVerifier({
        capability: { supported: true, covers_content_digest: 'either', required_for: [] },
        jwks: new StaticJwksResolver([]),
        resolveOperation: () => operation,
        now: () => 1001,
        webBotAuth: {
          keys,
          revocation: unavailable,
          ...(bindings && { bindings }),
          trustRecords: new TrustRecordEvaluator({
            now: () => 1001,
            fetch: async () => ({
              status: 200,
              body: JSON.stringify({ agents: [{ url: AGENCY, roles: ['adcp:buying'] }] }),
            }),
          }),
        },
      });
    const anonymous = await run(verifier(undefined, 'create_media_buy'), signedBy(rpc('tools/call')));
    assert.equal(anonymous.next, true);
    assert.equal(anonymous.signer, undefined);
    const bindings = new OriginBindings();
    bindings.bindSync(AGENCY, 'principal-1');
    const read = await run(verifier(bindings, 'get_products'), signedBy(rpc('tools/call')));
    assert.equal(read.signer.principal_id, 'principal-1', 'reads proceed without current status');
    const spend = await run(verifier(bindings, 'create_media_buy'), signedBy(rpc('tools/call')));
    assert.equal(spend.status, 403);
    assert.equal(spend.body.errors[0].code, 'PERMISSION_DENIED');
  });

  it('reports an unbound origin to onIdentityEstablished once per minute, one call in flight', async () => {
    let calls = 0;
    let release;
    const hook = () => {
      calls++;
      return new Promise(resolve => (release = resolve));
    };
    const verifier = base({ onIdentityEstablished: hook });
    for (let i = 0; i < 5; i++) await run(verifier, signedBy(rpc('tools/call')));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    release();
    await new Promise(resolve => setImmediate(resolve));
    await run(verifier, signedBy(rpc('tools/call')));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1, 'deduped for a minute after completing');
  });
});

describe('RFC 9421 deprecation notice', () => {
  it('can be silenced for processes that run with --throw-deprecation', () => {
    const { spawnSync } = require('node:child_process');
    const script = `const s=require(${JSON.stringify(require.resolve('../dist/lib/signing/server.js'))});
s.createExpressVerifier({capability:{supported:true,covers_content_digest:'either',required_for:[]},jwks:new s.StaticJwksResolver([]),resolveOperation:()=>undefined});
setTimeout(()=>{},20);`;
    const quiet = spawnSync(process.execPath, ['--throw-deprecation', '-e', script], {
      env: { ...process.env, ADCP_SUPPRESS_RFC9421_DEPRECATION: '1' },
      encoding: 'utf8',
    });
    assert.equal(quiet.status, 0, quiet.stderr);
    assert.equal(quiet.stderr, '');
    const loud = spawnSync(process.execPath, ['-e', script], {
      env: { ...process.env, ADCP_SUPPRESS_RFC9421_DEPRECATION: '' },
      encoding: 'utf8',
    });
    assert.match(loud.stderr, /ADCP_RFC9421_VERIFICATION_PROFILE/);
  });
});
