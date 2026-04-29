# @adcp/client

> This package has been renamed to [`@adcp/sdk`](https://www.npmjs.com/package/@adcp/sdk).
>
> `@adcp/client` continues to publish as a thin re-export of `@adcp/sdk` so existing installs keep working without code changes. New projects should install `@adcp/sdk` directly.

## Migration

```diff
- npm install @adcp/client
+ npm install @adcp/sdk
```

```diff
- import { AdcpClient } from '@adcp/client';
+ import { AdcpClient } from '@adcp/sdk';
```

All subpaths (`/client`, `/server`, `/compliance`, `/testing`, `/conformance`, `/signing`, etc.) are available under the new name with identical APIs.

## Why the rename

`@adcp/client` ships three distinct surfaces — a buyer-side client, a server builder, and a compliance harness. The new name and `/client` `/server` `/compliance` subpaths make that shape explicit.

## Versioning

`@adcp/client` and `@adcp/sdk` are version-linked via the repo's changeset config — both packages release at the same number on every cut, and the shim's `dependencies."@adcp/sdk"` covers the published range so npm dedupes consumers' trees that pull both names.

## Troubleshooting

**`@adcp/client could not locate @adcp/sdk`** — the CLI delegator calls `require.resolve('@adcp/sdk/package.json')` and fails when `@adcp/sdk` is missing from the install tree. Most common with `npm install --legacy-peer-deps` or Yarn classic with `nohoist` skipping the peer auto-install. Resolve by running `npm install @adcp/sdk` alongside, or by removing the `--legacy-peer-deps` flag if it's not load-bearing for the rest of your tree.

## Deprecation timeline

- **5.x line (now):** soft-deprecated. `@adcp/client` continues to publish as a re-export of `@adcp/sdk`. Every release is auto-deprecated on the npm registry so `npm install` shows the rename pointer; the package still works without code changes. New features ship to `@adcp/sdk` only — the shim never gains capability.
- **6.0 (next major):** hard-deprecated. Final release of `@adcp/client` ships under 5.x; 6.0 publishes as `@adcp/sdk` only. Consumers who haven't migrated by then need to swap their imports before bumping major.
- **Removal signal:** `@adcp/sdk` weekly downloads sustained above `@adcp/client` for two consecutive months. We post the removal date 90 days in advance on the GitHub repo before stopping shim publishes.

The shim is intentionally minimal so this timeline can hold without surprise — there's nothing in `packages/client-shim/` that diverges from `@adcp/sdk` semantically. If you're reading this and want the migration to take a long weekend, the change is `s/@adcp\/client/@adcp\/sdk/g` across imports plus a single dependency swap in `package.json`.
