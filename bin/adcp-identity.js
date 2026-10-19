'use strict';
const { readFileSync, writeFileSync } = require('node:fs');
const { parseStrictJson } = require('../dist/lib/signing/agent-resolver/strict-json.js');
const {
  createSignedSignatureDirectory,
  createSignedOriginRevocationList,
  assertPublishableTrustRecord,
} = require('../dist/lib/identity-3.3/index.js');

async function handleIdentityCommand(args) {
  const command = args[0];
  const option = name => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  if (command === 'trust-validate') {
    if (!args[1]) throw new Error('Usage: adcp identity trust-validate trust.json');
    const bytes = readFileSync(args[1]);
    if (bytes.length > 2 * 1024 * 1024) throw new Error('trust.json exceeds 2 MiB');
    // Publication rules, not only the schema: a non-registrable grantee grants nothing.
    assertPublishableTrustRecord(parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes), 32));
    process.stdout.write('Valid experimental trust v1 record\n');
    return;
  }
  if (command === 'revocations') {
    const origin = option('--origin'),
      keyFile = option('--keys'),
      output = option('--output'),
      snapshotFile = option('--snapshot');
    if (!origin || !keyFile || !output)
      throw new Error(
        'Usage: adcp identity revocations --origin https://agent.example.com --keys private-jwks.json --output revocations.jws [--snapshot revocations.json]'
      );
    const input = parseStrictJson(readFileSync(keyFile, 'utf8'), 32);
    if (!input?.keys?.length) throw new Error('Key file must contain a private JWK Set');
    const now = Date.now();
    const snapshot = snapshotFile
      ? parseStrictJson(readFileSync(snapshotFile, 'utf8'), 32)
      : {
          issuer: origin,
          updated: new Date(now).toISOString(),
          next_update: new Date(now + 300000).toISOString(),
          revoked_kids: [],
        };
    if (snapshot.issuer !== origin) throw new Error('Snapshot issuer must match --origin');
    const body = await createSignedOriginRevocationList(snapshot, input.keys[0]);
    writeFileSync(output, body + '\n', { mode: 0o600 });
    process.stdout.write(
      'Signed list written; serve at /.well-known/governance-revocations.json and refresh before next_update.\n'
    );
    return;
  }
  if (command === 'directory') {
    const origin = option('--origin'),
      keyFile = option('--keys'),
      output = option('--output');
    if (!origin || !keyFile || !output)
      throw new Error(
        'Usage: adcp identity directory --origin https://agent.example.com --keys private-jwks.json --output directory-response.json'
      );
    const input = parseStrictJson(readFileSync(keyFile, 'utf8'), 32);
    if (!input || !Array.isArray(input.keys)) throw new Error('Key file must contain a private JWK Set');
    const response = await createSignedSignatureDirectory(
      origin,
      input.keys.map(privateKey => ({ privateKey }))
    );
    writeFileSync(output, JSON.stringify(response, null, 2) + '\n', { mode: 0o600 });
    process.stdout.write(
      'Signed directory response written; serve its exact body and headers at the well-known path.\n'
    );
    return;
  }
  throw new Error('Identity commands: trust-validate, revocations, directory (generate or re-sign after rotation)');
}
module.exports = { handleIdentityCommand };
