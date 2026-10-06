import { z } from 'zod';
import type { AgentOAuthClientCredentials } from '../../types/adcp';

/**
 * OAuth client credentials configuration shape. Secret references remain
 * unresolved; endpoint transport and SSRF checks run during token exchange.
 */
export const AgentOAuthClientCredentialsSchema = z.object({
  token_endpoint: z.string().url(),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  scope: z.string().optional(),
  resource: z.union([z.string(), z.array(z.string())]).optional(),
  audience: z.string().optional(),
  auth_method: z.enum(['basic', 'body']).optional(),
}) satisfies z.ZodType<AgentOAuthClientCredentials>;
