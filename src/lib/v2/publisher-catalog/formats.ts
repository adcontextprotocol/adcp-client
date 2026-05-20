/**
 * Publisher-scoped format catalog helpers (AdCP 3.1).
 *
 * Built on top of the existing `validateAdAgents()` discovery flow —
 * publishers' `formats[]` arrives via the same `.well-known/adagents.json`
 * fetch chain (with ads.txt `MANAGERDOMAIN` fallback, SSRF guards,
 * cycle detection). This module adds the 3.1-specific extraction +
 * scoping + capability_id resolution on top.
 *
 * Three helpers:
 *
 *   - `extractPublisherFormats(adAgents)` — returns the raw formats[]
 *     from a validated adagents.json, or [] when absent.
 *   - `scopePublisherFormats(formats, scope)` — filters by `propertyId`
 *     and/or `propertyTags`. Formats with no `applies_to_*` apply to
 *     all properties at the publisher. Formats with both `propertyIds`
 *     and `propertyTags` set match either.
 *   - `resolveCapabilityId(formats, capabilityId)` — looks up a single
 *     publisher format by `capability_id`. Used when a placement's
 *     `format_options[i]` references a publisher format by id rather
 *     than declaring inline.
 *
 * Out of scope (deferred):
 *   - Fetching adagents.json itself (use `validateAdAgents` from
 *     `src/lib/discovery/`).
 *   - Merging the AAO base catalog with the publisher catalog —
 *     done at the projection layer, not here.
 *   - Auto-negotiation (separate 7.12+ surface).
 */

import type { AdAgentsJson, AdAgentsPublisherFormat } from '../../discovery/types';

/** Scope hint for filtering a publisher's formats. */
export interface PublisherFormatScope {
  /** Match only formats whose `applies_to_property_ids` includes this ID (and formats with no `applies_to_*`). */
  propertyId?: string;
  /** Match only formats whose `applies_to_property_tags` overlaps with these tags. */
  propertyTags?: string[];
}

/**
 * Pull the publisher-published format catalog out of a validated
 * adagents.json. Returns the raw array (with all `applies_to_*`
 * scoping intact) so callers can do their own filtering.
 *
 * `AdAgentsJson.formats` is optional and absent on 3.0.x adagents.json
 * — this returns `[]` in that case for caller convenience.
 */
export function extractPublisherFormats(adAgents: AdAgentsJson | null | undefined): AdAgentsPublisherFormat[] {
  if (!adAgents?.formats) return [];
  return adAgents.formats;
}

/**
 * Filter a publisher's formats by scope. A format matches when:
 *
 *   - It declares no `applies_to_*` (applies to all properties), OR
 *   - `scope.propertyId` is set AND the format's
 *     `applies_to_property_ids` includes it, OR
 *   - `scope.propertyTags` overlaps with the format's
 *     `applies_to_property_tags`.
 *
 * When `scope` is empty `{}`, returns formats that apply to all
 * properties (no `applies_to_*`); formats scoped to specific
 * properties/tags are excluded. Pass an empty filter when you want
 * the publisher's "default" formats.
 *
 * When neither `propertyId` nor `propertyTags` is provided AND you
 * want every format regardless of scoping, just use
 * `extractPublisherFormats` directly.
 */
export function scopePublisherFormats(
  formats: AdAgentsPublisherFormat[],
  scope: PublisherFormatScope = {}
): AdAgentsPublisherFormat[] {
  return formats.filter(f => {
    const hasIdScope = Array.isArray(f.applies_to_property_ids) && f.applies_to_property_ids.length > 0;
    const hasTagScope = Array.isArray(f.applies_to_property_tags) && f.applies_to_property_tags.length > 0;

    // No scoping → applies to all properties; always include.
    if (!hasIdScope && !hasTagScope) return true;

    // Format is scoped. Match by id OR by tag.
    if (scope.propertyId && hasIdScope && f.applies_to_property_ids!.includes(scope.propertyId)) {
      return true;
    }
    if (scope.propertyTags && hasTagScope) {
      const overlap = scope.propertyTags.some(t => f.applies_to_property_tags!.includes(t));
      if (overlap) return true;
    }
    return false;
  });
}

/**
 * Resolve a `capability_id` reference against a publisher's catalog.
 * Used when a placement's `format_options[i]` declares
 * `{ capability_id: 'meta_reels' }` rather than an inline declaration
 * — the SDK looks up the full format declaration on the publisher's
 * adagents.json by id.
 *
 * Returns undefined when no format matches (caller surfaces a
 * diagnostic; placement is unresolved).
 *
 * Note: capability_id uniqueness is the publisher's responsibility.
 * If two formats share the same id, this returns the first match
 * (formats array order is preserved from the publisher's adagents.json).
 */
export function resolveCapabilityId(
  formats: AdAgentsPublisherFormat[],
  capabilityId: string
): AdAgentsPublisherFormat | undefined {
  return formats.find(f => f.capability_id === capabilityId);
}
