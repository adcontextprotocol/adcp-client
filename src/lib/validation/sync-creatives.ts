import { z } from 'zod';
import {
  AccountSchema,
  CreativeStatusSchema,
  ErrorSchema,
  ContextObjectSchema,
  ExtensionObjectSchema,
  SyncCreativesErrorSchema,
  SyncCreativesSubmittedSchema,
} from '../types/schemas.generated';

export const SyncCreativesActionSchema = z.union([
  z.literal('created'),
  z.literal('updated'),
  z.literal('unchanged'),
  z.literal('failed'),
  z.literal('deleted'),
]);

const ASSIGNMENT_ERROR_KEY = /^[a-zA-Z0-9_-]+$/;

const HttpUrlSchema = z
  .string()
  .url()
  .refine((v) => /^https?:\/\//i.test(v), {
    message: "URL must use http(s) scheme",
  });

export const SyncCreativesItemSchema = z
  .object({
    creative_id: z.string(),
    action: SyncCreativesActionSchema,
    account: AccountSchema.optional(),
    status: CreativeStatusSchema.optional(),
    platform_id: z.string().optional(),
    changes: z.array(z.string()).optional(),
    errors: z.array(ErrorSchema).optional(),
    warnings: z.array(z.string()).optional(),
    preview_url: HttpUrlSchema.optional(),
    expires_at: z.string().datetime({ offset: true }).optional(),
    assigned_to: z.array(z.string()).optional(),
    assignment_errors: z
      .record(
        z.string().regex(ASSIGNMENT_ERROR_KEY, 'assignment_errors key must match ^[a-zA-Z0-9_-]+$'),
        z.string(),
      )
      .optional(),
  })
  .passthrough()
  .superRefine((item, ctx) => {
    // Spec: when action ∈ {failed, deleted}, `status` MUST be absent.
    if ((item.action === 'failed' || item.action === 'deleted') && item.status !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: `status must be omitted when action is '${item.action}'`,
      });
    }
  });

export type SyncCreativesItem = z.infer<typeof SyncCreativesItemSchema>;

export const SyncCreativesSuccessStrictSchema = z
  .object({
    dry_run: z.boolean().optional(),
    creatives: z.array(SyncCreativesItemSchema),
    sandbox: z.boolean().optional(),
    context: ContextObjectSchema.optional(),
    ext: ExtensionObjectSchema.optional(),
  })
  .passthrough();

export type SyncCreativesSuccessStrict = z.infer<typeof SyncCreativesSuccessStrictSchema>;

/**
 * Strict response schema for sync_creatives.
 *
 * The generated `SyncCreativesResponseSchema` degrades `creatives[]` to
 * `z.array(z.record(z.string(), z.unknown()))` because the upstream JSON
 * Schema inlines the item shape without a named $ref. This schema supplies
 * the per-item shape (creative_id + action required, plus the spec's
 * conditional that forbids `status` on failed/deleted items) so strict
 * response validation catches per-item drift at the SDK boundary.
 */
export const SyncCreativesResponseStrictSchema = z.union([
  SyncCreativesSuccessStrictSchema,
  SyncCreativesErrorSchema,
  SyncCreativesSubmittedSchema,
]);
