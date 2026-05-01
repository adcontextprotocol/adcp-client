import { adaptSyncCreativesRequestForV2 } from '../../../utils/sync-creatives-adapter';
import type { SyncCreativesRequest, SyncCreativesResponse } from '../../../types/v2-5';
import type { AdapterPair } from './types';

/**
 * `sync_creatives` adapter pair. Currently has no v2.5 → v3 response
 * normalizer — sync responses are pass-through. The request adapter strips
 * v3-only fields and converts `status` enum → `approved` boolean; `assets`
 * passes through verbatim because v2.5 uses the same role-keyed manifest
 * shape as v3.
 */
export const syncCreativesAdapter: AdapterPair<unknown, SyncCreativesRequest, SyncCreativesResponse, unknown> = {
  toolName: 'sync_creatives',
  adaptRequest: adaptSyncCreativesRequestForV2,
};
