---
'@adcp/sdk': patch
---

Stop trying to publish `@adcp/client` (the deprecated compat shim).

Background: `@adcp/client` was the legacy package name; v6.0 renamed it to `@adcp/sdk` and the shim re-exported the new package. The 6.0.0 publish attempt left `@adcp/client@6.0.0`'s npm version slot in a "burned" state (visibility removed but slot reserved), so every subsequent release workflow fails with `Cannot publish over previously published version "6.0.0"` — even though the SDK publish succeeds. The release workflow then exits with code 1 because of the shim failure, even on otherwise-clean releases.

Two surgical changes to stop the bleeding:

1. **`packages/client-shim/package.json` → `private: true`.** Source stays in-tree for historical reference; npm publish flow now ignores the package entirely.
2. **`.changeset/config.json`**: removed the `@adcp/sdk ↔ @adcp/client` linked-version pair (forced lock-step bumps that the npm registry rejected) and added `@adcp/client` to the `ignore` list so changesets stops generating release entries for it.

Operator action (not part of this PR): run `npm deprecate @adcp/client "Renamed to @adcp/sdk in v6.0. Install @adcp/sdk@^6.1.0 instead."` to land a deprecation banner on the existing `@adcp/client` versions still on npm. Adopters with stale lockfiles get a one-line nudge to migrate.

After this lands, the next release-PR's workflow run will publish `@adcp/sdk` cleanly without trying to touch `@adcp/client`.
