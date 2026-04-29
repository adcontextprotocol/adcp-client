/**
 * Pin-and-bind fetch — DNS-rebinding-resistant `fetch` for outbound webhook
 * delivery and other callbacks where the destination is buyer-supplied.
 *
 * The problem: validating a `push_notification_config.url`'s LITERAL hostname
 * against an SSRF deny list does not protect against a DNS-rebinding attack.
 * A buyer can register `https://rebind.attacker.com/`, pass the literal-host
 * check, and then flip the A-record TTL to `169.254.169.254` (cloud metadata)
 * or `127.0.0.1` (loopback) before the webhook fires. Node's `fetch` resolves
 * the host fresh at request time, gets the rebound IP, and posts the
 * signed payload to the attacker-controlled destination.
 *
 * The fix: control DNS resolution and connect-target inside the fetch itself.
 *   1. Resolve the hostname.
 *   2. Validate every resolved IP against the SSRF policy (CIDR deny lists,
 *      metadata-host names, scheme rules).
 *   3. Pin the connection to the validated IP — undici opens TCP/TLS to that
 *      specific address, but the original hostname is preserved for TLS SNI
 *      and the `Host:` header so HTTPS routing still works.
 *
 * Implementation note: undici's `Agent` accepts a `connect.lookup` callback
 * with the same signature as `dns.lookup`. We hook the callback, resolve via
 * `dns.lookup({ all: true })` to see EVERY address the host can reach, run
 * the resolved IPs through {@link enforceSsrfPolicyResolved}, and only return
 * a pinned address when every resolved IP is in an allowed range. This
 * matches the AdCP substitution-observer SSRF contract — a host that
 * resolves to *any* denied IP is treated as suspect and rejected wholesale.
 */

import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { lookup as nativeDnsLookup, type LookupAddress } from 'node:dns';
import { isIPv6 } from 'node:net';

import { enforceSsrfPolicy, enforceSsrfPolicyResolved } from '../substitution/observer/ssrf';
import type { SsrfPolicy } from '../substitution/types';

/**
 * Default SSRF policy for outbound webhook delivery. Stricter than
 * `DEFAULT_SSRF_POLICY` (substitution observer) only in that it allows
 * `host_literal_policy: 'allow'` — webhook URLs MAY use IP literals
 * (e.g. `https://203.0.113.10/cb`) as long as the IP is not in a denied
 * CIDR range. Schemes restricted to https; signed webhooks SHOULD be
 * delivered over TLS.
 *
 * For storyboard / in-process tests where the receiver runs on
 * `http://127.0.0.1:port`, use {@link LOOPBACK_OK_WEBHOOK_SSRF_POLICY}
 * instead. That preset relaxes only the loopback + http rules and keeps
 * every other deny range — adopters get most of the SSRF protection
 * during tests without disabling pin-and-bind entirely.
 */
export const WEBHOOK_SSRF_POLICY: SsrfPolicy = Object.freeze({
  schemes_allowed: Object.freeze(['https']),
  schemes_denied: Object.freeze(['http', 'file', 'gopher', 'ftp', 'ftps', 'data', 'javascript', 'about', 'ws', 'wss']),
  hosts_denied_ipv4_cidrs: Object.freeze([
    '0.0.0.0/8',
    '10.0.0.0/8',
    '100.64.0.0/10',
    '127.0.0.0/8',
    '169.254.0.0/16',
    '172.16.0.0/12',
    '192.0.0.0/24',
    '192.168.0.0/16',
    '224.0.0.0/4',
    '240.0.0.0/4',
  ]),
  hosts_denied_ipv6_cidrs: Object.freeze([
    '::1/128',
    '::/128',
    '::ffff:0:0/96',
    '64:ff9b::/96',
    'fc00::/7',
    'fe80::/10',
    'ff00::/8',
  ]),
  hosts_denied_metadata: Object.freeze([
    'metadata.google.internal',
    'metadata',
    'metadata.packet.net',
    'fd00:ec2::254',
  ]),
  host_literal_policy: 'allow',
}) as SsrfPolicy;

