// Preview utilities for rendering product/format cards with creative agent

import type { SingleAgentClient } from '../core/SingleAgentClient';
import type { Format, Product, FormatReferenceStructuredObject as FormatID } from '../types/tools.generated';
import type { PreviewCreativeRequest, PreviewCreativeResponse } from '../types/tools.generated';

/**
 * Preview result for a single item (product or format)
 */
export interface PreviewResult {
  /** The item being previewed (Product or Format) */
  item: Product | Format;
  /** Preview URL for the rendered card */
  previewUrl?: string;
  /** Preview ID from the creative agent */
  previewId?: string;
  /** Error message if preview failed */
  error?: string;
}

/**
 * Options for batch preview generation
 */
export interface BatchPreviewOptions {
  /** Cache TTL in milliseconds (defaults to 1 hour) */
  cacheTtl?: number;
  /** Whether to skip cache and force fresh previews (defaults to false) */
  skipCache?: boolean;
}

/**
 * Cache entry for preview results
 */
interface CacheEntry {
  previewUrl: string;
  previewId: string;
  timestamp: number;
}

/**
 * Simple in-memory cache for preview results
 * Key format: `${itemType}:${formatId.agent_url}:${formatId.id}:${manifestHash}`
 */
const previewCache = new Map<string, CacheEntry>();

/**
 * Generate a cache key for a preview request
 */
function getCacheKey(formatId: FormatID, manifest: any): string {
  // Simple hash of manifest for cache key
  const manifestStr = JSON.stringify(manifest);
  const manifestHash = Array.from(manifestStr)
    .reduce((hash, char) => (hash << 5) - hash + char.charCodeAt(0), 0)
    .toString(36);

  return `${formatId.agent_url}:${formatId.id}:${manifestHash}`;
}

/**
 * Get cached preview if available and not expired
 */
function getCachedPreview(cacheKey: string, ttl: number): CacheEntry | null {
  const entry = previewCache.get(cacheKey);
  if (!entry) return null;

  const now = Date.now();
  if (now - entry.timestamp > ttl) {
    previewCache.delete(cacheKey);
    return null;
  }

  return entry;
}

/**
 * Set cached preview
 */
function setCachedPreview(cacheKey: string, previewUrl: string, previewId: string): void {
  previewCache.set(cacheKey, {
    previewUrl,
    previewId,
    timestamp: Date.now(),
  });
}

/**
 * Clear all cached previews
 */
export function clearPreviewCache(): void {
  previewCache.clear();
}

/**
 * Extract preview URLs from products' `product_card` fields.
 *
 * AdCP 3.1.0-beta.2 changed `product_card` from a creative-agent-rendered
 * shape (`{ format_id, manifest }`) to a self-contained visual card
 * (`{ image, title, description, price_label, cta_label }`). The card IS
 * the preview — no creative-agent round-trip required. This function now
 * extracts the image URL directly from the inline card.
 *
 * Products with no `product_card`, or with a card that lacks an `image.url`,
 * return a result with no `previewUrl`. The function preserves its
 * `Promise<PreviewResult[]>` return shape so existing adopters' code paths
 * keep compiling and behaving correctly.
 *
 * @param products - Array of products to extract previews from
 * @param creativeAgentClient - Retained for signature compatibility; unused
 *   under 3.1.0-beta.2's self-rendering card model. Will be removed in
 *   8.0 final (or 9.0 at the latest) — pass any value through during the
 *   beta cycle.
 * @param options - Retained for signature compatibility. Cache fields
 *   (`cacheTtl`, `skipCache`) are unused — there's no expensive call to
 *   cache. Will be removed alongside `creativeAgentClient`.
 * @returns Array of preview results matching input products by index.
 *
 * @example
 * ```typescript
 * const previews = await batchPreviewProducts(products, creativeAgent);
 * previews.forEach(p => {
 *   if (p.previewUrl) {
 *     console.log(`${p.item.name}: ${p.previewUrl}`);
 *   }
 * });
 * ```
 *
 * @deprecated Use `product.product_card?.image?.url` directly. This wrapper
 *   only exists for 8.0-beta migration ergonomics and will be removed.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function batchPreviewProducts(
  products: Product[],
  _creativeAgentClient: SingleAgentClient,
  _options: BatchPreviewOptions = {}
): Promise<PreviewResult[]> {
  return products.map(product => {
    const imageUrl = product.product_card?.image?.url;
    if (imageUrl) {
      return { item: product, previewUrl: imageUrl };
    }
    return { item: product };
  });
}

/**
 * Generate batch previews for formats with format_card manifests
 *
 * Formats with format_card fields will have their cards rendered via the creative agent.
 * Formats without format_card will be returned with no preview.
 *
 * @param formats - Array of formats to preview
 * @param creativeAgentClient - ADCP client configured for creative agent
 * @param options - Preview generation options
 * @returns Array of preview results matching input formats
 *
 * @example
 * ```typescript
 * const creativeAgent = new SingleAgentClient({
 *   id: 'creative',
 *   name: 'Creative Agent',
 *   agent_uri: 'https://creative.adcontextprotocol.org/mcp',
 *   protocol: 'mcp'
 * });
 *
 * const previews = await batchPreviewFormats(formats, creativeAgent);
 * previews.forEach(p => {
 *   if (p.previewUrl) {
 *     console.log(`${(p.item as Format).name}: ${p.previewUrl}`);
 *   }
 * });
 * ```
 */
