// ES256 / Ed25519 signing and verification on edge runtimes (#3243): the
// SDK's RFC 9421 and Web Bot Auth paths run inside Cloudflare workerd (the
// `workerd` binary), and the WebCrypto and node:crypto fallbacks agree in Node.
process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { builtinModules } = require('node:module');
const { generateKeyPairSync } = require('node:crypto');
const signingCrypto = require('../../dist/lib/signing/crypto');

const ROOT = path.resolve(__dirname, '../..');
const VECTORS = path.join(ROOT, 'compliance/cache/latest/test-vectors/request-signing');
const WEBHOOK_KEYS = path.join(ROOT, 'test/fixtures/webhook-signing-vectors/keys.json');

function withoutWebCrypto(fn) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
  return Promise.resolve()
    .then(fn)
    .finally(() => Object.defineProperty(globalThis, 'crypto', descriptor));
}

test('ES256 and Ed25519 sign/verify agree across WebCrypto and the node:crypto fallback', async () => {
  const data = Buffer.from('signature base');
  for (const [alg, pair] of [
    ['ecdsa-p256-sha256', generateKeyPairSync('ec', { namedCurve: 'prime256v1' })],
    ['ed25519', generateKeyPairSync('ed25519')],
  ]) {
    const privateJwk = pair.privateKey.export({ format: 'jwk' });
    const viaSubtle = await signingCrypto.signWithPrivateJwkAsync(alg, privateJwk, data);
    const viaNode = signingCrypto.signWithPrivateJwk(alg, privateJwk, data);
    for (const signature of [viaSubtle, viaNode]) {
      if (alg === 'ecdsa-p256-sha256') assert.equal(signature.length, 64, 'IEEE P1363 r||s');
      assert.equal(signingCrypto.verifySignature(alg, pair.publicKey, data, signature), true);
      assert.equal(await signingCrypto.verifySignatureAsync(alg, pair.publicKey, data, signature), true);
      await withoutWebCrypto(async () =>
        assert.equal(await signingCrypto.verifySignatureAsync(alg, pair.publicKey, data, signature), true)
      );
    }
    await withoutWebCrypto(async () => {
      const fallback = await signingCrypto.signWithPrivateJwkAsync(alg, privateJwk, data);
      assert.equal(signingCrypto.verifySignature(alg, pair.publicKey, data, fallback), true);
    });
    const tampered = Buffer.from('signature basf');
    assert.equal(await signingCrypto.verifySignatureAsync(alg, pair.publicKey, tampered, viaSubtle), false);
    // The JWK form verifies the same way as the KeyObject form.
    const publicJwk = pair.publicKey.export({ format: 'jwk' });
    assert.equal(await signingCrypto.verifySignatureAsync(alg, publicJwk, data, viaSubtle), true);
    // Malformed signatures fail on both paths alike.
    for (const bad of [
      viaSubtle.subarray(1),
      Buffer.concat([viaSubtle, Buffer.from([0])]),
      new Uint8Array(64),
      new Uint8Array(0),
    ])
      assert.equal(
        await signingCrypto.verifySignatureAsync(alg, pair.publicKey, data, bad),
        signingCrypto.verifySignature(alg, pair.publicKey, data, bad)
      );
  }
});

