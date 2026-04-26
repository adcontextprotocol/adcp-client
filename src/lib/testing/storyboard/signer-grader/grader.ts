import { readFile } from 'node:fs/promises';
import { createPrivateKey, sign as nodeSign, type JsonWebKey } from 'node:crypto';
import {
  HttpsJwksResolver,
  InMemoryReplayStore,
  InMemoryRevocationStore,
  RequestSignatureError,
  signRequestAsync,
  verifyRequestSignature,
  type AdcpJsonWebKey,
  type AdcpSignAlg,
  type ContentDigestPolicy,
  type JwksResolver,
  type SigningProvider,
} from '../../../signing';
import { ssrfSafeFetch } from '../../../net/ssrf-fetch';
import type { SignerGradeReport, SignerGradeStep } from './types';

export interface GradeSignerOptions {
  /** Agent URL of the signer being graded — used as `agent_url` in the report and as the host for the sample signed request. */
  agentUrl: string;
  /** `kid` the signer advertises in `Signature-Input`. Must match a JWK at the agent's `jwks_uri`. */
  kid: string;
  /** Algorithm the signer advertises. Must match `ALLOWED_ALGS` and the JWK's `alg`. */
  algorithm: AdcpSignAlg;
  /**
   * Local JWK file (must include the private scalar `d`). Pick this OR
   * `signerUrl` — the grader produces a `SigningProvider` from whichever
   * is set.
   */
  keyFilePath?: string;
  /**
   * HTTP signing-oracle endpoint for KMS-backed signers. The grader POSTs
   * `{ payload_b64, kid, alg }` and expects `{ signature_b64 }` back. The
   * payload is the canonical RFC 9421 signature base; the response is raw
   * wire-format signature bytes (Ed25519: 64-byte raw; ECDSA-P256:
   * 64-byte `r‖s` IEEE P1363, NOT DER).
   */
  signerUrl?: string;
  /** Optional `Authorization` header for the signer-url POSTs. */
  signerAuth?: string;
  /** JWKS endpoint to verify against. Required (no brand.json discovery in v1). */
  jwksUrl: string;
  /** AdCP operation to embed in the sample request body. Defaults to `create_media_buy`. */
  operation?: string;
  /**
   * Content-digest policy the operator's verifier advertises. The grader
   * exercises the same policy locally so a signer that fails to emit
   * `Content-Digest` against a `'required'` policy surfaces here as
   * `request_signature_components_incomplete` (step 6) — the same code a
   * real counterparty would reject with. Defaults to `'required'`, which
   * is the recommended posture for spend-committing operations.
   */
  coversContentDigest?: ContentDigestPolicy;
  /** Allow http:// signer / JWKS URLs for development. Off by default. */
  allowPrivateIp?: boolean;
  /** Per-probe timeout. Defaults to 10000 ms. */
  timeoutMs?: number;
}

/**
 * Grade a signer end-to-end: produce a sample signed AdCP request through
 * the operator's signer, verify the signature against the JWKS the
 * operator publishes, report verifier-pipeline results step-by-step.
 *
 * Useful before pushing live signed traffic from a KMS-backed signer —
 * surfaces algorithm-mismatch / kid-mismatch / DER-vs-P1363 / wrong-key
 * failures as specific verifier error codes (the same codes a real
 * counterparty would reject with), rather than a generic
 * `request_signature_invalid` from the seller's monitoring.
 */