/**
 * Pin-and-bind policy that allows http URLs and IPv4/IPv6 loopback so
 * adopters can enable pin-and-bind for production webhook delivery while
 * keeping storyboard / in-process tests working — `createWebhookReceiver`
 * listens on `http://127.0.0.1:port`. Every other private CIDR, metadata
 * host, and link-local range is still denied, so loopback is the only
 * relaxation. Pass to `createPinAndBindFetch({ policy })` from your test
 * fixture or storyboard runner harness; do NOT use in production.
 */
export const LOOPBACK_OK_WEBHOOK_SSRF_POLICY: SsrfPolicy = Object.freeze({
  schemes_allowed: Object.freeze(['http', 'https']),
  schemes_denied: Object.freeze(['file', 'gopher', 'ftp', 'ftps', 'data', 'javascript', 'about', 'ws', 'wss']),
  hosts_denied_ipv4_cidrs: Object.freeze([
    '0.0.0.0/8',
    '10.0.0.0/8',
    '100.64.0.0/10',
    // 127.0.0.0/8 omitted — loopback allowed for tests.
    '169.254.0.0/16',
    '172.16.0.0/12',
    '192.0.0.0/24',
    '192.168.0.0/16',
    '224.0.0.0/4',
    '240.0.0.0/4',
  ]),
  hosts_denied_ipv6_cidrs: Object.freeze([
    // ::1/128 and ::/128 omitted — IPv6 loopback allowed for tests.
    '::ffff:0:0/96',
    '64:ff9b::/96',
    'fc00::/7',
    'fe80::/10',
    'ff00::/8',
  ]),
  hosts_denied_metadata: Object.freeze([
    'metadata.google.internal',
    'metadata',
    'metadata.packet.net',
    'fd00:ec2::254',
  ]),
  host_literal_policy: 'allow',
}) as SsrfPolicy;

/**
 * Signature of the lookup callback `dns.lookup` accepts. Re-declared here
 * because the native type from `node:dns` is a complex overload set; the
 * shape we actually need is the all=true variant the Agent expects.
 */
export type DnsLookupAll = (
  hostname: string,
  options: { family?: number; hints?: number; all: true; verbatim?: boolean },
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void
) => void;

export interface PinAndBindFetchOptions {
  /**
   * SSRF policy to enforce against resolved IPs. Defaults to
   * {@link WEBHOOK_SSRF_POLICY} (https-only, all private/loopback/metadata
   * ranges denied, IP literals allowed).
   */
  policy?: SsrfPolicy;
  /**
   * Override the underlying DNS lookup. Default uses `dns.lookup` with
   * `all: true`. Tests inject a stub to simulate rebinding attacks without
   * touching real DNS.
   */
  lookup?: DnsLookupAll;
  /**
   * Forward to `Agent` — connect-attempt timeout, TLS options, etc. Cannot
   * override `lookup`; that is wired by this helper.
   */
  agentOptions?: Omit<Agent.Options, 'connect'> & {
    connect?: Omit<NonNullable<Agent.Options['connect']>, 'lookup'>;
  };
}

const DEFAULT_LOOKUP_ALL: DnsLookupAll = (hostname, options, callback) => {
  nativeDnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    callback(err, addresses as LookupAddress[]);
  });
};

/**
 * Build a `fetch` that pins outbound connections to the IPs the SSRF policy
 * allows, defeating DNS-rebinding attacks against per-attempt DNS resolution.
 *
 * Pass as the `fetch` argument to `createWebhookEmitter` /
 * `createAdcpServer({ webhooks: { fetch } })` to enable rebinding protection
 * on outbound webhook delivery. Recommended for production. The default
 * `fetch` for `createWebhookEmitter` remains `globalThis.fetch` until v6 —
 * see `docs/guides/SIGNING-GUIDE.md` § Webhook SSRF defense for the
 * migration plan and {@link LOOPBACK_OK_WEBHOOK_SSRF_POLICY} for storyboard
 * tests that need loopback http delivery.
 *
 * Construct once per emitter and reuse — each call instantiates a fresh
 * `undici.Agent` with its own connection pool.
 *
 * @example
 * ```ts
 * import { createWebhookEmitter, createPinAndBindFetch } from '@adcp/sdk/server';
 *
 * const emitter = createWebhookEmitter({
 *   signerKey: webhookKey,
 *   fetch: createPinAndBindFetch(),
 * });
 * ```
 */
