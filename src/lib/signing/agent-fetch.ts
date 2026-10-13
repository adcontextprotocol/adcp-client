import type {
  AgentRequestSigningConfig,
  AgentRequestSigningConfigInline,
  AgentRequestSigningConfigProvider,
} from '../types/adcp';
import { createSigningFetch, type CoverContentDigestPredicate } from './fetch';
import { createSigningFetchAsync } from './fetch-async';
import {
  buildCapabilityCacheKey,
  defaultCapabilityCache,
  type CachedCapability,
  type CapabilityCache,
} from './capability-cache';
import type { ContentDigestPolicy, VerifierCapability } from './types';
import type { SignerKey } from './signer';
import { containsWebhookAuthentication } from './webhook-auth-detection';
import { ADCP_VERSION } from '../version';
import { requestSigningEncodingForVersion } from './content-digest';
import { resolveRequestOperation } from './operation-resolution';
import { WEB_BOT_AUTH_TAG } from './wba/constants';
import { warnRfc9421ProfileDeprecated } from './wba/deprecation';
import type { WebBotAuthSigner } from './wba/fetch';
import { publicDirectoryKey } from './wba/keys';
import { webBotAuthOrigin } from './wba/origin';
export { requestSigningEncodingForVersion } from './content-digest';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const MAX_WEBHOOK_AUTH_INSPECTION_BYTES = 1_048_576;

/**
 * Resolve `globalThis.fetch` at the moment of each outbound request — not at
 * module import, and not at factory call. Late resolution lets a polyfill
 * installed after `buildAgentSigningFetch` returns (but before first request)
 * still take effect. The helper throws a clear error on environments lacking
 * global `fetch` instead of binding `undefined` and failing cryptically inside
 * the signing pipeline.
 */
function defaultUpstream(): FetchLike {
  const f = (globalThis as { fetch?: FetchLike }).fetch;
  if (typeof f !== 'function') {
    throw new TypeError(
      'buildAgentSigningFetch: no upstream fetch provided and globalThis.fetch is unavailable. Pass `upstream: yourFetch` explicitly.'
    );
  }
  return f;
}

function bodyToUtf8(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body.length ? body : undefined;
  if (body instanceof Uint8Array) return Buffer.from(body).toString('utf8');
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString('utf8');
  // FormData / Blob / ReadableStream / async iterables fall through. Throw
  // rather than return `undefined` — a silent pass-through would ship the
  // request unsigned with no hint to the caller, defeating the seller's
  // `required_for` contract. Matches the strict posture of `createSigningFetch`
  // which also refuses unsupported body shapes.
  throw new TypeError(
    `buildAgentSigningFetch cannot extract an AdCP operation name from a body of type ${describeBody(body)}. The signer only supports string, Uint8Array, and ArrayBuffer bodies because the signature must cover the exact wire bytes.`
  );
}

function describeBody(body: unknown): string {
  if (body && typeof body === 'object') {
    const ctor = (body as { constructor?: { name?: string } }).constructor?.name;
    if (ctor) return ctor;
  }
  return typeof body;
}

/**
 * Extract the AdCP operation name from a JSON-RPC request body, if any.
 *
 * - MCP tool calls: `method === "tools/call"` → `params.name` is the op name.
 * - A2A send methods — `message/send` / `message/stream` (A2A 0.3) and
 *   `SendMessage` / `SendStreamingMessage` (A2A 1.0): the op name lives on
 *   the first data part as `data.skill`. A2A 0.3 tags that part
 *   `kind: "data"`; A2A 1.0 proto-JSON parts carry no `kind` at all.
 * - All other JSON-RPC methods (`initialize`, `tools/list`, notifications)
 *   return `undefined` — those are protocol-layer housekeeping, not AdCP
 *   operations subject to request-signing policy.
 *
 * Throws if the body is of a shape the signer can't read (Blob, FormData,
 * ReadableStream). The MCP / A2A SDKs both emit JSON strings today; a future
 * SDK version switching to streams would silently break signing otherwise.
 */
