/**
 * SSRF-safe HTTP fetch primitive.
 *
 * Used by compliance probes, storyboard runners, and (future) JWKS /
 * revocation-list resolvers — anywhere the library dispatches a request to a
 * URL that came from counterparty-controlled data and therefore might point at
 * the host's private network or a cloud metadata endpoint.
 *
 * Guarantees:
 *   - Scheme: only `https:` by default; `http:` allowed under the dev-opt-in
 *     `allowPrivateIp` flag. `file:`, `ftp:`, `data:`, etc. are always refused.
 *   - DNS: resolves every A/AAAA record once, validates the full set, then
 *     pins the outbound connection to the first validated address via an
 *     undici `Agent` whose `connect.lookup` returns the pinned tuple.
 *     Defeats DNS rebinding (attacker returns a public address to the guard
 *     lookup and a private address to the connect-time lookup) and any other
 *     TOCTOU gap between validation and connect.
 *   - IMDS (`169.254.169.254`, `fe80::`) stays refused even under
 *     `allowPrivateIp` — cloud metadata exfiltration is never a legitimate
 *     dev-loop use case.
 *   - Redirects are not followed (`redirect: 'manual'`). The 3xx response is
 *     returned with `Location` populated so callers can inspect it, but they
 *     MUST NOT re-dispatch to the `Location` URL themselves — that bypasses
 *     every guard above. To follow a redirect safely, re-invoke
 *     `ssrfSafeFetch` with the new URL so it runs through validation again.
 *   - Response body is buffered up to `maxBodyBytes` (default 64 KiB) and
 *     returned as raw bytes; the dispatcher is torn down after reading so
 *     connection-reuse can't carry an attacker-controlled keepalive.
 *
 * Returns a fully-buffered result. Callers that need streaming or large bodies
 * should extend this primitive rather than bypass it.
 */
import { type LookupAddress, type LookupOptions } from 'dns';
import { lookup as dnsLookupAsync } from 'dns/promises';
import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { isAlwaysBlocked, isPrivateIp } from './address-guards';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const ALLOWED_SCHEMES = new Set(['https:', 'http:']);

export type SsrfRefusedCode =
  | 'invalid_url'
  | 'scheme_not_allowed'
  | 'non_https_without_opt_in'
  | 'dns_lookup_failed'
  | 'dns_empty'
  | 'always_blocked_address'
  | 'private_address'
  | 'body_exceeds_limit';

/**
 * SSRF refusal codes that indicate runtime/network conditions rather than
 * policy refusal. Callers that want to fall back to a "host unreachable" or
 * "treat as unknown" path on these codes — rather than surfacing the
 * SsrfRefusedError to their own caller — can intersect against this set:
 *
 * ```ts
 * if (err instanceof SsrfRefusedError && SSRF_TRANSIENT_CODES.has(err.code)) {
 *   // network condition, not a policy attack — treat as unreachable
 * } else if (err instanceof SsrfRefusedError) {
 *   // policy refusal — must propagate; silently downgrading to "unreachable"
 *   // reintroduces the catch-swallow class flagged in adcp-client#1618 review
 *   throw err;
 * }
 * ```
 *
 * - `dns_lookup_failed`, `dns_empty`: name does not resolve. CLI fixtures
 *   use `*.example.invalid` to provoke these — preserving the runtime-error
 *   path matches pre-`ssrfSafeFetch` native-fetch behavior.
 * - `body_exceeds_limit`: response started OK (validated address, scheme,
 *   etc.) but exceeded the caller's defensive cap. The host is real and
 *   knows the URL; classifying as "policy attack" would be a misread.
 *
 * NOT in this set: `always_blocked_address`, `private_address`,
 * `scheme_not_allowed`, `non_https_without_opt_in`, `invalid_url`. Those
 * are policy refusals — silently downgrading them to "unreachable" or
 * "suspect" reintroduces the SSRF gap the gate was added to close.
 *
 * Added in adcp-client#1633.
 */
