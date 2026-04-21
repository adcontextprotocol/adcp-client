/**
 * Runner-side primitives for observing catalog-item macro substitution
 * in creative previews. Consumed by conformance runners grading the
 * `substitution-observer-runner` test-kit contract.
 *
 * Usage — inline HTML observation:
 * ```ts
 * const observer = new SubstitutionObserver();
 * const records = observer.parse_html(preview_html);
 * const matches = observer.match_bindings(records, template, bindings);
 * for (const m of matches) {
 *   const r = observer.assert_rfc3986_safe(m);
 *   if (!r.ok) report(r);
 * }
 * ```
 *
 * Usage — preview URL fetch (applies SSRF policy):
 * ```ts
 * const records = await observer.fetch_and_parse(new URL(preview_url));
 * ```
 */

import { setTimeout as delay } from 'node:timers/promises';
import dns from 'node:dns/promises';
import type { Dispatcher } from 'undici';

import type {
  AssertionResult,
  BindingMatch,
  CatalogBinding,
  PolicyResult,
  SsrfPolicy,
  TrackerUrlRecord,
} from '../types';
import { extractTrackerUrls } from './html-parser';
import { matchBindings } from './alignment';
import {
  DEFAULT_MACRO_PROHIBITED_PATTERN,
  assertNoNestedExpansion,
  assertRfc3986Safe,
  assertSchemePreserved,
  assertUnreservedOnly,
} from './assertions';
import { DEFAULT_SSRF_POLICY, enforceSsrfPolicy, enforceSsrfPolicyResolved } from './ssrf';

/**
 * Fetch knobs mirror the contract's `url_fetch.runner_config.fetch` block.
 * Callers SHOULD keep the defaults for AdCP Verified grading.
 */
export interface ObserverFetchOptions {
  /** Max body bytes to read before aborting. Default 262144 (256 KiB). */
  max_body_bytes?: number;
  /** Connect-timeout in seconds. Default 3. */
  max_connect_seconds?: number;
  /** Overall request timeout in seconds. Default 10. */
  timeout_seconds?: number;
  /** Acceptable response content-types. Default: `text/html`, `application/xhtml+xml`. */
  required_content_types?: readonly string[];
  /** SSRF policy to enforce. Default: {@link DEFAULT_SSRF_POLICY}. */
  ssrf_policy?: SsrfPolicy;
  /**
   * Custom undici dispatcher. Advanced callers (e.g., tests pinning a
   * specific agent) inject here; default uses undici's global dispatcher
   * with a per-request Agent pinned to the first allowed DNS address.
   */
  dispatcher?: Dispatcher;
}

export class PreviewFetchError extends Error {
  readonly sub_reason:
    | 'http_status'
    | 'content_type'
    | 'size_exceeded'
    | 'redirect_returned'
    | 'ssrf_blocked'
    | 'fetch_timeout';
  readonly detail: string;
  constructor(sub_reason: PreviewFetchError['sub_reason'], detail: string) {
    super(`preview_url_unusable:${sub_reason} — ${detail}`);
    this.name = 'PreviewFetchError';
    this.sub_reason = sub_reason;
    this.detail = detail;
  }
}

export class SubstitutionObserver {
  /**
   * Parse inline preview HTML and return tracker URLs from the
   * contract's normative tag/attribute set. URLs that fail WHATWG URL
   * parsing are skipped silently — a downstream binding that expected
   * them surfaces as `substitution_binding_missing`.
   */
  parse_html(html: string): TrackerUrlRecord[] {
    return extractTrackerUrls(html);
  }

