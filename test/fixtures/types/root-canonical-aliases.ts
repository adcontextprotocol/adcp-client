// Compiled by test/lib/runtime-subpaths.test.js, together with its `.mts` twin
// (which resolves the ESM `.d.mts` declarations).
//
// The root's `CreateMediaBuyRequest`, `Product` and `PackageRequest` are the
// canonical aliases from `@adcp/sdk/v2/projection`; `@adcp/sdk/types` exports
// different shapes under the same names. A caller who moves an import between
// entry points must not get a different type silently, so the root aliases are
// pinned here (adcontextprotocol/adcp-client#3664).
import type { CreateMediaBuyRequest, PackageRequest, Product } from '@adcp/sdk';
import type {
  CanonicalCreateMediaBuyRequest,
  CanonicalPackageRequest,
  CanonicalProduct,
} from '@adcp/sdk/v2/projection';

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function assertType<T extends true>(): T | void {}

assertType<Equals<CreateMediaBuyRequest, CanonicalCreateMediaBuyRequest>>();
assertType<Equals<Product, CanonicalProduct>>();
assertType<Equals<PackageRequest, CanonicalPackageRequest>>();