function workerSource(distRoot) {
  const imp = file => JSON.stringify(path.join(distRoot, file));
  return `
import {
  verifyRequestSignature, StaticJwksResolver, InMemoryReplayStore, InMemoryRevocationStore,
  signRequest, signRequestAsync, signWebhook, verifyWebhookSignature,
} from ${imp('signing/index.mjs')};
import { InMemorySigningProvider } from ${imp('signing/testing.mjs')};
import * as wba from ${imp('signing/web-bot-auth.mjs')};
export default { async fetch(req) {
  const input = await req.json();
  const out = {};
  const run = async (name, f) => {
    try { out[name] = await f(); } catch (e) { out[name] = 'THROW ' + (e && (e.code || e.reason || e.message)); }
  };
  const opts = (jwks, now, extra = {}) => ({
    capability: { supported: true, covers_content_digest: 'either', required_for: [] },
    jwks: new StaticJwksResolver(jwks), replayStore: new InMemoryReplayStore(),
    revocationStore: new InMemoryRevocationStore(), now: () => now, operation: 'create_media_buy',
    adcpVersion: '3.1', ...extra,
  });
  for (const v of input.vectors)
    await run('tampered ' + v.id, async () => {
      const sig = v.request.headers.Signature;
      const flipped = sig.replace(/:([A-Za-z0-9+/_-])/, (m, c) => ':' + (c === 'A' ? 'B' : 'A'));
      const request = { ...v.request, headers: { ...v.request.headers, Signature: flipped } };
      return (await verifyRequestSignature(request, opts(input.publicKeys.filter(k => v.jwks_ref.includes(k.kid)), v.reference_now))).status;
    });
  for (const v of input.vectors)
    await run('vector ' + v.id, async () =>
      (await verifyRequestSignature(v.request, opts(input.publicKeys.filter(k => v.jwks_ref.includes(k.kid)), v.reference_now))).status);
  const request = { method: 'POST', url: 'https://seller.example.com/adcp/create_media_buy',
    headers: { 'Content-Type': 'application/json' }, body: '{"plan_id":"plan_001"}' };
  for (const key of input.requestKeys) {
    const signer = { keyid: key.kid, alg: key.alg, privateKey: key.privateJwk };
    await run('signRequest ' + key.alg, async () => {
      const signed = signRequest(request, signer, { now: () => input.now });
      return (await verifyRequestSignature({ ...request, headers: signed.headers }, opts([key.publicJwk], input.now))).status;
    });
    await run('signRequestAsync ' + key.alg, async () => {
      const provider = new InMemorySigningProvider({ keyid: key.kid, algorithm: key.alg, privateKey: key.privateJwk });
      const signed = await signRequestAsync(request, provider, { now: () => input.now });
      return (await verifyRequestSignature({ ...request, headers: signed.headers }, opts([key.publicJwk], input.now))).status;
    });
  }
  for (const key of input.webhookKeys)
    await run('webhook ' + key.alg, async () => {
      const webhook = { method: 'POST', url: 'https://buyer.example.com/adcp/webhook/create_media_buy/a/op',
        headers: { 'Content-Type': 'application/json' }, body: '{"idempotency_key":"whk_01HW9D3H8FZP2N6R8T0V4X6Z9B"}' };
      const signed = signWebhook(webhook, { keyid: key.kid, alg: key.alg, privateKey: key.privateJwk }, { now: () => input.now });
      const result = await verifyWebhookSignature({ ...webhook, headers: { ...webhook.headers, ...signed.headers } }, {
        jwks: new StaticJwksResolver([key.publicJwk]), replayStore: new InMemoryReplayStore(),
        revocationStore: new InMemoryRevocationStore(), now: () => input.now });
      return result.status;
    });
  for (const key of input.wbaKeys)
    await run('web-bot-auth ' + key.alg, async () => {
      const origin = 'https://buyer.agency.com';
      const privateKey = { ...key.privateJwk, kid: wba.jwkThumbprint(key.privateJwk) };
      const proof = await wba.createSignedSignatureDirectory(origin, [{ privateKey }], { now: () => input.now });
      const directory = new wba.SignatureDirectoryResolver({ now: () => input.now, fetchOptions: {
        trustedFetchFn: async () => new Response(proof.body, { status: 200, headers: proof.headers }) } });
      const wbaRequest = { method: 'POST', url: 'https://seller.example.com/mcp', headers: { 'content-type': 'application/json' }, body: '{"a":1}' };
      const headers = await wba.signWebBotAuth(wbaRequest, { privateKey }, { origin, now: () => input.now });
      const signers = await wba.verifyWebBotAuth({ ...wbaRequest, headers }, {
        directory, replayStore: new InMemoryReplayStore(), isRevoked: async () => false, now: () => input.now });
      return signers[0].origin === origin ? 'verified' : 'wrong origin';
    });
  return Response.json(out);
} };`;
}

