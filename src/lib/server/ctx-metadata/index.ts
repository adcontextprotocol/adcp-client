/**
 * Public surface for the ctx-metadata store.
 *
 * @see docs/proposals/decisioning-platform-v6-1-ctx-metadata.md
 * @public
 */

export {
  createCtxMetadataStore,
  ctxMetadataResultKey,
  scopeCtxMetadataKey,
  CtxMetadataValidationError,
  ADCP_INTERNAL_TAG,
  DEFAULT_MAX_VALUE_BYTES,
  MAX_TTL_SECONDS,
} from './store';

export type {
  CtxMetadataStore,
  CtxMetadataStoreConfig,
  CtxMetadataBackend,
  CtxMetadataEntry,
  CtxMetadataRef,
  ResourceKind,
} from './store';

export { memoryCtxMetadataStore } from './backends/memory';
export type { MemoryCtxMetadataStoreOptions } from './backends/memory';

export {
  pgCtxMetadataStore,
  getCtxMetadataMigration,
  cleanupExpiredCtxMetadata,
  CTX_METADATA_MIGRATION,
} from './backends/pg';
export type { PgCtxMetadataBackendOptions } from './backends/pg';

export { stripCtxMetadata, hasCtxMetadata } from './wire-shape';
export type { WireShape } from './wire-shape';
