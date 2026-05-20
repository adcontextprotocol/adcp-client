/**
 * AAO Directory inverse-lookup wrapper per
 * [adcontextprotocol/adcp#4823](https://github.com/adcontextprotocol/adcp/issues/4823)
 * (spec PR [adcp#4828](https://github.com/adcontextprotocol/adcp/pull/4828)).
 *
 * Given an `agent_url`, fetch the set of publishers whose adagents.json
 * authorizes it from an AAO-compatible directory via
 * `GET /v1/agents/{agent_url}/publishers`. Returns an async iterator that
 * pages transparently — consumers iterate `PublisherEntry` values without
 * managing cursors.
 *
 * **Trust model.** The directory is discovery, not authorization. Each
 * `PublisherEntry` tells the operator which publisher's adagents.json to
 * verify directly via the SDK's per-domain primitives (`fetchAdAgents`,
 * `resolveAgentProperties`). The directory's `properties_authorized` and
 * `status` are operator-facing summaries; the publisher's own file remains
 * the trust root.
 *
 * **SSRF safety.** Outbound HTTP routes through {@link ssrfSafeFetch} —
 * private IPs, link-local, loopback, and metadata-service hosts are
 * refused. Adopters who centralize their directory on an internal host
 * must enable internal probes via the SDK's probe-policy.
 *
 * @public
 */

import { ssrfSafeFetch, SsrfRefusedError, decodeBodyAsJsonOrText } from '../net/ssrf-fetch';
import { isInternalProbesAllowed } from '../utils/probe-policy';
import { LIBRARY_VERSION } from '../version';
import { validateUserAgent } from '../utils/validate-user-agent';

/**
 * Discovery provenance for a publisher → agent edge. Mirrors the
 * `discovery_method` enum on the AAO directory response. See the AAO
 * `agent-publishers.json` schema for trust-profile notes per value.
 */
export type DirectoryDiscoveryMethod =
  | 'direct'
  | 'authoritative_location'
  | 'adagents_authoritative'
  | 'ads_txt_managerdomain';

/** Lifecycle state for a publisher → agent edge. */
export type DirectoryPublisherStatus = 'authorized' | 'revoked';

/** Per-publisher entry in the directory's inverse-lookup response. */
export interface DirectoryPublisherEntry {
  publisher_domain: string;
  discovery_method: DirectoryDiscoveryMethod;
  /**
   * Manager file domain. Required when `discovery_method` is not `direct`;
   * null/absent for direct discovery.
   */
  manager_domain?: string | null;
  /**
   * Count of properties under THIS `publisher_domain` only that the
   * agent's selectors resolve to. Per-publisher count, never network-wide.
   */
  properties_authorized: number;
  /**
   * Count of properties under THIS `publisher_domain` only — total
   * inventory the publisher's file declares. Per-publisher count.
   */
  properties_total: number;
  /**
   * Whether the publisher's adagents.json entry for this agent pins
   * `signing_keys[]`. When true, signed responses MUST verify against
   * the pinned key set regardless of the agent's own JWKS.
   */
  signing_keys_pinned?: boolean;
  status: DirectoryPublisherStatus;
  /**
   * When the directory last fetched and validated this publisher's
   * adagents.json. Per-publisher freshness, distinct from the envelope's
   * `directory_indexed_at`.
   */
  last_verified_at: string;
}

/**
 * Single-page response envelope from
 * `GET /v1/agents/{agent_url}/publishers`. Mirrors the AAO
 * `agent-publishers.json` schema.
 */
export interface DirectoryLookupPage {
  /** Canonicalized echo of the agent_url that was looked up. */
  agent_url: string;
  /**
   * When the directory last completed a refresh of any publisher in this
   * result. NULL on empty pages — treat null as "no freshness assertion"
   * and do not advance local cache freshness.
   */
  directory_indexed_at: string | null;
  publishers: DirectoryPublisherEntry[];
  /** Opaque pagination cursor. Absent or null on the terminal page. */
  next_cursor?: string | null;
}

/**
 * Options for {@link fetchAgentAuthorizationsFromDirectory}.
 */
export interface FetchAgentAuthorizationsOptions {
  /**
   * Base URL of the AAO-compatible directory (e.g.
   * `https://aao.example.com`). Required — adopters explicitly pick which
   * directory they trust. The SDK does not default to a canonical AAO
   * host because directory choice is an operator decision.
   */
  directoryUrl: string;
  /** Return only entries verified after this timestamp. */
  since?: Date;
  /** Filter by lifecycle status. Default is server-defined. */
  status?: ReadonlyArray<DirectoryPublisherStatus>;
  /** Resume from a specific cursor (use the value from a prior page's `next_cursor`). */
  cursor?: string;
  /** Per-page size hint. The directory MAY enforce a lower cap. */
  limit?: number;
  /** Per-request timeout in milliseconds. Defaults to 30_000. */
  timeoutMs?: number;
  /** Custom `User-Agent` for outbound requests. */
  userAgent?: string;
  /**
   * AbortSignal that cancels both in-flight requests and the async
   * iterator. Once aborted, the iterator throws on the next `.next()` call.
   */
  signal?: AbortSignal;
}

