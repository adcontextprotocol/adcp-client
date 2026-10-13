/**
 * Experimental (AdCP 3.3) key-directory discovery for Web Bot Auth signers.
 *
 * One resolution rule: `Signature-Agent` member → origin →
 * `https://<origin>/.well-known/http-message-signatures-directory`. The
 * resolver reads no other document: no capabilities call, no brand.json, and
 * never trust.json. Lookups are keyed by `(origin, thumbprint)`, never by
 * `kid` alone (WBA §5.4).
 */
import { ssrfSafeFetch, type SsrfDnsLookup } from '../../net';
import { getHeaderValue } from '../canonicalize';
import { eTldPlusOne } from '../agent-resolver/etld';
import type { JwksResolution, JwksResolver } from '../jwks';
import { parseStrictJson } from '../agent-resolver/strict-json';
import type { AdcpJsonWebKey } from '../types';
import {
  DISCOVERY_FETCH_TIMEOUT_MS,
  DISCOVERY_NEGATIVE_CACHE_SECONDS,
  KEY_DIRECTORY_MAX_BYTES,
  KEY_DIRECTORY_MAX_CACHE_SECONDS,
  KEY_DIRECTORY_MAX_KEYS,
  KEY_DIRECTORY_MEDIA_TYPE,
  KEY_DIRECTORY_PATH,
  KEY_DIRECTORY_TAG,
} from './constants';
import { WebBotAuthError } from './errors';
import { directoryKeyAlgorithm, jwkThumbprint, tryJwkThumbprint } from './keys';
import { webBotAuthOrigin } from './origin';
import { sha256DigestMatches, type KeyDirectoryResponse } from './sign';
import { serializeItem } from 'structured-headers';
import { isInnerList, parseStrictDictionary, wbaSignatureBase } from './structured';
import { verifyWbaSignatureBytes, wbaSignatureWindow } from './verify-common';

/**
 * Validate a signed key-directory response (WBA Appendix B.1): status 200,
 * the directory media type, the 256 KiB cap, strict JSON, 1–100 public keys
 * whose `kid` is their thumbprint, a matching `Content-Digest`, and exactly
 * one valid signature per key covering `"@authority";req` and
 * `content-digest`. Returns the keys by `kid`.
 */
export function verifyKeyDirectoryResponse(
  originOrUrl: string,
  response: KeyDirectoryResponse,
  options: { now?: number } = {}
): Map<string, AdcpJsonWebKey> {
  return verifyDirectory(originOrUrl, response, options).keys;
}

function verifyDirectory(
  originOrUrl: string,
  response: KeyDirectoryResponse,
  options: { now?: number }
): { keys: Map<string, AdcpJsonWebKey>; expires: number } {
  const origin = webBotAuthOrigin(originOrUrl);
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const mediaType = (getHeaderValue(response.headers, 'content-type') ?? '').split(';', 1)[0]!.trim().toLowerCase();
  if (
    response.status !== 200 ||
    mediaType !== KEY_DIRECTORY_MEDIA_TYPE ||
    Buffer.byteLength(response.body, 'utf8') > KEY_DIRECTORY_MAX_BYTES
  ) {
    throw new WebBotAuthError('invalid key directory response');
  }
  let document: unknown;
  try {
    document = parseStrictJson(response.body);
  } catch (error) {
    throw new WebBotAuthError('invalid key directory JSON', { cause: error });
  }
  const keys = document && typeof document === 'object' ? (document as { keys?: unknown }).keys : undefined;
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > KEY_DIRECTORY_MAX_KEYS) {
    throw new WebBotAuthError('invalid key directory key count');
  }
  const index = new Map<string, AdcpJsonWebKey>();
  for (const jwk of keys) {
    if (!jwk || typeof jwk !== 'object' || Array.isArray(jwk)) throw new WebBotAuthError('invalid directory key');
    const kid = (jwk as { kid?: unknown }).kid;
    if (typeof kid !== 'string' || kid !== tryJwkThumbprint(jwk) || index.has(kid)) {
      throw new WebBotAuthError('invalid or duplicate directory thumbprint');
    }
    directoryKeyAlgorithm(jwk as Record<string, unknown>);
    index.set(kid, { ...(jwk as AdcpJsonWebKey) });
  }
  if (!sha256DigestMatches(getHeaderValue(response.headers, 'content-digest'), response.body)) {
    throw new WebBotAuthError('key directory digest mismatch');
  }
  const inputs = parseStrictDictionary(getHeaderValue(response.headers, 'signature-input'), 'Signature-Input');
  const signatures = parseStrictDictionary(getHeaderValue(response.headers, 'signature'), 'Signature');
  const verified = new Set<string>();
  let earliest = Infinity;
  const request = { method: 'GET', url: origin + KEY_DIRECTORY_PATH, headers: response.headers };
  for (const [label, member] of inputs) {
    if (!isInnerList(member) || member[1].get('tag') !== KEY_DIRECTORY_TAG) {
      throw new WebBotAuthError('invalid key directory signature profile');
    }
    wbaSignatureWindow(member, now, { directory: true });
    // Exact identifiers: a parameterized `"content-digest";key="sha-512"` is
    // not the sha-256 digest this verifier checks.
    const covered = new Set(member[0].map(component => serializeItem(component)));
    if (!covered.has('"@authority";req') || !covered.has('"content-digest"')) {
      throw new WebBotAuthError('key directory signature does not bind authority and digest');
    }
    const keyid = member[1].get('keyid') as string;
    const jwk = index.get(keyid);
    if (!jwk || verified.has(keyid)) throw new WebBotAuthError('key directory signature key is absent or repeated');
    verifyWbaSignatureBytes(
      member,
      signatures.get(label),
      jwk,
      wbaSignatureBase(request, member, { directoryResponse: true }),
      label
    );
    verified.add(keyid);
    earliest = Math.min(earliest, member[1].get('expires') as number);
  }
  if (
    verified.size !== index.size ||
    signatures.size !== inputs.size ||
    [...signatures.keys()].some(l => !inputs.has(l))
  ) {
    throw new WebBotAuthError('key directory requires one signature per key');
  }
  return { keys: index, expires: earliest };
}

