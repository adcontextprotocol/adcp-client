# npm Dist-Tags

`@adcp/sdk` uses `latest` for the current stable SDK line. Users should be able
to run `npm install @adcp/sdk` or `npx @adcp/sdk` and receive the supported
stable release.

Older supported protocol lines may also have explicit AdCP compatibility
dist-tags:

- `adcp-3.0` for the newest SDK runner/schema bundle in the AdCP 3.0 line.
- `adcp-3.1` only if AdCP 3.1 becomes a maintenance line after a newer stable
  protocol line opens.

Compatibility tags are long-lived CI targets. They should move forward within a
protocol minor line, but should not move across protocol minor lines. For
example, Python SDK CI can pin `@adcp/sdk@adcp-3.0` without being moved when
another compatibility line opens.

Do not use bare `3.0`, `3.1`, or `3.2` as npm dist-tags. npm rejects those tag
names because it parses them as semver ranges.

## Release Automation

The release workflow publishes with `npm publish --tag latest` via
`npm run release`. `latest` intentionally tracks the default stable SDK release,
not a branch name.

Set `ADCP_NPM_TAG` only when intentionally publishing a maintenance or alternate
channel, for example `ADCP_NPM_TAG=adcp-3.0 npm run release`.

This is intentionally a publish-time tag, not a post-publish `npm dist-tag add`.
npm trusted publishing via GitHub OIDC authenticates `npm publish`, so the
chosen tag works without a long-lived npm token. Post-publish dist-tag mutation
is a separate registry operation and is not covered by OIDC. Emergency retags can
still be repaired manually with `npm dist-tag add`, but normal releases should
not need a registry token.

Changesets pre-mode normally uses the pre-mode tag for both the npm dist-tag and
the semver prerelease identifier. The release wrapper keeps that pre-mode tag
unless `ADCP_NPM_TAG` is set. That prevents prereleases from moving `latest`
accidentally.

## Per-PR Beta Releases

Add the `beta-release` label to a PR to get an installable npm build of that
PR's exact code, for end-to-end testing before merge:

```sh
npm install @adcp/sdk@pr-<N>   # N is the PR number
```

The `beta-release.yml` workflow publishes this automatically under the
`pr-<N>` dist-tag using a Changesets snapshot release (`changeset version
--snapshot` + `changeset publish --tag`), reusing `scripts/publish-adcp-release.ts`
via `ADCP_NPM_TAG`. It republishes on every push while the label stays
attached, and comments the resolved version and install command on the PR.

**Promotion is just merging the PR normally.** There is no separate promote
step: the real `latest` version is cut fresh by the existing `release.yml` +
Changesets flow from whatever lands on `main`, which is not guaranteed to be
byte-identical to the last snapshot build if other PRs merge into the same
release batch first.

Cleanup of the `pr-<N>` dist-tag on PR close is best-effort — it requires an
`NPM_DIST_TAG_TOKEN` secret (dist-tag removal isn't covered by OIDC trusted
publishing, same limitation as above) and silently no-ops if that secret isn't
configured. Stale `pr-<N>` tags left behind are harmless registry clutter, not
a functional problem.

This is a different mechanism from the long-lived beta-channel pattern
described in [`v8.0-beta-plan.md`](./v8.0-beta-plan.md) (a dedicated
`release/*-beta` branch in Changesets pre-release mode, publishing
`X.Y.Z-beta.N` under a shared `beta` tag across many PRs, promoted via
`changeset pre exit`). Use per-PR snapshots to validate one change in
isolation; use the pre-release-mode pattern for a sustained beta line ahead of
a major/minor GA.
