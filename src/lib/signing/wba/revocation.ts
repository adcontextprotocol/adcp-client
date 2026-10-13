/**
 * Experimental (AdCP 3.3) revocation at the identity origin, with RFC 5280
 * `revocation_details`.
 *
 * A Web Bot Auth identity publishes one signed list at
 * `https://O/.well-known/governance-revocations.json` (`typ`
 * `adcp-gov-revocation+jws`), signed with a key from O's own directory. The
 * checker keeps every revocation it has seen for O, and the most severe
 * detail per key: an origin cannot un-revoke a key or weaken a compromise
 * entry (spec R3a, R9).
 */
import { ssrfSafeFetch, type SsrfDnsLookup } from '../../net';
import { eTldPlusOne } from '../agent-resolver/etld';
import { parseStrictJson } from '../agent-resolver/strict-json';
import { jwkToPublicKey, verifySignature } from '../crypto';
import type { JwksResolver } from '../jwks';
import {
  DISCOVERY_FETCH_TIMEOUT_MS,
  DISCOVERY_NEGATIVE_CACHE_SECONDS,
  ORIGIN_REVOCATION_PATH,
  REVOCATION_LIST_TYP,
} from './constants';
import { WebBotAuthError } from './errors';
import { directoryKeyAlgorithm, tryJwkThumbprint } from './keys';
import { tryWebBotAuthOrigin, webBotAuthOrigin } from './origin';

/** RFC 5280 §5.3.1 reason codes, in the JSON spelling of RFC 8555 §7.6. */
export const REVOCATION_REASONS = [
  'unspecified',
  'keyCompromise',
  'cACompromise',
  'affiliationChanged',
  'superseded',
  'cessationOfOperation',
  'certificateHold',
  'removeFromCRL',
  'privilegeWithdrawn',
  'aACompromise',
] as const;
export type RevocationReason = (typeof REVOCATION_REASONS)[number];

/** Optional per-key detail on a revocation list (`revocation_details[kid]`). */
export interface RevocationDetails {
  reason?: RevocationReason;
  /** RFC 3339 instant the key is known or suspected compromised (RFC 5280 §5.3.2). */
  invalidity_date?: string;
}

/** A parsed, signature-verified revocation list payload. */
export interface RevocationListPayload {
  version: number;
  issuer: string;
  updated: string;
  next_update: string;
  revoked_kids: string[];
  revoked_jtis: string[];
  revocation_details?: Record<string, RevocationDetails>;
}

/** Validate one `revocation_details` entry. Throws `TypeError` on bad input. */
export function parseRevocationDetails(value: unknown): RevocationDetails {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('revocation detail must be an object');
  const { reason, invalidity_date } = value as Record<string, unknown>;
  const detail: RevocationDetails = {};
  if (reason !== undefined) {
    if (typeof reason !== 'string' || !(REVOCATION_REASONS as readonly string[]).includes(reason)) {
      throw new TypeError('unknown RFC 5280 revocation reason');
    }
    detail.reason = reason as RevocationReason;
  }
  if (invalidity_date !== undefined) {
    if (typeof invalidity_date !== 'string' || parseRfc3339(invalidity_date) === undefined) {
      throw new TypeError('invalidity_date must be an RFC 3339 timestamp with a time zone');
    }
    detail.invalidity_date = invalidity_date;
  }
  return detail;
}

/**
 * Keep the most severe detail seen for a key: `keyCompromise` wins over any
 * other reason, and the earliest `invalidity_date` wins. Entries are never
 * withdrawn or weakened (spec R9 rule 3).
 */
export function mergeRevocationDetails(
  seen: RevocationDetails | undefined,
  newer: RevocationDetails | undefined
): RevocationDetails {
  const reasons = [seen?.reason, newer?.reason];
  const reason = reasons.includes('keyCompromise') ? 'keyCompromise' : (seen?.reason ?? newer?.reason);
  const dates = [seen?.invalidity_date, newer?.invalidity_date].filter((d): d is string => d !== undefined);
  const earliest = dates.sort((a, b) => parseRfc3339(a)! - parseRfc3339(b)!)[0];
  return { ...(reason !== undefined && { reason }), ...(earliest !== undefined && { invalidity_date: earliest }) };
}

