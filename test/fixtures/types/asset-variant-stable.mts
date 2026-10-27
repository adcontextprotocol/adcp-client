import type { z } from 'zod';
import { AssetVariantSchema } from '@adcp/sdk/schemas';
import type { AssetVariant } from '@adcp/sdk/types/sync-creatives';
import type { AssetVariant as RootAsset } from '@adcp/sdk';
import type { AssetVariant as TypesAsset } from '@adcp/sdk/types';
import type { AssetVariant as SchemaAsset } from '@adcp/sdk/schemas';
declare const parsed: z.output<typeof AssetVariantSchema>;
const asset: AssetVariant = parsed;
const root: RootAsset = asset;
const types: TypesAsset = root;
const schema: SchemaAsset = types;
const roundTrip: AssetVariant = schema;
const options: readonly z.ZodType[] = AssetVariantSchema.options;
void [parsed, asset, root, types, schema, roundTrip, options];

const imageShape = AssetVariantSchema.options[0].shape;
declare const unknownValue: unknown;
// @ts-expect-error The stable asset input remains typed rather than unknown.
const input: z.input<typeof AssetVariantSchema> = unknownValue;
void [imageShape, input];
