// CatalogSync — in-memory replica of an AdCP agent's product and signal
// catalog. Discovers the agent's catalog-sync capabilities at start() and
// picks the highest-capability sync strategy the agent supports (auto-poll
// conditional fetch or manual bootstrap).
//
// Companion to the AdCP 3.1 catalog-sync cluster (issue
// adcontextprotocol/adcp#4794). Activates against 3.1+ agents that
// declare `wholesale_feed_versioning` and/or `wholesale_feed_webhooks`; falls back
// to manual-mode bootstrap against 3.0 agents.

export { CatalogSync } from './sync';
export type {
  CatalogSyncClient,
  CatalogSyncConfig,
  CatalogSyncEvents,
  CatalogSyncMode,
  CatalogSyncState,
  ProductFilter,
  ResolvedCapabilities,
  SignalFilter,
} from './types';
// Re-export the cursor-store interface and built-in implementations so
// consumers don't have to dig into the registry-sync surface to find
// them — same shape, same semantics, just a different consumer.
export type { CursorStore } from '../registry/cursor-store';
export { InMemoryCursorStore, FileCursorStore } from '../registry/cursor-store';
