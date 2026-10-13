#!/usr/bin/env node

const { generateKeyPairSync } = require('node:crypto');
const { readFileSync, writeFileSync, existsSync } = require('node:fs');
const path = require('node:path');

const {
  canonicalTargetUri,
  InMemoryReplayStore,
  InMemoryRevocationStore,
  RequestSignatureError,
  StaticJwksResolver,
  verifyRequestSignature,
} = require('../dist/lib/signing/index.js');
const { writeJsonOutput } = require('./adcp-json-stdout.js');

function generateKey(argv) {
  let alg = 'ed25519';
  let kid;
  let outPrivate;
  let outPublic;
  let profile = 'adcp/request-signing/v1';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--alg') alg = argv[++i];
    else if (a === '--profile') profile = argv[++i];
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
  if (profile === 'web-bot-auth') return generateWebBotAuthKey(alg, kid, outPrivate, outPublic);
  if (profile !== 'adcp/request-signing/v1') {
    console.error(`--profile must be adcp/request-signing/v1 or web-bot-auth (got ${profile})`);
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
  const vector = JSON.parse(readFileSync(vectorPath, 'utf8'));
  if (vector.signing_profile === 'web-bot-auth') {
    if (!keysPath) {
      console.error('Web Bot Auth vectors need --keys <wba-profile keys.json>.');
      process.exit(2);
    }
    return verifyWebBotAuthVector(vector, keysPath);
  }
  const keys = JSON.parse(readFileSync(keysJsonPath, 'utf8')).keys;
  const keysByKid = new Map(keys.map(k => [k.kid, k]));
  const now = vector.reference_now ?? Math.floor(Date.now() / 1000);

  const replayStore = new InMemoryReplayStore();
  const revocationStore = new InMemoryRevocationStore();
  const state = vector.test_harness_state ?? {};
  try {
    if (state.replay_cache_entries) {
      const scope = canonicalTargetUri(vector.request.url);
      for (const entry of state.replay_cache_entries) {
        replayStore.preload(entry.keyid, scope, entry.nonce, entry.ttl_seconds, now);
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

    const verified = await verifyRequestSignature(vector.request, {
      capability: vector.verifier_capability,
      jwks,
      replayStore,
      revocationStore,
      now: () => now,
      operation,
      adcpVersion: vector.signing_profile_version ?? '3.1',
    });
    await writeJsonOutput({ outcome: 'accepted', verified_signer: verified, operation });
    return { accepted: true };
  } catch (err) {
    if (err instanceof RequestSignatureError) {
      const payload = {
        outcome: 'rejected',
        error_code: err.code,
        failed_step: err.failedStep,
        message: err.message,
      };
      await writeJsonOutput(payload);
      return { accepted: false, code: err.code };
    }
    throw err;
  }
}

function loadIdentityModule() {
  return require('../dist/lib/signing/server.js');
}

// Experimental (AdCP 3.3): Web Bot Auth keys carry their RFC 7638 thumbprint
// as kid and no AdCP-specific members; purpose separation is by origin.
function generateWebBotAuthKey(alg, kid, outPrivate, outPublic) {
  const { publicDirectoryKey } = loadIdentityModule();
  const { privateKey } =
    alg === 'ed25519' ? generateKeyPairSync('ed25519') : generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const publicJwk = publicDirectoryKey(privateKey);
  if (kid && kid !== publicJwk.kid) {
    console.error(`--kid must be the key's RFC 7638 thumbprint under web-bot-auth; omit it to derive ${publicJwk.kid}`);
    process.exit(2);
  }
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  if (outPrivate) {
    writeFileSync(outPrivate, privatePem, { mode: 0o600 });
    console.log(`✔ Private key written: ${outPrivate}`);
  } else {
    process.stdout.write(privatePem);
  }
  const publicJson = JSON.stringify(publicJwk, null, 2);
  if (outPublic) {
    writeFileSync(outPublic, publicJson);
    console.log(`✔ Public directory key written: ${outPublic}`);
  } else {
    console.log('\n// Publish this key with `adcp signing key-directory` before signing with it:');
    console.log(publicJson);
  }
  console.log(`\n// kid (thumbprint): ${publicJwk.kid}`);
}

function parseFlags(argv, spec, help) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      help();
      process.exit(0);
    }
    const kind = spec[a];
    if (kind === 'list') (out[a] ??= []).push(argv[++i]);
    else if (kind === 'value') out[a] = argv[++i];
    else if (kind === 'flag') out[a] = true;
    else if (a.startsWith('--')) {
      console.error(`Unknown flag: ${a}`);
      help();
      process.exit(2);
    } else out._.push(a);
  }
  return out;
}

