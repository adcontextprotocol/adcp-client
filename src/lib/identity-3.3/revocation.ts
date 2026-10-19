import { eTldPlusOne } from '../signing/agent-resolver/etld';
import { CompactSign, compactVerify, decodeProtectedHeader, importJWK, type JWK } from 'jose';
import { ssrfSafeFetch, type SsrfFetchOptions } from '../net';
import { canonicalAgentOrigin } from '../signing/agent-resolver/canonicalize';
import { parseStrictJson } from '../signing/agent-resolver/strict-json';
import {
  SignatureDirectoryResolver,
  WebBotAuthError,
  WebBotAuthUnavailableError,
  jwkThumbprint,
} from '../signing/web-bot-auth';
import type { RevocationDetail, RevocationReason } from './types';
export interface OriginRevocationSnapshot {
  issuer: string;
  updated: string;
  next_update: string;
  revoked_kids: string[];
  revoked_jtis?: string[];
  revocation_details?: Record<string, RevocationDetail>;
}
const REASONS: RevocationReason[] = [
  'removeFromCRL',
  'unspecified',
  'superseded',
  'cessationOfOperation',
  'affiliationChanged',
  'certificateHold',
  'privilegeWithdrawn',
  'aACompromise',
  'cACompromise',
  'keyCompromise',
];
/** @internal Shared monotonic merge for in-memory and CAS-backed stores. */
export { mergeRevocationDetails as mergeRevocationDetail } from '../signing/revocation';
import { mergeRevocationDetails as mergeRevocationDetail } from '../signing/revocation';
export interface MonotonicOriginRevocationStore {
  /** Merge atomically and persist forever. Never replace with a new snapshot. */
  merge(origin: string, snapshot: OriginRevocationSnapshot): Promise<void>;
  get(origin: string, keyid: string): Promise<RevocationDetail | undefined>;
}
/**
 * Process-local revocation history for development and tests. Public
 * deployments need durable history (`createIdentity33StateStores`) so a
 * restart never forgets a revocation.
 *
 * Capacity is bounded per origin, per operator (registrable domain) and in
 * total. The operator budget stops one registrable domain's wildcard
 * subdomains from filling the store alone; it does not reserve capacity for
 * anyone else, so several operators together can still exhaust the total.
 * Facts are never evicted to regain capacity; a refused merge fails closed.
 */
