/**
 * Experimental (AdCP 3.3) Web Bot Auth request verification.
 *
 * The result is the verified canonical origin of each signer. Verification
 * establishes identity and nothing else: it creates no principal, reads no
 * trust record, and grants no authority (spec R3, R5 rule 1).
 */
import { serializeItem, type InnerList, type Item } from 'structured-headers';
import { parseStrictJson, StrictJsonError } from '../agent-resolver/strict-json';
import { canonicalAuthority, getHeaderValue, rejectNonAsciiHost, type RequestLike } from '../canonicalize';
import type { JwksResolver } from '../jwks';
import type { ReplayStore } from '../replay';
import type { AdcpSignAlg } from '../types';
import { WBA_CLOCK_SKEW_SECONDS, WBA_MAX_NONCE_LENGTH, WBA_MIN_NONCE_LENGTH, WEB_BOT_AUTH_TAG } from './constants';
import { WebBotAuthAuthorizationError, WebBotAuthError } from './errors';
import { tryJwkThumbprint } from './keys';
import { tryWebBotAuthOrigin } from './origin';
import { sha256DigestMatches } from './sign';
import { isInnerList, parseStrictDictionary, wbaSignatureBase } from './structured';
import { verifyWbaSignatureBytes, wbaSignatureWindow } from './verify-common';

/** Replay scope used for WBA nonces: one namespace per identity origin. */
export const WBA_REPLAY_SCOPE = 'web-bot-auth';

/**
 * Origin revocation check: `true` when `keyid` is revoked for `origin`.
 * Throwing fails the request closed. {@link OriginRevocationChecker} is the
 * SDK implementation.
 */
export type WebBotAuthRevocationCheck =
  | ((origin: string, keyid: string) => Promise<boolean>)
  | { isRevoked(origin: string, keyid: string): Promise<boolean> };

/** One verified Web Bot Auth signature. */
export interface VerifiedWebBotAuthSigner {
  profile: typeof WEB_BOT_AUTH_TAG;
  label: string;
  /** Verified canonical origin: the identity. */
  origin: string;
  /** RFC 7638 thumbprint of the verifying key. */
  keyid: string;
  alg: AdcpSignAlg;
  /** Seller receipt time (epoch seconds), for revocation exposure (R9). */
  verified_at: number;
  /** Whether the signature bound a non-empty body through `content-digest`. */
  body_authenticated: boolean;
}

export interface VerifyWebBotAuthRequestOptions {
  /**
   * Origin-aware key resolver: {@link WebBotAuthKeyDirectoryResolver} or
   * {@link StaticWebBotAuthKeys}. It must implement `resolveWithMetadata`
   * and report the origin it resolved from; resolvers that look keys up by
   * `kid` alone are refused.
   */
  keys: JwksResolver;
  /** Nonce store. Required: the profile requires a nonce on every request. */
  replayStore: ReplayStore;
  /** Required origin revocation check. */
  revocation: WebBotAuthRevocationCheck;
  now?: () => number;
}

/** Request plus optional raw header lines (Node `IncomingMessage.rawHeaders`). */
export type WebBotAuthRequestLike = RequestLike & { rawHeaders?: readonly string[] };

const SINGLE_LINE_HEADERS = new Set([
  'signature',
  'signature-input',
  'signature-agent',
  'content-type',
  'content-digest',
  'host',
]);

/**
 * Profile selection (spec R2): a message carrying `Signature-Agent` or the
 * `web-bot-auth` tag is verified under the Web Bot Auth profile only. A
 * malformed marker still selects WBA so a parse failure cannot downgrade the
 * request to the RFC 9421 profile.
 */
export function usesWebBotAuth(headers: RequestLike['headers']): boolean {
  if (getHeaderValue(headers, 'signature-agent') !== undefined) return true;
  const input = getHeaderValue(headers, 'signature-input');
  if (input === undefined) return false;
  try {
    for (const member of parseStrictDictionary(input, 'Signature-Input').values()) {
      if (isInnerList(member) && member[1].get('tag') === WEB_BOT_AUTH_TAG) return true;
    }
    return false;
  } catch {
    return input.includes(WEB_BOT_AUTH_TAG);
  }
}

/**
 * Verify every `web-bot-auth` signature on a request (WBA §5.2.2) and return
 * the verified identities in label order. The first is the originating
 * signer; a relay must cover every earlier signature's `signature-agent`,
 * `signature-input`, and `signature` members and all of its components.
 *
 * Failures throw {@link WebBotAuthError} carrying the WBA status (`400`,
 * `403` with `Accept-Signature`, `429`). A revoked key throws
 * {@link WebBotAuthAuthorizationError}.
 */