// Experimental (AdCP 3.3): generate, or re-sign before expiry, the signed
// key-directory response for /.well-known/http-message-signatures-directory.
async function keyDirectory(argv) {
  const flags = parseFlags(
    argv,
    {
      '--origin': 'value',
      '--key': 'list',
      '--expires-in': 'value',
      '--out-dir': 'value',
      '--renew-before': 'value',
      '--force': 'flag',
      '--json': 'flag',
    },
    printKeyDirectoryHelp
  );
  const origin = flags['--origin'];
  const keys = flags['--key'] ?? [];
  const outDir = flags['--out-dir'] ?? '.';
  if (!origin || keys.length === 0) {
    printKeyDirectoryHelp();
    process.exit(2);
  }
  const { signKeyDirectory, keyDirectoryNeedsRenewal, keyDirectoryExpiry } = loadIdentityModule();
  const bodyPath = path.join(outDir, 'http-message-signatures-directory');
  const headersPath = `${bodyPath}.headers.json`;
  const renewBefore = flags['--renew-before'] !== undefined ? Number(flags['--renew-before']) : 3600;
  if (!Number.isFinite(renewBefore) || renewBefore < 0) {
    console.error('--renew-before must be a non-negative number of seconds');
    process.exit(2);
  }
  if (!flags['--force'] && existsSync(headersPath) && existsSync(bodyPath)) {
    const headers = JSON.parse(readFileSync(headersPath, 'utf8'));
    if (!keyDirectoryNeedsRenewal(headers, { renewBeforeSeconds: renewBefore })) {
      const expires = keyDirectoryExpiry(headers);
      const result = { outcome: 'fresh', expires, expires_at: new Date(expires * 1000).toISOString() };
      if (flags['--json']) await writeJsonOutput(result);
      else console.log(`✔ Key directory is valid until ${result.expires_at}; not re-signed (use --force).`);
      return;
    }
  }
  const expiresIn = flags['--expires-in'] !== undefined ? Number(flags['--expires-in']) : 86400;
  const privateKeys = keys.map(file => readFileSync(file, 'utf8'));
  const directory = signKeyDirectory({ agentOrigin: origin, privateKeys, expiresInSeconds: expiresIn });
  writeFileSync(bodyPath, directory.body);
  writeFileSync(headersPath, JSON.stringify(directory.headers, null, 2) + '\n');
  const result = {
    outcome: 'signed',
    body: bodyPath,
    headers: headersPath,
    kids: directory.keys.map(key => key.kid),
    expires: directory.expires,
    expires_at: new Date(directory.expires * 1000).toISOString(),
  };
  if (flags['--json']) await writeJsonOutput(result);
  else {
    console.log(
      `✔ Signed ${result.kids.length} key(s); serve ${bodyPath} byte for byte with the headers in ${headersPath}.`
    );
    console.log(`  Re-sign before ${result.expires_at} (run this command on a schedule).`);
  }
}

async function verifyDirectory(argv) {
  const flags = parseFlags(argv, { '--origin': 'value', '--dir': 'value' }, printVerifyDirectoryHelp);
  const origin = flags['--origin'];
  const dir = flags['--dir'] ?? '.';
  if (!origin) {
    printVerifyDirectoryHelp();
    process.exit(2);
  }
  const { verifyKeyDirectoryResponse, WebBotAuthError } = loadIdentityModule();
  const bodyPath = path.join(dir, 'http-message-signatures-directory');
  try {
    const keys = verifyKeyDirectoryResponse(origin, {
      status: 200,
      headers: JSON.parse(readFileSync(`${bodyPath}.headers.json`, 'utf8')),
      body: readFileSync(bodyPath, 'utf8'),
    });
    await writeJsonOutput({ outcome: 'valid', kids: [...keys.keys()] });
    return true;
  } catch (err) {
    if (!(err instanceof WebBotAuthError)) throw err;
    await writeJsonOutput({ outcome: 'invalid', reason: err.reason });
    return false;
  }
}

// Experimental (AdCP 3.3): validate an authored trust.json for its host.
async function trustJson(argv) {
  const flags = parseFlags(argv, { '--operator-domain': 'value' }, printTrustJsonHelp);
  const [sub, file] = flags._;
  const operatorDomain = flags['--operator-domain'];
  if (sub !== 'validate' || !file || !operatorDomain) {
    printTrustJsonHelp();
    process.exit(2);
  }
  const { validateTrustRecord, TrustRecordError } = loadIdentityModule();
  try {
    validateTrustRecord(JSON.parse(readFileSync(file, 'utf8')), { operatorDomain });
    await writeJsonOutput({ outcome: 'valid', operator_domain: operatorDomain });
    return true;
  } catch (err) {
    if (!(err instanceof TrustRecordError) && !(err instanceof SyntaxError)) throw err;
    await writeJsonOutput({ outcome: 'invalid', reason: err.message });
    return false;
  }
}

