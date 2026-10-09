import { OAuthClientInformationSchema } from '@modelcontextprotocol/sdk/shared/auth.js';
import { z } from 'zod';
import type { PendingWebFlow } from './web-flow';

const persistedDate = z.iso
  .datetime({ offset: true })
  .transform(value => new Date(value))
  .pipe(z.date());

// Exhaustive even for optional fields: adding a PendingWebFlow member must also
// update persistence validation. Unknown fields remain intact across SDK versions.
const pendingWebFlowShape = {
  state: z.string(),
  agentId: z.string(),
  agentUrl: z.string(),
  codeVerifier: z.string(),
  redirectUri: z.string(),
  resource: z.string().optional(),
  resourceOverride: z.string().optional(),
  resourceOverrideAction: z.enum(['set', 'clear']).optional(),
  resourceOverrideSnapshot: z.string().nullable().optional(),
  scope: z.string().optional(),
  authorizationServerUrl: z.string(),
  authorizationServerIssuer: z.string().optional(),
  // The MCP schema strips extensions and catches invalid issuer values. Stored
  // credentials must retain extensions and reject a malformed issuer instead.
  clientInformation: OAuthClientInformationSchema.extend({ issuer: z.string().optional() }).loose(),
  createdAt: persistedDate,
  expiresAt: persistedDate,
  carry: z.record(z.string(), z.unknown()).optional(),
} satisfies { [K in keyof PendingWebFlow]-?: z.ZodType<PendingWebFlow[K]> };

type Assert<T extends true> = T;
type NarrowedFields = {
  [K in keyof PendingWebFlow]-?: PendingWebFlow[K] extends z.output<(typeof pendingWebFlowShape)[K]> ? never : K;
}[keyof PendingWebFlow];
// Also reject schemas narrower than the interface (e.g. requiring optional fields).
type _PendingWebFlowSchemaParity = Assert<NarrowedFields extends never ? true : false>;

const persistedPendingWebFlowSchema = z.looseObject(pendingWebFlowShape);

/**
 * Serialize a pending flow for a durable store, preserving unknown fields.
 * Throws for malformed SDK fields or JSON.stringify failures. The payload
 * contains PKCE/client secrets; the store owns encryption, TTL and atomic consume.
 */
export function serializePendingWebFlow(flow: PendingWebFlow): string {
  const json = JSON.stringify(flow);
  if (!parsePendingWebFlow(json)) throw new TypeError('Invalid PendingWebFlow payload');
  return json;
}

/**
 * Validate a JSON string or decoded JSON value (e.g. PostgreSQL jsonb), and revive
 * createdAt/expiresAt as Dates. Unknown fields (including client metadata)
 * pass through unchanged. Malformed input
 * returns null. Expiry and issuer trust are enforced by the store/callback,
 * not by this parser; legacy rows without a frozen issuer remain parseable.
 * The store must also bind the parsed state to the key it consumed.
 */
export function parsePendingWebFlow(json: unknown): PendingWebFlow | null {
  try {
    const parsed = persistedPendingWebFlowSchema.safeParse(typeof json === 'string' ? JSON.parse(json) : json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