export async function batchPreviewFormats(
  formats: Format[],
  creativeAgentClient: SingleAgentClient,
  options: BatchPreviewOptions = {}
): Promise<PreviewResult[]> {
  const cacheTtl = options.cacheTtl ?? 3600000; // 1 hour default
  const skipCache = options.skipCache ?? false;

  // Collect all formats that have format_card manifests
  const previewRequests: {
    format: Format;
    formatId: FormatID;
    manifest: any;
    cacheKey: string;
    inputName: string;
  }[] = [];

  const results: PreviewResult[] = [];

  formats.forEach(format => {
    if (format.format_card) {
      const cacheKey = getCacheKey(format.format_card.format_id, format.format_card.manifest);

      // Check cache first
      if (!skipCache) {
        const cached = getCachedPreview(cacheKey, cacheTtl);
        if (cached) {
          results.push({
            item: format,
            previewUrl: cached.previewUrl,
            previewId: cached.previewId,
          });
          return;
        }
      }

      previewRequests.push({
        format,
        formatId: format.format_card.format_id,
        manifest: format.format_card.manifest,
        cacheKey,
        inputName: format.name || 'Format Card',
      });
    } else {
      // No format_card, return format with no preview
      results.push({
        item: format,
      });
    }
  });

  // If all were cached or none have format_card, return early
  if (previewRequests.length === 0) {
    return results;
  }

  // Batch preview using preview_creative with inputs array
  // Group by format_id since preview_creative takes one format_id
  const groupedByFormat = new Map<string, typeof previewRequests>();

  previewRequests.forEach(req => {
    const formatKey = `${req.formatId.agent_url}:${req.formatId.id}`;
    if (!groupedByFormat.has(formatKey)) {
      groupedByFormat.set(formatKey, []);
    }
    groupedByFormat.get(formatKey)!.push(req);
  });

  // Process each format individually
  // Note: Each format has different manifest data, so we can't truly batch them
  // We process them sequentially but could parallelize in the future
  for (const req of previewRequests) {
    try {
      // Build preview_creative request for this format
      // For format cards, the manifest typically contains the format object as JSON
      const previewRequest: PreviewCreativeRequest = {
        request_type: 'single',
        format_id: req.formatId,
        creative_manifest: {
          format_id: req.formatId,
          assets: req.manifest, // manifest contains the asset map (format, etc)
        },
      };

      // Call preview_creative
      const response = await creativeAgentClient.previewCreative(previewRequest);

      // Check for data even if validation failed (response.success may be false due to schema warnings)
      // Handle both single request (previews) and batch request (results) response formats
      const responseData = response.data;
      if (responseData && 'previews' in responseData && responseData.previews && responseData.previews.length > 0) {
        const preview = responseData.previews[0]!;
        if (preview.renders && preview.renders.length > 0) {
          const render = preview.renders[0]!;
          const previewUrl =
            render.output_format === 'url' || render.output_format === 'both' ? render.preview_url : undefined;
          const previewId = preview.preview_id;

          if (previewUrl) {
            // Cache the result
            setCachedPreview(req.cacheKey, previewUrl, previewId);

            results.push({
              item: req.format,
              previewUrl,
              previewId,
            });
          } else {
            results.push({
              item: req.format,
              error: 'Preview render has no URL',
            });
          }
        } else {
          results.push({
            item: req.format,
            error: 'No renders in preview response',
          });
        }
      } else {
        // Only treat as error if we have no data at all
        results.push({
          item: req.format,
          error: response.error || 'Preview generation failed',
        });
      }
    } catch (error) {
      results.push({
        item: req.format,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  return results;
}