async function verifyWebBotAuthVector(vector, keysJsonPath) {
  const { StaticWebBotAuthKeys, verifyWebBotAuthRequest, verifyKeyDirectoryResponse, WebBotAuthError } =
    loadIdentityModule();
  const now = vector.reference_now ?? Math.floor(Date.now() / 1000);
  try {
    if (vector.response) {
      const keys = verifyKeyDirectoryResponse(vector.request.url, vector.response, { now });
      await writeJsonOutput({ outcome: 'accepted', kids: [...keys.keys()] });
      return { accepted: true };
    }
    const all = JSON.parse(readFileSync(keysJsonPath, 'utf8')).keys;
    const directories = {};
    for (const [origin, entry] of Object.entries(vector.directories ?? {})) {
      directories[origin] = all.filter(key => (entry.keys_ref ?? []).includes(key.kid));
    }
    const replayStore = new InMemoryReplayStore();
    for (const entry of vector.test_harness_state?.replay_cache_entries ?? []) {
      replayStore.preload(entry.identity, 'web-bot-auth', entry.nonce, entry.ttl_seconds, now);
    }
    const signers = await verifyWebBotAuthRequest(vector.request, {
      keys: new StaticWebBotAuthKeys(directories),
      replayStore,
      revocation: async () => false,
      now: () => now,
    });
    await writeJsonOutput({
      outcome: 'accepted',
      identities: Object.fromEntries(signers.map(signer => [signer.label, signer.origin])),
    });
    return { accepted: true };
  } catch (err) {
    if (!(err instanceof WebBotAuthError)) throw err;
    await writeJsonOutput({
      outcome: 'rejected',
      status: err.status,
      reason: err.reason,
      ...(err.headers['Accept-Signature'] && { accept_signature: err.headers['Accept-Signature'] }),
    });
    return { accepted: false, code: err.status };
  }
}

function printKeyDirectoryHelp() {
  console.log(`Usage: adcp signing key-directory --origin <https-origin> --key <private.pem> [--key ...] [options]

EXPERIMENTAL (AdCP 3.3 Web Bot Auth). Generate the signed key-directory
response for <origin>/.well-known/http-message-signatures-directory, signed
once per key (WBA Appendix B.1). Writes the exact body and its headers. When
an existing directory is still valid beyond --renew-before, exits without
re-signing, so the command can run on a schedule.

Options:
  --origin <url>          The agent's HTTPS origin (one agent per origin).
  --key <path>            PKCS#8 private key PEM; repeat for several keys.
  --expires-in <seconds>  Signature lifetime (default 86400).
  --out-dir <dir>         Output directory (default .).
  --renew-before <secs>   Re-sign when expiry is this close (default 3600).
  --force                 Re-sign even when the current directory is valid.
  --json                  Print the result as JSON.
`);
}

function printVerifyDirectoryHelp() {
  console.log(`Usage: adcp signing verify-directory --origin <https-origin> [--dir <dir>]

EXPERIMENTAL (AdCP 3.3 Web Bot Auth). Verify a key-directory response written
by \`adcp signing key-directory\`: thumbprint kids, Content-Digest, and one
valid signature per key over the origin's authority.
`);
}

function printTrustJsonHelp() {
  console.log(`Usage: adcp signing trust-json validate <trust.json> --operator-domain <domain>

EXPERIMENTAL (AdCP 3.3). Validate an authored trust.json against the pinned
draft schema and the identity rules: no keys in agent entries, one agent per
canonical origin, every agent under the operator's registrable domain, and
grantees as exact registrable domains.
`);
}

function printGenerateHelp() {
  console.log(`Usage: adcp signing generate-key [options]

Generate an Ed25519 (default) or P-256 keypair for AdCP request signing.
Writes or prints a PEM-encoded PKCS#8 private key + a one-key JWKS you can
publish at your agent's jwks_uri.

Options:
  --alg <ed25519|es256>   Signature algorithm (default: ed25519).
  --profile <id>          adcp/request-signing/v1 (default) or web-bot-auth
                          (experimental; kid is the key's RFC 7638 thumbprint).
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
  verify-vector      Run one RFC 9421 (or Web Bot Auth) test vector through the verifier.
  key-directory      Generate or re-sign a Web Bot Auth key directory (experimental).
  verify-directory   Verify a Web Bot Auth key directory (experimental).
  trust-json         Validate an authored trust.json (experimental).
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
  if (sub === 'key-directory') return keyDirectory(rest);
  if (sub === 'verify-directory') process.exit((await verifyDirectory(rest)) ? 0 : 1);
  if (sub === 'trust-json') process.exit((await trustJson(rest)) ? 0 : 1);
  console.error(`Unknown signing subcommand: ${sub}`);
  printSigningHelp();
  process.exit(2);
}

module.exports = { handleSigningCommand };
