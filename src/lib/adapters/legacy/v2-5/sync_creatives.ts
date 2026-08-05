import { adaptSyncCreativesRequestForV2 } from '../../../utils/sync-creatives-adapter';
import type { SyncCreativesRequest, SyncCreativesResponse } from '../../../types/v2-5';
import type { AdapterPair } from './types';

/**
 * `sync_creatives` adapter pair. Currently has no v2.5 → v3 response
 * normalizer — sync responses are pass-through. The request adapter strips
 * v3-only fields, converts `status` enum → `approved` boolean, and groups
 * v3 assignment edges into v2.5's creative-keyed package mapping. `assets`
 * passes through with the v3 `asset_type` discriminator stripped because
 * v2.5 uses the role key as its discriminator.
 */
export const syncCreativesAdapter: AdapterPair<unknown, SyncCreativesRequest, SyncCreativesResponse, unknown> = {
  toolName: 'sync_creatives',
  adaptRequest: adaptSyncCreativesRequestForV2,
};
