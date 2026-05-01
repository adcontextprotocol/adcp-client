import { adaptCreateMediaBuyRequestForV2, normalizeMediaBuyResponse } from '../../../utils/creative-adapter';
import type { CreateMediaBuyRequest, CreateMediaBuyResponse } from '../../../types/v2-5';
import type { AdapterPair } from './types';

export const createMediaBuyAdapter: AdapterPair<unknown, CreateMediaBuyRequest, CreateMediaBuyResponse, unknown> = {
  toolName: 'create_media_buy',
  adaptRequest: adaptCreateMediaBuyRequestForV2,
  normalizeResponse: normalizeMediaBuyResponse,
};