export function extractAdcpOperation(body: unknown): string | undefined {
  const text = bodyToUtf8(body);
  if (!text) return undefined;
  // The seller resolves the operation from the SAME rules (sole DataPart for
  // A2A, `params.name` for MCP), so the buyer never decides whether to sign on
  // the basis of a different Part than the seller will dispatch. A body the
  // seller treats as unresolvable has no operation here either.
  const operation = resolveRequestOperation({ rawBody: text, method: 'POST' });
  return typeof operation === 'string' ? operation : undefined;
}

/**
 * Detect webhook receiver credentials in the outbound JSON-RPC payload. The
 * verifier rejects unsigned requests carrying these credentials regardless of
 * the seller's operation-level capability advertisement, so the client must
 * sign them even while the capability cache is cold or silent for that op.
 * The scan is bounded; if the body exceeds the inspection budget, sign it.
 */
function carriesWebhookAuthentication(body: unknown): boolean {
  const text = bodyToUtf8(body);
  if (!text) return false;
  if (text.length > MAX_WEBHOOK_AUTH_INSPECTION_BYTES) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  return containsWebhookAuthentication(parsed);
}

/**
 * Decide whether an outbound AdCP call should be signed given the seller's
 * advertised capability block and the buyer's override list.
 *
 * Precedence matches the AdCP spec (`required_for` > `warn_for` >
 * `supported_for`):
 *   1. `always_sign` on the buyer config — pilot-time override, signs even
 *      if the seller hasn't listed the op.
 *   2. Seller `required_for` — seller rejects unsigned requests, MUST sign.
 *   3. Seller `warn_for` — shadow mode. Seller verifies when present and
 *      logs failures without rejecting; counterparties SHOULD sign so the
 *      seller can surface failure rates before flipping to `required_for`.
 *   4. Seller `supported_for` — sign only if the buyer opted in via
 *      `sign_supported: true` (defaults off).
 *
 * Returns false when the capability is unknown (cold cache) except for ops
 * in `always_sign`.
 */
export function shouldSignOperation(
  operation: string | undefined,
  capability: VerifierCapability | undefined,
  config: AgentRequestSigningConfig
): boolean {
  if (!operation) return false;
  if (config.always_sign?.includes(operation)) return true;
  if (!capability?.supported) return false;
  if (capability.required_for?.includes(operation)) return true;
  if (capability.warn_for?.includes(operation)) return true;
  if (config.sign_supported && capability.supported_for?.includes(operation)) return true;
  return false;
}

/**
 * Resolve the seller's content-digest policy into a concrete per-request
 * coverage decision.
 *
 * - `required` → must cover content-digest.
 * - `forbidden` → must NOT cover content-digest.
 * - `either` / absent → default to covering (body-binding is the safer
 *   choice; the seller has explicitly allowed both forms).
 */
export function resolveCoverContentDigest(policy: ContentDigestPolicy | undefined): boolean {
  if (policy === 'forbidden') return false;
  return true;
}

/**
 * Convert an inline `AgentRequestSigningConfig` into the `SignerKey` shape
 * expected by `signRequest` / `createSigningFetch`. Provider-backed configs
 * have no in-process key material — callers must route through
 * `createSigningFetchAsync(upstream, config.provider, ...)` instead.
 */
export function toSignerKey(config: AgentRequestSigningConfigInline): SignerKey {
  return {
    keyid: config.kid,
    alg: config.alg,
    privateKey: config.private_key as SignerKey['privateKey'],
  };
}

/** Experimental (AdCP 3.3): whether a signing config opts into the Web Bot Auth profile. */
export function isWebBotAuthSigningConfig(config: AgentRequestSigningConfig): boolean {
  return config.profile === WEB_BOT_AUTH_TAG;
}

/**
 * Experimental (AdCP 3.3): the Web Bot Auth signer for an opted-in config.
 * Validates at wire-up that `agent_url` is an HTTPS origin and that the
 * inline `kid` is the key's RFC 7638 thumbprint.
 */