export const SSRF_TRANSIENT_CODES: ReadonlySet<SsrfRefusedCode> = new Set([
  'dns_lookup_failed',
  'dns_empty',
  'body_exceeds_limit',
]);

/**
 * Thrown when the SSRF guard refuses a request before (or during) the fetch.
 * Network failures after the guard passes are not wrapped in this type —
 * callers that want to distinguish "we refused this" from "the remote broke"
 * can `instanceof SsrfRefusedError` the catch.
 */
export class SsrfRefusedError extends Error {
  readonly code: SsrfRefusedCode;
  readonly url: string;
  readonly hostname?: string;
  readonly address?: string;

  constructor(code: SsrfRefusedCode, message: string, meta: { url: string; hostname?: string; address?: string }) {
    super(message);
    this.name = 'SsrfRefusedError';
    this.code = code;
    this.url = meta.url;
    this.hostname = meta.hostname;
    this.address = meta.address;
  }
}

export interface SsrfFetchOptions {
  method?: string;
  /** Lowercased keys preferred; values preserved verbatim. */
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Allow `http://` and private/loopback targets. Default false. */
  allowPrivateIp?: boolean;
  /** Overall timeout including DNS + connect + body read. Default 10_000 ms. */
  timeoutMs?: number;
  /** Hard cap on response body bytes. Default 64 KiB. */
  maxBodyBytes?: number;
  /** Caller-provided abort signal, composed with the internal timeout. */
  signal?: AbortSignal;
  /**
   * Declarative client-authentication material for a runner-owned HTTPS
   * connection. Certificate verification remains enabled and SNI is always
   * derived from the validated URL hostname; callers cannot override either.
   */
  tls?: {
    cert?: string;
    key?: string;
    passphrase?: string;
    ca?: string;
  };
  /**
   * Trusted scoped fetch implementation. URL scheme validation, redirect
   * handling, timeouts, and body limits still run, but DNS resolution and
   * address policy are delegated to this implementation because custom
   * fetchers do not accept undici dispatchers. The caller MUST enforce
   * DNS-rebinding and private-address policy itself.
   *
   * This deliberately explicit name prevents callers from mistaking a custom
   * transport for the internally DNS-pinned path.
   */
  trustedFetchFn?: typeof fetch;
}

export interface SsrfFetchResult {
  url: string;
  status: number;
  /** Response headers, lowercased. */
  headers: Record<string, string>;
  /** Raw response body bytes (empty Uint8Array if no body). */
  body: Uint8Array;
  /** The validated IP address. Absent when a trusted fetch implementation owns DNS. */
  pinnedAddress?: string;
  /** The validated address family. Absent when a trusted fetch implementation owns DNS. */
  pinnedFamily?: 4 | 6;
  /** Whether the internal undici dispatcher pinned the connection to `pinnedAddress`. */
  connectionPinned: boolean;
}

/**
 * GET/POST/etc. a URL with SSRF guarding + DNS pinning. Throws
 * {@link SsrfRefusedError} when the guard refuses; other errors (network
 * timeouts, remote resets) propagate as the native fetch error.
 */