/** Fetches a key directory. Custom fetchers are a trusted seam and own SSRF policy. */
export type KeyDirectoryFetcher = (url: string) => Promise<KeyDirectoryResponse>;

export interface FetchKeyDirectoryOptions {
  /** Allow private/loopback addresses (development only). */
  allowPrivateIp?: boolean;
  lookup?: SsrfDnsLookup;
  timeoutMs?: number;
}

/**
 * Fetch a directory under AdCP's fetch rules: HTTPS only, resolved-address
 * checks with the connection pinned, no redirects, a 256 KiB cap, and a 10 s
 * deadline.
 */
export async function fetchKeyDirectory(
  url: string,
  options: FetchKeyDirectoryOptions = {}
): Promise<KeyDirectoryResponse> {
  if (!url.startsWith('https://')) throw new WebBotAuthError('key directories are fetched over HTTPS only');
  const response = await ssrfSafeFetch(url, {
    method: 'GET',
    headers: { accept: KEY_DIRECTORY_MEDIA_TYPE, 'accept-encoding': 'identity' },
    allowPrivateIp: options.allowPrivateIp === true,
    timeoutMs: options.timeoutMs ?? DISCOVERY_FETCH_TIMEOUT_MS,
    maxBodyBytes: KEY_DIRECTORY_MAX_BYTES,
    ...(options.lookup !== undefined && { lookup: options.lookup }),
  });
  return { status: response.status, headers: response.headers, body: decodeUtf8(response.body) };
}

export interface WebBotAuthKeyDirectoryResolverOptions extends FetchKeyDirectoryOptions {
  /** Trusted transport seam; defaults to {@link fetchKeyDirectory}. */
  fetch?: KeyDirectoryFetcher;
  /** Maximum cached origins (and concurrent discoveries). Default 256. */
  maxOrigins?: number;
  /** Maximum concurrent discoveries per operator domain. Default 8. */
  maxPendingPerOperator?: number;
  /**
   * Resolver for context-free (RFC 9421 profile) lookups on the same
   * endpoint. Only lookups without a signer origin reach it; a failed WBA
   * discovery never falls back to it.
   */
  legacy?: JwksResolver;
  /** Epoch-seconds clock. */
  now?: () => number;
}

interface DirectoryCacheEntry {
  response: KeyDirectoryResponse;
  keys: Map<string, AdcpJsonWebKey>;
  /** Positive cache deadline: five minutes, never past the signatures. */
  expiresAt: number;
  /** Earliest signature `expires`: the evidence stays usable until then. */
  signedExpires: number;
}

