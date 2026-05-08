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