export function createPinAndBindFetch(options: PinAndBindFetchOptions = {}): typeof fetch {
  const policy = options.policy ?? WEBHOOK_SSRF_POLICY;
  const lookupImpl = options.lookup ?? DEFAULT_LOOKUP_ALL;

  const guardedLookup = (
    hostname: string,
    opts: { family?: number; hints?: number; all?: boolean; verbatim?: boolean } | undefined,
    callback: (err: NodeJS.ErrnoException | null, addressOrAll?: string | LookupAddress[], family?: number) => void
  ): void => {
    const wantsAll = opts?.all === true;
    lookupImpl(hostname, { ...(opts ?? {}), all: true }, (err, addresses) => {
      if (err) {
        callback(err);
        return;
      }
      if (!Array.isArray(addresses) || addresses.length === 0) {
        callback(
          makeSsrfError(`DNS resolution returned no addresses for ${hostname}`, 'dns_revalidation:no_addresses')
        );
        return;
      }

      // The URL passed in here only matters for scheme + hostname checks,
      // both of which were already validated synchronously by undici when
      // the request started. We re-build a placeholder URL to feed the
      // resolved-address rule, which is the load-bearing check for
      // rebinding defense.
      const url = new URL(`https://${bracketIfV6(hostname)}`);
      const ips = addresses.map(a => a.address);
      const result = enforceSsrfPolicyResolved(url, ips, policy);
      if (!result.allowed) {
        callback(makeSsrfError(result.message ?? 'SSRF policy denied resolved address', result.rule ?? 'ssrf'));
        return;
      }

      if (wantsAll) {
        callback(null, addresses);
        return;
      }
      // Pin to the first resolved address. enforceSsrfPolicyResolved is
      // all-or-none: if it allowed the resolution, every entry passed.
      const first = addresses[0]!;
      callback(null, first.address, first.family);
    });
  };

  const dispatcher = new Agent({
    ...(options.agentOptions ?? {}),
    connect: {
      ...(options.agentOptions?.connect ?? {}),
      // undici's connect type accepts a lookup with the dns.lookup signature.
      lookup: guardedLookup as unknown as Agent.Options['connect'] extends infer T
        ? T extends { lookup?: infer L }
          ? L
          : never
        : never,
    },
  });

  const wrapped = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    // Synchronous pre-check for the URL's literal scheme + (if it's an IP)
    // its CIDR membership. undici skips `connect.lookup` for IP-literal
    // hostnames, so the resolved-IP path below would never see them.
    // This pre-check enforces the same SSRF policy on URLs like
    // `https://127.0.0.1/cb` or `https://[::1]/cb`.
    const url = resolveRequestUrl(input);
    if (url) {
      const sync = enforceSsrfPolicy(url, policy);
      if (!sync.allowed) {
        throw makeSsrfError(sync.message ?? 'SSRF policy denied URL', sync.rule ?? 'ssrf');
      }
    }
    return undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher: dispatcher as unknown as Dispatcher,
    }) as unknown as Response;
  };

  return wrapped as typeof fetch;
}

function resolveRequestUrl(input: Parameters<typeof fetch>[0]): URL | null {
  try {
    if (typeof input === 'string') return new URL(input);
    if (input instanceof URL) return input;
    if (
      typeof input === 'object' &&
      input !== null &&
      'url' in input &&
      typeof (input as { url: unknown }).url === 'string'
    ) {
      return new URL((input as { url: string }).url);
    }
  } catch {
    // Let undici surface the parse error in its own shape.
    return null;
  }
  return null;
}

function bracketIfV6(host: string): string {
  return isIPv6(host) ? `[${host}]` : host;
}

function makeSsrfError(message: string, rule: string): NodeJS.ErrnoException {
  const err = new Error(`pin-and-bind: ${rule}: ${message}`) as NodeJS.ErrnoException;
  err.code = 'EADCP_SSRF_BLOCKED';
  return err;
}
