import type { PropertyListReference } from '../types/tools.generated';
import { resolvePropertyList, type ResolveListOptions } from '../server/targeting-helpers';

export interface PropertyListConformanceReport {
  totalRuns: number;
  totalFailures: number;
  results: Array<{ index: number; ok: boolean; identifierCount?: number; code?: string }>;
}

/** Certify buyer-issued references using the same MCP resolver sellers use, with caching disabled. */
export async function runPropertyListConformance(
  references: readonly PropertyListReference[],
  options: ResolveListOptions = {}
): Promise<PropertyListConformanceReport> {
  const results: PropertyListConformanceReport['results'] = [];
  for (const [index, reference] of references.entries()) {
    try {
      const resolved = await resolvePropertyList(reference, {
        ...options,
        cache: false,
        strictResponseValidation: true,
      });
      if (resolved.listId !== reference.list_id) throw new Error('property_list_identity_mismatch');
      results.push({ index, ok: true, identifierCount: resolved.identifiers.length });
    } catch {
      // Reports may be published: never include auth_token, agent URL, or remote exceptions.
      results.push({ index, ok: false, code: 'property_list_reference_unresolvable' });
    }
  }
  return { totalRuns: results.length, totalFailures: results.filter(result => !result.ok).length, results };
}
