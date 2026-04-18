export type ContentDigestPolicy = 'required' | 'forbidden' | 'either';

export interface VerifierCapability {
  supported: boolean;
  covers_content_digest: ContentDigestPolicy;
  required_for: string[];
  supported_for?: string[];
}

export interface AdcpJsonWebKey {
  kid: string;
  kty: string;
  crv?: string;
  alg?: string;
  use?: string;
  key_ops?: string[];
  adcp_use?: string;
  x?: string;
  y?: string;
  [extra: string]: unknown;
}

export interface RevocationSnapshot {
  issuer: string;
  updated: string;
  next_update: string;
  revoked_kids: string[];
  revoked_jtis: string[];
}

export interface VerifiedSigner {
  keyid: string;
  agent_url?: string;
  verified_at: number;
}

export const REQUEST_SIGNING_TAG = 'adcp/request-signing/v1';
export const ALLOWED_ALGS = new Set(['ed25519', 'ecdsa-p256-sha256']);
export const MAX_SIGNATURE_WINDOW_SECONDS = 300;
export const CLOCK_SKEW_TOLERANCE_SECONDS = 60;
export const MANDATORY_COMPONENTS: ReadonlyArray<string> = ['@method', '@target-uri', '@authority'];
