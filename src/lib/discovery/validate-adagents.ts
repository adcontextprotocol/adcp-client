/**
 * `adagents.json` discovery + validation with the ads.txt `MANAGERDOMAIN`
 * one-hop fallback (adcp#4175 / adcontextprotocol/adcp PR #4173, adcp-client#1717).
 *
 * Discovery order:
 *   1. `https://{publisher}/.well-known/adagents.json` (direct)
 *      - if the file carries `authoritative_location`, follow one redirect
 *        and report `discovery_method = 'authoritative_location'`
 *   2. On HTTP 404 only — fetch `https://{publisher}/ads.txt`, parse the
 *      `MANAGERDOMAIN=` directive, and attempt
 *      `https://{managerdomain}/.well-known/adagents.json`.
 *      Reports `discovery_method = 'ads_txt_managerdomain'` and
 *      `manager_domain`.
 *
 * Per the #4173 resolution of the RFC's open questions:
 *   - Only the IAB directive form `MANAGERDOMAIN=example.com` counts;
 *     the comment form `# managerdomain=example.com` is rejected.
 *   - Duplicate `MANAGERDOMAIN` lines: last-wins (rather than the RFC's
 *     fail-closed default — IAB-aligned).
 *
 * Other safety rules from the RFC carry through:
 *   - Fallback fires only on 404 (not 5xx / timeout / invalid JSON).
 *   - Exactly one hop. The manager-domain file is fetched once, never
 *     recursed into.
 *   - `publisher → publisher` cycle is rejected.
 *   - `#noagents` trailing comment on a `MANAGERDOMAIN` line excludes
 *     that entry from fallback discovery.
 *   - Manager-domain failure is terminal — never a silent pass.
 */
import { createLogger, type LogLevel } from '../utils/logger';
import { LIBRARY_VERSION } from '../version';
import { validateUserAgent } from '../utils/validate-user-agent';
import { ssrfSafeFetch, SsrfRefusedError, decodeBodyAsJsonOrText } from '../net/ssrf-fetch';
import { isInternalProbesAllowed } from '../utils/probe-policy';
import type { AdAgentsJson } from './types';

/** How the validator located the authoritative `adagents.json` for a publisher. */
export type DiscoveryMethod = 'direct' | 'authoritative_location' | 'ads_txt_managerdomain';

export interface AdAgentsValidationResult {
  /** Whether a valid `adagents.json` was discovered for this publisher. */
  valid: boolean;
  /** The publisher domain the caller asked us to validate. */
  publisher_domain: string;
  /**
   * Which discovery path was used. Defaults to `'direct'`: a failure on
   * the publisher's own `.well-known/adagents.json` reports `'direct'`
   * even when no file was retrieved. `'authoritative_location'` and
   * `'ads_txt_managerdomain'` only appear once the validator has
   * committed to that path (followed the pointer / parsed a directive).
   */
  discovery_method: DiscoveryMethod;
  /**
   * The manager domain consulted when `discovery_method ===
   * 'ads_txt_managerdomain'`. Populated even on manager-domain failure
   * so callers can surface "we tried <manager>" in error reports.
   */
  manager_domain?: string;
  /** URL the `adagents.json` was ultimately loaded from. Omitted when nothing loaded. */
  resolved_url?: string;
  /** Parsed authoritative file. Omitted on failure. */
  adagents?: AdAgentsJson;
  /** One or more reasons validation failed. Empty when `valid === true`. */
  errors: string[];
}

export interface ValidateAdAgentsOptions {
  /** Per-request timeout in ms (default 10_000). */
  timeoutMs?: number;
  /** Optional User-Agent suffix (validated via `validateUserAgent`). */
  userAgent?: string;
  /** Logger level (default `'warn'`). */
  logLevel?: LogLevel;
  /**
   * Build the URL for a `domain` + well-known `path` pair. Defaults to
   * `https://{domain}{path}`. Provide a custom builder to point the
   * validator at a loopback test server (`http://...`), an internal
   * mirror, or a CDN-rewriting host.
   */
  urlForDomain?: (domain: string, path: string) => string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ADAGENTS_BYTES = 256 * 1024;
const MAX_ADS_TXT_BYTES = 256 * 1024;

const FETCH_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
};