export class InMemoryOriginRevocationStore implements MonotonicOriginRevocationStore {
  readonly durability = 'process-local' as const;
  private readonly revoked = new Map<string, RevocationDetail>();
  private readonly originKeys = new Map<string, number>();
  private readonly operatorKeys = new Map<string, number>();
  private readonly limits: { perOrigin: number; perOperator: number; total: number };
  constructor(limits: { perOrigin?: number; perOperator?: number; total?: number } = {}) {
    this.limits = {
      perOrigin: limits.perOrigin ?? 16384,
      perOperator: limits.perOperator ?? 16384,
      total: limits.total ?? 100000,
    };
    if (Object.values(this.limits).some(value => !Number.isSafeInteger(value) || value < 1))
      throw new TypeError('Revocation limits must be positive safe integers');
  }
  async merge(origin: string, snapshot: OriginRevocationSnapshot): Promise<void> {
    origin = canonicalAgentOrigin(origin);
    const operator = operatorOf(origin);
    const additions = new Set(snapshot.revoked_kids.filter(kid => !this.revoked.has(JSON.stringify([origin, kid]))));
    const originCount = this.originKeys.get(origin) ?? 0,
      operatorCount = this.operatorKeys.get(operator) ?? 0;
    if (
      originCount + additions.size > this.limits.perOrigin ||
      operatorCount + additions.size > this.limits.perOperator ||
      this.revoked.size + additions.size > this.limits.total
    )
      throw new WebBotAuthError(403, 'revocation_storage_limit');
    for (const kid of snapshot.revoked_kids) {
      const key = JSON.stringify([origin, kid]),
        prior = this.revoked.get(key),
        detail = snapshot.revocation_details?.[kid] ?? {};
      this.revoked.set(key, mergeRevocationDetail(prior, detail));
    }
    if (additions.size) {
      this.originKeys.set(origin, originCount + additions.size);
      this.operatorKeys.set(operator, operatorCount + additions.size);
    }
  }
  async get(origin: string, keyid: string): Promise<RevocationDetail | undefined> {
    const entry = this.revoked.get(JSON.stringify([canonicalAgentOrigin(origin), keyid]));
    return entry && { ...entry };
  }
}
function operatorOf(origin: string): string {
  try {
    return eTldPlusOne(origin);
  } catch {
    // No registrable domain (IP literal, unlisted suffix): the host is its own bucket.
    return new URL(origin).hostname;
  }
}
/** Polling ceiling (security.mdx): also bounds how long one fetch stays valid during an outage. */
const MAX_POLLING_SECONDS = 1800;
/** See {@link OriginRevocationResolver.status}. */
export type OriginRevocationStatus = 'revoked' | 'current' | 'absent' | 'unknown';
/** The origin answered 404/410 for its revocation list. */
class RevocationListAbsentError extends Error {}
export class OriginRevocationResolver {
  private readonly freshness = new Map<string, number>();
  private readonly updated = new Map<string, number>();
  private readonly graceUntil = new Map<string, number>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly failures = new Map<string, number>();
  private readonly persistenceFailures = new Set<string>();
  private readonly absentUntil = new Map<string, number>();
  constructor(
    private readonly options: {
      directory: import('../signing/web-bot-auth').SignatureDirectoryResolver;
      store: MonotonicOriginRevocationStore;
      pollingIntervalSeconds?: number;
      now?: () => number;
      fetchOptions?: Pick<SsrfFetchOptions, 'lookup' | 'trustedFetchFn'>;
      maxOrigins?: number;
    }
  ) {
    if (!(options.directory instanceof SignatureDirectoryResolver))
      throw new TypeError('Origin revocation requires a verified SignatureDirectoryResolver');
    if (
      !Number.isFinite(options.pollingIntervalSeconds ?? 300) ||
      (options.pollingIntervalSeconds ?? 300) < 60 ||
      (options.pollingIntervalSeconds ?? 300) > 1800
    )
      throw new TypeError('Invalid revocation polling interval');
  }
  /**
   * Compatibility wrapper over {@link status}: `true` when revoked, `false`
   * when the list is current, and `revocation_unavailable` when the identity
   * publishes no list (`absent`) or its status is not known (`unknown`).
   */
  async isRevoked(originUrl: string, keyid: string): Promise<boolean> {
    const state = await this.status(originUrl, keyid);
    if (state === 'revoked') return true;
    if (state === 'current') return false;
    throw new WebBotAuthError(403, state === 'absent' ? 'revocation_absent' : 'revocation_unavailable');
  }
  /**
   * Revocation status of `keyid` at `origin`:
   * - `revoked`: a stored (permanent) revocation covers the key.
   * - `current`: a signed list is current, or within `next_update` + grace.
   * - `absent`: the origin serves no list (404/410). The identity is still
   *   established but cannot be bound for spend.
   * - `unknown`: no list could be verified and grace has passed (or there was
   *   never a list). The identity is not established.
   * Throws {@link WebBotAuthUnavailableError} (`revocation_persistence_failed`)
   * when the history store fails: an infrastructure outage, never a
   * revocation outcome.
   */
  async status(originUrl: string, keyid: string): Promise<OriginRevocationStatus> {
    try {
      return await this.currentStatus(originUrl, keyid);
    } catch (error) {
      if (error instanceof WebBotAuthError && error.reason === 'revocation_persistence_failed')
        throw new WebBotAuthUnavailableError('revocation_persistence_failed', error);
      throw error;
    }
  }
  private async currentStatus(originUrl: string, keyid: string): Promise<OriginRevocationStatus> {
    const origin = canonicalAgentOrigin(originUrl),
      now = this.now();
    if (await this.readStored(origin, keyid)) return 'revoked';
    const settled = async (): Promise<OriginRevocationStatus> => {
      if (await this.readStored(origin, keyid)) return 'revoked';
      if ((this.absentUntil.get(origin) ?? 0) > now) return 'absent';
      return (this.freshness.get(origin) ?? 0) > now || (this.graceUntil.get(origin) ?? 0) > now
        ? 'current'
        : 'unknown';
    };
    if ((this.freshness.get(origin) ?? 0) <= now) {
      if ((this.failures.get(origin) ?? 0) > now) {
        if (this.persistenceFailures.has(origin)) throw new WebBotAuthError(403, 'revocation_persistence_failed');
        return settled();
      }
      let promise = this.pending.get(origin);
      if (!promise) {
        if (
          this.pending.size >= 16 ||
          [...this.pending.keys()].filter(pendingOrigin => operatorOf(pendingOrigin) === operatorOf(origin)).length >= 2
        ) {
          // Refresh capacity is shared across attacker-selectable origins; a
          // full queue must not fail an origin whose signed list is still
          // within its outage grace.
          return settled();
        }
        promise = this.refresh(origin).catch(error => {
          if (this.failures.size >= (this.options.maxOrigins ?? 1000)) {
            const oldest = this.failures.keys().next().value!;
            this.failures.delete(oldest);
            this.persistenceFailures.delete(oldest);
            this.absentUntil.delete(oldest);
          }
          this.failures.set(origin, now + 60);
          if (error instanceof WebBotAuthError && error.reason === 'revocation_persistence_failed') {
            this.persistenceFailures.add(origin);
            this.graceUntil.delete(origin);
          }
          if ((error as { cause?: unknown }).cause instanceof RevocationListAbsentError) {
            // No list is served: the identity stays established without spend.
            this.absentUntil.set(origin, now + 60);
            this.graceUntil.delete(origin);
          }
          throw error;
        });
        this.pending.set(origin, promise);
      }
      try {
        await promise;
      } catch (error) {
        if (error instanceof WebBotAuthError && error.reason === 'revocation_persistence_failed') throw error;
      } finally {
        if (this.pending.get(origin) === promise) this.pending.delete(origin);
      }
    }
    return settled();
  }
  private async readStored(origin: string, keyid: string): Promise<RevocationDetail | undefined> {
    try {
      return await this.options.store.get(origin, keyid);
    } catch (cause) {
      const error = new WebBotAuthError(403, 'revocation_persistence_failed');
      Object.defineProperty(error, 'cause', { value: cause });
      throw error;
    }
  }
  private async refresh(origin: string): Promise<void> {
    try {
      const response = await ssrfSafeFetch(origin + '/.well-known/governance-revocations.json', {
        ...this.options.fetchOptions,
        maxBodyBytes: 256 * 1024,
        timeoutMs: 10_000,
      });
      if (response.status === 404 || response.status === 410) throw new RevocationListAbsentError();
      if (response.status !== 200) throw new Error('Unavailable revocation list');
      const body = new TextDecoder('utf-8', { fatal: true }).decode(response.body);
      let tokens: string[];
      if (body.trim().startsWith('{')) {
        const envelope = parseStrictJson(body, 32) as {
          payload?: string;
          signatures?: Array<{ protected?: string; signature?: string; header?: unknown }>;
          protected?: string;
          signature?: string;
          jws?: string;
        };
        if (typeof envelope.jws === 'string') tokens = [envelope.jws];
        else {
          if ('header' in envelope) throw new Error('Revocation metadata must be protected');
          const signatures =
            envelope.signatures ??
            (envelope.protected && envelope.signature
              ? [{ protected: envelope.protected, signature: envelope.signature }]
              : []);
          if (
            typeof envelope.payload !== 'string' ||
            !Array.isArray(signatures) ||
            !signatures.length ||
            signatures.length > 64
          )
            throw new Error('Invalid JWS revocation envelope');
          tokens = signatures.map(signature => {
            if (
              typeof signature.protected !== 'string' ||
              typeof signature.signature !== 'string' ||
              signature.header !== undefined
            )
              throw new Error('Revocation metadata must be protected');
            return `${signature.protected}.${envelope.payload}.${signature.signature}`;
          });
        }
      } else tokens = [body.trim()];
      let verifiedPayload: Uint8Array | undefined;
      for (const token of tokens) {
        try {
          const header = decodeProtectedHeader(token);
          if (header.typ !== 'adcp-gov-revocation+jws' || typeof header.kid !== 'string') continue;
          await this.options.directory.resolve(header.kid, origin);
          const checked = this.options.directory.getVerifiedDirectory(origin);
          if (!checked || new URL(checked.proof.request.url).origin !== origin || checked.expires <= this.now())
            continue;
          const jwk = checked.keys.find(key => key.kid === header.kid);
          if (!jwk) continue;
          // Directory keys are Ed25519 only under the profile (adcp#7894), so a list is EdDSA only.
          const result = await compactVerify(token, await importJWK(jwk as JWK, 'EdDSA'), {
            algorithms: ['EdDSA'],
          });
          verifiedPayload = result.payload;
          break;
        } catch {
          /* Another protected signature may carry the rotation key. */
        }
      }
      if (!verifiedPayload) throw new Error('No valid protected revocation signature');
      const snapshot = parseStrictJson(
        new TextDecoder('utf-8', { fatal: true }).decode(verifiedPayload),
        32
      ) as OriginRevocationSnapshot;
      const updated = Date.parse(snapshot.updated) / 1000,
        next = Date.parse(snapshot.next_update) / 1000,
        now = this.now();
      if (
        snapshot.issuer !== origin ||
        !Number.isFinite(updated) ||
        !Number.isFinite(next) ||
        // Tolerate a publisher clock slightly ahead, as for request `created`.
        updated > now + 60 ||
        next <= now ||
        next <= updated ||
        !Array.isArray(snapshot.revoked_kids) ||
        snapshot.revoked_kids.length > 4096 ||
        snapshot.revoked_kids.some(k => typeof k !== 'string' || k.length > 256) ||
        updated < (this.updated.get(origin) ?? 0)
      )
        throw new Error('Invalid revocation snapshot');
      for (const [kid, detail] of Object.entries(snapshot.revocation_details ?? {}))
        if (
          !snapshot.revoked_kids.includes(kid) ||
          !detail ||
          (detail.reason && !REASONS.includes(detail.reason)) ||
          (detail.invalidity_date && !Number.isFinite(Date.parse(detail.invalidity_date)))
        )
          throw new Error('Invalid revocation detail');
      try {
        await this.options.store.merge(origin, snapshot);
      } catch (cause) {
        const error = new WebBotAuthError(403, 'revocation_persistence_failed');
        Object.defineProperty(error, 'cause', { value: cause });
        throw error;
      }
      if (!this.freshness.has(origin) && this.freshness.size >= (this.options.maxOrigins ?? 1000)) {
        const oldest = this.freshness.keys().next().value!;
        this.freshness.delete(oldest);
        this.updated.delete(oldest);
        this.graceUntil.delete(oldest);
      }
      // Staleness follows the signed next_update (plus grace) and is never
      // shortened by the polling interval. A publisher cannot stretch outage
      // tolerance past the 30-minute ceiling: validity counted from this
      // successful fetch is capped there, and each re-poll of an unchanged
      // long-cadence list renews it.
      this.graceUntil.set(
        origin,
        Math.min(next, now + MAX_POLLING_SECONDS) + 4 * (this.options.pollingIntervalSeconds ?? 300)
      );
      this.updated.set(origin, updated);
      this.freshness.set(origin, Math.min(next, now + (this.options.pollingIntervalSeconds ?? 300)));
      this.failures.delete(origin);
      this.persistenceFailures.delete(origin);
      this.absentUntil.delete(origin);
    } catch (cause) {
      if (cause instanceof WebBotAuthError && cause.reason === 'revocation_persistence_failed') throw cause;
      const error = new WebBotAuthError(403, 'revocation_unavailable');
      Object.defineProperty(error, 'cause', { value: cause });
      throw error;
    }
  }
  private now(): number {
    const now = (this.options.now ?? (() => Date.now() / 1000))();
    if (!Number.isFinite(now)) throw new WebBotAuthError(403, 'revocation_unavailable');
    return now;
  }
}

