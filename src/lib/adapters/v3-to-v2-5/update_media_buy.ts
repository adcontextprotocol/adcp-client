import { adaptUpdateMediaBuyRequestForV2, normalizeMediaBuyResponse } from '../../utils/creative-adapter';
import type { UpdateMediaBuyRequest, UpdateMediaBuyResponse } from '../../types/v2-5';
import type { AdapterPair } from './types';

export const updateMediaBuyAdapter: AdapterPair<unknown, UpdateMediaBuyRequest, UpdateMediaBuyResponse, unknown> = {
  toolName: 'update_media_buy',
  adaptRequest: adaptUpdateMediaBuyRequestForV2,
  // Update responses share the media-buy normalizer (creative_ids ↔
  // creative_assignments + null-array coercion).
  normalizeResponse: normalizeMediaBuyResponse,
};