/**
 * Whether a request the seller *received* at `receivedAt` (epoch seconds)
 * under a revoked key is suspect (spec R9 rule 4): only `keyCompromise`
 * exposes, from the `invalidity_date` or always when there is none. Never
 * compare against the signature's `created`, which the signer controls.
 */
export function revocationExposes(details: RevocationDetails | undefined, receivedAt: number): boolean {
  if (details?.reason !== 'keyCompromise') return false;
  if (details.invalidity_date === undefined) return true;
  return receivedAt * 1000 >= parseRfc3339(details.invalidity_date)!;
}

/**
 * Validate a revocation list payload. `issuer` must equal `expectedIssuer`,
 * identifiers must be strings, `revocation_details` may describe only keys in
 * `revoked_kids`, and the declared cadence must be at least 60 seconds.
 */
export function parseRevocationListPayload(payload: unknown, expectedIssuer: string): RevocationListPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new TypeError('revocation list must be an object');
  const list = payload as Record<string, unknown>;
  if (typeof list.version !== 'number' || !Number.isInteger(list.version) || list.version < 1) {
    throw new TypeError('revocation list version must be a positive integer');
  }
  if (list.issuer !== expectedIssuer) throw new TypeError('revocation list issuer does not match the origin');
  if (typeof list.updated !== 'string' || typeof list.next_update !== 'string') {
    throw new TypeError('revocation list requires updated and next_update');
  }
  const updated = parseRfc3339(list.updated);
  const next = parseRfc3339(list.next_update);
  if (updated === undefined || next === undefined || next - updated < 60_000) {
    throw new TypeError('revocation list cadence must be at least 60 seconds');
  }
  const strings = (value: unknown, field: string): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
      throw new TypeError(`${field} must be an array of strings`);
    }
    return value as string[];
  };
  const revoked_kids = strings(list.revoked_kids, 'revoked_kids');
  const revoked_jtis = strings(list.revoked_jtis, 'revoked_jtis');
  let revocation_details: Record<string, RevocationDetails> | undefined;
  if (list.revocation_details !== undefined) {
    const raw = list.revocation_details;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new TypeError('revocation_details must be an object');
    revocation_details = {};
    for (const [kid, detail] of Object.entries(raw)) {
      if (!revoked_kids.includes(kid)) throw new TypeError('revocation_details must describe revoked_kids only');
      revocation_details[kid] = parseRevocationDetails(detail);
    }
  }
  return {
    version: list.version,
    issuer: list.issuer,
    updated: list.updated,
    next_update: list.next_update,
    revoked_kids,
    revoked_jtis,
    ...(revocation_details !== undefined && { revocation_details }),
  };
}

/**
 * Monotonic revocation history for one issuer: revoked identifiers are only
 * ever added, and each key keeps its most severe detail.
 */
export class RevocationHistory {
  private readonly kids = new Set<string>();
  private readonly jtis = new Set<string>();
  private readonly details = new Map<string, RevocationDetails>();

  merge(list: Pick<RevocationListPayload, 'revoked_kids' | 'revoked_jtis' | 'revocation_details'>): void {
    for (const kid of list.revoked_kids) this.kids.add(kid);
    for (const jti of list.revoked_jtis) this.jtis.add(jti);
    for (const [kid, detail] of Object.entries(list.revocation_details ?? {})) {
      this.details.set(kid, mergeRevocationDetails(this.details.get(kid), detail));
    }
  }

  isRevoked(kid: string): boolean {
    return this.kids.has(kid);
  }

  isJtiRevoked(jti: string): boolean {
    return this.jtis.has(jti);
  }

  detailsFor(kid: string): RevocationDetails | undefined {
    const detail = this.details.get(kid);
    return detail && { ...detail };
  }

  revokedKids(): string[] {
    return [...this.kids];
  }
}

/** Raw response of a revocation-list fetch. Custom fetchers are a trusted seam. */
export interface RevocationListResponse {
  status: number;
  body: string;
}
export type RevocationListFetcher = (url: string) => Promise<RevocationListResponse>;

