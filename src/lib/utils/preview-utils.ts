// Preview utilities for rendering product/format cards with creative agent

import type { ADCPClient } from '../core/ADCPClient';
import type { Format, Product, FormatID } from '../types/tools.generated';
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
    .reduce((hash, char) => ((hash << 5) - hash) + char.charCodeAt(0), 0)
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
 * Generate batch previews for products with product_card manifests
 *
 * Products with product_card fields will have their cards rendered via the creative agent.
 * Products without product_card will be returned with no preview.
 *
 * @param products - Array of products to preview
 * @param creativeAgentClient - ADCP client configured for creative agent
 * @param options - Preview generation options
 * @returns Array of preview results matching input products
 *
 * @example
 * ```typescript
 * const creativeAgent = new ADCPClient({
 *   id: 'creative',
 *   name: 'Creative Agent',
 *   agent_uri: 'https://creative.adcontextprotocol.org/mcp',
 *   protocol: 'mcp'
 * });
 *
 * const previews = await batchPreviewProducts(products, creativeAgent);
 * previews.forEach(p => {
 *   if (p.previewUrl) {
 *     console.log(`${p.item.name}: ${p.previewUrl}`);
 *   }
 * });
 * ```
 */
export async function batchPreviewProducts(
  products: Product[],
  creativeAgentClient: ADCPClient,
  options: BatchPreviewOptions = {}
): Promise<PreviewResult[]> {
  const cacheTtl = options.cacheTtl ?? 3600000; // 1 hour default
  const skipCache = options.skipCache ?? false;

  // Collect all products that have product_card manifests
  const previewRequests: {
    product: Product;
    formatId: FormatID;
    manifest: any;
    cacheKey: string;
    inputName: string;
  }[] = [];

  const results: PreviewResult[] = [];

  products.forEach(product => {
    if (product.product_card) {
      const cacheKey = getCacheKey(product.product_card.format_id, product.product_card.manifest);

      // Check cache first
      if (!skipCache) {
        const cached = getCachedPreview(cacheKey, cacheTtl);
        if (cached) {
          results.push({
            item: product,
            previewUrl: cached.previewUrl,
            previewId: cached.previewId,
          });
          return;
        }
      }

      previewRequests.push({
        product,
        formatId: product.product_card.format_id,
        manifest: product.product_card.manifest,
        cacheKey,
        inputName: product.name || 'Product Card',
      });
    } else {
      // No product_card, return product with no preview
      results.push({
        item: product,
      });
    }
  });

  // If all were cached or none have product_card, return early
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

  // Process each format group
  for (const [formatKey, requests] of groupedByFormat) {
    try {
      const firstReq = requests[0];

      // Build preview_creative request with inputs array for batch processing
      const previewRequest: PreviewCreativeRequest = {
        format_id: firstReq.formatId,
        creative_manifest: requests[0].manifest, // Use first manifest as base
        inputs: requests.map(req => ({
          name: req.inputName,
          macros: {}, // Product cards don't typically use macros
        })),
      };

      // Call preview_creative
      const response = await creativeAgentClient.previewCreative(previewRequest);

      if (response.success && response.data?.previews) {
        // Map previews back to products
        requests.forEach((req, index) => {
          const preview = response.data!.previews[index];
          if (preview && preview.renders && preview.renders.length > 0) {
            const previewUrl = preview.renders[0].preview_url;
            const previewId = preview.preview_id;

            // Cache the result
            setCachedPreview(req.cacheKey, previewUrl, previewId);

            results.push({
              item: req.product,
              previewUrl,
              previewId,
            });
          } else {
            results.push({
              item: req.product,
              error: 'No renders in preview response',
            });
          }
        });
      } else {
        // Preview failed for this format group
        requests.forEach(req => {
          results.push({
            item: req.product,
            error: response.error || 'Preview generation failed',
          });
        });
      }
    } catch (error) {
      // Error calling preview_creative
      requests.forEach(req => {
        results.push({
          item: req.product,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      });
    }
  }

  return results;
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
 * const creativeAgent = new ADCPClient({
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
  creativeAgentClient: ADCPClient,
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

  // Process each format group
  for (const [formatKey, requests] of groupedByFormat) {
    try {
      const firstReq = requests[0];

      // Build preview_creative request with inputs array for batch processing
      const previewRequest: PreviewCreativeRequest = {
        format_id: firstReq.formatId,
        creative_manifest: requests[0].manifest, // Use first manifest as base
        inputs: requests.map(req => ({
          name: req.inputName,
          macros: {}, // Format cards don't typically use macros
        })),
      };

      // Call preview_creative
      const response = await creativeAgentClient.previewCreative(previewRequest);

      if (response.success && response.data?.previews) {
        // Map previews back to formats
        requests.forEach((req, index) => {
          const preview = response.data!.previews[index];
          if (preview && preview.renders && preview.renders.length > 0) {
            const previewUrl = preview.renders[0].preview_url;
            const previewId = preview.preview_id;

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
              error: 'No renders in preview response',
            });
          }
        });
      } else {
        // Preview failed for this format group
        requests.forEach(req => {
          results.push({
            item: req.format,
            error: response.error || 'Preview generation failed',
          });
        });
      }
    } catch (error) {
      // Error calling preview_creative
      requests.forEach(req => {
        results.push({
          item: req.format,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      });
    }
  }

  return results;
}
