import type { HttpProbeResult } from '../types';

export type OAuthMetadataGraphErrorCode =
  | 'oauth_protected_resource_metadata_unavailable'
  | 'oauth_protected_resource_metadata_invalid'
  | 'oauth_resource_mismatch'
  | 'oauth_authorization_servers_empty'
  | 'oauth_authorization_server_url_invalid'
  | 'oauth_authorization_server_metadata_unavailable'
  | 'oauth_authorization_server_metadata_invalid'
  | 'oauth_issuer_mismatch'
  | 'oauth_endpoint_url_invalid'
  | 'oauth_endpoint_unreachable'
  | 'oauth_jwks_unavailable'
  | 'oauth_fetch_blocked'
  | 'oauth_graph_limit_exceeded';

export interface OAuthMetadataGraphObservation {
  kind:
    | 'protected_resource_metadata'
    | 'authorization_server_metadata'
    | 'authorization_endpoint'
    | 'token_endpoint'
    | 'jwks_uri';
  url: string;
  status: number;
  authorization_server_index?: number;
}

export interface OAuthMetadataGraphFinding {
  code: OAuthMetadataGraphErrorCode;
  message: string;
  url?: string;
  field?: string;
  authorization_server_index?: number;
}

export interface OAuthMetadataGraphGrade {
  success: boolean;
  protected_resource_url: string;
  protected_resource_result: HttpProbeResult;
  observations: OAuthMetadataGraphObservation[];
  findings: OAuthMetadataGraphFinding[];
  error_code?: OAuthMetadataGraphErrorCode;
  error?: string;
  total_requests: number;
  total_response_bytes: number;
}

export interface OAuthMetadataFetchResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  connectedPeerAddress?: string;
}

export interface OAuthMetadataFetchTransport {
  fetch(url: string, options: { signal: AbortSignal; maxBodyBytes: number }): Promise<OAuthMetadataFetchResponse>;
}
