/**
 * Forward-compat narrow access for `identity.brand_json_url` and the
 * surrounding fields from a `get_adcp_capabilities` response. The field
 * lands in the spec as a typed property in 3.1's additive minor (PR
 * adcontextprotocol/adcp#3690); 3.0.5 already accepts it on the wire by
 * relaxing `identity.additionalProperties` to `true`, but the generated
 * TS surface won't include it until codegen runs against a release that
 * declares it as a typed property. This file bridges the gap on both
 * sides:
 *
 *   - **Verifier side**: `readBrandJsonUrl(caps)` peels the field out of
 *     an unknown payload without forcing the caller into `as any`.
 *   - **Publisher side**: TS sellers constructing their capabilities
 *     response in 3.0.5+ can spread `IdentityPosture` over the generated
 *     `identity` shape to set `brand_json_url` without losing types on
 *     the rest of the block:
 *
 *       ```ts
 *       import type { IdentityPosture } from '@adcp/sdk/signing/server';
 *       const identity: IdentityPosture = {
 *         per_principal_key_isolation: true,
 *         key_origins: { request_signing: 'https://keys.example.com' },
 *         brand_json_url: 'https://example.com/.well-known/brand.json',
 *       };
 *       return { adcp: {...}, identity, ... };
 *       ```
 *
 * This file goes away — replaced by the generated type — when the SDK's
 * schema pin moves to a release that includes the field as a typed
 * property.
 */

import type { GetAdCPCapabilitiesResponse } from '../../types/tools.generated';

export type IdentityKeyOriginPurpose = 'governance_signing' | 'request_signing' | 'webhook_signing' | 'tmp_signing';

export interface IdentityKeyOrigins {
  governance_signing?: string;
  request_signing?: string;
  webhook_signing?: string;
  tmp_signing?: string;
}

export interface IdentityPosture {
  per_principal_key_isolation?: boolean;
  key_origins?: IdentityKeyOrigins;
  compromise_notification?: { emits?: boolean; accepts?: boolean };
  brand_json_url?: string;
}

export type CapabilitiesWithBrandJsonUrl = GetAdCPCapabilitiesResponse & {
  identity?: IdentityPosture;
};

export function readIdentityPosture(caps: unknown): IdentityPosture | undefined {
  if (!caps || typeof caps !== 'object') return undefined;
  const identity = (caps as { identity?: unknown }).identity;
  if (!identity || typeof identity !== 'object') return undefined;
  return identity as IdentityPosture;
}

export function readBrandJsonUrl(caps: unknown): string | undefined {
  const identity = readIdentityPosture(caps);
  const value = identity?.brand_json_url;
  return typeof value === 'string' ? value : undefined;
}