/**
 * Iteration result. The iterator yields entries one-at-a-time across all
 * pages. After the terminal page is exhausted, iteration ends — no
 * sentinel value is emitted.
 */
export interface AgentAuthorizationsIterator extends AsyncIterableIterator<DirectoryPublisherEntry> {
  /**
   * Drain the iterator into an array. Convenience for small result sets;
   * adopters with potentially-large directories should iterate to bound
   * memory.
   */
  toArray(): Promise<DirectoryPublisherEntry[]>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** Cap on a single directory response. AAO pages are typically <100 KiB. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/**
 * Safety bound on total pages fetched. Prevents an infinite-loop bug in
 * the directory (or a hostile directory) from running the iterator forever.
 */
const MAX_PAGES = 10_000;

/**
 * Fetch the set of publishers whose adagents.json authorizes `agentUrl`,
 * from an AAO-compatible directory. Returns an async iterator that yields
 * `DirectoryPublisherEntry` values across all pages.
 *
 * @example
 * ```ts
 * for await (const pub of fetchAgentAuthorizationsFromDirectory(myAgentUrl, {
 *   directoryUrl: 'https://aao.example.com',
 *   status: ['authorized'],
 * })) {
 *   console.log(pub.publisher_domain, pub.properties_authorized);
 * }
 * ```
 *
 * @example Drain to array (small directories only):
 * ```ts
 * const iter = fetchAgentAuthorizationsFromDirectory(myAgentUrl, {
 *   directoryUrl: 'https://aao.example.com',
 * });
 * const allPublishers = await iter.toArray();
 * ```
 */
export function fetchAgentAuthorizationsFromDirectory(
  agentUrl: string,
  options: FetchAgentAuthorizationsOptions
): AgentAuthorizationsIterator {
  if (typeof agentUrl !== 'string' || agentUrl.length === 0) {
    throw new TypeError('fetchAgentAuthorizationsFromDirectory: agentUrl is required');
  }
  if (!options || typeof options.directoryUrl !== 'string' || options.directoryUrl.length === 0) {
    throw new TypeError('fetchAgentAuthorizationsFromDirectory: options.directoryUrl is required');
  }
  if (options.userAgent !== undefined) {
    validateUserAgent(options.userAgent);
  }

  const state: IteratorState = {
    agentUrl,
    options,
    cursor: options.cursor,
    pageIndex: 0,
    currentBatch: [],
    nextBatchIndex: 0,
    done: false,
  };

  const iter: AgentAuthorizationsIterator = {
    next: () => advance(state),
    return: async (value?: unknown) => {
      state.done = true;
      return { value, done: true } as IteratorResult<DirectoryPublisherEntry, unknown>;
    },
    throw: async (err?: unknown) => {
      state.done = true;
      throw err;
    },
    [Symbol.asyncIterator](): AgentAuthorizationsIterator {
      return this;
    },
    async toArray(): Promise<DirectoryPublisherEntry[]> {
      const out: DirectoryPublisherEntry[] = [];
      for await (const entry of this) out.push(entry);
      return out;
    },
  };

  return iter;
}

interface IteratorState {
  agentUrl: string;
  options: FetchAgentAuthorizationsOptions;
  cursor: string | undefined;
  pageIndex: number;
  currentBatch: DirectoryPublisherEntry[];
  nextBatchIndex: number;
  done: boolean;
}

async function advance(state: IteratorState): Promise<IteratorResult<DirectoryPublisherEntry>> {
  if (state.done) return { value: undefined, done: true };

  while (state.nextBatchIndex >= state.currentBatch.length) {
    if (state.pageIndex > 0 && state.cursor === undefined) {
      state.done = true;
      return { value: undefined, done: true };
    }
    if (state.pageIndex >= MAX_PAGES) {
      throw new Error(
        `fetchAgentAuthorizationsFromDirectory: refused to fetch beyond ${MAX_PAGES} pages — directory may be looping`
      );
    }
    const page = await fetchPage(state.agentUrl, state.options, state.cursor);
    state.pageIndex++;
    state.currentBatch = page.publishers;
    state.nextBatchIndex = 0;
    state.cursor = page.next_cursor ?? undefined;
    if (page.publishers.length === 0 && (state.cursor === undefined || state.cursor === null)) {
      state.done = true;
      return { value: undefined, done: true };
    }
  }

  const entry = state.currentBatch[state.nextBatchIndex];
  state.nextBatchIndex++;
  return { value: entry as DirectoryPublisherEntry, done: false };
}

async function fetchPage(
  agentUrl: string,
  options: FetchAgentAuthorizationsOptions,
  cursor: string | undefined
): Promise<DirectoryLookupPage> {
  const url = buildDirectoryUrl(options.directoryUrl, agentUrl, {
    since: options.since,
    status: options.status,
    cursor,
    limit: options.limit,
  });

  const headers: Record<string, string> = {
    accept: 'application/json',
    'user-agent': options.userAgent ?? `@adcp/client/${LIBRARY_VERSION}`,
  };

  let response;
  try {
    response = await ssrfSafeFetch(url, {
      method: 'GET',
      headers,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBodyBytes: MAX_RESPONSE_BYTES,
      allowPrivateIp: isInternalProbesAllowed(),
      signal: options.signal,
    });
  } catch (err) {
    if (err instanceof SsrfRefusedError) {
      throw new Error(`fetchAgentAuthorizationsFromDirectory: SSRF guard refused ${url}: ${err.code}`);
    }
    throw err;
  }

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`fetchAgentAuthorizationsFromDirectory: directory returned HTTP ${response.status} for ${url}`);
  }

  const decoded = decodeBodyAsJsonOrText(response.body, response.headers['content-type']);
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error(`fetchAgentAuthorizationsFromDirectory: directory response was not a JSON object (${url})`);
  }

  return parseDirectoryPage(decoded, url);
}

