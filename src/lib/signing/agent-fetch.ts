import type { AgentRequestSigningConfig } from '../types/adcp';
import { createSigningFetch, type CoverContentDigestPredicate } from './fetch';
import type { CachedCapability, CapabilityCache } from './capability-cache';
import type { ContentDigestPolicy, VerifierCapability } from './types';
import type { SignerKey } from './signer';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function bodyToUtf8(body: unknown): string | undefined {
  if (typeof body === 'string') return body.length ? body : undefined;
  if (body instanceof Uint8Array) return Buffer.from(body).toString('utf8');
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString('utf8');
  return undefined;
}

/**
 * Extract the AdCP operation name from a JSON-RPC request body, if any.
 *
 * - MCP tool calls: `method === "tools/call"` → `params.name` is the op name.
 * - A2A `message/send` / `message/stream`: the op name lives on the first
 *   data-kind part as `data.skill`.
 * - All other JSON-RPC methods (`initialize`, `tools/list`, notifications)
 *   return `undefined` — those are protocol-layer housekeeping, not AdCP
 *   operations subject to request-signing policy.
 */
export function extractAdcpOperation(body: unknown): string | undefined {
  const text = bodyToUtf8(body);
  if (!text) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const rpc = parsed as { method?: unknown; params?: unknown };

  if (rpc.method === 'tools/call') {
    const params = rpc.params as { name?: unknown } | undefined;
    return typeof params?.name === 'string' ? params.name : undefined;
  }

  if (rpc.method === 'message/send' || rpc.method === 'message/stream') {
    const params = rpc.params as { message?: { parts?: unknown } } | undefined;
    const parts = params?.message?.parts;
    if (!Array.isArray(parts)) return undefined;
    for (const part of parts) {
      if (part && typeof part === 'object') {
        const p = part as { kind?: unknown; data?: { skill?: unknown } };
        if (p.kind === 'data' && typeof p.data?.skill === 'string') {
          return p.data.skill;
        }
      }
    }
  }

  return undefined;
}

/**
 * Decide whether an outbound AdCP call should be signed given the seller's
 * advertised capability block and the buyer's override list.
 *
 * Precedence:
 *   1. `always_sign` on the buyer config — pilot-time override, signs even
 *      if the seller hasn't listed the op.
 *   2. Seller `required_for` — seller rejects unsigned requests, MUST sign.
 *   3. Seller `supported_for` — sign only if the buyer opted in via
 *      `sign_supported: true`.
 *
 * Returns false when the capability is unknown (cold cache) except for ops
 * in `always_sign`, so the priming `get_adcp_capabilities` call itself is
 * never signed.
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
 * Convert an `AgentRequestSigningConfig` into the `SignerKey` shape expected
 * by `signRequest` / `createSigningFetch`.
 */
export function toSignerKey(config: AgentRequestSigningConfig): SignerKey {
  return {
    keyid: config.kid,
    alg: config.alg,
    privateKey: config.private_key as SignerKey['privateKey'],
  };
}

export interface BuildAgentSigningFetchOptions {
  upstream: FetchLike;
  signing: AgentRequestSigningConfig;
  /** Lazy accessor for the current cached capability — re-read on every call. */
  getCapability: () => CachedCapability | undefined;
}

/**
 * Build a fetch wrapper suitable for injection into MCP/A2A transports. On
 * every outbound request:
 *   1. Extract the AdCP operation name from the JSON-RPC body (MCP tool-call
 *      or A2A message/send). Non-AdCP JSON-RPC methods (e.g., `initialize`)
 *      pass through unsigned.
 *   2. Consult the cached seller capability to decide whether to sign.
 *   3. Resolve the seller's content-digest policy into a per-request toggle.
 *   4. Delegate to `createSigningFetch` with the decision baked in.
 */
export function buildAgentSigningFetch(options: BuildAgentSigningFetchOptions): FetchLike {
  const { upstream, signing, getCapability } = options;
  const key = toSignerKey(signing);

  const shouldSign = (_url: string, init: RequestInit | undefined): boolean => {
    const operation = extractAdcpOperation(init?.body);
    const entry = getCapability();
    return shouldSignOperation(operation, entry?.requestSigning, signing);
  };

  const coverContentDigest: CoverContentDigestPredicate = (_url, _init) => {
    const entry = getCapability();
    return resolveCoverContentDigest(entry?.requestSigning?.covers_content_digest);
  };

  return createSigningFetch(upstream, key, { shouldSign, coverContentDigest });
}