export async function verifyWebBotAuthRequest(
  request: WebBotAuthRequestLike,
  options: VerifyWebBotAuthRequestOptions
): Promise<VerifiedWebBotAuthSigner[]> {
  if (!options || !options.replayStore) throw new TypeError('Web Bot Auth verification requires a replay store');
  if (!options.revocation) throw new TypeError('Web Bot Auth verification requires an origin revocation check');
  if (!options.keys?.resolveWithMetadata) {
    throw new TypeError('Web Bot Auth verification requires an origin-aware resolver with resolveWithMetadata');
  }
  const now = options.now ? options.now() : Math.floor(Date.now() / 1000);
  precheckHeaders(request);

  const inputs = parseStrictDictionary(getHeaderValue(request.headers, 'signature-input'), 'Signature-Input');
  const signatures = parseStrictDictionary(getHeaderValue(request.headers, 'signature'), 'Signature');
  const agents = parseStrictDictionary(getHeaderValue(request.headers, 'signature-agent'), 'Signature-Agent');
  const wba: Array<[string, InnerList]> = [];
  for (const [label, member] of inputs) {
    if (isInnerList(member) && member[1].get('tag') === WEB_BOT_AUTH_TAG) wba.push([label, member]);
  }
  if (wba.length === 0) throw new WebBotAuthError('Signature-Agent requires the Web Bot Auth profile');
  if (signatures.size !== inputs.size || [...inputs.keys()].some(label => !signatures.has(label))) {
    throw new WebBotAuthError('signature labels do not match', { status: 400 });
  }

  const labels = wba.map(([label]) => label);
  try {
    return await verifyLabels(request, options, now, wba, signatures, agents);
  } catch (error) {
    // Name every label's requirements so a relay learns what it must cover.
    if (error instanceof WebBotAuthError && !(error instanceof WebBotAuthAuthorizationError) && error.status === 403) {
      throw new WebBotAuthError(error.reason, {
        status: 403,
        label: error.label,
        labels,
        freshNonce: error.freshNonce,
        cause: error.cause ?? error,
      });
    }
    throw error;
  }
}

