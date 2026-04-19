#!/usr/bin/env node

const { generateKeyPairSync } = require('node:crypto');
const { readFileSync, writeFileSync, existsSync } = require('node:fs');
const path = require('node:path');

const {
  InMemoryReplayStore,
  InMemoryRevocationStore,
  RequestSignatureError,
  StaticJwksResolver,
  verifyRequestSignature,
} = require('../dist/lib/signing/index.js');

function generateKey(argv) {
  let alg = 'ed25519';
  let kid;
  let outPrivate;
  let outPublic;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--alg') alg = argv[++i];
    else if (a === '--kid') kid = argv[++i];
    else if (a === '--out' || a === '--private-out') outPrivate = argv[++i];
    else if (a === '--public-out' || a === '--jwk-out') outPublic = argv[++i];
    else if (a === '--help' || a === '-h') {
      printGenerateHelp();
      process.exit(0);
    } else {
      console.error(`Unknown flag: ${a}`);
      printGenerateHelp();
      process.exit(2);
    }
  }
  if (alg !== 'ed25519' && alg !== 'es256') {
    console.error(`--alg must be ed25519 or es256 (got ${alg})`);
    process.exit(2);
  }
  if (!kid) {
    const year = new Date().getUTCFullYear();
    kid = `adcp-${alg}-${year}`;
  }

  const { publicKey, privateKey } =
    alg === 'ed25519' ? generateKeyPairSync('ed25519') : generateKeyPairSync('ec', { namedCurve: 'P-256' });

  const jwkAlg = alg === 'ed25519' ? 'EdDSA' : 'ES256';
  const privateJwk = privateKey.export({ format: 'jwk' });
  const publicJwk = publicKey.export({ format: 'jwk' });
  publicJwk.kid = kid;
  publicJwk.alg = jwkAlg;
  publicJwk.use = 'sig';
  publicJwk.key_ops = ['verify'];
  publicJwk.adcp_use = 'request-signing';

  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });

  if (outPrivate) {
    writeFileSync(outPrivate, privatePem, { mode: 0o600 });
    console.log(`✔ Private key written: ${outPrivate}`);
  } else {
    process.stdout.write(privatePem);
  }

  const publicJson = JSON.stringify({ keys: [publicJwk] }, null, 2);
  if (outPublic) {
    writeFileSync(outPublic, publicJson);
    console.log(`✔ JWKS written: ${outPublic}`);
  } else {
    console.log('\n// Publish this JWKS at the jwks_uri of your agents[] entry:');
    console.log(publicJson);
  }
  // Print the private JWK to stdout ONLY when the user explicitly wants it
  // rendered (no --private-out). Otherwise the private key has already been
  // written to a 0600 file and we must not leak it into terminal/shell history.
  if (!outPrivate) {
    privateJwk.kid = kid;
    privateJwk.alg = jwkAlg;
    privateJwk.use = 'sig';
    privateJwk.key_ops = ['sign'];
    privateJwk.adcp_use = 'request-signing';
    console.log(
      `\n// Private JWK (keep secret — load via { signing_key, keyid: "${kid}", alg: "${alg === 'ed25519' ? 'ed25519' : 'ecdsa-p256-sha256'}" }):`
    );
    console.log(JSON.stringify(privateJwk, null, 2));
  }
}