test(
  'RFC 9421 (ES256/Ed25519) and Web Bot Auth (Ed25519/RSA-PSS) sign and verify inside Cloudflare workerd',
  { timeout: 120_000 },
  async t => {
    const esbuild = require('esbuild');
    let workerdBinary;
    try {
      workerdBinary = require('workerd').default;
      if (!fs.existsSync(workerdBinary)) throw new Error('missing binary');
    } catch {
      t.skip('the workerd binary is not available on this platform');
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-workerd-'));
    const entry = path.join(dir, 'worker.mjs');
    fs.writeFileSync(entry, workerSource(path.join(ROOT, 'dist/lib')));
    const nodePrefix = {
      name: 'node-builtins',
      setup(build) {
        // workerd has no undici. The worker serves key directories through
        // trustedFetchFn, which never reaches the SSRF-guarded undici fetch.
        build.onResolve({ filter: /^undici$/ }, () => ({ path: 'undici', namespace: 'undici-stub' }));
        build.onLoad({ filter: /.*/, namespace: 'undici-stub' }, () => ({
          contents: 'export class Agent {} export class Request {} export const fetch = undefined;',
          loader: 'js',
        }));
        build.onResolve({ filter: /.*/ }, args => {
          const name = args.path.replace(/^node:/, '');
          if (builtinModules.includes(name)) return { path: `node:${name}`, external: true };
          return undefined;
        });
      },
    };
    const bundle = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      format: 'esm',
      platform: 'node',
      write: false,
      logLevel: 'error',
      plugins: [nodePrefix],
    });
    fs.rmSync(dir, { recursive: true, force: true });

    const keys = JSON.parse(fs.readFileSync(path.join(VECTORS, 'keys.json'), 'utf8')).keys;
    const publicKeys = keys.map(({ _private_d_for_test_only, ...publicJwk }) => publicJwk);
    const withPrivate = (entry, alg) => {
      const { _private_d_for_test_only: d, ...publicJwk } = entry;
      return { kid: entry.kid, alg, publicJwk, privateJwk: { ...publicJwk, d } };
    };
    const requestKeys = [
      withPrivate(
        keys.find(k => k.kid === 'test-ed25519-2026'),
        'ed25519'
      ),
      withPrivate(
        keys.find(k => k.kid === 'test-es256-2026'),
        'ecdsa-p256-sha256'
      ),
    ];
    const webhookFixture = JSON.parse(fs.readFileSync(WEBHOOK_KEYS, 'utf8')).keys;
    const webhookKeys = [
      withPrivate(
        webhookFixture.find(k => k.kid === 'test-ed25519-webhook-2026'),
        'ed25519'
      ),
      withPrivate(
        webhookFixture.find(k => k.kid === 'test-es256-webhook-2026'),
        'ecdsa-p256-sha256'
      ),
    ];
    const wbaKeys = [
      { alg: 'ed25519', privateJwk: generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }) },
      // ES256 is not a Web Bot Auth algorithm (adcp#7894); RSA-PSS-SHA512 is.
      {
        alg: 'rsa-pss-sha512',
        privateJwk: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' }),
      },
    ];
    const vectors = ['001-basic-post', '003-es256-post'].map(id => ({
      id,
      ...JSON.parse(fs.readFileSync(path.join(VECTORS, 'positive', `${id}.json`), 'utf8')),
    }));

    const worker = await startWorkerd(workerdBinary, bundle.outputFiles[0].text);
    try {
      const response = await fetch(worker.url, {
        method: 'POST',
        body: JSON.stringify({
          vectors,
          publicKeys,
          requestKeys,
          webhookKeys,
          wbaKeys,
          now: Math.floor(Date.now() / 1000),
        }),
      });
      const results = await response.json();
      assert.deepEqual(results, {
        'tampered 001-basic-post': 'THROW request_signature_invalid',
        'tampered 003-es256-post': 'THROW request_signature_invalid',
        'vector 001-basic-post': 'verified',
        'vector 003-es256-post': 'verified',
        'signRequest ed25519': 'verified',
        'signRequestAsync ed25519': 'verified',
        'signRequest ecdsa-p256-sha256': 'verified',
        'signRequestAsync ecdsa-p256-sha256': 'verified',
        'webhook ed25519': 'verified',
        'webhook ecdsa-p256-sha256': 'verified',
        'web-bot-auth ed25519': 'verified',
        'web-bot-auth rsa-pss-sha512': 'verified',
      });
    } finally {
      worker.stop();
    }
  }
);

/** Serve one ES module with `workerd serve` on a free local port (compat date 2024-11-01, nodejs_compat). */
async function startWorkerd(binary, moduleSource) {
  const { spawn } = require('node:child_process');
  const net = require('node:net');
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port: free } = server.address();
      server.close(() => resolve(free));
    });
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-workerd-'));
  fs.writeFileSync(path.join(dir, 'worker.mjs'), moduleSource);
  fs.writeFileSync(
    path.join(dir, 'config.capnp'),
    `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [(name = "main", worker = .worker)],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")],
);
const worker :Workerd.Worker = (
  modules = [(name = "worker", esModule = embed "worker.mjs")],
  compatibilityDate = "2024-11-01",
  compatibilityFlags = ["nodejs_compat"],
);
`
  );
  const child = spawn(binary, ['serve', path.join(dir, 'config.capnp')], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => (stderr += chunk));
  const stop = () => {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const url = `http://127.0.0.1:${port}/`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) break;
    try {
      await fetch(url, { method: 'HEAD' });
      return { url, stop };
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  stop();
  throw new Error(`workerd did not start: ${stderr}`);
}