/**
 * Experimental (AdCP 3.3). A resolver for many WBA signers, keyed by the
 * covered `Signature-Agent` origin: `resolve(keyid, signerOrigin)`. A seller
 * with many buyers needs no hand-written `keyid` → agent dispatch.
 *
 * Caching follows the draft: a verified directory is cached for at most five
 * minutes (and never past its signatures' `expires`); a directory that
 * resolves without the key is evidence of removal. A failed fetch is not
 * evidence and does not evict a cached entry: its signed keys stay usable
 * until their signatures expire, with a 60-second retry. A failure with no
 * prior evidence is negatively cached for 60 seconds in a separate bounded
 * table, so failing origins never displace good entries. Concurrent lookups
 * coalesce per origin, and concurrent discoveries are bounded globally and
 * per operator domain.
 */
export class WebBotAuthKeyDirectoryResolver implements JwksResolver {
  private readonly fetcher: KeyDirectoryFetcher;
  private readonly maxOrigins: number;
  private readonly maxPendingPerOperator: number;
  private readonly legacy: JwksResolver | undefined;
  private readonly now: () => number;
  private readonly cache = new Map<string, DirectoryCacheEntry>();
  private readonly failures = new Map<string, number>();
  private readonly retryAt = new Map<string, number>();
  private readonly pending = new Map<string, Promise<DirectoryCacheEntry>>();

  constructor(options: WebBotAuthKeyDirectoryResolverOptions = {}) {
    const fetchOptions: FetchKeyDirectoryOptions = {
      ...(options.allowPrivateIp !== undefined && { allowPrivateIp: options.allowPrivateIp }),
      ...(options.lookup !== undefined && { lookup: options.lookup }),
      ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
    };
    this.fetcher = options.fetch ?? (url => fetchKeyDirectory(url, fetchOptions));
    this.maxOrigins = options.maxOrigins ?? 256;
    if (!Number.isInteger(this.maxOrigins) || this.maxOrigins <= 0) throw new TypeError('maxOrigins must be positive');
    this.maxPendingPerOperator = options.maxPendingPerOperator ?? 8;
    if (!Number.isInteger(this.maxPendingPerOperator) || this.maxPendingPerOperator <= 0) {
      throw new TypeError('maxPendingPerOperator must be positive');
    }
    this.legacy = options.legacy;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async resolve(keyid: string, signerOrigin?: string): Promise<AdcpJsonWebKey | null> {
    return (await this.resolveWithMetadata(keyid, signerOrigin)).jwk;
  }

  async resolveWithMetadata(keyid: string, signerOrigin?: string): Promise<JwksResolution> {
    if (signerOrigin === undefined) {
      // Coexistence is explicit and never falls back from the WBA branch.
      if (!this.legacy) return { jwk: null };
      if (this.legacy.resolveWithMetadata) return this.legacy.resolveWithMetadata(keyid);
      return { jwk: await this.legacy.resolve(keyid) };
    }
    let origin: string;
    try {
      origin = webBotAuthOrigin(signerOrigin, { wire: true });
    } catch (error) {
      throw new WebBotAuthError('invalid signer origin', { cause: error });
    }
    const entry = await this.entry(origin);
    const jwk = entry.keys.get(keyid);
    return jwk ? { jwk: { ...jwk }, agentUrl: origin } : { jwk: null, agentUrl: origin };
  }

  /** The signed directory response last verified for `origin`, kept as the fetch record. */
  directoryRecord(origin: string): KeyDirectoryResponse | undefined {
    const response = this.cache.get(webBotAuthOrigin(origin))?.response;
    return response && { ...response, headers: { ...response.headers } };
  }

  /**
   * Drop cached state for an origin (e.g. after an operator delists it). A
   * discovery already in flight still completes and repopulates the cache.
   */
  invalidate(origin: string): void {
    const canonical = webBotAuthOrigin(origin);
    this.cache.delete(canonical);
    this.failures.delete(canonical);
    this.retryAt.delete(canonical);
  }

  private async entry(origin: string): Promise<DirectoryCacheEntry> {
    const now = this.now();
    const cached = this.cache.get(origin);
    if (cached && cached.expiresAt > now) {
      this.cache.delete(origin);
      this.cache.set(origin, cached);
      return cached;
    }
    // Retained evidence after a failed refresh: usable until its signatures
    // expire, retried at most once a minute.
    if (cached && cached.signedExpires > now && (this.retryAt.get(origin) ?? 0) > now) return cached;
    if ((this.failures.get(origin) ?? 0) > now) throw new WebBotAuthError('key directory discovery is cooling down');
    let task = this.pending.get(origin);
    if (!task) {
      const operator = operatorOf(origin);
      if (
        this.pending.size >= this.maxOrigins ||
        [...this.pending.keys()].filter(o => operatorOf(o) === operator).length >= this.maxPendingPerOperator
      ) {
        throw new WebBotAuthError('key directory discovery capacity exceeded', { status: 429 });
      }
      task = this.refresh(origin);
      this.pending.set(origin, task);
      const settled = task;
      // Remove only this task, after registration (a custom fetcher may
      // throw synchronously), and observe rejections a caller abandoned.
      settled.then(
        () => this.pending.get(origin) === settled && this.pending.delete(origin),
        () => this.pending.get(origin) === settled && this.pending.delete(origin)
      );
    }
    return task;
  }

  private async refresh(origin: string): Promise<DirectoryCacheEntry> {
    await undefined;
    try {
      const response = await this.fetcher(origin + KEY_DIRECTORY_PATH);
      const now = this.now();
      const { keys, expires } = verifyDirectory(origin, response, { now });
      const fresh: DirectoryCacheEntry = {
        response,
        keys,
        expiresAt: Math.min(now + KEY_DIRECTORY_MAX_CACHE_SECONDS, expires),
        signedExpires: expires,
      };
      this.store(origin, fresh);
      this.failures.delete(origin);
      this.retryAt.delete(origin);
      return fresh;
    } catch (error) {
      const now = this.now();
      const previous = this.cache.get(origin);
      // A failed fetch is not evidence of removal: keep serving the last
      // signed snapshot while its signatures are valid.
      if (previous && previous.signedExpires > now) {
        this.retryAt.set(origin, now + DISCOVERY_NEGATIVE_CACHE_SECONDS);
        trim(this.retryAt, this.maxOrigins);
        return previous;
      }
      this.failures.delete(origin);
      this.failures.set(origin, now + DISCOVERY_NEGATIVE_CACHE_SECONDS);
      trim(this.failures, this.maxOrigins);
      if (error instanceof WebBotAuthError && error.status === 429) throw error;
      throw new WebBotAuthError('key directory discovery failed', { cause: error });
    }
  }

  private store(origin: string, entry: DirectoryCacheEntry): void {
    this.cache.delete(origin);
    this.cache.set(origin, entry);
    trim(this.cache, this.maxOrigins);
  }
}

function trim<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) map.delete(map.keys().next().value as K);
}

