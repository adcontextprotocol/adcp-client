/**
 * Helpers for building paginated list responses.
 *
 * `list_creatives` is the heaviest of the read tools: its response wraps the
 * row array in `query_summary` (`total_matching`, `returned`, `filters_applied`,
 * `sort_applied`) AND `pagination` (`has_more`, `cursor`, `total_count`).
 * Adopters writing the wrapper by hand re-derive the same fields per call;
 * this helper threads a row array + pagination cursor + the original request
 * into the wire shape.
 *
 * `list_property_lists`, `list_collection_lists`, and other governance reads
 * use a simpler `{ lists: [...] }` wrapper that the framework's response
 * builders already cover — those don't need a row helper.
 *
 * Status: Preview / 6.0.
 *
 * @public
 */

import type { ListCreativesRequest, ListCreativesResponse, PaginationResponse } from '../../types/tools.generated';

export interface BuildListCreativesResponseOpts {
  /** Original request — used to surface `filters_applied` + `sort_applied` summaries. */
  request: ListCreativesRequest;
  /** The page of creative rows. Length determines `query_summary.returned`. */
  creatives: ListCreativesResponse['creatives'];
  /** Pagination cursor for the next page. Required — pass `{ has_more: false }` when this is the last page. */
  pagination: PaginationResponse;
  /**
   * Total count across all pages. When omitted, defaults to
   * `pagination.total_count` if present, else `creatives.length` (last-page
   * approximation). Set explicitly when your backend can compute the true
   * total.
   */
  totalMatching?: number;
}

/**
 * Build a `ListCreativesResponse` from a row array + pagination + the
 * original request. Computes `query_summary.filters_applied` from
 * `request.filters` and threads `request.sort` into `sort_applied`.
 *
 * ```ts
 * listCreatives: async (req, ctx) => {
 *   const rows = await this.db.queryCreatives(req);
 *   const cursor = rows.length === req.pagination?.limit ? this.nextCursor(rows) : undefined;
 *   return buildListCreativesResponse({
 *     request: req,
 *     creatives: rows,
 *     pagination: { has_more: cursor != null, cursor, total_count: rows.totalCount },
 *   });
 * }
 * ```
 */
export function buildListCreativesResponse(opts: BuildListCreativesResponseOpts): ListCreativesResponse {
  const { request, creatives, pagination, totalMatching } = opts;

  const filters = request.filters;
  const filtersApplied: string[] = [];
  if (filters) {
    if (filters.accounts?.length) filtersApplied.push('accounts');
    if (filters.statuses?.length) filtersApplied.push('statuses');
    if (filters.tags?.length) filtersApplied.push('tags');
    if (filters.tags_any?.length) filtersApplied.push('tags_any');
    if (filters.name_contains) filtersApplied.push('name_contains');
    if (filters.creative_ids?.length) filtersApplied.push('creative_ids');
    if (filters.created_after) filtersApplied.push('created_after');
    if (filters.created_before) filtersApplied.push('created_before');
    if (filters.updated_after) filtersApplied.push('updated_after');
    if (filters.updated_before) filtersApplied.push('updated_before');
    if (filters.assigned_to_packages?.length) filtersApplied.push('assigned_to_packages');
    if (filters.media_buy_ids?.length) filtersApplied.push('media_buy_ids');
    if (filters.unassigned !== undefined) filtersApplied.push('unassigned');
    if (filters.has_served !== undefined) filtersApplied.push('has_served');
    if (filters.concept_ids?.length) filtersApplied.push('concept_ids');
    if (filters.format_ids?.length) filtersApplied.push('format_ids');
    if (filters.has_variables !== undefined) filtersApplied.push('has_variables');
  }

  const summary: ListCreativesResponse['query_summary'] = {
    total_matching: totalMatching ?? pagination.total_count ?? creatives.length,
    returned: creatives.length,
    ...(filtersApplied.length > 0 && { filters_applied: filtersApplied }),
    ...(request.sort && {
      sort_applied: {
        ...(request.sort.field !== undefined && { field: request.sort.field }),
        ...(request.sort.direction !== undefined && { direction: request.sort.direction }),
      },
    }),
  };

  return {
    query_summary: summary,
    pagination,
    creatives,
  };
}
