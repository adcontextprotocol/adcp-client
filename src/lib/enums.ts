// Lean, zero-dependency entry point for AdCP enum value arrays.
//
// Both re-exported modules are pure `as const` string-literal arrays with no
// imports (codegen output), so importing from `@adcp/sdk/enums` pulls in only
// the arrays a consumer names: no `./types` barrel, no zod. This is the safe
// entry for zod-free consumers (e.g. browser bundles) that want an AdCP enum
// as their single source of truth.
//
//   import { EventTypeValues } from '@adcp/sdk/enums';
//
// enums.generated exposes `NameValues` arrays for named string-literal unions;
// inline-enums.generated exposes `Parent_PropertyValues` arrays for anonymous
// per-field unions.
export * from './types/enums.generated';
export * from './types/inline-enums.generated';