function operatorOf(origin: string): string {
  try {
    return eTldPlusOne(origin);
  } catch {
    return new URL(origin).hostname;
  }
}

/**
 * Experimental (AdCP 3.3). Pinned WBA keys per origin, for tests and for
 * sellers that pre-provision directories. Keys must carry their thumbprint
 * as `kid`. Context-free lookups go only to `legacy`.
 */
export class StaticWebBotAuthKeys implements JwksResolver {
  private readonly byOrigin = new Map<string, Map<string, AdcpJsonWebKey>>();
  private readonly legacy: JwksResolver | undefined;

  constructor(directories: Record<string, ReadonlyArray<AdcpJsonWebKey>>, options: { legacy?: JwksResolver } = {}) {
    for (const [origin, keys] of Object.entries(directories)) {
      const index = new Map<string, AdcpJsonWebKey>();
      for (const key of keys) {
        const publicKey = Object.fromEntries(
          Object.entries(key).filter(([name]) => name !== 'd' && !name.startsWith('_'))
        ) as AdcpJsonWebKey;
        if (publicKey.kid !== jwkThumbprint(publicKey)) {
          throw new TypeError('StaticWebBotAuthKeys requires thumbprint kids');
        }
        directoryKeyAlgorithm(publicKey as Record<string, unknown>);
        index.set(publicKey.kid, publicKey);
      }
      this.byOrigin.set(webBotAuthOrigin(origin), index);
    }
    this.legacy = options.legacy;
  }

  async resolve(keyid: string, signerOrigin?: string): Promise<AdcpJsonWebKey | null> {
    return (await this.resolveWithMetadata(keyid, signerOrigin)).jwk;
  }

  async resolveWithMetadata(keyid: string, signerOrigin?: string): Promise<JwksResolution> {
    if (signerOrigin === undefined) {
      if (!this.legacy) return { jwk: null };
      if (this.legacy.resolveWithMetadata) return this.legacy.resolveWithMetadata(keyid);
      return { jwk: await this.legacy.resolve(keyid) };
    }
    const origin = webBotAuthOrigin(signerOrigin, { wire: true });
    const jwk = this.byOrigin.get(origin)?.get(keyid);
    return { jwk: jwk ? { ...jwk } : null, agentUrl: origin };
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    throw new WebBotAuthError('key directory body is not UTF-8', { cause: error });
  }
}
