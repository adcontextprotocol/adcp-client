import { adaptSyncCreativesRequestForV2 } from '../../../utils/sync-creatives-adapter';
import type { SyncCreativesRequest, SyncCreativesResponse } from '../../../types/v2-5';
import type { AdapterPair } from './types';

/**
 * `sync_creatives` adapter pair. Currently has no v2.5 → v3 response
 * normalizer — sync responses are pass-through. The request adapter is
 * the known-broken thin prefix-stripper tracked at
 * adcontextprotocol/adcp-client#1116; replacing it with a manifest
 * flattener is the next concrete adapter fix.
 */
export const syncCreativesAdapter: AdapterPair<unknown, SyncCreativesRequest, SyncCreativesResponse, unknown> = {
  toolName: 'sync_creatives',
  adaptRequest: adaptSyncCreativesRequestForV2,
};
