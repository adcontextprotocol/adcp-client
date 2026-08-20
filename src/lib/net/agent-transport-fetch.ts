/**
 * DNS-resolving, connection-pinning fetch for MCP and A2A transports.
 *
 * A fetch instance is created alongside a cached protocol client. Each origin
 * is resolved once, every returned address is classified, and an undici Agent
 * pins subsequent connects to the validated address. Redirects are either
 * returned to callers that requested `manual`, or followed hop-by-hop through
 * the same validation path.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { isAlwaysBlocked, isLikelyPrivateUrl, isPrivateIp } from './address-guards';

type ResolvedAddress = { address: string; family: number };

export interface AgentTransportFetchOptions {
  /** A caller-owned fetch is trusted to provide its own connect-time pinning. */
  trustedFetchFn?: typeof fetch;
  /** @internal Deterministic network seam; production callers should omit. */
  networkFetch?: (url: URL, init: RequestInit, dispatcher: Agent) => Promise<Response>;
  /** Permit private DNS answers for this client. Prefer this to process-global flags. */
  allowPrivateIp?: boolean;
  /** Test seam for deterministic DNS answers. */
  lookup?: (hostname: string) => Promise<ResolvedAddress[]>;
  maxRedirects?: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SENSITIVE_REDIRECT_HEADERS = ['authorization', 'cookie', 'proxy-authorization', 'x-adcp-auth'];

export function createAgentTransportFetch(agentUrl: string, options: AgentTransportFetchOptions = {}): typeof fetch {
  const lookup = options.lookup ?? (hostname => dnsLookup(hostname, { all: true }));
  const maxRedirects = options.maxRedirects ?? 5;
  const initialUrl = new URL(agentUrl);
  const allowPrivateEverywhere =
    options.allowPrivateIp === true ||
    process.env.ADCP_ALLOW_INTERNAL_PROBES === '1' ||
    process.env.ADCP_ALLOW_PRIVATE_AGENT_URL === '1';
  const allowPrivateInitialOrigin = isLikelyPrivateUrl(initialUrl.toString());
  const dispatchers = new Map<string, Promise<Agent>>();
  const privateIpAllowedFor = (url: URL): boolean =>
    allowPrivateEverywhere || (allowPrivateInitialOrigin && url.origin === initialUrl.origin);

  const dispatcherFor = (url: URL): Promise<Agent> => {
    const cached = dispatchers.get(url.origin);
    if (cached) return cached;
    const pending = resolveAndCreateDispatcher(url, lookup, privateIpAllowedFor(url));
    dispatchers.set(url.origin, pending);
    pending.catch(() => dispatchers.delete(url.origin));
    return pending;
  };

  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = typeof Request !== 'undefined' && input instanceof Request ? input : undefined;
    let url = new URL(request?.url ?? input.toString());
    let method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    let body = init?.body;
    if (body === undefined && request?.body && method !== 'GET' && method !== 'HEAD') {
      body = new Uint8Array(await request.clone().arrayBuffer());
    }
    const signal = init?.signal ?? request?.signal;
    let headers = new Headers(request?.headers);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    const redirectMode = init?.redirect ?? request?.redirect ?? 'follow';

    for (let redirects = 0; ; redirects++) {
      assertTransportScheme(url);
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      if (isIP(hostname) !== 0) assertAgentAddressAllowed(hostname, hostname, privateIpAllowedFor(url), false);
      const headerRecord: Record<string, string> = {};
      headers.forEach((value, key) => {
        headerRecord[key] = value;
      });
      const requestInit = { ...init, method, body, headers, signal, redirect: 'manual' as const };
      let response: Response;
      if (options.trustedFetchFn) {
        // Explicit trust means the caller owns connect-time DNS pinning. Do
        // not pre-resolve here: hardened proxies and virtual test transports
        // may intentionally use names the host resolver cannot resolve.
        response = await options.trustedFetchFn(url, requestInit);
      } else {
        const dispatcher = await dispatcherFor(url);
        response = options.networkFetch
          ? await options.networkFetch(url, { ...requestInit, headers: headerRecord }, dispatcher)
          : ((await undiciFetch(url, {
              ...requestInit,
              body: body as any,
              headers: headerRecord,
              dispatcher,
            })) as unknown as Response);
      }

      if (!REDIRECT_STATUSES.has(response.status) || !response.headers.get('location')) return response;
      if (redirectMode === 'manual') return response;
      if (redirectMode === 'error') {
        await response.body?.cancel();
        throw new TypeError('Redirect encountered while redirect mode is error');
      }
      if (redirects >= maxRedirects) {
        await response.body?.cancel();
        throw new TypeError(`Agent transport exceeded ${maxRedirects} redirects`);
      }

      const next = new URL(response.headers.get('location')!, url);
      await response.body?.cancel();
      if (next.origin !== url.origin) {
        for (const header of SENSITIVE_REDIRECT_HEADERS) headers.delete(header);
      }
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
        headers.delete('content-length');
        headers.delete('content-type');
      }
      url = next;
    }
  }) as typeof fetch;
}

async function resolveAndCreateDispatcher(
  url: URL,
  lookup: (hostname: string) => Promise<ResolvedAddress[]>,
  allowPrivateIp: boolean
): Promise<Agent> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await lookup(hostname);
  if (addresses.length === 0) throw new Error(`DNS returned no addresses for agent host ${hostname}`);
  for (const entry of addresses) {
    assertAgentAddressAllowed(entry.address, hostname, allowPrivateIp, true);
  }

  const pinned = addresses[0]!;
  const family = pinned.family === 6 ? 6 : 4;
  return new Agent({
    connect: {
      rejectUnauthorized: true,
      ...(url.protocol === 'https:' && isIP(hostname) === 0 ? { servername: hostname } : {}),
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions?.all) callback(null, [{ address: pinned.address, family }]);
        else callback(null, pinned.address, family);
      },
    },
  });
}

function assertAgentAddressAllowed(
  address: string,
  hostname: string,
  allowPrivateIp: boolean,
  resolved: boolean
): void {
  const relationship = resolved ? 'resolves to' : 'is';
  if (isAlwaysBlocked(address)) {
    throw new Error(`Agent host ${hostname} ${relationship} an always-blocked address`);
  }
  if (!allowPrivateIp && isPrivateIp(address)) {
    const guidance = resolved
      ? 'set transport.allowPrivateIp=true for an explicitly trusted private agent, or provide a trustedFetchFn that enforces its own hostname address policy'
      : 'set transport.allowPrivateIp=true for an explicitly trusted private agent';
    throw new Error(`Agent host ${hostname} ${relationship} a private or loopback address; ` + guidance);
  }
}

function assertTransportScheme(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`Agent transport does not allow ${url.protocol} URLs`);
  }
}
