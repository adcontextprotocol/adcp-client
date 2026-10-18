#!/usr/bin/env node
// Web Bot Auth interop adapter for the adcp repository's harness
// (tests/wba-interop/ in adcontextprotocol/adcp). The harness grades this SDK
// against Cloudflare's web-bot-auth as the judge. It runs this file once per
// operation, writes one JSON operation to standard input, and reads one JSON
// result from standard output. The operations are defined in the harness's
// PROTOCOL.md: sign_request, sign_directory, verify_request, verify_directory.
//
// The adapter calls only the SDK's public entry points in the built dist/, so
// run `npm run build:lib` first. The vector keys are published test keys,
// which the SDK refuses unless allowTestKeys is set under NODE_ENV=test
// (WBA section 6.8).
process.env.NODE_ENV = 'test';
const identity = require('@adcp/sdk/identity-3.3');
const { InMemoryReplayStore } = require('@adcp/sdk/signing/server');

const DIRECTORY_PATH = '/.well-known/http-message-signatures-directory';
const directoryUrl = origin => origin.replace(/\/$/, '') + DIRECTORY_PATH;
const failure = error => ({
  ok: false,
  status: error?.status ?? 0,
  rule: error?.reason ?? error?.name ?? 'error',
  error: String(error?.message ?? error),
});

// `directories` maps each origin to the signed directory response it serves.
function directoryResolver(directories, now) {
  return new identity.SignatureDirectoryResolver({
    now: () => now,
    allowTestKeys: true,
    fetchOptions: {
      trustedFetchFn: async url => {
        const origin = Object.keys(directories).find(o => directoryUrl(o) === url);
        if (origin === undefined) return new Response('', { status: 404 });
        const { status, headers, body } = directories[origin];
        return new Response(body, { status, headers });
      },
    },
  });
}

// `prior` lists requests to verify first with the same replay store, which
// builds replay state without reaching into the SDK's replay keys.
async function verifyRequest({ request, directories = {}, now, prior = [] }) {
  const options = {
    directory: directoryResolver(directories, now),
    replayStore: new InMemoryReplayStore(),
    now: () => now,
    allowTestKeys: true,
  };
  let signers;
  for (const message of [...prior, request]) signers = await identity.verifyWebBotAuth(message, options);
  const [signer] = signers;
  return { ok: true, identity: signer.origin, keyid: signer.keyid };
}

async function verifyDirectory({ origin, response, now }) {
  const verified = await identity.verifyKeyDirectory(
    {
      status: response.status,
      headers: response.headers,
      body: response.body,
      request: { method: 'GET', url: directoryUrl(origin) },
    },
    now,
    { allowTestKeys: true }
  );
  return { ok: true, keyids: verified.keys.map(key => key.kid) };
}

async function signRequest({ key, origin, request, now, nonce }) {
  const headers = await identity.signWebBotAuth(
    request,
    { privateKey: key },
    { origin, now: () => now, ...(typeof nonce === 'string' && { nonce }) }
  );
  return { ...request, headers };
}

async function signDirectory({ keys, origin, now }) {
  const response = await identity.createSignedSignatureDirectory(
    origin,
    keys.map(privateKey => ({ privateKey })),
    { now: () => now }
  );
  return { url: response.request.url, status: response.status, headers: response.headers, body: response.body };
}

const OPERATIONS = {
  sign_request: signRequest,
  sign_directory: signDirectory,
  verify_request: verifyRequest,
  verify_directory: verifyDirectory,
};

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const operation = JSON.parse(input);
  const run = OPERATIONS[operation.op];
  let result;
  try {
    if (!run) throw new Error(`unknown operation ${operation.op}`);
    result = await run(operation);
  } catch (error) {
    result = failure(error);
  }
  process.stdout.write(JSON.stringify(result));
}

main();