export async function ssrfSafeFetch(url: string, options: SsrfFetchOptions = {}): Promise<SsrfFetchResult> {
  throwIfSignalAborted(options.signal);
  const allowPrivateIp = options.allowPrivateIp === true;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (options.tls && options.trustedFetchFn) {
    throw new Error('ssrf-fetch: tls material requires the internally constructed, DNS-pinned dispatcher');
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfRefusedError('invalid_url', `Invalid URL: ${url}`, { url });
  }
  const checkedUrl = parsed.href;
  // From this point onward use the immutable serialization that was checked.
  // This also prevents stateful string coercion in untyped JavaScript callers
  // from presenting a different target to diagnostics or result metadata.
  url = checkedUrl;

  // `URL.hostname` wraps IPv6 literals in brackets (`https://[::1]/` →
  // `[::1]`). `dns.lookup` and the address classifier both want the bare
  // form; strip brackets here so IPv6 localhost URLs work under
  // `allowPrivateIp` and so bracketed literals can't slip past classification
  // on a future Node release that tolerates them.
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new SsrfRefusedError(
      'scheme_not_allowed',
      `Refusing to fetch URL with unsupported scheme: ${parsed.protocol}`,
      { url, hostname }
    );
  }
  if (parsed.protocol !== 'https:' && !allowPrivateIp) {
    throw new SsrfRefusedError('non_https_without_opt_in', `Refusing to fetch non-HTTPS URL: ${url}`, {
      url,
      hostname,
    });
  }

  // A trusted fetch implementation owns DNS resolution, but literal IPs need
  // no lookup and can still be classified locally. Keep the unconditional
  // cloud-metadata/link-local refusal and the private-address opt-in at this
  // boundary so a caller cannot accidentally turn a plainly unsafe literal
  // into a trusted destination merely by supplying an egress hook.
  if (isIP(hostname) !== 0) {
    if (isAlwaysBlocked(hostname)) {
      throw new SsrfRefusedError(
        'always_blocked_address',
        'Refusing to fetch an always-blocked address (local, metadata, or unsafe translation)',
        { url, hostname, address: hostname }
      );
    }
    if (!allowPrivateIp && isPrivateIp(hostname)) {
      throw new SsrfRefusedError('private_address', 'Refusing to fetch a private/loopback address', {
        url,
        hostname,
        address: hostname,
      });
    }
  }

  // Start the request deadline before DNS. `dns.lookup()` does not accept an
  // AbortSignal, so race it against the same controller used for connect and
  // body reads. The lookup may continue inside libuv after an abort, but its
  // eventual settlement is observed by `raceWithAbort` and cannot keep this
  // caller pending or produce an unhandled rejection.
  const ac = new AbortController();
  const onExternalAbort = () => ac.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onExternalAbort, { once: true });
  if (options.signal?.aborted) onExternalAbort();
  const timer = setTimeout(() => ac.abort(new Error('ssrf-fetch: timeout')), timeoutMs);
  let dispatcher: Agent | undefined;
  let pinned: { address: string; family: number } | undefined;
  let pinnedFamily: 4 | 6 | undefined;

  try {
    if (!options.trustedFetchFn) {
      let addresses: { address: string; family: number }[];
      try {
        addresses = await raceWithAbort(dnsLookupAsync(hostname, { all: true }), ac.signal);
      } catch (err) {
        throwIfSignalAborted(ac.signal);
        throw new SsrfRefusedError(
          'dns_lookup_failed',
          `DNS lookup failed for ${hostname}: ${err instanceof Error ? err.message : String(err)}`,
          { url, hostname }
        );
      }
      throwIfSignalAborted(ac.signal);
      if (addresses.length === 0) {
        throw new SsrfRefusedError('dns_empty', `DNS returned no addresses for ${hostname}`, {
          url,
          hostname,
        });
      }
      // Error messages intentionally do NOT include the resolved IP — a
      // counterparty-supplied hostname that resolves into the caller's internal
      // address space would otherwise leak network topology into compliance
      // reports and log aggregators. The address is still available on the
      // thrown error's `.address` field for programmatic debugging.
      for (const a of addresses) {
        if (isAlwaysBlocked(a.address)) {
          throw new SsrfRefusedError(
            'always_blocked_address',
            `Refusing to fetch: ${hostname} resolves to an always-blocked address (local, metadata, or unsafe translation)`,
            { url, hostname, address: a.address }
          );
        }
      }
      if (!allowPrivateIp) {
        for (const a of addresses) {
          if (isPrivateIp(a.address)) {
            throw new SsrfRefusedError(
              'private_address',
              `Refusing to fetch: ${hostname} resolves to a private/loopback address`,
              { url, hostname, address: a.address }
            );
          }
        }
      }

      pinned = addresses[0]!;
      pinnedFamily = pinned.family === 6 ? 6 : 4;
      dispatcher = new Agent({
        connect: {
          timeout: Math.min(5_000, timeoutMs),
          rejectUnauthorized: true,
          ...(parsed.protocol === 'https:' && hostname && isIP(hostname) === 0 ? { servername: hostname } : {}),
          ...(options.tls?.cert !== undefined ? { cert: options.tls.cert } : {}),
          ...(options.tls?.key !== undefined ? { key: options.tls.key } : {}),
          ...(options.tls?.passphrase !== undefined ? { passphrase: options.tls.passphrase } : {}),
          ...(options.tls?.ca !== undefined ? { ca: options.tls.ca } : {}),
          // All addresses were validated above; pin the connect to the first. The
          // custom lookup also means undici won't re-resolve and pick up a rebind.
          lookup: (
            _h: string,
            opts: LookupOptions | undefined,
            cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void
          ) => {
            if (opts?.all) {
              cb(null, [{ address: pinned!.address, family: pinnedFamily! }]);
            } else {
              cb(null, pinned!.address, pinnedFamily!);
            }
          },
        },
      });
    }

    const res = options.trustedFetchFn
      ? await options.trustedFetchFn(checkedUrl, {
          method: options.method ?? 'GET',
          redirect: 'manual',
          signal: ac.signal,
          headers: options.headers,
          ...(options.body !== undefined && { body: options.body as BodyInit }),
        })
      : await undiciFetch(checkedUrl, {
          method: options.method ?? 'GET',
          redirect: 'manual',
          signal: ac.signal,
          headers: options.headers,
          dispatcher,
          ...(options.body !== undefined && { body: options.body }),
        });

    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });

    const reader = res.body?.getReader();
    if (!reader) {
      return {
        url,
        status: res.status,
        headers,
        body: new Uint8Array(),
        ...(pinned && { pinnedAddress: pinned.address, pinnedFamily: pinnedFamily! }),
        connectionPinned: pinned !== undefined,
      };
    }

    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBodyBytes) {
        await reader.cancel();
        throw new SsrfRefusedError('body_exceeds_limit', `Response body exceeded ${maxBodyBytes} bytes`, {
          url,
          hostname: parsed.hostname,
          ...(pinned && { address: pinned.address }),
        });
      }
      chunks.push(value);
    }

    const buf = new Uint8Array(bytes);
    let offset = 0;
    for (const c of chunks) {
      buf.set(c, offset);
      offset += c.byteLength;
    }

    return {
      url,
      status: res.status,
      headers,
      body: buf,
      ...(pinned && { pinnedAddress: pinned.address, pinnedFamily: pinnedFamily! }),
      connectionPinned: pinned !== undefined,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onExternalAbort);
    await dispatcher?.close().catch(() => {});
  }
}

/**
 * Await an operation that has no native AbortSignal support without allowing
 * it to retain the caller after cancellation. Attaching both fulfillment and
 * rejection handlers also observes a late operation failure after the abort
 * branch has already won the race.
 */
function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfSignalAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signalAbortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function signalAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(signal.reason == null ? 'The operation was aborted' : String(signal.reason));
  error.name = 'AbortError';
  return error;
}

function throwIfSignalAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signalAbortError(signal);
}

/**
 * Decode a UTF-8 byte buffer as JSON when the content-type declares JSON, or
 * fall back to a UTF-8 string. Handy shared helper for probe-style call sites
 * that don't care about binary bodies.
 */
export function decodeBodyAsJsonOrText(body: Uint8Array, contentType: string | undefined): unknown {
  if (body.byteLength === 0) return null;
  const text = Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8');
  if (contentType?.toLowerCase().includes('application/json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}