export interface OriginRevocationCheckerOptions {
  /** Trusted transport seam. Defaults to an SSRF-guarded, redirect-free fetch. */
  fetch?: RevocationListFetcher;
  allowPrivateIp?: boolean;
  lookup?: SsrfDnsLookup;
  /** Maximum admitted origins. New origins past the cap get `429`. Default 256. */
  maxOrigins?: number;
  /** Maximum admitted origins per operator (registrable domain). Default 8. */
  maxOriginsPerOperator?: number;
  /** Grace past `next_update`, as a multiple of the polling interval. Default 4 (security.mdx). */
  graceMultiplier?: number;
  /** Epoch-seconds clock. */
  now?: () => number;
}

interface OriginState {
  history: RevocationHistory;
  updatedMs: number;
  nextUpdate: number;
  interval: number;
  lastAttempt: number;
  refreshing?: Promise<void>;
}

const MAX_REVOCATION_LIST_BYTES = 1024 * 1024;
const MAX_POLLING_INTERVAL_SECONDS = 30 * 60;
const MIN_REFETCH_SECONDS = 30;

/**
 * Experimental (AdCP 3.3). Checks keys against each identity origin's signed
 * revocation list, verified with keys from that origin's directory (the
 * resolver passed in, e.g. {@link WebBotAuthKeyDirectoryResolver}).
 *
 * - Polls on the list's `next_update` (60 s floor, 30 min ceiling) and fails
 *   closed past `next_update + grace`.
 * - Retains every revoked key and the most severe detail across refreshes,
 *   and refuses a list older than the one it holds.
 * - Admits an origin only after a signed list authenticates. A failed first
 *   discovery holds a bounded 60-second negative entry instead of a slot.
 * - Admission is bounded globally and per operator; larger deployments
 *   should supply a durable checker with seller-owned admission policy.
 */
export class OriginRevocationChecker {
  private readonly keys: JwksResolver;
  private readonly fetcher: RevocationListFetcher;
  private readonly maxOrigins: number;
  private readonly maxPerOperator: number;
  private readonly graceMultiplier: number;
  private readonly now: () => number;
  private readonly origins = new Map<string, OriginState>();
  private readonly pending = new Map<string, Promise<OriginState>>();
  private readonly failures = new Map<string, number>();

