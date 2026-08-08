import { isAlwaysBlocked, isPrivateIp } from '../../../net/address-guards';
import { ssrfSafeFetch, SsrfRefusedError } from '../../../net/ssrf-fetch';
import type { HttpProbeResult } from '../types';
import type {
  OAuthMetadataFetchResponse,
  OAuthMetadataFetchTransport,
  OAuthMetadataGraphErrorCode,
  OAuthMetadataGraphFinding,
  OAuthMetadataGraphGrade,
  OAuthMetadataGraphObservation,
} from './types';

const LIMITS = Object.freeze({
  authorizationServers: 16,
  uniqueUrls: 64,
  totalRequests: 64,
  responseBytes: 2 * 1024 * 1024,
  responseBytesPerRequest: 256 * 1024,
  redirects: 3,
  wholeRunMs: 60_000,
});

const DIAGNOSTIC_ORDER: readonly OAuthMetadataGraphErrorCode[] = Object.freeze([
  'oauth_graph_limit_exceeded',
  'oauth_fetch_blocked',
  'oauth_protected_resource_metadata_unavailable',
  'oauth_protected_resource_metadata_invalid',
  'oauth_resource_mismatch',
  'oauth_authorization_servers_empty',
  'oauth_authorization_server_url_invalid',
  'oauth_authorization_server_metadata_unavailable',
  'oauth_authorization_server_metadata_invalid',
  'oauth_issuer_mismatch',
  'oauth_endpoint_url_invalid',
  'oauth_endpoint_unreachable',
  'oauth_jwks_unavailable',
]);

export interface GradeOAuthMetadataGraphOptions {
  /** Explicit local-development opt-in. Production grading remains HTTPS-only. */
  allowHttp?: boolean;
  signal?: AbortSignal;
  /** Trusted scoped fetch supplied by a hosted runner; it must enforce peer-address binding. */
  trustedFetchFn?: typeof fetch;
}

interface InternalGradeOAuthMetadataGraphOptions extends GradeOAuthMetadataGraphOptions {
  /** Offline vector transport; deliberately excluded from the public grader options. */
  transport?: OAuthMetadataFetchTransport;
  trustedDevelopmentOrigin?: string;
}

interface FetchedDocument {
  result: HttpProbeResult;
  bytes: number;
  blocked?: boolean;
  limitExceeded?: boolean;
}

interface FetchState {
  totalRequests: number;
  totalResponseBytes: number;
  uniqueUrls: Set<string>;
  cache: Map<string, FetchedDocument>;
  responses: Map<string, OAuthMetadataFetchResponse>;
  observations: OAuthMetadataGraphObservation[];
}

interface FetchDocumentOptions {
  followRedirects: boolean;
  kind: OAuthMetadataGraphObservation['kind'];
  authorizationServerIndex?: number;
}

/**
 * Shared RFC 9728 comparison semantics used by security.yaml and oauth_setup.
 * Only scheme and host are case-folded and default ports are elided. The
 * path, query, fragment, userinfo, and trailing slash remain significant.
 */
