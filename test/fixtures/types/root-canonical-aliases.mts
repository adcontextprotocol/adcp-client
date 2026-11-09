// Compiled by test/lib/runtime-subpaths.test.js. The `.ts` twin of this file
// resolves the `require` declarations; this `.mts` copy resolves the `import`
// (`.d.mts`) ones.
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
