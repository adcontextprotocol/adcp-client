// Typed factory helpers for `SignalID` — provenance tuple used in
// `signal_ids` filters and as the `signal_id` field on `Signal` records.
// Schema oneOf on `source: "catalog" | "agent"`. Adopters emit bare ID
// strings for `signal_ids` filters even though the wire shape is an array
// of provenance objects. SHAPE-GOTCHAS §2.

import type { SignalID } from '../types/core.generated';

type CatalogSignal = Extract<SignalID, { source: 'catalog' }>;
type AgentSignal = Extract<SignalID, { source: 'agent' }>;
type Tagged<T, Tag extends string> = Omit<T, 'source'> & { source: Tag };

/** Build a `catalog`-variant `SignalID`. Verifiable via the providers adagents.json. */
export function catalogSignalId(fields: Omit<CatalogSignal, 'source'>): Tagged<CatalogSignal, 'catalog'> {
  return { ...fields, source: 'catalog' };
}

/** Build an `agent`-variant `SignalID`. Agent-native segments not in a catalog. */
export function agentSignalId(fields: Omit<AgentSignal, 'source'>): Tagged<AgentSignal, 'agent'> {
  return { ...fields, source: 'agent' };
}

/** Grouped accessor for both `SignalID` variants. */
export const signalId = {
  catalog: catalogSignalId,
  agent: agentSignalId,
} as const;

/**
 * Return the segment identifier from a `SignalID`, independent of source.
 * Both `catalog` and `agent` variants carry the segment identifier in `id`.
 *
 * @example
 * getSignalId(signalId.catalog({ data_provider_domain: 'polk.com', id: 'likely_ev_buyers' }))
 * // → 'likely_ev_buyers'
 */
export function getSignalId(sid: SignalID): string {
  return sid.id;
}

/**
 * Return the issuer identifier from a `SignalID`, independent of source.
 * - `source: 'catalog'` → `data_provider_domain` (e.g. `'polk.com'`)
 * - `source: 'agent'`   → `agent_url` (e.g. `'https://liveramp.com/.well-known/adcp/signals'`)
 *
 * @example
 * getSignalIssuer(signalId.catalog({ data_provider_domain: 'polk.com', id: 'likely_ev_buyers' }))
 * // → 'polk.com'
 */
export function getSignalIssuer(sid: SignalID): string {
  if (sid.source === 'catalog') return sid.data_provider_domain;
  if (sid.source === 'agent') return sid.agent_url;
  const _exhaustive: never = sid;
  throw new Error(`Unhandled SignalID source: ${String((_exhaustive as { source: unknown }).source)}`);
}