export function toWebBotAuthSigner(config: AgentRequestSigningConfig): {
  signer: WebBotAuthSigner;
  agentOrigin: string;
} {
  const agentOrigin = webBotAuthOrigin(config.agent_url);
  if (isProviderSigningConfig(config)) {
    const provider = config.provider;
    if (!/^[A-Za-z0-9_-]{43}$/.test(provider.keyid)) {
      throw new TypeError("Web Bot Auth provider keyid must be the key's RFC 7638 thumbprint");
    }
    return {
      agentOrigin,
      signer: { keyid: provider.keyid, algorithm: provider.algorithm, sign: payload => provider.sign(payload) },
    };
  }
  const thumbprint = publicDirectoryKey(config.private_key as AdcpPrivateJwk).kid;
  if (config.kid !== thumbprint) {
    throw new TypeError(
      `Web Bot Auth request_signing.kid must be the key's RFC 7638 thumbprint (${thumbprint}); got '${config.kid}'`
    );
  }
  return { agentOrigin, signer: { privateKey: config.private_key as AdcpPrivateJwk, keyid: config.kid } };
}

type AdcpPrivateJwk = import('./types').AdcpJsonWebKey;

/**
 * Load the Web Bot Auth signer on first use, so RFC 9421-only clients never
 * pull the WBA signing modules into their eager graph. Configuration is
 * validated synchronously by {@link toWebBotAuthSigner}.
 */
function lazyWebBotAuthFetch(
  upstream: FetchLike,
  signer: WebBotAuthSigner,
  options: import('./wba/fetch').WebBotAuthSigningFetchOptions
): FetchLike {
  let wrapped: Promise<FetchLike> | undefined;
  return async (input, init) => {
    wrapped ??= import('./wba/fetch')
      .then(module => module.createWebBotAuthSigningFetch(upstream, signer, options))
      .catch(error => {
        wrapped = undefined; // a failed load is retried on the next request
        throw error;
      });
    return (await wrapped)(input, init);
  };
}

/**
 * Experimental (AdCP 3.3): sign every selected request under the configured
 * profile without consulting seller capabilities. Used for protocol-method
 * calls such as A2A `tasks/cancel`.
 */
export function buildDirectSigningFetch(upstream: FetchLike, signing: AgentRequestSigningConfig): FetchLike {
  if (isWebBotAuthSigningConfig(signing)) {
    const { signer, agentOrigin } = toWebBotAuthSigner(signing);
    return lazyWebBotAuthFetch(upstream, signer, { agentOrigin });
  }
  if (isProviderSigningConfig(signing)) return createSigningFetchAsync(upstream, signing.provider);
  return createSigningFetch(upstream, toSignerKey(signing));
}

/** Narrow predicate for the inline shape (kind absent or `'inline'`). */
export function isInlineSigningConfig(config: AgentRequestSigningConfig): config is AgentRequestSigningConfigInline {
  return config.kind !== 'provider';
}

/** Narrow predicate for the provider shape. */
export function isProviderSigningConfig(
  config: AgentRequestSigningConfig
): config is AgentRequestSigningConfigProvider {
  return config.kind === 'provider';
}

export interface BuildAgentSigningFetchOptions {
  /**
   * Upstream fetch to wrap. Defaults to `globalThis.fetch` when omitted —
   * use a Node 18+ / browser / worker global, or pass a polyfill / a
   * decorated fetch (retries, telemetry) to compose.
   */
  upstream?: FetchLike;
  signing: AgentRequestSigningConfig;
  /** Lazy accessor for the current cached capability — re-read on every call. */
  getCapability: () => CachedCapability | undefined;
  /** Trusted SDK/endpoint version pin; never inferred from the request body. */
  adcpVersion?: string;
}

