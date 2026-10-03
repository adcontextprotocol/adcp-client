import { calculateJwkThumbprint, type JWK } from 'jose';
import type { AdcpJsonWebKey } from './types';
import { AgentResolverError } from './agent-resolver/errors';

export interface PublisherSigningKeyPin {
  /** Publisher identity from the buyer's own record, for local diagnostics. */
  publisher: string;
  /** undefined means no pin; an empty pin accepts no keys. */
  signingKeys?: readonly Record<string, unknown>[];
  /** Fetch adagents.json without its usual cache. Reuse a callback bound to this agent/publisher/tenant across deliveries; refreshes share a 30-second cooldown. Return null only for confirmed pin removal; throw on failure. */
  refresh: () => Promise<readonly Record<string, unknown>[] | null>;
}

type PinSnapshot = readonly Record<string, unknown>[] | null;
interface RefreshState {
  attemptedAt: number;
  inputPins: string | undefined;
  snapshot?: PinSnapshot;
  error?: unknown;
  inFlight?: Promise<PinSnapshot>;
}
// Callback identity keeps snapshots isolated across agents and tenant contexts.
// Reusing a publisher name alone would allow one context to populate another's pin.
const refreshes = new WeakMap<PublisherSigningKeyPin['refresh'], Map<string, RefreshState>>();

async function refreshPin(publisher: PublisherSigningKeyPin, now: () => number): Promise<PinSnapshot> {
  let states = refreshes.get(publisher.refresh);
  if (!states) refreshes.set(publisher.refresh, (states = new Map()));
  const checkedAt = now();
  const existing = states.get(publisher.publisher);
  if (
    existing &&
    (existing.inFlight || checkedAt - existing.attemptedAt < 30) &&
    existing.inputPins !== JSON.stringify(publisher.signingKeys)
  ) {
    throw new AgentResolverError(
      'request_signature_key_unknown',
      'Publisher pin changed during the refresh cooldown',
      {}
    );
  }
  if (existing?.inFlight) return existing.inFlight;
  if (existing && checkedAt - existing.attemptedAt < 30) {
    if (existing.error !== undefined) throw existing.error;
    return existing.snapshot!;
  }
  const state: RefreshState = { attemptedAt: checkedAt, inputPins: JSON.stringify(publisher.signingKeys) };
  if (states.size >= 512) {
    const evictable = [...states].find(([, candidate]) => !candidate.inFlight);
    if (!evictable)
      throw new AgentResolverError('request_signature_key_unknown', 'Publisher refresh capacity exceeded', {});
    states.delete(evictable[0]);
  }
  states.set(publisher.publisher, state);
  state.inFlight = Promise.resolve().then(async () => {
    try {
      const snapshot = await publisher.refresh();
      if (snapshot === undefined) throw new TypeError('Publisher refresh must return a confirmed pin or null');
      state.snapshot = snapshot === null ? null : Object.freeze(snapshot.map(key => Object.freeze({ ...key })));
      return state.snapshot;
    } catch (error) {
      state.error = error ?? new Error('Publisher refresh failed');
      throw state.error;
    } finally {
      state.inFlight = undefined;
    }
  });
  return state.inFlight;
}

async function thumbprint(key: Record<string, unknown>): Promise<string | undefined> {
  const members =
    key.kty === 'OKP'
      ? ['crv', 'x']
      : key.kty === 'EC'
        ? ['crv', 'x', 'y']
        : key.kty === 'RSA'
          ? ['n', 'e']
          : undefined;
  if (!members || members.some(name => typeof key[name] !== 'string' || key[name] === '')) return undefined;
  try {
    return await calculateJwkThumbprint(key as JWK, 'sha256');
  } catch {
    return undefined;
  }
}

async function matchingValidity(
  keyThumbprint: string,
  pins: readonly Record<string, unknown>[] | undefined
): Promise<number[]> {
  if (pins === undefined) return [Infinity];
  const validity: number[] = [];
  for (const pin of pins) {
    if (!pin || typeof pin !== 'object' || (await thumbprint(pin)) !== keyThumbprint) continue;
    if (pin.revoked_at === undefined) validity.push(Infinity);
    else if (typeof pin.revoked_at === 'string') {
      const revoked = Date.parse(pin.revoked_at) / 1000;
      if (Number.isFinite(revoked)) validity.push(revoked);
    }
  }
  return validity;
}

async function matches(keyThumbprint: string, pins: readonly Record<string, unknown>[] | undefined, now: () => number) {
  const validity = await matchingValidity(keyThumbprint, pins);
  return validity.some(until => now() < until);
}

/** Intersect an already discovered JWKS key with every applicable publisher pin. */
export async function assertPublisherPins(
  jwk: AdcpJsonWebKey,
  publishers: readonly PublisherSigningKeyPin[],
  now: () => number
): Promise<void> {
  const fingerprint = await thumbprint(jwk as unknown as Record<string, unknown>);
  if (!fingerprint) throw new AgentResolverError('request_signature_key_unknown', 'Invalid public key', {});
  const applicable: Array<readonly Record<string, unknown>[] | undefined> = [];
  const supplied: Array<string | undefined> = [];
  for (const publisher of publishers) {
    const inputPins = JSON.stringify(publisher.signingKeys);
    supplied.push(inputPins);
    const recent = refreshes.get(publisher.refresh)?.get(publisher.publisher);
    let selected =
      recent?.snapshot !== undefined && recent.inputPins === inputPins && now() - recent.attemptedAt < 30
        ? (recent.snapshot ?? undefined)
        : publisher.signingKeys;
    if (!(await matches(fingerprint, selected, now))) {
      const refreshed = await refreshPin(publisher, now);
      selected = refreshed ?? undefined;
      if (!(await matches(fingerprint, selected, now)))
        throw new AgentResolverError(
          'request_signature_key_unknown',
          'Key is outside the applicable publisher pin',
          {}
        );
    }
    applicable.push(selected);
  }
  // Await all key comparisons, then check every revocation boundary together.
  // Later publisher discovery cannot extend an earlier publisher's validity.
  const validity = await Promise.all(applicable.map(selected => matchingValidity(fingerprint, selected)));
  const checkedInputs = publishers.map(publisher => JSON.stringify(publisher.signingKeys));
  for (let i = 0; i < publishers.length; i++) {
    if (supplied[i] !== checkedInputs[i]) {
      validity.push(await matchingValidity(fingerprint, publishers[i]!.signingKeys));
    }
  }
  const checkedAt = now();
  if (
    publishers.some((publisher, i) => JSON.stringify(publisher.signingKeys) !== checkedInputs[i]) ||
    validity.some(bounds => !bounds.some(until => checkedAt < until))
  ) {
    throw new AgentResolverError('request_signature_key_unknown', 'Key is outside the applicable publisher pin', {});
  }
}
