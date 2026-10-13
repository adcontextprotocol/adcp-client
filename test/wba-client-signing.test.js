/**
 * Experimental AdCP 3.3 Web Bot Auth signing on the buyer side: opt-in
 * only, thumbprint kid, seller profile advertisement required, no silent
 * downgrade, and the RFC 9421 deprecation notice.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { buildAgentSigningFetch, publicDirectoryKey, WEB_BOT_AUTH_TAG } = require('../dist/lib/signing/client.js');
const { InMemoryReplayStore, StaticWebBotAuthKeys, verifyWebBotAuthRequest } = require('../dist/lib/signing/server.js');
const { buildDirectSigningFetch } = require('../dist/lib/signing/agent-fetch.js');
const { _resetRfc9421DeprecationWarnings } = require('../dist/lib/signing/wba/deprecation.js');

const ORIGIN = 'https://buyer.agency.com';
const privateKey = generateKeyPairSync('ed25519').privateKey;
const privateJwk = privateKey.export({ format: 'jwk' });
const kid = publicDirectoryKey(privateKey).kid;
const BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'create_media_buy', arguments: {} },
});

function capture() {
  const sent = [];
  const upstream = async (url, init) => {
    sent.push({ url, init });
    return new Response('{}', { status: 200 });
  };
  return { sent, upstream };
}

const wbaSigning = (overrides = {}) => ({
  kid,
  alg: 'ed25519',
  private_key: privateJwk,
  agent_url: `${ORIGIN}/mcp`,
  profile: 'web-bot-auth',
  ...overrides,
});

describe('buildAgentSigningFetch with profile web-bot-auth', () => {
  it('signs a verifiable WBA request when the seller advertises the profile', async () => {
    const { sent, upstream } = capture();
    const fetch = buildAgentSigningFetch({
      upstream,
      signing: wbaSigning(),
      getCapability: () => ({
        requestSigning: {
          supported: true,
          covers_content_digest: 'required',
          required_for: ['create_media_buy'],
          profiles: ['adcp/request-signing/v1', WEB_BOT_AUTH_TAG],
        },
      }),
    });
    await fetch('https://seller.example.com/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: BODY,
    });
    assert.equal(sent.length, 1);
    const headers = sent[0].init.headers;
    assert.equal(headers['Signature-Agent'], `sig1="${ORIGIN}"`);
    assert.match(headers['Signature-Input'], /tag="web-bot-auth"/);
    assert.match(headers['Signature-Input'], /"signature-agent";key="sig1"/);
    const [signer] = await verifyWebBotAuthRequest(
      { method: 'POST', url: 'https://seller.example.com/mcp', headers, body: BODY },
      {
        keys: new StaticWebBotAuthKeys({ [ORIGIN]: [publicDirectoryKey(privateKey)] }),
        replayStore: new InMemoryReplayStore(),
        revocation: async () => false,
      }
    );
    assert.equal(signer.origin, ORIGIN);
    assert.equal(signer.keyid, kid);
  });

  it('refuses before sending when the seller does not list web-bot-auth (no silent downgrade)', async () => {
    for (const requestSigning of [
      { supported: true, covers_content_digest: 'required', required_for: ['create_media_buy'] },
      {
        supported: true,
        covers_content_digest: 'required',
        required_for: ['create_media_buy'],
        profiles: ['adcp/request-signing/v1'],
      },
    ]) {
      const { sent, upstream } = capture();
      const fetch = buildAgentSigningFetch({
        upstream,
        signing: wbaSigning(),
        getCapability: () => ({ requestSigning }),
      });
      await assert.rejects(
        fetch('https://seller.example.com/mcp', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: BODY,
        }),
        /does not advertise request-signing profile 'web-bot-auth'/
      );
      assert.equal(sent.length, 0);
    }
  });

  it('passes unsigned requests through unchanged when the operation needs no signature', async () => {
    const { sent, upstream } = capture();
    const fetch = buildAgentSigningFetch({ upstream, signing: wbaSigning(), getCapability: () => undefined });
    const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: BODY };
    await fetch('https://seller.example.com/mcp', init);
    assert.equal(sent[0].init, init);
  });

  it('requires the kid to be the key thumbprint and an HTTPS agent origin', () => {
    assert.throws(
      () => buildAgentSigningFetch({ signing: wbaSigning({ kid: 'my-key-2026' }), getCapability: () => undefined }),
      /thumbprint/
    );
    assert.throws(
      () =>
        buildAgentSigningFetch({
          signing: wbaSigning({ agent_url: 'http://buyer.agency.com' }),
          getCapability: () => undefined,
        }),
      /HTTPS/
    );
  });

  it('signs protocol methods (A2A tasks/cancel) under the configured profile', async () => {
    const { sent, upstream } = capture();
    await buildDirectSigningFetch(upstream, wbaSigning())('https://seller.example.com/a2a', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"jsonrpc":"2.0","id":1,"method":"tasks/cancel","params":{"id":"t"}}',
    });
    assert.equal(sent[0].init.headers['Signature-Agent'], `sig1="${ORIGIN}"`);
  });
});

describe('RFC 9421 profile deprecation notice', () => {
  it('warns once per process for RFC 9421 signing configuration, never for WBA', async () => {
    _resetRfc9421DeprecationWarnings();
    const warnings = [];
    const onWarning = warning => warnings.push(warning);
    process.on('warning', onWarning);
    try {
      buildAgentSigningFetch({ signing: wbaSigning(), getCapability: () => undefined });
      const legacyKey = { ...privateJwk, kid: 'legacy', adcp_use: 'request-signing' };
      const legacy = { kid: 'legacy', alg: 'ed25519', private_key: legacyKey, agent_url: ORIGIN };
      buildAgentSigningFetch({ signing: legacy, getCapability: () => undefined });
      buildAgentSigningFetch({ signing: legacy, getCapability: () => undefined });
      await new Promise(resolve => setImmediate(resolve));
    } finally {
      process.off('warning', onWarning);
    }
    const ours = warnings.filter(warning => warning.code === 'ADCP_RFC9421_SIGNING_PROFILE');
    assert.equal(ours.length, 1);
    assert.equal(ours[0].name, 'DeprecationWarning');
  });

  it('warns once for RFC 9421-only verifier configuration', async () => {
    _resetRfc9421DeprecationWarnings();
    const { createExpressVerifier, StaticJwksResolver } = require('../dist/lib/signing/server.js');
    const warnings = [];
    const onWarning = warning => warnings.push(warning);
    process.on('warning', onWarning);
    try {
      const base = {
        capability: { supported: true, covers_content_digest: 'either', required_for: [] },
        jwks: new StaticJwksResolver([]),
        resolveOperation: () => undefined,
      };
      createExpressVerifier({
        ...base,
        webBotAuth: { keys: new StaticWebBotAuthKeys({}), revocation: async () => false },
      });
      createExpressVerifier(base);
      createExpressVerifier(base);
      await new Promise(resolve => setImmediate(resolve));
    } finally {
      process.off('warning', onWarning);
    }
    assert.equal(warnings.filter(warning => warning.code === 'ADCP_RFC9421_VERIFICATION_PROFILE').length, 1);
  });
});

describe('Web Bot Auth signing fetch body bytes', () => {
  it('signs a UTF-8 BOM body over the exact bytes it sends', async () => {
    const { createWebBotAuthSigningFetch } = require('../dist/lib/signing/wba/fetch.js');
    const { createHash } = require('node:crypto');
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from('{"a":1}')]);
    let sent;
    const fetch = createWebBotAuthSigningFetch(
      async (_url, init) => {
        sent = init;
        return new Response('');
      },
      { privateKey },
      { agentOrigin: ORIGIN }
    );
    await fetch('https://seller.example.com/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: bytes,
    });
    const digest = `sha-256=:${createHash('sha256').update(Buffer.from(sent.body)).digest('base64')}:`;
    assert.equal(sent.headers['Content-Digest'], digest);
  });
});
