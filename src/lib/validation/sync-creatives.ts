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

export const SyncCreativesActionSchema = /* @__PURE__ */ (() =>
  z.union([
    z.literal('created'),
    z.literal('updated'),
    z.literal('unchanged'),
    z.literal('failed'),
    z.literal('deleted'),
  ]))();

const ASSIGNMENT_ERROR_KEY = /^[a-zA-Z0-9_-]+$/;

const HttpUrlSchema = /* @__PURE__ */ (() =>
  z
    .string()
    .url()
    .refine(v => /^https?:\/\//i.test(v), {
      message: 'URL must use http(s) scheme',
    }))();

// Explicit shapes keep declaration emit pointing at the generated schema
// module. Inferred types make TypeScript re-name nested generated types
// through the root barrel, whose declarations reach Node-only packages and
// would leak into `@adcp/sdk/schemas/browser`. `satisfies` on each object
// literal keeps the shape in sync with the runtime schema.
type SyncCreativesItemShape = {
  creative_id: z.ZodString;
  revision_id: z.ZodOptional<typeof CreativeRevisionIDSchema>;
  action: typeof SyncCreativesActionSchema;
  account: z.ZodOptional<typeof AccountSchema>;
  status: z.ZodOptional<typeof CreativeStatusSchema>;
  platform_id: z.ZodOptional<z.ZodString>;
  localization: z.ZodOptional<typeof CreativeLocalizationReadbackSchema>;
  changes: z.ZodOptional<z.ZodArray<z.ZodString>>;
  errors: z.ZodOptional<z.ZodArray<typeof ErrorSchema>>;
  warnings: z.ZodOptional<z.ZodArray<z.ZodString>>;
  macro_resolution_results: z.ZodOptional<z.ZodArray<typeof MacroResolutionResultSchema>>;
  preview_url: z.ZodOptional<z.ZodString>;
  expires_at: z.ZodOptional<z.ZodString>;
  assigned_to: z.ZodOptional<z.ZodArray<z.ZodString>>;
  assignment_errors: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
};

type SyncCreativesSuccessStrictShape = {
  dry_run: z.ZodOptional<z.ZodBoolean>;
  creatives: z.ZodArray<typeof SyncCreativesItemSchema>;
  sandbox: z.ZodOptional<z.ZodBoolean>;
  context: z.ZodOptional<typeof ContextObjectSchema>;
  ext: z.ZodOptional<typeof ExtensionObjectSchema>;
};

export const SyncCreativesItemSchema: z.ZodObject<SyncCreativesItemShape, z.core.$loose> = /* @__PURE__ */ (() =>
  z
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
    } satisfies SyncCreativesItemShape)
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
    }))();

export type SyncCreativesItem = z.infer<typeof SyncCreativesItemSchema>;

export const SyncCreativesSuccessStrictSchema: z.ZodObject<SyncCreativesSuccessStrictShape, z.core.$loose> =
  /* @__PURE__ */ (() =>
    z
      .object({
        dry_run: z.boolean().optional(),
        creatives: z.array(SyncCreativesItemSchema),
        sandbox: z.boolean().optional(),
        context: ContextObjectSchema.optional(),
        ext: ExtensionObjectSchema.optional(),
      } satisfies SyncCreativesSuccessStrictShape)
      .passthrough())();

export type SyncCreativesSuccessStrict = z.infer<typeof SyncCreativesSuccessStrictSchema>;

/**
 * Strict response schema for sync_creatives.
 *
 * This hand-authored strict projection preserves the beta.9 per-item fields
 * and the cross-field conditions that TypeScript-to-Zod generation cannot
 * express: failed/deleted rows omit lifecycle state, and localization
 * readback requires an enclosing creative status.
 */
export const SyncCreativesResponseStrictSchema: z.ZodUnion<
  readonly [
    typeof SyncCreativesSuccessStrictSchema,
    typeof SyncCreativesErrorSchema,
    typeof SyncCreativesSubmittedSchema,
  ]
> = /* @__PURE__ */ (() =>
  z.union([SyncCreativesSuccessStrictSchema, SyncCreativesErrorSchema, SyncCreativesSubmittedSchema]))();
