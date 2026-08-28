import { z } from 'zod';
import {
  AccountSchema,
  CreativeStatusSchema,
  ErrorSchema,
  ContextObjectSchema,
  CreativeLocalizationReadbackSchema,
  CreativeRevisionIDSchema,
  ExtensionObjectSchema,
  MacroResolutionResultSchema,
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
  .refine(v => /^https?:\/\//i.test(v), {
    message: 'URL must use http(s) scheme',
  });

export const SyncCreativesItemSchema = z
  .object({
    creative_id: z.string(),
    revision_id: CreativeRevisionIDSchema.optional(),
    action: SyncCreativesActionSchema,
    account: AccountSchema.optional(),
    status: CreativeStatusSchema.optional(),
    platform_id: z.string().optional(),
    localization: CreativeLocalizationReadbackSchema.optional(),
    changes: z.array(z.string()).optional(),
    errors: z.array(ErrorSchema).optional(),
    warnings: z.array(z.string()).optional(),
    macro_resolution_results: z.array(MacroResolutionResultSchema).optional(),
    preview_url: HttpUrlSchema.optional(),
    expires_at: z.string().datetime({ offset: true }).optional(),
    assigned_to: z.array(z.string()).optional(),
    assignment_errors: z
      .record(z.string().regex(ASSIGNMENT_ERROR_KEY, 'assignment_errors key must match ^[a-zA-Z0-9_-]+$'), z.string())
      .optional(),
  })
  .passthrough()
  .superRefine((item, ctx) => {
    // Spec: failed/deleted items have no review, localization, or revision state.
    if (item.action === 'failed' || item.action === 'deleted') {
      for (const field of ['status', 'localization', 'revision_id'] as const) {
        if (item[field] !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `${field} must be omitted when action is '${item.action}'`,
          });
        }
      }
    }

    if (item.localization !== undefined && item.status === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: 'status is required when localization is present',
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
 * This hand-authored strict projection preserves the beta.9 per-item fields
 * and the cross-field conditions that TypeScript-to-Zod generation cannot
 * express: failed/deleted rows omit lifecycle state, and localization
 * readback requires an enclosing creative status.
 */
export const SyncCreativesResponseStrictSchema = z.union([
  SyncCreativesSuccessStrictSchema,
  SyncCreativesErrorSchema,
  SyncCreativesSubmittedSchema,
]);