/**
 * Parse a raw directory response into a {@link DirectoryLookupPage},
 * applying defensive checks on counterparty-controlled fields. Throws
 * descriptive errors when the response shape violates the schema; the
 * iterator surfaces these unchanged.
 */
function parseDirectoryPage(raw: unknown, url: string): DirectoryLookupPage {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`directory response is not a JSON object (${url})`);
  }
  const obj = raw as Record<string, unknown>;

  const agent_url = obj.agent_url;
  if (typeof agent_url !== 'string') {
    throw new Error(`directory response missing 'agent_url' string (${url})`);
  }
  const indexed = obj.directory_indexed_at;
  if (indexed !== null && typeof indexed !== 'string') {
    throw new Error(`directory response 'directory_indexed_at' must be string or null (${url})`);
  }
  const publishersRaw = obj.publishers;
  if (!Array.isArray(publishersRaw)) {
    throw new Error(`directory response 'publishers' must be an array (${url})`);
  }

  const publishers: DirectoryPublisherEntry[] = [];
  for (const p of publishersRaw) {
    const entry = parsePublisherEntry(p);
    if (entry !== null) publishers.push(entry);
  }

  const next_cursor =
    typeof obj.next_cursor === 'string' ? obj.next_cursor : obj.next_cursor === null ? null : undefined;

  return {
    agent_url,
    directory_indexed_at: indexed ?? null,
    publishers,
    next_cursor,
  };
}

function parsePublisherEntry(raw: unknown): DirectoryPublisherEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.publisher_domain !== 'string') return null;
  if (typeof o.discovery_method !== 'string') return null;
  if (!isDiscoveryMethod(o.discovery_method)) return null;
  if (typeof o.properties_authorized !== 'number' || o.properties_authorized < 0) return null;
  if (typeof o.properties_total !== 'number' || o.properties_total < 0) return null;
  if (o.status !== 'authorized' && o.status !== 'revoked') return null;
  if (typeof o.last_verified_at !== 'string') return null;

  const entry: DirectoryPublisherEntry = {
    publisher_domain: o.publisher_domain,
    discovery_method: o.discovery_method as DirectoryDiscoveryMethod,
    properties_authorized: o.properties_authorized,
    properties_total: o.properties_total,
    status: o.status as DirectoryPublisherStatus,
    last_verified_at: o.last_verified_at,
  };
  if (typeof o.manager_domain === 'string') entry.manager_domain = o.manager_domain;
  else if (o.manager_domain === null) entry.manager_domain = null;
  if (typeof o.signing_keys_pinned === 'boolean') entry.signing_keys_pinned = o.signing_keys_pinned;
  return entry;
}

function isDiscoveryMethod(s: string): s is DirectoryDiscoveryMethod {
  return (
    s === 'direct' || s === 'authoritative_location' || s === 'adagents_authoritative' || s === 'ads_txt_managerdomain'
  );
}

function buildDirectoryUrl(
  base: string,
  agentUrl: string,
  query: {
    since?: Date;
    status?: ReadonlyArray<DirectoryPublisherStatus>;
    cursor?: string;
    limit?: number;
  }
): string {
  const trimmed = base.endsWith('/') ? base.slice(0, -1) : base;
  const u = new URL(`${trimmed}/v1/agents/${encodeURIComponent(agentUrl)}/publishers`);
  if (query.since) u.searchParams.set('since', query.since.toISOString());
  if (query.status && query.status.length > 0) {
    for (const s of query.status) u.searchParams.append('status', s);
  }
  if (query.cursor) u.searchParams.set('cursor', query.cursor);
  if (typeof query.limit === 'number' && query.limit > 0) {
    u.searchParams.set('limit', String(Math.floor(query.limit)));
  }
  return u.toString();
}