export function normalizeOAuthResourceForComparison(value: string): string {
  // Do not rebuild through URL: WHATWG parsing removes dot segments and turns
  // an empty path into `/`, but the shared storyboard rule says the remainder
  // of the URL is byte-for-byte significant after scheme/host/default-port.
  const match = /^([A-Za-z][A-Za-z\d+.-]*):\/\/([^/?#]*)([\s\S]*)$/.exec(value);
  if (!match) return value;
  const scheme = match[1]!.toLowerCase();
  const authority = match[2]!;
  const remainder = match[3]!;
  const at = authority.lastIndexOf('@');
  const userinfo = at >= 0 ? authority.slice(0, at + 1) : '';
  const hostAndPort = at >= 0 ? authority.slice(at + 1) : authority;
  let host: string;
  let port = '';
  if (hostAndPort.startsWith('[')) {
    const bracket = hostAndPort.indexOf(']');
    if (bracket < 0) return value;
    host = hostAndPort.slice(0, bracket + 1).toLowerCase();
    const suffix = hostAndPort.slice(bracket + 1);
    if (suffix && !/^:\d+$/.test(suffix)) return value;
    port = suffix.slice(1);
  } else {
    const colon = hostAndPort.lastIndexOf(':');
    if (colon >= 0) {
      const suffix = hostAndPort.slice(colon + 1);
      if (!/^\d+$/.test(suffix)) return value;
      host = hostAndPort.slice(0, colon).toLowerCase();
      port = suffix;
    } else {
      host = hostAndPort.toLowerCase();
    }
  }
  if (!host) return value;
  const defaultPort = scheme === 'https' ? '443' : scheme === 'http' ? '80' : undefined;
  const renderedPort = port && port !== defaultPort ? `:${port}` : '';
  return `${scheme}://${userinfo}${host}${renderedPort}${remainder}`;
}

/** Redact sensitive URL components before including a URL in a report. */
export function redactOAuthUrlForOutput(value: string): string {
  try {
    const u = new URL(value);
    if (u.username || u.password) {
      u.username = 'REDACTED';
      u.password = 'REDACTED';
    }
    for (const key of [...u.searchParams.keys()]) u.searchParams.set(key, 'REDACTED');
    if (u.hash) u.hash = '#REDACTED';
    return u.href;
  } catch {
    return '[invalid URL]';
  }
}

/** Redact absolute URLs embedded in diagnostic text before report serialization. */
export function redactOAuthUrlsInText(value: string): string {
  return value.replace(/https?:\/\/[^\s"'<>]+/gi, url => redactOAuthUrlForOutput(url));
}

export function buildProtectedResourceMetadataUrl(agentUrl: string): string {
  const u = new URL(agentUrl);
  return `${u.origin}/.well-known/oauth-protected-resource${u.pathname}`;
}

export function buildAuthorizationServerMetadataUrl(issuer: string): string {
  const u = new URL(issuer);
  const issuerPath = u.pathname === '/' ? '' : u.pathname;
  return `${u.origin}/.well-known/oauth-authorization-server${issuerPath}`;
}

export async function gradeOAuthMetadataGraph(
  agentUrl: string,
  options: GradeOAuthMetadataGraphOptions = {}
): Promise<OAuthMetadataGraphGrade> {
  return gradeOAuthMetadataGraphWithTransport(agentUrl, options);
}

/** @internal Used only by the deterministic, no-network vector harness. */
export async function gradeOAuthMetadataGraphWithTransport(
  agentUrl: string,
  options: InternalGradeOAuthMetadataGraphOptions = {}
): Promise<OAuthMetadataGraphGrade> {
  const timeoutSignal = AbortSignal.timeout(LIMITS.wholeRunMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  const trustedDevelopmentOrigin = options.allowHttp === true ? parseOrigin(agentUrl) : undefined;
  const graphOptions: InternalGradeOAuthMetadataGraphOptions = { ...options, trustedDevelopmentOrigin };
  const state: FetchState = {
    totalRequests: 0,
    totalResponseBytes: 0,
    uniqueUrls: new Set(),
    cache: new Map(),
    responses: new Map(),
    observations: [],
  };
  const findings: OAuthMetadataGraphFinding[] = [];
  let protectedResourceUrl: string;
  try {
    protectedResourceUrl = buildProtectedResourceMetadataUrl(agentUrl);
  } catch {
    protectedResourceUrl = redactOAuthUrlForOutput(agentUrl);
    findings.push(finding('oauth_protected_resource_metadata_invalid', 'Agent URL is not an absolute URL.'));
    return finish(protectedResourceUrl, emptyProbe(protectedResourceUrl), state, findings);
  }

  const protectedResource = await fetchDocument(protectedResourceUrl, graphOptions, signal, state, {
    followRedirects: true,
    kind: 'protected_resource_metadata',
  });
  if (protectedResource.blocked) {
    findings.push(fetchFailureFinding('oauth_fetch_blocked', protectedResource.result, undefined));
    return finish(protectedResourceUrl, protectedResource.result, state, findings);
  }
  if (protectedResource.limitExceeded) {
    findings.push(fetchFailureFinding('oauth_graph_limit_exceeded', protectedResource.result, undefined));
    return finish(protectedResourceUrl, protectedResource.result, state, findings);
  }
  if (protectedResource.result.error || protectedResource.result.status !== 200) {
    findings.push(
      fetchFailureFinding('oauth_protected_resource_metadata_unavailable', protectedResource.result, undefined)
    );
    return finish(protectedResourceUrl, protectedResource.result, state, findings);
  }
  const prm = asObject(protectedResource.result.body);
  if (!prm || !isJsonContentType(protectedResource.result.headers['content-type'])) {
    findings.push(
      finding(
        'oauth_protected_resource_metadata_invalid',
        'Protected-resource metadata must be an application/json object.',
        protectedResource.result.url
      )
    );
    return finish(protectedResourceUrl, protectedResource.result, state, findings);
  }

  const resource = prm.resource;
  if (typeof resource !== 'string' || !isAllowedAbsoluteUrl(resource, trustedDevelopmentOrigin, false)) {
    findings.push(
      finding(
        'oauth_protected_resource_metadata_invalid',
        'Protected-resource metadata resource must be an absolute HTTPS URI.',
        protectedResource.result.url,
        'resource'
      )
    );
  } else if (normalizeOAuthResourceForComparison(resource) !== normalizeOAuthResourceForComparison(agentUrl)) {
    findings.push(
      finding(
        'oauth_resource_mismatch',
        'Protected-resource metadata resource does not match the agent endpoint.',
        protectedResource.result.url,
        'resource'
      )
    );
  }

  const authorizationServers = prm.authorization_servers;
  if (!Array.isArray(authorizationServers) || authorizationServers.length === 0) {
    findings.push(
      finding(
        'oauth_authorization_servers_empty',
        'authorization_servers must be a non-empty array of issuer URI strings.',
        protectedResource.result.url,
        'authorization_servers'
      )
    );
    return finish(protectedResourceUrl, protectedResource.result, state, findings);
  }
  if (authorizationServers.length > LIMITS.authorizationServers) {
    findings.push(
      finding(
        'oauth_graph_limit_exceeded',
        `authorization_servers exceeds the graph limit of ${LIMITS.authorizationServers}.`,
        protectedResource.result.url,
        'authorization_servers'
      )
    );
    return finish(protectedResourceUrl, protectedResource.result, state, findings);
  }

  // Deliberately sequential: the contract permits up to four concurrent
  // requests, while sequential traversal guarantees source-array ordering and
  // still validates every authorization server instead of returning early.
  for (let index = 0; index < authorizationServers.length; index++) {
    const issuer: unknown = authorizationServers[index];
    if (typeof issuer !== 'string' || !isIssuerUrl(issuer, trustedDevelopmentOrigin)) {
      findings.push(
        finding(
          'oauth_authorization_server_url_invalid',
          'Authorization-server identifier must be an absolute HTTPS issuer URI without userinfo, query, or fragment.',
          typeof issuer === 'string' ? issuer : protectedResource.result.url,
          `authorization_servers[${index}]`,
          index
        )
      );
      continue;
    }

    const metadataUrl = buildAuthorizationServerMetadataUrl(issuer);
    const metadata = await fetchDocument(metadataUrl, graphOptions, signal, state, {
      followRedirects: true,
      kind: 'authorization_server_metadata',
      authorizationServerIndex: index,
    });
    if (metadata.blocked) {
      findings.push(fetchFailureFinding('oauth_fetch_blocked', metadata.result, index));
      continue;
    }
    if (metadata.limitExceeded) {
      findings.push(fetchFailureFinding('oauth_graph_limit_exceeded', metadata.result, index));
      continue;
    }
    if (metadata.result.error || metadata.result.status !== 200) {
      findings.push(fetchFailureFinding('oauth_authorization_server_metadata_unavailable', metadata.result, index));
      continue;
    }
    const document = asObject(metadata.result.body);
    if (!document || !isJsonContentType(metadata.result.headers['content-type'])) {
      findings.push(
        finding(
          'oauth_authorization_server_metadata_invalid',
          'Authorization-server metadata must be an application/json object.',
          metadata.result.url,
          undefined,
          index
        )
      );
      continue;
    }

    const issuerField = document.issuer;
    if (typeof issuerField !== 'string' || !isIssuerUrl(issuerField, trustedDevelopmentOrigin)) {
      findings.push(
        finding(
          'oauth_authorization_server_metadata_invalid',
          'Authorization-server metadata issuer is missing or invalid.',
          metadata.result.url,
          'issuer',
          index
        )
      );
    } else if (issuerField !== issuer) {
      // RFC 8414 section 3.3: exact decoded JSON string equality. Do not URL-
      // normalize case, ports, escapes, path, or a trailing slash here.
      findings.push(
        finding(
          'oauth_issuer_mismatch',
          'Authorization-server metadata issuer is not exactly equal to the advertised issuer.',
          metadata.result.url,
          'issuer',
          index
        )
      );
    }

    const shape = validateAuthorizationServerShape(document);
    if (!shape.ok) {
      findings.push(
        finding('oauth_authorization_server_metadata_invalid', shape.message, metadata.result.url, shape.field, index)
      );
      continue;
    }

    const endpointEntries: Array<{
      field: 'authorization_endpoint' | 'token_endpoint' | 'jwks_uri' | 'registration_endpoint';
      kind: OAuthMetadataGraphObservation['kind'];
      probe: boolean;
      followRedirects: boolean;
    }> = [
      {
        field: 'authorization_endpoint',
        kind: 'authorization_endpoint',
        probe: shape.needsAuthorizationEndpoint,
        followRedirects: false,
      },
      { field: 'token_endpoint', kind: 'token_endpoint', probe: shape.needsTokenEndpoint, followRedirects: false },
      { field: 'jwks_uri', kind: 'jwks_uri', probe: document.jwks_uri !== undefined, followRedirects: true },
      { field: 'registration_endpoint', kind: 'authorization_endpoint', probe: false, followRedirects: false },
    ];

    let endpointShapeFailed = false;
    for (const endpoint of endpointEntries) {
      const raw = document[endpoint.field];
      if (raw === undefined) continue;
      if (typeof raw !== 'string' || !isAllowedAbsoluteUrl(raw, trustedDevelopmentOrigin, true)) {
        findings.push(
          finding(
            'oauth_endpoint_url_invalid',
            `${endpoint.field} must be an absolute HTTPS URL without credentials or a fragment.`,
            metadata.result.url,
            endpoint.field,
            index
          )
        );
        endpointShapeFailed = true;
      }
    }
    if (endpointShapeFailed) continue;

    for (const endpoint of endpointEntries) {
      if (!endpoint.probe) continue;
      const url = document[endpoint.field] as string;
      const probed = await fetchDocument(url, graphOptions, signal, state, {
        followRedirects: endpoint.followRedirects,
        kind: endpoint.kind,
        authorizationServerIndex: index,
      });
      if (probed.blocked) {
        findings.push(fetchFailureFinding('oauth_fetch_blocked', probed.result, index));
        continue;
      }
      if (probed.limitExceeded) {
        findings.push(fetchFailureFinding('oauth_graph_limit_exceeded', probed.result, index));
        continue;
      }
      if (endpoint.field === 'jwks_uri') {
        const jwks = asObject(probed.result.body);
        if (
          probed.result.error ||
          probed.result.status !== 200 ||
          !isJsonContentType(probed.result.headers['content-type']) ||
          !jwks ||
          !Array.isArray(jwks.keys)
        ) {
          findings.push(fetchFailureFinding('oauth_jwks_unavailable', probed.result, index));
        }
      } else if (
        (endpoint.field === 'authorization_endpoint' || endpoint.field === 'token_endpoint') &&
        !endpointReachable(endpoint.field, probed.result)
      ) {
        findings.push(fetchFailureFinding('oauth_endpoint_unreachable', probed.result, index));
      }
    }
  }

  return finish(protectedResourceUrl, protectedResource.result, state, findings);
}

function validateAuthorizationServerShape(document: Record<string, unknown>):
  | {
      ok: true;
      needsAuthorizationEndpoint: boolean;
      needsTokenEndpoint: boolean;
    }
  | { ok: false; message: string; field: string } {
  const grants = document.grant_types_supported;
  if (grants !== undefined && !isNonEmptyStringArray(grants)) {
    return {
      ok: false,
      message: 'grant_types_supported must be a non-empty string array when present.',
      field: 'grant_types_supported',
    };
  }
  const effectiveGrants = grants === undefined ? ['authorization_code', 'implicit'] : (grants as string[]);
  const responseTypes = document.response_types_supported;
  if (responseTypes !== undefined && !isNonEmptyStringArray(responseTypes)) {
    return {
      ok: false,
      message: 'response_types_supported must be a non-empty string array when present.',
      field: 'response_types_supported',
    };
  }
  const responseTypeUsesAuthorization = Array.isArray(responseTypes)
    ? responseTypes.some(value => value.split(/\s+/).some(part => part === 'code' || part === 'token'))
    : false;
  const needsAuthorizationEndpoint =
    effectiveGrants.some(grant => grant === 'authorization_code' || grant === 'implicit') ||
    responseTypeUsesAuthorization;
  const needsTokenEndpoint = !(effectiveGrants.length === 1 && effectiveGrants[0] === 'implicit');

  if (needsAuthorizationEndpoint && !isNonEmptyStringArray(responseTypes)) {
    return {
      ok: false,
      message: 'response_types_supported is required when the authorization endpoint is used.',
      field: 'response_types_supported',
    };
  }
  if (needsAuthorizationEndpoint && typeof document.authorization_endpoint !== 'string') {
    return {
      ok: false,
      message: 'authorization_endpoint is required for the effective grant and response-type set.',
      field: 'authorization_endpoint',
    };
  }
  if (needsTokenEndpoint && typeof document.token_endpoint !== 'string') {
    return {
      ok: false,
      message: 'token_endpoint is required unless the effective grant set is implicit-only.',
      field: 'token_endpoint',
    };
  }
  return { ok: true, needsAuthorizationEndpoint, needsTokenEndpoint };
}

function endpointReachable(field: 'authorization_endpoint' | 'token_endpoint', result: HttpProbeResult): boolean {
  if (result.error) return false;
  const status = result.status;
  if (field === 'token_endpoint') return status > 0 && status < 500 && status !== 410;
  if (status >= 200 && status < 400) return true;
  return status === 400 || status === 401 || status === 403 || status === 405 || status === 429;
}

async function fetchDocument(
  initialUrl: string,
  options: InternalGradeOAuthMetadataGraphOptions,
  signal: AbortSignal,
  state: FetchState,
  fetchOptions: FetchDocumentOptions
): Promise<FetchedDocument> {
  const cacheKey = `${fetchOptions.followRedirects ? 'follow' : 'manual'} ${initialUrl}`;
  const cached = state.cache.get(cacheKey);
  if (cached) return cached;

  let current = initialUrl;
  let redirects = 0;
  while (true) {
    throwIfCallerAborted(options.signal);
    if (signal.aborted) {
      const outcome = failedFetch(current, 'OAuth metadata graph exceeded its whole-run timeout.');
      outcome.limitExceeded = true;
      state.cache.set(cacheKey, outcome);
      return outcome;
    }
    let response = state.responses.get(current);
    if (!response) {
      if (!state.uniqueUrls.has(current) && state.uniqueUrls.size >= LIMITS.uniqueUrls) {
        const outcome = failedFetch(current, `OAuth metadata graph exceeded ${LIMITS.uniqueUrls} unique URLs.`);
        outcome.limitExceeded = true;
        state.cache.set(cacheKey, outcome);
        return outcome;
      }
      state.uniqueUrls.add(current);
      if (state.totalRequests >= LIMITS.totalRequests) {
        const outcome = failedFetch(current, `OAuth metadata graph exceeded ${LIMITS.totalRequests} requests.`);
        outcome.limitExceeded = true;
        state.cache.set(cacheKey, outcome);
        return outcome;
      }
      state.totalRequests++;

      try {
        response = options.transport
          ? await options.transport.fetch(current, { signal, maxBodyBytes: LIMITS.responseBytesPerRequest })
          : await defaultTransportFetch(current, options.trustedDevelopmentOrigin, signal, options.trustedFetchFn);
        if (
          response.connectedPeerAddress &&
          isBlockedAddress(
            response.connectedPeerAddress,
            isTrustedDevelopmentUrl(current, options.trustedDevelopmentOrigin)
          )
        ) {
          const outcome = failedFetch(current, 'Connected peer address was rejected by the SSRF policy.');
          outcome.blocked = true;
          state.cache.set(cacheKey, outcome);
          return outcome;
        }
      } catch (error) {
        throwIfCallerAborted(options.signal);
        const outcome = failedFetch(current, safeFetchError(error));
        if (signal.aborted || (error instanceof SsrfRefusedError && error.code === 'body_exceeds_limit')) {
          outcome.limitExceeded = true;
        } else {
          outcome.blocked =
            error instanceof SsrfRefusedError && !['dns_lookup_failed', 'dns_empty'].includes(error.code);
        }
        state.cache.set(cacheKey, outcome);
        return outcome;
      }

      state.totalResponseBytes += response.body.byteLength;
      if (state.totalResponseBytes > LIMITS.responseBytes) {
        const outcome = failedFetch(current, `OAuth metadata graph exceeded ${LIMITS.responseBytes} response bytes.`);
        outcome.limitExceeded = true;
        state.cache.set(cacheKey, outcome);
        return outcome;
      }
      state.responses.set(current, response);
    }

    const result: HttpProbeResult = {
      url: redactOAuthUrlForOutput(current),
      status: response.status,
      headers: response.headers,
      body: decodeBody(response.body, response.headers['content-type']),
    };
    state.observations.push({
      kind: fetchOptions.kind,
      url: result.url,
      status: result.status,
      ...(fetchOptions.authorizationServerIndex !== undefined && {
        authorization_server_index: fetchOptions.authorizationServerIndex,
      }),
    });

    if (!fetchOptions.followRedirects || !isRedirectStatus(response.status)) {
      const outcome = { result, bytes: response.body.byteLength };
      state.cache.set(cacheKey, outcome);
      return outcome;
    }
    const location = response.headers.location;
    if (!location) {
      const outcome = { result, bytes: response.body.byteLength };
      state.cache.set(cacheKey, outcome);
      return outcome;
    }
    if (redirects >= LIMITS.redirects) {
      const outcome = failedFetch(current, `OAuth metadata redirect count exceeded ${LIMITS.redirects}.`);
      outcome.limitExceeded = true;
      state.cache.set(cacheKey, outcome);
      return outcome;
    }
    let next: string;
    try {
      next = new URL(location, current).href;
    } catch {
      const outcome = failedFetch(current, 'OAuth metadata redirect Location was not a valid URL.');
      outcome.blocked = true;
      state.cache.set(cacheKey, outcome);
      return outcome;
    }
    if (!isAllowedAbsoluteUrl(next, options.trustedDevelopmentOrigin, true)) {
      const outcome = failedFetch(next, 'OAuth metadata redirect target violated the URL policy.');
      outcome.blocked = true;
      state.cache.set(cacheKey, outcome);
      return outcome;
    }
    redirects++;
    current = next;
  }
}

async function defaultTransportFetch(
  url: string,
  trustedDevelopmentOrigin: string | undefined,
  signal: AbortSignal,
  trustedFetchFn?: typeof fetch
): Promise<OAuthMetadataFetchResponse> {
  const result = await ssrfSafeFetch(url, {
    method: 'GET',
    headers: { accept: 'application/json', 'accept-encoding': 'identity' },
    allowPrivateIp: isTrustedDevelopmentUrl(url, trustedDevelopmentOrigin),
    signal,
    timeoutMs: 10_000,
    maxBodyBytes: LIMITS.responseBytesPerRequest,
    ...(trustedFetchFn && { trustedFetchFn }),
  });
  return {
    status: result.status,
    headers: result.headers,
    body: result.body,
    connectedPeerAddress: result.connectionPinned ? result.pinnedAddress : undefined,
  };
}

function finish(
  protectedResourceUrl: string,
  protectedResourceResult: HttpProbeResult,
  state: FetchState,
  findings: OAuthMetadataGraphFinding[]
): OAuthMetadataGraphGrade {
  const sorted = findings.slice().sort((a, b) => {
    const codeOrder = DIAGNOSTIC_ORDER.indexOf(a.code) - DIAGNOSTIC_ORDER.indexOf(b.code);
    if (codeOrder !== 0) return codeOrder;
    return (a.authorization_server_index ?? -1) - (b.authorization_server_index ?? -1);
  });
  const first = sorted[0];
  return {
    success: first === undefined,
    protected_resource_url: redactOAuthUrlForOutput(protectedResourceUrl),
    protected_resource_result: sanitizeProtectedResourceResult(protectedResourceResult),
    observations: state.observations,
    findings: sorted,
    ...(first && { error_code: first.code, error: first.message }),
    total_requests: state.totalRequests,
    total_response_bytes: state.totalResponseBytes,
  };
}

function finding(
  code: OAuthMetadataGraphErrorCode,
  message: string,
  url?: string,
  field?: string,
  authorizationServerIndex?: number
): OAuthMetadataGraphFinding {
  return {
    code,
    message,
    ...(url && { url: redactOAuthUrlForOutput(url) }),
    ...(field && { field }),
    ...(authorizationServerIndex !== undefined && { authorization_server_index: authorizationServerIndex }),
  };
}

function fetchFailureFinding(
  code: OAuthMetadataGraphErrorCode,
  result: HttpProbeResult,
  authorizationServerIndex: number | undefined
): OAuthMetadataGraphFinding {
  return finding(code, result.error ?? `HTTP ${result.status}`, result.url, undefined, authorizationServerIndex);
}

function failedFetch(url: string, error: string): FetchedDocument {
  return { result: { ...emptyProbe(redactOAuthUrlForOutput(url)), error }, bytes: 0 };
}

function emptyProbe(url: string): HttpProbeResult {
  return { url, status: 0, headers: {}, body: null };
}

function safeFetchError(error: unknown): string {
  if (error instanceof SsrfRefusedError) return `SSRF fetch refused (${error.code}).`;
  if (error instanceof Error) {
    if (error.name === 'AbortError' || /timeout/i.test(error.message)) return 'OAuth metadata fetch timed out.';
    return 'OAuth metadata fetch failed.';
  }
  return 'OAuth metadata fetch failed.';
}

function throwIfCallerAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error(signal.reason == null ? 'The operation was aborted' : String(signal.reason));
  error.name = 'AbortError';
  throw error;
}

function isIssuerUrl(value: string, trustedDevelopmentOrigin: string | undefined): boolean {
  try {
    const u = new URL(value);
    return (
      (u.protocol === 'https:' || isTrustedDevelopmentUrl(value, trustedDevelopmentOrigin)) &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash
    );
  } catch {
    return false;
  }
}

function isAllowedAbsoluteUrl(
  value: string,
  trustedDevelopmentOrigin: string | undefined,
  rejectCredentialsAndFragment: boolean
): boolean {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' && !isTrustedDevelopmentUrl(value, trustedDevelopmentOrigin)) return false;
    if (rejectCredentialsAndFragment && (u.username || u.password || u.hash)) return false;
    return true;
  } catch {
    return false;
  }
}

function parseOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function isTrustedDevelopmentUrl(value: string, trustedDevelopmentOrigin: string | undefined): boolean {
  return trustedDevelopmentOrigin !== undefined && parseOrigin(value) === trustedDevelopmentOrigin;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function sanitizeProtectedResourceResult(result: HttpProbeResult): HttpProbeResult {
  const body = asObject(result.body);
  let safeBody: unknown = result.body;
  if (body) {
    const safeRecord: Record<string, unknown> = { ...body };
    if (typeof body.resource === 'string') {
      safeRecord.resource = redactOAuthUrlForOutput(body.resource);
    }
    if (Array.isArray(body.authorization_servers)) {
      safeRecord.authorization_servers = body.authorization_servers.map(value =>
        typeof value === 'string' ? redactOAuthUrlForOutput(value) : value
      );
    }
    safeBody = safeRecord;
  }
  const allowedHeaders = new Set(['content-type', 'content-length', 'content-encoding', 'location']);
  const headers = Object.fromEntries(
    Object.entries(result.headers)
      .filter(([key]) => allowedHeaders.has(key.toLowerCase()))
      .map(([key, value]) => [
        key.toLowerCase(),
        key.toLowerCase() === 'location' ? redactOAuthUrlForOutput(value) : value,
      ])
  );
  return {
    ...result,
    url: redactOAuthUrlForOutput(result.url),
    headers,
    body: safeBody,
  };
}

function isBlockedAddress(address: string, allowPrivate: boolean): boolean {
  return isAlwaysBlocked(address) || (!allowPrivate && isPrivateIp(address));
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string' && item.length > 0);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isJsonContentType(value: string | undefined): boolean {
  return typeof value === 'string' && /^(application\/json|[^;]+\+json)(?:;|$)/i.test(value.trim());
}

function decodeBody(body: Uint8Array, contentType: string | undefined): unknown {
  if (body.byteLength === 0) return null;
  const text = Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8');
  if (isJsonContentType(contentType)) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}
