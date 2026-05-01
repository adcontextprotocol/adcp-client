import { normalizePreviewCreativeResponse } from '../../../utils/preview-normalizer';
import type { PreviewCreativeRequest, PreviewCreativeResponse } from '../../../types/v2-5';
import type { AdapterPair } from './types';

export const previewCreativeAdapter: AdapterPair<
  PreviewCreativeRequest,
  PreviewCreativeRequest,
  PreviewCreativeResponse,
  unknown
> = {
  toolName: 'preview_creative',
  adaptRequest: req => req,
  normalizeResponse: normalizePreviewCreativeResponse,
};
