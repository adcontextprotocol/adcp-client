import type { PaginationRequest, PaginationResponse } from '../types/tools.generated';

export interface PaginateOptions {
  /** Maximum total items to fetch across all pages */
  maxItems?: number;
  /** Maximum number of pages to fetch (default: 100) */
  maxPages?: number;
  /** Page size hint passed as max_results per request */
  pageSize?: number;
}

type PaginatedResponse = {
  pagination?: PaginationResponse;
  [key: string]: unknown;
};

/**
 * Collect all items across paginated AdCP responses.
 *
 * @param fetchPage - Calls the paginated endpoint with optional pagination params
 * @param getItems - Extracts the item array from a single page response
 * @param options - Controls for page size, max items, and max pages
 */
export async function paginate<TResponse extends PaginatedResponse, TItem>(
  fetchPage: (pagination?: PaginationRequest) => Promise<TResponse>,
  getItems: (response: TResponse) => TItem[],
  options?: PaginateOptions
): Promise<TItem[]> {
  const maxPages = options?.maxPages ?? 100;
  const allItems: TItem[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const pagination: PaginationRequest | undefined =
      cursor || options?.pageSize ? { cursor, max_results: options?.pageSize } : undefined;

    const response = await fetchPage(pagination);
    const items = getItems(response);
    allItems.push(...items);

    if (options?.maxItems && allItems.length >= options.maxItems) {
      return allItems.slice(0, options.maxItems);
    }

    if (!response.pagination?.has_more || !response.pagination?.cursor) {
      break;
    }

    cursor = response.pagination.cursor;
  }

  return allItems;
}

/**
 * Async generator that yields one page at a time from a paginated AdCP endpoint.
 * Useful for progressive/streaming UI rendering.
 *
 * @param fetchPage - Calls the paginated endpoint with optional pagination params
 * @param options - Controls for page size and max pages
 */
export async function* paginatePages<TResponse extends PaginatedResponse>(
  fetchPage: (pagination?: PaginationRequest) => Promise<TResponse>,
  options?: PaginateOptions
): AsyncGenerator<TResponse> {
  const maxPages = options?.maxPages ?? 100;
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const pagination: PaginationRequest | undefined =
      cursor || options?.pageSize ? { cursor, max_results: options?.pageSize } : undefined;

    const response = await fetchPage(pagination);
    yield response;

    if (!response.pagination?.has_more || !response.pagination?.cursor) {
      break;
    }

    cursor = response.pagination.cursor;
  }
}
