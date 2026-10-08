# npm Dist-Tags

`@adcp/sdk` uses `latest` for the current stable SDK line. Users should be able
to run `npm install @adcp/sdk` or `npx @adcp/sdk` and receive the supported
stable release.

Each supported protocol line also has an explicit AdCP compatibility
dist-tag:

| Tag | SDK line | AdCP line | Published from |
|---|---|---|---|
| `latest` | 15.x | 3.2 | `main` |
| `sdk-15.2` | 15.2.x | 3.2 | `15.2.x` branch, with `ADCP_NPM_TAG=sdk-15.2` |
| `adcp-3.2` | 14.x | 3.2 (tag trails the current SDK) | `main`; moved manually after each release (see below) |
| `adcp-3.1` | 13.x | 3.1 (maintenance line) | `13.x` branch, with `ADCP_NPM_TAG=adcp-3.1` |
| `adcp-3.0` | 7.11.x | 3.0 | 7.x maintenance releases, with `ADCP_NPM_TAG=adcp-3.0` |

The `rc` tag still points at the last SDK 14 prerelease (`14.0.0-rc.53`) and is
no longer maintained. Do not recommend it.

Compatibility tags are long-lived CI targets. They should move forward within a
protocol minor line, but should not move across protocol minor lines. For
example, Python SDK CI can pin `@adcp/sdk@adcp-3.0` without being moved when
another compatibility line opens.

Do not use bare `3.0`, `3.1`, or `3.2` as npm dist-tags. npm rejects those tag
names because it parses them as semver ranges.

## Release Automation

The `15.2.x` release workflow publishes SDK backports under `sdk-15.2`. Limit
backport changesets to `@adcp/sdk`; other workspace packages keep their own
release lines. This
keeps `latest` on the current stable SDK line from `main`. Consumers can install
an exact version (such as `@adcp/sdk@15.2.2`) or use `@adcp/sdk@sdk-15.2`.

The release workflow on `main` publishes with `npm publish --tag latest` via
`npm run release`. `latest` intentionally tracks the default stable SDK release,
not a branch name.

Set `ADCP_NPM_TAG` only when intentionally publishing a maintenance or alternate
channel, for example `ADCP_NPM_TAG=adcp-3.1 npm run release` from the `13.x`
branch or `ADCP_NPM_TAG=adcp-3.0 npm run release` for the 3.0 line.

This is intentionally a publish-time tag, not a post-publish `npm dist-tag add`.
npm trusted publishing via GitHub OIDC authenticates `npm publish`, so the
chosen tag works without a long-lived npm token. Post-publish dist-tag mutation
is a separate registry operation and is not covered by OIDC. Emergency retags can
still be repaired manually with `npm dist-tag add`, but normal releases should
not need a registry token.

The current-line tag is the one exception. A release from `main` publishes with
`latest`, so OIDC cannot also move `adcp-3.2`. After each current SDK release, a
maintainer with registry access moves it by hand:

```bash
npm dist-tag add @adcp/sdk@<version> adcp-3.2
npm dist-tag ls @adcp/sdk   # confirm latest and adcp-3.2 match
```

Until that runs, `adcp-3.2` lags `latest` by one release.

Changesets pre-mode normally uses the pre-mode tag for both the npm dist-tag and
the semver prerelease identifier. The release wrapper keeps that pre-mode tag
unless `ADCP_NPM_TAG` is set. That prevents prereleases from moving `latest`
accidentally.