/**
 * Validate `adagents.json` for a publisher domain. Implements the
 * ads.txt `MANAGERDOMAIN` one-hop fallback specified in adcp#4175.
 */
export async function validateAdAgents(
  publisherDomain: string,
  options: ValidateAdAgentsOptions = {}
): Promise<AdAgentsValidationResult> {
  if (!publisherDomain || typeof publisherDomain !== 'string') {
    throw new Error('publisherDomain must be a non-empty string');
  }
  if (options.userAgent) {
    validateUserAgent(options.userAgent);
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const logger = createLogger({ level: options.logLevel ?? 'warn' }).child('validateAdAgents');
  const userAgentHeader = `adcp-validate-adagents/${LIBRARY_VERSION} (+https://adcontextprotocol.org)`;
  const fromHeader = options.userAgent
    ? `adcp-validate-adagents@adcontextprotocol.org (${options.userAgent}; v${LIBRARY_VERSION})`
    : `adcp-validate-adagents@adcontextprotocol.org (v${LIBRARY_VERSION})`;

  const publisher = publisherDomain.toLowerCase();
  const buildUrl = options.urlForDomain ?? ((domain, path) => `https://${domain}${path}`);
  const publisherUrl = buildUrl(publisher, '/.well-known/adagents.json');

  // Step 1: try the publisher's canonical location.
  const direct = await fetchJsonOrStatus(publisherUrl, {
    timeoutMs,
    maxBodyBytes: MAX_ADAGENTS_BYTES,
    userAgentHeader,
    fromHeader,
  });

  if (direct.kind === 'ok') {
    const data = direct.data as AdAgentsJson;

    // Handle `authoritative_location` indirection: a pointer file with no
    // inline `authorized_agents` should be followed exactly once.
    if (data.authoritative_location && !data.authorized_agents) {
      const target = data.authoritative_location;
      // Production: HTTPS-only. Loopback test runs (gated by
      // ADCP_ALLOW_INTERNAL_PROBES=1) may use `http://` against a
      // 127.0.0.1 server — the same opt-in that lets `ssrfSafeFetch`
      // touch loopback in the first place.
      const allowHttp = isInternalProbesAllowed();
      if (!target.startsWith('https://') && !(allowHttp && target.startsWith('http://'))) {
        return {
          valid: false,
          publisher_domain: publisher,
          discovery_method: 'authoritative_location',
          resolved_url: publisherUrl,
          errors: [`authoritative_location must use https://, got: ${target}`],
        };
      }
      if (target === publisherUrl) {
        return {
          valid: false,
          publisher_domain: publisher,
          discovery_method: 'authoritative_location',
          resolved_url: publisherUrl,
          errors: ['authoritative_location points back to the publisher (cycle)'],
        };
      }
      const followed = await fetchJsonOrStatus(target, {
        timeoutMs,
        maxBodyBytes: MAX_ADAGENTS_BYTES,
        userAgentHeader,
        fromHeader,
      });
      if (followed.kind !== 'ok') {
        return {
          valid: false,
          publisher_domain: publisher,
          discovery_method: 'authoritative_location',
          resolved_url: target,
          errors: [`authoritative_location fetch failed: ${describeOutcome(followed)}`],
        };
      }
      return {
        valid: true,
        publisher_domain: publisher,
        discovery_method: 'authoritative_location',
        resolved_url: target,
        adagents: followed.data as AdAgentsJson,
        errors: [],
      };
    }

    return {
      valid: true,
      publisher_domain: publisher,
      discovery_method: 'direct',
      resolved_url: publisherUrl,
      adagents: data,
      errors: [],
    };
  }

  // Step 2: managerdomain fallback only fires on 404. Other failures
  // (5xx, timeout, malformed JSON, SSRF refusal) are terminal under the
  // RFC's "Only trigger fallback on 404" rule.
  if (direct.kind !== 'not_found') {
    return {
      valid: false,
      publisher_domain: publisher,
      discovery_method: 'direct',
      errors: [`adagents.json fetch failed: ${describeOutcome(direct)}`],
    };
  }

  // Step 3: fetch ads.txt and look for a MANAGERDOMAIN= directive.
  const adsTxtUrl = buildUrl(publisher, '/ads.txt');
  const adsTxt = await fetchTextOrStatus(adsTxtUrl, {
    timeoutMs,
    maxBodyBytes: MAX_ADS_TXT_BYTES,
    userAgentHeader,
    fromHeader,
  });
  if (adsTxt.kind !== 'ok') {
    return {
      valid: false,
      publisher_domain: publisher,
      discovery_method: 'direct',
      errors: [`adagents.json missing (404) and ads.txt unavailable: ${describeOutcome(adsTxt)}`],
    };
  }

  const managerDomain = parseManagerDomain(adsTxt.text);
  if (!managerDomain) {
    return {
      valid: false,
      publisher_domain: publisher,
      discovery_method: 'direct',
      errors: ['adagents.json missing (404) and no eligible MANAGERDOMAIN directive in ads.txt'],
    };
  }
  if (managerDomain === publisher) {
    return {
      valid: false,
      publisher_domain: publisher,
      discovery_method: 'direct',
      errors: [`MANAGERDOMAIN references the publisher domain itself (cycle): ${managerDomain}`],
    };
  }

  // Step 4: fetch the manager domain's adagents.json. One hop only —
  // even if this file has its own `authoritative_location`, we do NOT
  // follow it (the RFC restricts to one hop publisher → managerdomain).
  const managerUrl = buildUrl(managerDomain, '/.well-known/adagents.json');
  const manager = await fetchJsonOrStatus(managerUrl, {
    timeoutMs,
    maxBodyBytes: MAX_ADAGENTS_BYTES,
    userAgentHeader,
    fromHeader,
  });
  if (manager.kind !== 'ok') {
    logger.debug(`Manager domain ${managerDomain} adagents.json fetch failed: ${describeOutcome(manager)}`);
    return {
      valid: false,
      publisher_domain: publisher,
      discovery_method: 'ads_txt_managerdomain',
      manager_domain: managerDomain,
      errors: [`Manager domain adagents.json fetch failed: ${describeOutcome(manager)}`],
    };
  }

  return {
    valid: true,
    publisher_domain: publisher,
    discovery_method: 'ads_txt_managerdomain',
    manager_domain: managerDomain,
    resolved_url: managerUrl,
    adagents: manager.data as AdAgentsJson,
    errors: [],
  };
}

/**
 * Parse a MANAGERDOMAIN directive out of an ads.txt body. Returns the
 * lowercased host token (last-wins on duplicates) or `undefined` when
 * no eligible directive is present.
 *
 * Eligibility rules (per adcp-client#1717 / adcp#4175 + #4173 resolution):
 *   - Directive form `MANAGERDOMAIN=<host>` only. Case-insensitive on
 *     the key; the value preserves no case. Comment-only lines like
 *     `# managerdomain=...` are rejected.
 *   - Value must be a host token (no scheme, no path, no whitespace).
 *   - Trailing inline comment containing `noagents` (case-insensitive)
 *     opts that entry out of fallback discovery.
 *   - Duplicate eligible entries: the last one wins.
 *
 * Exported for direct unit testing.
 */
export function parseManagerDomain(adsTxt: string): string | undefined {
  if (!adsTxt) return undefined;
  // Strip BOM if present — common on Windows-authored ads.txt files.
  const body = adsTxt.replace(/^﻿/, '');
  let last: string | undefined;
  for (const rawLine of body.split(/\r?\n/)) {
    // Split off any inline comment so the directive parser only sees
    // the code part, but keep the comment text around for the
    // `#noagents` opt-out check.
    const hashIdx = rawLine.indexOf('#');
    const code = (hashIdx === -1 ? rawLine : rawLine.slice(0, hashIdx)).trim();
    const comment = hashIdx === -1 ? '' : rawLine.slice(hashIdx + 1);
    if (!code) continue;
    // Directive form only: KEY=VALUE on its own line, key matched
    // case-insensitively. Trailing `, ...` (ads.txt record syntax)
    // isn't valid on a variable line, so we don't tolerate commas.
    const match = code.match(/^MANAGERDOMAIN\s*=\s*(.+?)\s*$/i);
    if (!match || !match[1]) continue;
    const value = match[1].trim();
    if (!isEligibleHostToken(value)) continue;
    if (/\bnoagents\b/i.test(comment)) continue;
    last = value.toLowerCase();
  }
  return last;
}

function isEligibleHostToken(value: string): boolean {
  if (!value) return false;
  // Reject anything with whitespace, slashes, or query strings.
  if (/[\s/?#]/.test(value)) return false;
  // Reject anything that looks like a URL (`scheme:` prefix). The single
  // `:` permitted in a host token is the port separator handled below —
  // so look for the colon-before-slash-or-end shape `scheme:...`.
  if (/^[a-z][a-z0-9+.-]*:[^0-9]/i.test(value)) return false;
  // Split off an optional `:port` suffix. Port must be 1–5 digits.
  const portMatch = value.match(/^(.*?):([0-9]{1,5})$/);
  const host = portMatch?.[1] ?? value;
  // Minimal hostname shape — at least one dot, labels per RFC 1035-ish.
  // Reject `example` (no TLD) and obvious junk like `..` or `-foo.com`.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(host)) return false;
  return true;
}

type FetchFailure =
  | { kind: 'not_found' }
  | { kind: 'http_error'; status: number }
  | { kind: 'transport_error'; message: string }
  | { kind: 'parse_error'; message: string }
  | { kind: 'ssrf_refused'; message: string };

type RawFetchOutcome = { kind: 'ok-text'; text: string } | FetchFailure;

type JsonFetchOutcome = { kind: 'ok'; data: unknown } | FetchFailure;

type TextFetchOutcome = { kind: 'ok'; text: string } | FetchFailure;

interface InternalFetchOptions {
  timeoutMs: number;
  maxBodyBytes: number;
  userAgentHeader: string;
  fromHeader: string;
}

async function fetchJsonOrStatus(url: string, opts: InternalFetchOptions): Promise<JsonFetchOutcome> {
  const raw = await rawFetch(url, opts);
  if (raw.kind !== 'ok-text') return raw;
  try {
    return { kind: 'ok', data: JSON.parse(raw.text) };
  } catch (err) {
    return { kind: 'parse_error', message: err instanceof Error ? err.message : 'invalid JSON' };
  }
}

async function fetchTextOrStatus(url: string, opts: InternalFetchOptions): Promise<TextFetchOutcome> {
  const raw = await rawFetch(url, opts);
  if (raw.kind === 'ok-text') return { kind: 'ok', text: raw.text };
  return raw;
}

async function rawFetch(url: string, opts: InternalFetchOptions): Promise<RawFetchOutcome> {
  try {
    const result = await ssrfSafeFetch(url, {
      timeoutMs: opts.timeoutMs,
      allowPrivateIp: isInternalProbesAllowed(),
      maxBodyBytes: opts.maxBodyBytes,
      headers: {
        ...FETCH_HEADERS,
        'User-Agent': opts.userAgentHeader,
        From: opts.fromHeader,
      },
    });
    if (result.status === 404) return { kind: 'not_found' };
    if (result.status < 200 || result.status >= 300) {
      return { kind: 'http_error', status: result.status };
    }
    // Always decode as text — JSON parsing is the caller's choice. This
    // lets ads.txt and adagents.json share the same fetch primitive.
    const decoded = decodeBodyAsJsonOrText(result.body, 'text/plain');
    const text = typeof decoded === 'string' ? decoded : JSON.stringify(decoded);
    return { kind: 'ok-text', text };
  } catch (err) {
    if (err instanceof SsrfRefusedError) {
      return { kind: 'ssrf_refused', message: err.message };
    }
    return { kind: 'transport_error', message: err instanceof Error ? err.message : String(err) };
  }
}

function describeOutcome(outcome: JsonFetchOutcome | TextFetchOutcome): string {
  switch (outcome.kind) {
    case 'not_found':
      return 'HTTP 404';
    case 'http_error':
      return `HTTP ${outcome.status}`;
    case 'transport_error':
      return outcome.message;
    case 'parse_error':
      return `invalid JSON: ${outcome.message}`;
    case 'ssrf_refused':
      return `[SSRF refused] ${outcome.message}`;
    case 'ok':
      return 'ok';
  }
}