export async function gradeSigner(options: GradeSignerOptions): Promise<SignerGradeReport> {
  const start = Date.now();
  const operation = options.operation ?? 'create_media_buy';
  const coversContentDigest = options.coversContentDigest ?? 'required';
  const sampleUrl = new URL(`/adcp/${operation}`, options.agentUrl).toString();
  const sampleBody = JSON.stringify({ probe: 'adcp-signer-grade', operation });
  const sample = {
    method: 'POST',
    url: sampleUrl,
    body: sampleBody,
    headers: {} as Record<string, string>,
  };

  let provider: SigningProvider;
  try {
    provider = await buildProviderFromOptions(options);
  } catch (err) {
    return failReport(options, sample, start, {
      status: 'fail',
      error_code: 'signer_setup_failed',
      diagnostic: err instanceof Error ? err.message : String(err),
    });
  }

  // Sign a sample request with the user's signer. Wire format is the
  // verifier's only contact surface — if this step throws, the user's
  // signer raised before producing a signature (e.g., KMS auth failure,
  // network timeout). When `coversContentDigest === 'required'` the signer
  // must emit a `Content-Digest` header; the verifier then exercises step
  // 11 (digest recompute) end-to-end.
  let signed;
  try {
    signed = await signRequestAsync(
      { method: 'POST', url: sampleUrl, headers: { 'Content-Type': 'application/json' }, body: sampleBody },
      provider,
      // Cover Content-Digest unless the operator's policy is `'forbidden'`,
      // matching `resolveCoverContentDigest`'s posture at the agent layer.
      { coverContentDigest: coversContentDigest !== 'forbidden' }
    );
  } catch (err) {
    return failReport(options, sample, start, {
      status: 'fail',
      error_code: 'signer_invocation_failed',
      diagnostic: err instanceof Error ? err.message : String(err),
    });
  }
  sample.headers = signed.headers;

  // Verify against the user's JWKS. The verifier returns step + code on
  // failure; pass that straight through to the report so the operator
  // sees exactly which spec check rejected. The capability passed here is
  // the operator's (not a permissive default) so digest-policy
  // misconfigurations surface as step 6 rejections.
  const jwks = buildJwksResolver(options);
  const replayStore = new InMemoryReplayStore();
  const revocationStore = new InMemoryRevocationStore();
  const verifyRequest = {
    method: sample.method,
    url: sample.url,
    headers: signed.headers,
    body: sample.body,
  };

  let step: SignerGradeStep;
  try {
    const result = await verifyRequestSignature(verifyRequest, {
      capability: { supported: true, covers_content_digest: coversContentDigest, required_for: [operation] },
      jwks,
      replayStore,
      revocationStore,
      operation,
    });
    if (result.status !== 'verified') {
      // Defensive — `signRequestAsync` always emits `Signature` /
      // `Signature-Input` so a successful sign-then-verify can't reach
      // here. Throw rather than silently report a custom code so an SDK
      // bug that produces empty headers surfaces loudly.
      throw new Error(
        `gradeSigner internal: verifier returned status='${result.status}' on a freshly-signed request — likely SDK bug`
      );
    }
    step = { status: 'pass', diagnostic: 'Signature verified end-to-end against JWKS.' };
  } catch (err) {
    if (err instanceof RequestSignatureError) {
      step = {
        status: 'fail',
        error_code: err.code,
        diagnostic: buildVerifierDiagnostic(err, options.algorithm),
      };
    } else {
      step = {
        status: 'fail',
        error_code: 'verifier_threw_unexpected',
        diagnostic: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return {
    agent_url: options.agentUrl,
    jwks_uri: options.jwksUrl,
    kid: options.kid,
    algorithm: options.algorithm,
    duration_ms: Date.now() - start,
    passed: step.status === 'pass',
    step,
    sample,
  };
}

/**
 * Layer a hint on top of the verifier's raw error message for the
 * common KMS-adapter misconfigurations operators hit. Today the only
 * one with a unique signature is DER-vs-P1363 for ECDSA — the verifier
 * surfaces it as the generic `request_signature_invalid` at step 10,
 * but the most likely cause is a KMS adapter that didn't run output
 * through `derEcdsaToP1363`. Surfacing this inline is cheap and saves
 * an operator a debugging cycle.
 */
function buildVerifierDiagnostic(err: RequestSignatureError, algorithm: AdcpSignAlg): string {
  const base = `step ${err.failedStep}: ${err.message}`;
  if (err.code === 'request_signature_invalid' && algorithm === 'ecdsa-p256-sha256') {
    return (
      `${base}\n  Common cause: signing oracle returned a DER-encoded signature.` +
      ` AdCP / RFC 9421 §3.3.1 require raw r‖s (IEEE P1363, 64 bytes for P-256).` +
      ` See \`derEcdsaToP1363\` in @adcp/client/signing.`
    );
  }
  return base;
}

function failReport(
  options: GradeSignerOptions,
  sample: SignerGradeReport['sample'],
  start: number,
  step: SignerGradeStep
): SignerGradeReport {
  return {
    agent_url: options.agentUrl,
    jwks_uri: options.jwksUrl,
    kid: options.kid,
    algorithm: options.algorithm,
    duration_ms: Date.now() - start,
    passed: false,
    step,
    sample,
  };
}

async function buildProviderFromOptions(options: GradeSignerOptions): Promise<SigningProvider> {
  const hasKey = options.keyFilePath !== undefined;
  const hasUrl = options.signerUrl !== undefined;
  if (hasKey === hasUrl) {
    throw new Error('gradeSigner: pass exactly one of --key-file or --signer-url');
  }
  if (hasKey) {
    return await keyFileProvider(options.keyFilePath as string, options.kid, options.algorithm);
  }
  return httpOracleProvider({
    url: options.signerUrl as string,
    authorization: options.signerAuth,
    kid: options.kid,
    algorithm: options.algorithm,
    timeoutMs: options.timeoutMs ?? 10_000,
    allowPrivateIp: options.allowPrivateIp ?? false,
  });
}

async function keyFileProvider(filePath: string, kid: string, algorithm: AdcpSignAlg): Promise<SigningProvider> {
  const raw = await readFile(filePath, 'utf8');
  let jwk: AdcpJsonWebKey;
  try {
    jwk = JSON.parse(raw);
  } catch {
    throw new Error(`gradeSigner: --key-file ${filePath} is not valid JSON`);
  }
  if (!jwk.d) {
    throw new Error(`gradeSigner: --key-file ${filePath} is missing the private scalar 'd'`);
  }
  // Build a minimal in-process SigningProvider directly. We can't use
  // InMemorySigningProvider here because its production-NODE_ENV gate
  // would refuse to construct in a CI environment running the grader.
  // The grader is dev / pre-deployment tooling; bypass the gate
  // intentionally with a clear note.
  return {
    keyid: kid,
    algorithm,
    fingerprint: `key-file:${kid}`,
    async sign(payload: Uint8Array): Promise<Uint8Array> {
      const privateKey = createPrivateKey({ key: jwk as JsonWebKey, format: 'jwk' });
      const data = Buffer.from(payload);
      if (algorithm === 'ed25519') {
        return new Uint8Array(nodeSign(null, data, privateKey));
      }
      return new Uint8Array(nodeSign('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' }));
    },
  };
}

interface HttpOracleOptions {
  url: string;
  authorization?: string;
  kid: string;
  algorithm: AdcpSignAlg;
  timeoutMs: number;
  allowPrivateIp: boolean;
}

/**
 * SigningProvider that delegates `sign(payload)` to an HTTP signing
 * oracle. The oracle protocol is intentionally minimal — bytes in,
 * bytes out — so any KMS-backed signer can put it in front of
 * `provider.sign()` without exposing the underlying KMS to the grader.
 *
 * Wire contract:
 *   POST <url>
 *     Content-Type: application/json
 *     Authorization: <signerAuth?>             // optional shared-secret
 *     Body: { "payload_b64": "...",
 *             "kid": "...",
 *             "alg": "ed25519" | "ecdsa-p256-sha256" }
 *
 *   Response:
 *     200 OK
 *     Content-Type: application/json
 *     Body: { "signature_b64": "..." }         // raw wire-format bytes
 */
function httpOracleProvider(options: HttpOracleOptions): SigningProvider {
  return {
    keyid: options.kid,
    algorithm: options.algorithm,
    fingerprint: `oracle:${options.url}#${options.kid}`,
    async sign(payload: Uint8Array): Promise<Uint8Array> {
      // Route through `ssrfSafeFetch` so the oracle POST inherits DNS
      // pinning, IMDS-block, manual-redirect (a hostile or compromised
      // oracle URL can't 302 the `Authorization: Bearer ...` header to
      // an attacker-controlled host), and a 64 KiB body cap. Plain
      // `fetch()` would re-introduce the SSRF / redirect-leak surface
      // every other counterparty-influenced URL in the SDK already
      // guards against.
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (options.authorization) headers.authorization = options.authorization;
      const reqBody = JSON.stringify({
        payload_b64: Buffer.from(payload).toString('base64'),
        kid: options.kid,
        alg: options.algorithm,
      });
      const response = await ssrfSafeFetch(options.url, {
        method: 'POST',
        headers,
        body: reqBody,
        timeoutMs: options.timeoutMs,
        allowPrivateIp: options.allowPrivateIp,
      });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(
          `signing oracle ${options.url} responded ${response.status} (manual-redirect; not following 3xx)`
        );
      }
      let parsed: { signature_b64?: unknown };
      try {
        parsed = JSON.parse(Buffer.from(response.body).toString('utf8'));
      } catch (err) {
        throw new Error(
          `signing oracle response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      if (typeof parsed.signature_b64 !== 'string') {
        throw new Error(`signing oracle response missing 'signature_b64' string field`);
      }
      return new Uint8Array(Buffer.from(parsed.signature_b64, 'base64'));
    },
  };
}

function buildJwksResolver(options: GradeSignerOptions): JwksResolver {
  return new HttpsJwksResolver(options.jwksUrl, {
    allowPrivateIp: options.allowPrivateIp ?? false,
  });
}