/**
 * Build a fetch wrapper suitable for injection into MCP/A2A transports. On
 * every outbound request:
 *   1. Sign immediately when the payload carries webhook authentication.
 *   2. Extract the AdCP operation name from the JSON-RPC body (MCP tool-call
 *      or an A2A send method). Non-AdCP JSON-RPC methods (e.g., `initialize`)
 *      pass through unsigned.
 *   3. Consult the cached seller capability to decide whether to sign.
 *   4. Resolve the seller's content-digest policy into a per-request toggle.
 *   5. Delegate to `createSigningFetch` with the decision baked in.
 */
export function buildAgentSigningFetch(options: BuildAgentSigningFetchOptions): FetchLike {
  const { signing, getCapability } = options;
  // Resolve `globalThis.fetch` per-call when no explicit upstream was passed
  // so a polyfill installed between factory creation and first request still
  // takes effect. Eager resolution would freeze whatever was global at
  // factory-call time.
  const explicitUpstream = options.upstream;
  const upstream: FetchLike = explicitUpstream ?? ((input, init) => defaultUpstream()(input, init));

  const shouldSign = (_url: string, init: RequestInit | undefined): boolean => {
    if (carriesWebhookAuthentication(init?.body)) return true;
    const operation = extractAdcpOperation(init?.body);
    const entry = getCapability();
    return shouldSignOperation(operation, entry?.requestSigning, signing);
  };

  if (isWebBotAuthSigningConfig(signing)) {
    const { signer, agentOrigin } = toWebBotAuthSigner(signing);
    return lazyWebBotAuthFetch(upstream, signer, {
      agentOrigin,
      shouldSign,
      beforeSign: () => {
        // Omission of `profiles` means RFC 9421 only. Never downgrade a
        // configured Web Bot Auth identity to the deprecated profile.
        const profiles = getCapability()?.requestSigning?.profiles;
        if (!Array.isArray(profiles) || !profiles.includes(WEB_BOT_AUTH_TAG)) {
          throw new TypeError(
            "Seller does not advertise request-signing profile 'web-bot-auth'; automatic signing cannot downgrade the configured identity"
          );
        }
      },
    });
  }
  warnRfc9421ProfileDeprecated('signing');

  const binaryEncoding = requestSigningEncodingForVersion(options.adcpVersion ?? ADCP_VERSION);
  const coverContentDigest: CoverContentDigestPredicate = (_url, _init) => {
    if (binaryEncoding === 'rfc8941-base64') return true;
    const entry = getCapability();
    return resolveCoverContentDigest(entry?.requestSigning?.covers_content_digest);
  };

  if (isProviderSigningConfig(signing)) {
    // Freeze the provider's identity fields at factory time and pass a
    // snapshot view down to the async signer. TypeScript `readonly` on the
    // `SigningProvider` interface is compile-time only — if a downstream
    // adapter mutates `keyid`/`algorithm`/`fingerprint` between context
    // build and outbound request, the wire `keyid` would drift away from
    // the cache key the connection was bound to. The frozen view binds the
    // wire identity to the snapshot already used for cache routing.
    const frozen = freezeProviderIdentity(signing.provider);
    return createSigningFetchAsync(upstream, frozen, { shouldSign, coverContentDigest, binaryEncoding });
  }
  return createSigningFetch(upstream, toSignerKey(signing), { shouldSign, coverContentDigest, binaryEncoding });
}

function freezeProviderIdentity(provider: AgentRequestSigningConfigProvider['provider']) {
  const keyid = provider.keyid;
  const algorithm = provider.algorithm;
  const adcpUse = provider.adcpUse;
  const fingerprint = provider.fingerprint;
  return {
    keyid,
    algorithm,
    adcpUse,
    fingerprint,
    sign: (payload: Uint8Array) => provider.sign(payload),
  };
}

