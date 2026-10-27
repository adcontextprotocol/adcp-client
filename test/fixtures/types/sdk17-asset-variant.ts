import type { z } from 'zod';
import { AssetVariantSchema } from '../../../dist/lib/schemas/index.js';
import type { AssetVariant } from '../../../dist/lib/types/sync-creatives.js';
import type { AssetVariant as RootAsset } from '../../../dist/lib/index.js';
import type { AssetVariant as TypesAsset } from '../../../dist/lib/types/index.js';
import type { AssetVariant as SchemaAsset } from '../../../dist/lib/schemas/index.js';

declare const parsed: z.output<typeof AssetVariantSchema>;
const perTool: AssetVariant = parsed;
const root: RootAsset = perTool;
const types: TypesAsset = root;
const schema: SchemaAsset = types;
const roundTrip: AssetVariant = schema;
void [parsed, perTool, root, types, schema, roundTrip];