  /**
   * Fetch `preview_url` under the SSRF policy, validate response
   * shape, and parse the body. Redirects are treated as failure
   * (policy: `follow_redirects: false`). The body is capped at
   * `max_body_bytes` bytes — exceeding the cap yields a
   * `size_exceeded` failure rather than a truncated parse.
   *
   * Throws {@link PreviewFetchError} on any fetch-layer failure so the
   * runner can map the sub-reason to the contract's
   * `preview_url_unusable_sub_reasons` vocabulary.
   */
  async fetch_and_parse(url: URL, options: ObserverFetchOptions = {}): Promise<TrackerUrlRecord[]> {
    const policy = options.ssrf_policy ?? DEFAULT_SSRF_POLICY;
    const maxBodyBytes = options.max_body_bytes ?? 262_144;
    const connectTimeoutMs = (options.max_connect_seconds ?? 3) * 1000;
    const timeoutMs = (options.timeout_seconds ?? 10) * 1000;
    const allowedContentTypes = options.required_content_types ?? ['text/html', 'application/xhtml+xml'];

    const presync = enforceSsrfPolicy(url, policy);
    if (!presync.allowed) {
      throw new PreviewFetchError('ssrf_blocked', presync.rule ?? 'unknown_rule');
    }

    let addresses: string[] = [];
    if (isHostname(url.hostname)) {
      try {
        const lookup = await dns.lookup(url.hostname, { all: true, verbatim: true });
        addresses = lookup.map(entry => entry.address);
      } catch (e) {
        throw new PreviewFetchError('fetch_timeout', `DNS lookup failed: ${(e as Error).message}`);
      }
      const resolvedCheck = enforceSsrfPolicyResolved(url, addresses, policy);
      if (!resolvedCheck.allowed) {
        throw new PreviewFetchError('ssrf_blocked', resolvedCheck.rule ?? 'unknown_rule');
      }
    }

    const { request, Agent } = await loadUndici();
    const dispatcher =
      options.dispatcher ??
      new Agent({
        connect: { timeout: connectTimeoutMs },
        // Pin to the first resolved address to close the rebinding window
        // between DNS revalidation and TCP connect.
        bodyTimeout: timeoutMs,
        headersTimeout: timeoutMs,
      });

    const abortCtrl = new AbortController();
    const timer = delay(timeoutMs, undefined, { signal: abortCtrl.signal })
      .then(() => {
        abortCtrl.abort(new Error('preview fetch timeout'));
      })
      .catch(() => undefined);

    try {
      const res = await request(url.href, {
        method: 'GET',
        dispatcher,
        maxRedirections: 0,
        signal: abortCtrl.signal,
        headers: { accept: allowedContentTypes.join(', ') },
      });

      if (res.statusCode >= 300 && res.statusCode < 400) {
        throw new PreviewFetchError('redirect_returned', `status=${res.statusCode}`);
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        throw new PreviewFetchError('http_status', `status=${res.statusCode}`);
      }
      const contentType = (String(res.headers['content-type'] ?? '').split(';')[0] ?? '').trim().toLowerCase();
      if (!allowedContentTypes.includes(contentType)) {
        throw new PreviewFetchError('content_type', `content-type=${contentType || 'missing'}`);
      }

      const body = await readCapped(res.body, maxBodyBytes);
      return extractTrackerUrls(body);
    } catch (e) {
      if (e instanceof PreviewFetchError) throw e;
      if ((e as Error).name === 'AbortError') {
        throw new PreviewFetchError('fetch_timeout', `exceeded ${timeoutMs}ms`);
      }
      throw new PreviewFetchError('fetch_timeout', (e as Error).message);
    } finally {
      abortCtrl.abort();
      await timer;
    }
  }

  /** See {@link matchBindings}. */
  match_bindings(
    records: readonly TrackerUrlRecord[],
    template: URL | string,
    bindings: readonly CatalogBinding[]
  ): BindingMatch[] {
    return matchBindings(records, template, bindings);
  }

  /** See {@link assertRfc3986Safe}. */
  assert_rfc3986_safe(match: BindingMatch): AssertionResult {
    return assertRfc3986Safe(match);
  }

  /** See {@link assertUnreservedOnly}. */
  assert_unreserved_only(match: BindingMatch): AssertionResult {
    return assertUnreservedOnly(match);
  }

  /** See {@link assertNoNestedExpansion}. */
  assert_no_nested_expansion(
    match: BindingMatch,
    prohibited_pattern: RegExp = DEFAULT_MACRO_PROHIBITED_PATTERN
  ): AssertionResult {
    return assertNoNestedExpansion(match, prohibited_pattern);
  }

  /** See {@link assertSchemePreserved}. */
  assert_scheme_preserved(match: BindingMatch, template_scheme: string): AssertionResult {
    return assertSchemePreserved(match, template_scheme);
  }

  /** See {@link enforceSsrfPolicy}. */
  enforce_ssrf_policy(url: URL, policy: SsrfPolicy = DEFAULT_SSRF_POLICY): PolicyResult {
    return enforceSsrfPolicy(url, policy);
  }
}

function isHostname(host: string): boolean {
  const unwrapped = host.replace(/^\[|\]$/g, '');
  return !/^[0-9.]+$/.test(unwrapped) && !unwrapped.includes(':');
}

async function readCapped(body: NodeJS.ReadableStream, capBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body as AsyncIterable<Buffer | string>) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    total += buf.length;
    if (total > capBytes) {
      throw new PreviewFetchError('size_exceeded', `>${capBytes} bytes`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

let undiciModule: typeof import('undici') | undefined;
async function loadUndici(): Promise<typeof import('undici')> {
  if (!undiciModule) {
    undiciModule = await import('undici');
  }
  return undiciModule;
}
