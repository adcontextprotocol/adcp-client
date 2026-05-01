import { normalizeFormatsResponse } from '../../../utils/format-renders';
import type { ListCreativeFormatsRequest, ListCreativeFormatsResponse } from '../../../types/v2-5';
import type { AdapterPair } from './types';

/**
 * `list_creative_formats` has no v2.5 wire-shape divergence on the request
 * side (pass-through). The response normalizer maps v2.5's older format
 * shape (`format_id` strings, etc.) to the v3 surface.
 */
export const listCreativeFormatsAdapter: AdapterPair<
  ListCreativeFormatsRequest,
  ListCreativeFormatsRequest,
  ListCreativeFormatsResponse,
  unknown
> = {
  toolName: 'list_creative_formats',
  adaptRequest: req => req,
  normalizeResponse: normalizeFormatsResponse,
};