  constructor(keys: JwksResolver, options: OriginRevocationCheckerOptions = {}) {
    if (!keys?.resolveWithMetadata)
      throw new TypeError('OriginRevocationChecker requires an origin-aware key resolver');
    this.keys = keys;
    this.fetcher =
      options.fetch ??
      (url => fetchRevocationList(url, { allowPrivateIp: options.allowPrivateIp === true, lookup: options.lookup }));
    this.maxOrigins = options.maxOrigins ?? 256;
    this.maxPerOperator = options.maxOriginsPerOperator ?? 8;
    if (!(this.maxOrigins > 0) || !(this.maxPerOperator > 0))
      throw new TypeError('origin admission limits must be positive');
    this.graceMultiplier = options.graceMultiplier ?? 4;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** `true` when `keyid` is revoked at `origin`. Throws when status is unavailable. */
  isRevoked = async (origin: string, keyid: string): Promise<boolean> => {
    const state = await this.state(origin);
    return state.history.isRevoked(keyid);
  };

  /** Most severe detail seen for a revoked key, if any. */
  revocationDetails(origin: string, keyid: string): RevocationDetails | undefined {
    return this.origins.get(webBotAuthOrigin(origin))?.history.detailsFor(keyid);
  }

  /** Whether a request received at `receivedAt` under `keyid` is suspect (R9). */
  exposes(origin: string, keyid: string, receivedAt: number): boolean {
    const history = this.origins.get(webBotAuthOrigin(origin))?.history;
    return history?.isRevoked(keyid) === true && revocationExposes(history.detailsFor(keyid), receivedAt);
  }

  private async state(rawOrigin: string): Promise<OriginState> {
    const origin = webBotAuthOrigin(rawOrigin, { wire: true });
    const now = this.now();
    const existing = this.origins.get(origin);
    if (existing) {
      if (now >= existing.nextUpdate && now - existing.lastAttempt >= MIN_REFETCH_SECONDS) {
        existing.refreshing ??= this.refresh(origin, existing).finally(() => {
          existing.refreshing = undefined;
        });
        await existing.refreshing.catch(() => undefined);
      }
      if (this.now() > existing.nextUpdate + existing.interval * this.graceMultiplier) {
        throw new WebBotAuthError('origin revocation list is stale');
      }
      return existing;
    }
    if ((this.failures.get(origin) ?? 0) > now)
      throw new WebBotAuthError('origin revocation discovery is cooling down');
    let task = this.pending.get(origin);
    if (!task) {
      if (this.origins.size + this.pending.size >= this.maxOrigins) {
        throw new WebBotAuthError('origin revocation capacity exceeded', { status: 429 });
      }
      const operator = operatorOf(origin);
      const admitted = [...this.origins.keys(), ...this.pending.keys()].filter(o => operatorOf(o) === operator).length;
      if (admitted >= this.maxPerOperator) {
        throw new WebBotAuthError('operator revocation capacity exceeded', { status: 429 });
      }
      task = this.discover(origin);
      this.pending.set(origin, task);
      task.catch(() => undefined);
    }
    return task;
  }

  private async discover(origin: string): Promise<OriginState> {
    try {
      const list = await this.fetchVerified(origin, undefined);
      const history = new RevocationHistory();
      history.merge(list);
      const state = this.stateFor(list, history);
      // Reserve permanent history only after a signed list authenticated: a
      // 404 or an attacker-induced outage must not consume an origin slot.
      this.origins.set(origin, state);
      this.failures.delete(origin);
      return state;
    } catch (error) {
      this.failures.delete(origin);
      this.failures.set(origin, this.now() + DISCOVERY_NEGATIVE_CACHE_SECONDS);
      while (this.failures.size > this.maxOrigins) this.failures.delete(this.failures.keys().next().value as string);
      throw new WebBotAuthError('origin revocation status unavailable', { cause: error });
    } finally {
      this.pending.delete(origin);
    }
  }

  private async refresh(origin: string, state: OriginState): Promise<void> {
    state.lastAttempt = this.now();
    const list = await this.fetchVerified(origin, state.updatedMs);
    state.history.merge(list);
    Object.assign(state, this.stateFor(list, state.history), { refreshing: state.refreshing });
  }

  private stateFor(list: RevocationListPayload, history: RevocationHistory): OriginState {
    const now = this.now();
    const updatedMs = parseRfc3339(list.updated)!;
    const declared = Math.floor((parseRfc3339(list.next_update)! - updatedMs) / 1000);
    const interval = Math.min(declared, MAX_POLLING_INTERVAL_SECONDS);
    return {
      history,
      updatedMs,
      nextUpdate: Math.floor(updatedMs / 1000) + interval,
      interval,
      lastAttempt: now,
    };
  }

  private async fetchVerified(origin: string, currentUpdatedMs: number | undefined): Promise<RevocationListPayload> {
    const response = await this.fetcher(origin + ORIGIN_REVOCATION_PATH);
    if (response.status !== 200) throw new Error(`revocation list returned HTTP ${response.status}`);
    if (Buffer.byteLength(response.body, 'utf8') > MAX_REVOCATION_LIST_BYTES)
      throw new Error('revocation list is oversized');
    const payload = await verifyRevocationJws(response.body, origin, this.keys);
    const list = parseRevocationListPayload(payload, origin);
    const updatedMs = parseRfc3339(list.updated)!;
    if (updatedMs > (this.now() + 60) * 1000) throw new Error('revocation list updated is in the future');
    if (currentUpdatedMs !== undefined && updatedMs < currentUpdatedMs) {
      throw new Error('refusing to roll back to an older revocation list');
    }
    return list;
  }
}

/**
 * Verify a revocation list JWS (compact, flattened, or general JSON
 * serialization) with a key from `origin`'s directory. The protected header
 * must name `typ: adcp-gov-revocation+jws`, an allowed `alg`, and a thumbprint
 * `kid` the origin publishes.
 */
export async function verifyRevocationJws(document: string, origin: string, keys: JwksResolver): Promise<unknown> {
  const parts = splitJws(document);
  let header: Record<string, unknown>;
  try {
    header = parseStrictJson(Buffer.from(parts.protected, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch (error) {
    throw new Error('revocation list protected header is malformed', { cause: error });
  }
  if (!header || typeof header !== 'object' || header.typ !== REVOCATION_LIST_TYP || header.crit !== undefined) {
    throw new Error('revocation list JWS header is not adcp-gov-revocation+jws');
  }
  const jwsAlg = header.alg;
  if (jwsAlg !== 'EdDSA' && jwsAlg !== 'ES256') throw new Error('revocation list JWS alg is not allowed');
  if (typeof header.kid !== 'string') throw new Error('revocation list JWS has no kid');
  const resolution = await keys.resolveWithMetadata!(header.kid, origin);
  const jwk = resolution.jwk;
  if (!jwk || tryWebBotAuthOrigin(resolution.agentUrl ?? '') !== origin || tryJwkThumbprint(jwk) !== header.kid) {
    throw new Error('revocation list key is not in the origin directory');
  }
  const alg = directoryKeyAlgorithm(jwk as Record<string, unknown>);
  if ((alg === 'ed25519') !== (jwsAlg === 'EdDSA')) throw new Error('revocation list JWS alg does not match its key');
  const signingInput = Buffer.from(`${parts.protected}.${parts.payload}`, 'ascii');
  if (!verifySignature(alg, jwkToPublicKey(jwk), signingInput, Buffer.from(parts.signature, 'base64url'))) {
    throw new Error('revocation list signature did not verify');
  }
  return parseStrictJson(Buffer.from(parts.payload, 'base64url').toString('utf8'));
}

function splitJws(document: string): { protected: string; payload: string; signature: string } {
  const text = document.trim();
  const b64 = /^[A-Za-z0-9_-]+$/;
  if (!text.startsWith('{')) {
    const segments = text.split('.');
    if (segments.length !== 3 || !segments.every(s => b64.test(s))) throw new Error('malformed compact JWS');
    return { protected: segments[0]!, payload: segments[1]!, signature: segments[2]! };
  }
  const parsed = parseStrictJson(text) as Record<string, unknown>;
  const entries = Array.isArray(parsed.signatures) ? parsed.signatures : [parsed];
  if (entries.length !== 1) throw new Error('revocation list JWS must carry exactly one signature');
  const entry = entries[0] as Record<string, unknown>;
  if (entry.header !== undefined) throw new Error('unprotected JWS headers are not accepted');
  const { payload } = parsed;
  if (typeof payload !== 'string' || typeof entry.protected !== 'string' || typeof entry.signature !== 'string') {
    throw new Error('malformed JSON JWS');
  }
  if (![payload, entry.protected, entry.signature].every(s => b64.test(s))) throw new Error('malformed JSON JWS');
  return { protected: entry.protected, payload, signature: entry.signature };
}

export async function fetchRevocationList(
  url: string,
  options: { allowPrivateIp?: boolean; lookup?: SsrfDnsLookup } = {}
): Promise<RevocationListResponse> {
  if (!url.startsWith('https://')) throw new Error('revocation lists are fetched over HTTPS only');
  const response = await ssrfSafeFetch(url, {
    method: 'GET',
    headers: { accept: 'application/jose+json, application/json', 'accept-encoding': 'identity' },
    allowPrivateIp: options.allowPrivateIp === true,
    timeoutMs: DISCOVERY_FETCH_TIMEOUT_MS,
    maxBodyBytes: MAX_REVOCATION_LIST_BYTES,
    ...(options.lookup !== undefined && { lookup: options.lookup }),
  });
  return { status: response.status, body: new TextDecoder('utf-8', { fatal: true }).decode(response.body) };
}

function operatorOf(origin: string): string {
  try {
    return eTldPlusOne(origin);
  } catch {
    // Origins without a registrable domain cannot bind through trust.json
    // but still share a host bucket for anonymous identity discovery.
    return new URL(origin).hostname;
  }
}

/** Milliseconds since epoch for an RFC 3339 timestamp carrying a zone, else `undefined`. */
export function parseRfc3339(value: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}