export interface CreateAgentSignedFetchOptions {
  /** This agent's RFC 9421 signing identity (kid, alg, private_key, agent_url). */
  signing: AgentRequestSigningConfig;
  /** Trusted endpoint pin used to select the 3.0/3.1 or 3.2 request profile. */
  adcpVersion?: string;
  /**
   * Target seller's `agent_uri` — the base URL whose `get_adcp_capabilities`
   * response gates whether each operation gets signed. The preset keys a
   * capability-cache entry off this URL so repeat calls reuse the same
   * advertisement.
   *
   * For multi-seller buyers, build one signed fetch per seller (or use
   * {@link buildAgentSigningFetch} directly and supply your own
   * `getCapability` that dispatches on the target URL).
   */
  sellerAgentUri: string;
  /**
   * Optional auth token the seller expects alongside the signing headers.
   * Included in the capability cache key so a token rotation naturally
   * invalidates the cached advertisement.
   */
  sellerAuthToken?: string;
  /**
   * Capability cache. Defaults to the shared {@link defaultCapabilityCache}.
   *
   * **The shared default is load-bearing.** `ProtocolClient` and
   * `buildAgentSigningContext` write the seller's `get_adcp_capabilities`
   * response into `defaultCapabilityCache`; this preset reads from the same
   * instance so a single priming call serves every subsequent signing
   * decision. Passing a fresh `new CapabilityCache()` here without also
   * priming it will silently disable `required_for` enforcement: cold cache
   * → `shouldSignOperation` returns `false` → every required op ships
   * unsigned → seller rejects. The SDK emits no error on this path because
   * "decided not to sign" is the spec-correct behavior on a cold cache.
   *
   * Pass an explicit cache only when you've also primed it — call
   * {@link ensureCapabilityLoaded} against your cache instance after
   * construction, or seed it via `cache.set(buildCapabilityCacheKey(uri,
   * token, fingerprint, adcpVersion), entry)` — or when you genuinely want each caller to re-fetch
   * the seller's capability block.
   *
   * Note: the cache stores **public** seller capability advertisements
   * (the contents of `get_adcp_capabilities` responses), not buyer
   * credentials. The shared default is not a multi-tenant security
   * boundary — different sellers, different auth tokens, and different
   * signing keys already get separate entries via
   * {@link buildCapabilityCacheKey}.
   */
  cache?: CapabilityCache;
  /** Upstream fetch. Defaults to `globalThis.fetch`. */
  upstream?: FetchLike;
}

/**
 * One-call preset for the single-seller case: bundles
 * {@link buildAgentSigningFetch} with a {@link CapabilityCache} lookup keyed
 * by `sellerAgentUri`, so adapter authors don't have to wire the cache and
 * capability accessor themselves.
 *
 * ```ts
 * // fetch.ts
 * import { createAgentSignedFetch } from '@adcp/sdk/signing';
 *
 * export const signedFetch = createAgentSignedFetch({
 *   signing: {
 *     kid: 'my-agent-2026',
 *     alg: 'ed25519',
 *     private_key: JSON.parse(process.env.ADCP_PRIV_KEY!),
 *     agent_url: 'https://agent.example.com',
 *   },
 *   sellerAgentUri: 'https://seller.example.com',
 * });
 * ```
 *
 * ```ts
 * // any other module
 * import { signedFetch } from './fetch';
 *
 * await signedFetch('https://seller.example.com/mcp', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify(payload),
 * });
 * ```
 *
 * Signing only happens on operations the seller advertises as
 * `required_for` / `warn_for` (or `supported_for` when the buyer config
 * opts in) — so the `get_adcp_capabilities` priming call itself is always
 * unsigned, as the spec requires.
 *
 * For multi-seller adapters, construct one preset per seller, or use
 * {@link buildAgentSigningFetch} directly with a request-dispatching
 * `getCapability` callback.
 */
export function createAgentSignedFetch(options: CreateAgentSignedFetchOptions): FetchLike {
  const cache = options.cache ?? defaultCapabilityCache;
  const adcpVersion = options.adcpVersion ?? ADCP_VERSION;
  const cacheKey = buildCapabilityCacheKey(options.sellerAgentUri, options.sellerAuthToken, undefined, adcpVersion);
  return buildAgentSigningFetch({
    signing: options.signing,
    upstream: options.upstream,
    getCapability: () => cache.get(cacheKey),
    adcpVersion,
  });
}
