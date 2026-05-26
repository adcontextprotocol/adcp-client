/**
 * Publisher-catalog helpers for AdCP 3.1's `adagents.json#/formats`.
 *
 * Used after `validateAdAgents()` (from `src/lib/discovery/`) returns a
 * parsed `AdAgentsJson` — these helpers extract + scope + resolve
 * `format_option_id` references against the publisher's format catalog.
 *
 * Typical flow:
 *
 * ```ts
 * import { validateAdAgents } from '@adcp/sdk/discovery';
 * import {
 *   extractPublisherFormats,
 *   scopePublisherFormats,
 *   resolveFormatOptionId,
 * } from '@adcp/sdk/v2/publisher-catalog';
 *
 * const { adagents } = await validateAdAgents('https://nytimes.com');
 * const all = extractPublisherFormats(adagents);
 * const homepageFormats = scopePublisherFormats(all, { propertyId: 'homepage' });
 * const placementFormat = resolveFormatOptionId(homepageFormats, 'nytimes_homepage_takeover_premium');
 * ```
 *
 * No new fetcher — uses the existing discovery layer's HTTPS-only fetch
 * with SSRF guards, ads.txt MANAGERDOMAIN fallback, cycle detection,
 * and authoritative_location redirect handling.
 */

export {
  extractPublisherFormats,
  scopePublisherFormats,
  resolveFormatOptionId,
  resolveCapabilityId,
  type PublisherFormatScope,
} from './formats';

// Re-export the AdAgentsJson types from discovery for caller convenience —
// the publisher-catalog module is the natural import site for adopters
// using AdCP 3.1's publisher-scoped format catalog.
export type { AdAgentsPublisherFormat, AdAgentsJson } from '../../discovery/types';