/** Publish a signed list even when there are no revoked keys; refresh before next_update. */
export async function createSignedOriginRevocationList(
  snapshot: OriginRevocationSnapshot,
  privateKey: JWK
): Promise<string> {
  const issuer = canonicalAgentOrigin(snapshot.issuer),
    now = Date.now() / 1000;
  if (
    issuer !== snapshot.issuer ||
    !Number.isFinite(Date.parse(snapshot.updated)) ||
    !Number.isFinite(Date.parse(snapshot.next_update)) ||
    Date.parse(snapshot.updated) / 1000 > now ||
    Date.parse(snapshot.next_update) / 1000 <= now ||
    Date.parse(snapshot.next_update) / 1000 > now + 1800 ||
    !Array.isArray(snapshot.revoked_kids)
  )
    throw new TypeError('Invalid origin revocation snapshot');
  const kid = jwkThumbprint(privateKey);
  if (privateKey.kid && privateKey.kid !== kid)
    throw new TypeError('Revocation signing kid must be the JWK thumbprint');
  // The signing key must be publishable in the origin's key directory, which
  // holds Ed25519 keys only (adcp#7894).
  const alg = 'EdDSA';
  if (privateKey.kty !== 'OKP' || privateKey.crv !== 'Ed25519' || !privateKey.d)
    throw new TypeError('Revocations require a private Ed25519 key');
  return new CompactSign(Buffer.from(JSON.stringify(snapshot)))
    .setProtectedHeader({ alg, kid, typ: 'adcp-gov-revocation+jws' })
    .sign(await importJWK(privateKey, alg));
}