async function verifyLabels(
  request: WebBotAuthRequestLike,
  options: VerifyWebBotAuthRequestOptions,
  now: number,
  wba: Array<[string, InnerList]>,
  signatures: ReturnType<typeof parseStrictDictionary>,
  agents: ReturnType<typeof parseStrictDictionary>
): Promise<VerifiedWebBotAuthSigner[]> {
  const body = request.body ?? '';
  const verified: Array<{ signer: VerifiedWebBotAuthSigner; nonce: string; expires: number }> = [];
  const earlier: Array<[string, InnerList]> = [];
  for (const [label, member] of wba) {
    wbaSignatureWindow(member, now, { label });
    const nonce = member[1].get('nonce');
    if (typeof nonce !== 'string' || nonce.length < WBA_MIN_NONCE_LENGTH || nonce.length > WBA_MAX_NONCE_LENGTH) {
      throw new WebBotAuthError('missing or invalid nonce', { label });
    }
    const agent = agents.get(label);
    const agentType = agent && !isInnerList(agent) ? agent[1].get('type') : undefined;
    if (
      !agent ||
      isInnerList(agent) ||
      typeof agent[0] !== 'string' ||
      (agentType !== undefined && agentType !== 'directory')
    ) {
      throw new WebBotAuthError('missing supported Signature-Agent member', { label });
    }
    const origin = tryWebBotAuthOrigin(agent[0], { wire: true });
    if (origin === undefined) throw new WebBotAuthError('invalid signer origin', { label });

    const covered = member[0].map(component => serializeItem(component));
    const coveredSet = new Set(covered);
    const required = new Set(['"@method"', '"@target-uri"', '"@authority"', `"signature-agent";key=${quote(label)}`]);
    if (body.length > 0) {
      required.add('"content-type"');
      required.add('"content-digest"');
    }
    for (const [previous, previousMember] of earlier) {
      for (const field of ['signature-agent', 'signature-input', 'signature'])
        required.add(`"${field}";key=${quote(previous)}`);
      // RFC 9421 §2.2.8 via WBA §5.2.2: covering a signature means covering
      // every component of it, including application-specific fields.
      for (const component of previousMember[0]) required.add(serializeItem(component));
    }
    if (coveredSet.size !== covered.length || [...required].some(component => !coveredSet.has(component))) {
      throw new WebBotAuthError('missing or repeated covered component', { label });
    }

    const keyid = member[1].get('keyid') as string;
    // Cheap replay pre-check before key discovery and crypto.
    if (await options.replayStore.has(origin, WBA_REPLAY_SCOPE, nonce, now)) {
      throw new WebBotAuthError('replayed nonce', { label, freshNonce: true });
    }
    let resolution;
    try {
      resolution = await options.keys.resolveWithMetadata!(keyid, origin);
    } catch (error) {
      if (error instanceof WebBotAuthError) throw relabel(error, label);
      throw new WebBotAuthError('signer key resolution failed', { label, cause: error });
    }
    const jwk = resolution?.jwk;
    // Enforce (origin, thumbprint) here, independently of the resolver: a
    // resolver that ignored the origin must not attribute a foreign key.
    if (
      !jwk ||
      resolution.legacyWebhookFallback === true ||
      resolution.agentUrl === undefined ||
      tryWebBotAuthOrigin(resolution.agentUrl) !== origin ||
      tryJwkThumbprint(jwk) !== keyid
    ) {
      throw new WebBotAuthError('key absent from the named origin', { label });
    }
    let base: string;
    try {
      base = wbaSignatureBase(request, member);
    } catch (error) {
      if (error instanceof WebBotAuthError) throw relabel(error, label);
      throw new WebBotAuthError('request target is malformed', { status: 400, label, cause: error });
    }
    const alg = verifyWbaSignatureBytes(member, signatures.get(label), jwk, base, label);
    if (body.length > 0 && !sha256DigestMatches(getHeaderValue(request.headers, 'content-digest'), body)) {
      throw new WebBotAuthError('request digest mismatch', { label });
    }
    let revoked: boolean;
    try {
      revoked =
        typeof options.revocation === 'function'
          ? await options.revocation(origin, keyid)
          : await options.revocation.isRevoked(origin, keyid);
    } catch (error) {
      if (error instanceof WebBotAuthError) throw error;
      throw new WebBotAuthError('origin revocation status unavailable', { label, cause: error });
    }
    if (revoked) throw new WebBotAuthAuthorizationError('signing key revoked');
    verified.push({
      signer: {
        profile: WEB_BOT_AUTH_TAG,
        label,
        origin,
        keyid,
        alg,
        verified_at: now,
        body_authenticated: body.length > 0,
      },
      nonce,
      expires: member[1].get('expires') as number,
    });
    earlier.push([label, member]);
  }

  // A valid digest authenticates bytes, not their interpretation.
  if (body.trim() !== '') {
    try {
      parseStrictJson(body);
    } catch (error) {
      if (error instanceof StrictJsonError) {
        throw new WebBotAuthError('malformed signed JSON body', { status: 400, cause: error });
      }
      throw error;
    }
  }

  // Each signature's nonce is claimed in its own identity's replay state, so
  // a relay cannot hide a replayed inner signature behind a fresh one.
  for (const { signer, nonce, expires } of verified) {
    const ttl = Math.max(expires - now + WBA_CLOCK_SKEW_SECONDS, WBA_CLOCK_SKEW_SECONDS);
    const result = await options.replayStore.insert(signer.origin, WBA_REPLAY_SCOPE, nonce, ttl, now);
    if (result === 'replayed') throw new WebBotAuthError('replayed nonce', { label: signer.label, freshNonce: true });
    if (result === 'rate_abuse') {
      throw new WebBotAuthError('replay store capacity exceeded', { status: 429, label: signer.label });
    }
  }
  return verified.map(entry => entry.signer);
}

function precheckHeaders(request: WebBotAuthRequestLike): void {
  if (request.rawHeaders) {
    const seen = new Set<string>();
    for (let i = 0; i + 1 < request.rawHeaders.length; i += 2) {
      const name = request.rawHeaders[i]!.toLowerCase();
      if (SINGLE_LINE_HEADERS.has(name) && seen.has(name)) {
        throw new WebBotAuthError(`repeated ${name} field`, { status: 400 });
      }
      seen.add(name);
    }
  }
  const contentType = getHeaderValue(request.headers, 'content-type');
  if (contentType !== undefined && hasTopLevelComma(contentType)) {
    throw new WebBotAuthError('Content-Type carries more than one value', { status: 400 });
  }
  try {
    rejectNonAsciiHost(request.url);
    // The seller's own URL may be http behind TLS termination; only its
    // authority must be well formed here.
    canonicalAuthority(request.url, '3.2');
    const host = getHeaderValue(request.headers, 'host');
    if (host !== undefined) {
      if (/[\s/?#@\\]/.test(host)) throw new TypeError('invalid Host');
      rejectNonAsciiHost(`https://${host}/`);
      canonicalAuthority(`https://${host}/`, '3.2');
    }
  } catch (error) {
    throw new WebBotAuthError('request target is malformed', { status: 400, cause: error });
  }
}

function hasTopLevelComma(value: string): boolean {
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quoted && ch === '\\') {
      i++;
      continue;
    }
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) return true;
  }
  return false;
}

function quote(label: string): string {
  return serializeItem([label, new Map()] as Item);
}

function relabel(error: WebBotAuthError, label: string): WebBotAuthError {
  if (error instanceof WebBotAuthAuthorizationError || error.label === label) return error;
  return new WebBotAuthError(error.reason, { status: error.status, label, cause: error.cause ?? error });
}