async function verifyVector(argv) {
  let vectorPath;
  let keysPath;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--vector') vectorPath = argv[++i];
    else if (a === '--keys') keysPath = argv[++i];
    else if (a === '--help' || a === '-h') {
      printVerifyHelp();
      process.exit(0);
    } else if (!vectorPath) vectorPath = a;
    else {
      console.error(`Unknown argument: ${a}`);
      printVerifyHelp();
      process.exit(2);
    }
  }
  if (!vectorPath) {
    printVerifyHelp();
    process.exit(2);
  }
  if (!existsSync(vectorPath)) {
    console.error(`Vector file not found: ${vectorPath}`);
    process.exit(2);
  }
  const defaultKeys = path.join(
    __dirname,
    '..',
    'compliance',
    'cache',
    'latest',
    'test-vectors',
    'request-signing',
    'keys.json'
  );
  const keysJsonPath = keysPath ?? (existsSync(defaultKeys) ? defaultKeys : null);
  if (!keysJsonPath) {
    console.error(
      'No --keys file provided and no default spec keys.json found. Run `npm run sync-schemas` first, or pass --keys <path>.'
    );
    process.exit(2);
  }
  const keys = JSON.parse(readFileSync(keysJsonPath, 'utf8')).keys;
  const keysByKid = new Map(keys.map(k => [k.kid, k]));
  const vector = JSON.parse(readFileSync(vectorPath, 'utf8'));
  const now = vector.reference_now ?? Math.floor(Date.now() / 1000);

  const replayStore = new InMemoryReplayStore();
  const revocationStore = new InMemoryRevocationStore();
  const state = vector.test_harness_state ?? {};
  if (state.replay_cache_entries) {
    for (const entry of state.replay_cache_entries) {
      replayStore.preload(entry.keyid, entry.nonce, entry.ttl_seconds, now);
    }
  }
  if (state.revocation_list) revocationStore.load(state.revocation_list);
  if (state.replay_cache_per_keyid_cap_hit) {
    replayStore.setCapHitForTesting(state.replay_cache_per_keyid_cap_hit.keyid);
  }

  const jwksEntries = vector.jwks_override
    ? vector.jwks_override.keys
    : (vector.jwks_ref ?? []).map(kid => keysByKid.get(kid)).filter(Boolean);
  const jwks = new StaticJwksResolver(jwksEntries);
  const operation = new URL(vector.request.url).pathname.split('/').filter(Boolean).pop();

  try {
    const verified = await verifyRequestSignature(vector.request, {
      capability: vector.verifier_capability,
      jwks,
      replayStore,
      revocationStore,
      now: () => now,
      operation,
    });
    console.log(JSON.stringify({ outcome: 'accepted', verified_signer: verified, operation }, null, 2));
    return { accepted: true };
  } catch (err) {
    if (err instanceof RequestSignatureError) {
      const payload = {
        outcome: 'rejected',
        error_code: err.code,
        failed_step: err.failedStep,
        message: err.message,
      };
      console.log(JSON.stringify(payload, null, 2));
      return { accepted: false, code: err.code };
    }
    throw err;
  }
}

function printGenerateHelp() {
  console.log(`Usage: adcp signing generate-key [options]

Generate an Ed25519 (default) or P-256 keypair for AdCP request signing.
Writes or prints a PEM-encoded PKCS#8 private key + a one-key JWKS you can
publish at your agent's jwks_uri.

Options:
  --alg <ed25519|es256>   Signature algorithm (default: ed25519).
  --kid <value>           JWK kid. Default: adcp-<alg>-<year>.
  --private-out <path>    Write private PEM to a file (mode 0600) instead of stdout.
  --public-out <path>     Write JWKS JSON to a file instead of stdout.
  -h, --help              Show this help.
`);
}

function printVerifyHelp() {
  console.log(`Usage: adcp signing verify-vector --vector <path> [--keys <keys.json>]

Run a single RFC 9421 test vector through the AdCP verifier. Useful for
debugging conformance failures against the spec's positive/negative vectors
at compliance/cache/latest/test-vectors/request-signing/.

If --keys is omitted, defaults to the bundled spec keys.json.
`);
}

function printSigningHelp() {
  console.log(`Usage: adcp signing <subcommand>

Subcommands:
  generate-key       Generate an Ed25519/P-256 keypair + JWKS for publication.
  verify-vector      Run one RFC 9421 test vector through the verifier.
`);
}

async function handleSigningCommand(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printSigningHelp();
    process.exit(0);
  }
  const [sub, ...rest] = argv;
  if (sub === 'generate-key') return generateKey(rest);
  if (sub === 'verify-vector') {
    const result = await verifyVector(rest);
    process.exit(result.accepted ? 0 : 1);
  }
  console.error(`Unknown signing subcommand: ${sub}`);
  printSigningHelp();
  process.exit(2);
}

module.exports = { handleSigningCommand };
