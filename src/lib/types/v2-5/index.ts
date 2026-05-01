// AdCP v2.5 type surface — re-export the generated request/response
// interfaces so consumers can import them as a namespace:
//
//   import * as V25 from '@adcp/sdk/types/v2-5';
//   const req: V25.CreateMediaBuyRequest = ...;
//
// Or by name:
//
//   import type { CreateMediaBuyRequest } from '@adcp/sdk/types/v2-5';
//
// The generated file is the source of truth; refresh by running
// `npm run sync-schemas:v2.5 && npm run generate-types:v2.5`.

export * from './tools.generated';
