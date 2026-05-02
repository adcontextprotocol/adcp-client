/**
 * Forward-compat narrow access for `identity.brand_json_url` and the
 * surrounding fields from a `get_adcp_capabilities` response. The field
 * lands in the spec's next minor (3.x, additive — see PR
 * adcontextprotocol/adcp#3690); generated types catch up on the next
 * schema bump. Until then we read it as an optional string from
 * structurally-typed access, so the resolver can run today against any
 * 3.x agent that has opted into the field per the spec's forward-compat
 * note (security.mdx §"Adopting `brand_json_url` while pinned to AdCP
 * 3.0"). This file goes away — replaced by the generated type — when
 * the SDK's schema pin moves to a release that includes the field.
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
