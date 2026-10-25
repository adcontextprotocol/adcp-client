# npm Dist-Tags

`@adcp/sdk` uses `latest` for the current stable SDK line. Users should be able
to run `npm install @adcp/sdk` or `npx @adcp/sdk` and receive the supported
stable release.

Each supported protocol line also has an explicit AdCP compatibility
dist-tag:

| Tag | SDK line | AdCP line | Published from |
|---|---|---|---|
| `latest` | 16.x | 3.2 | `16.x` |
| `adcp-3.2` | 16.x | 3.2 (stable line) | `16.x`; moved manually after each release (see below) |
| `beta` | 17.x beta | 3.3 beta | `main`, in Changesets pre-mode |
| `adcp-3.1` | 13.x | 3.1 (maintenance line) | `13.x` branch, with `ADCP_NPM_TAG=adcp-3.1` |
| `adcp-3.0` | 7.11.x | 3.0 | 7.x maintenance releases, with `ADCP_NPM_TAG=adcp-3.0` |

The `rc` tag is a historical SDK 14 channel and is no longer maintained. Do not recommend it.

Compatibility tags are long-lived CI targets. They should move forward within a
protocol minor line, but should not move across protocol minor lines. For
example, Python SDK CI can pin `@adcp/sdk@adcp-3.0` without being moved when
another compatibility line opens.

Do not use bare `3.0`, `3.1`, or `3.2` as npm dist-tags. npm rejects those tag
names because it parses them as semver ranges.

## Release Automation

The release workflow runs on `main` and `16.x`. SDK 16 releases publish with `npm publish --tag latest` via
`npm run release`; `main` publishes SDK 17 prereleases under `beta` while Changesets pre-mode is active. `latest` intentionally tracks the default stable SDK release,
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

The current-line tag is the one exception. A stable release from `16.x` publishes with
`latest`, so OIDC cannot also move `adcp-3.2`. After each stable AdCP 3.2 SDK release, a
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

## SDK 16 and SDK 17 release boundary

SDK 16 is the stable AdCP 3.2 line (`ADCP_VERSION=3.2.7`). Exit Changesets pre-mode and run `npm run version` to produce its GA versions, lockfile, changelogs and generated documentation. Merge and verify the stable npm publication before entering another prerelease cycle.

SDK 17 beta adopts the published AdCP 3.3 beta protocol bundle. Its release preparation enters Changesets pre-mode with `npx changeset pre enter beta` and adds a major SDK changeset. Sync the exact published protocol beta, regenerate its types and schemas, and validate the integration before publishing. Keep `latest` on SDK 16 throughout the SDK 17 beta cycle, and maintain SDK 16 fixes from a stable branch with `ADCP_NPM_TAG=latest`.

The experimental identity preview already shipped in SDK 16 remains explicitly opt-in; SDK 16 GA does not make AdCP 3.3 the default or stabilize that preview. See the [SDK 16 release notes](../releases/16.0.0.md).

## Workspace packages

The repository publishes more than `@adcp/sdk`. Changesets versions and publishes every non-private workspace
package in one release, with the same pre-mode tag:

| Package                      | Directory                      | SDK 16 stable dist-tag | Notes                                                                        |
| ---------------------------- | ------------------------------ | -------------------------------- | ---------------------------------------------------------------------------- |
| `@adcp/sdk`                  | `.`                            | `latest`                           | The SDK.                                                                     |
| `@adcp/reporting-storage`    | `packages/reporting-storage`   | `latest`                           | Reliable Reporting storage. Pre-1.0 (`0.x`); depends on `@adcp/sdk` as a peer. |
| `@adcp/eslint-plugin`        | `packages/eslint-plugin`       | `latest`                           |                                                                              |
| `@adcp/reference-renderers`  | `packages/reference-renderers` | `latest`                           |                                                                              |

`@adcp/reporting-storage` starts at `0.0.0` in `package.json` so a changeset sets its first real version. Under
pre-release mode its first changeset (`minor`) produces `0.1.0-beta.0`, published on the `beta` tag and never on
`latest`. The SDK 16 promotion releases storage `0.1.0` on `latest` while keeping its API experimental. It reaches `1.0.0` when the `@experimental` tags come off
([stability policy](../guides/REPORTING-STABILITY.md)). Its `@adcp/sdk` peer range is rewritten by Changesets to the
SDK version released with it, so install the pair published together.

## First publish of a new workspace package

npm trusted publishing (GitHub OIDC) can only be configured for a package that already exists on the registry. A
new workspace package therefore cannot make its first publish from `release.yml`. A maintainer with publish rights on
the `@adcp` scope does one manual publish, then configures the trusted publisher; every later release is OIDC with
provenance.

**The release workflow will not fail on an unbootstrapped package.** `scripts/publish-adcp-release.ts` asks the
registry about each publishable workspace package first. One the registry has never seen (a definite 404) is marked
`private` for the duration of `changeset publish`, which skips it, and the run prints a warning that names the package
and points here. Every other package, `@adcp/sdk` included, publishes as usual. A registry lookup that fails for any
other reason holds nothing back. The held-back package keeps its version in `package.json`, so the first release after
the bootstrap publishes it with no other change. (`test/lib/hold-back-unbootstrapped-packages.test.js` pins this.)

### Steps for `@adcp/reporting-storage`

Do these once, as an `@adcp` npm maintainer. Do 1 to 4 before the `chore: release package` PR that first includes the
package is merged if you can; if it has merged already, the same steps work and publish whatever version `main` holds.

1. Check out a clean `main` and build the whole workspace. `npm run build` builds `@adcp/sdk` and then the package.

   ```bash
   git checkout main && git pull
   npm ci
   npm run build
   npm run check --workspace=@adcp/reporting-storage
   ```

2. Log in and confirm who you are:

   ```bash
   npm login
   npm whoami
   ```

3. Publish once, from your machine, under a throwaway tag. Provenance needs the GitHub OIDC identity, so it has to
   be off for this publish. The package's `publishConfig.provenance: true` outranks `NPM_CONFIG_PROVENANCE=false`, and
   a real publish with it fails with `EUSAGE Automatic provenance generation not supported for provider: null`.
   `--dry-run` skips provenance and passes either way, so it cannot tell you whether the line is still there. Remove
   the line from your working tree before publishing, and do not commit the change:

   ```bash
   node -e 'const f="packages/reporting-storage/package.json",fs=require("fs"),p=JSON.parse(fs.readFileSync(f));
     delete p.publishConfig.provenance; fs.writeFileSync(f, JSON.stringify(p, null, 2) + "\n")'
   ```

   The package's `prepublishOnly` cleans, rebuilds and re-checks it. Then publish:

   ```bash
   NPM_CONFIG_PROVENANCE=false npm publish \
     --workspace=@adcp/reporting-storage \
     --access public \
     --tag bootstrap
   ```

   This publishes the version in `packages/reporting-storage/package.json` (`0.0.0` until the release PR bumps it to
   `0.1.0-beta.0`). Restore the line with `git checkout -- packages/reporting-storage/package.json`. Then keep an
   install of the placeholder from becoming the default:

   ```bash
   npm dist-tag ls @adcp/reporting-storage
   npm dist-tag rm @adcp/reporting-storage latest      # only if latest points at 0.0.0
   ```

4. Configure the trusted publisher on npmjs.com (package page, Settings, Trusted Publisher, GitHub Actions):

   - GitHub organization: `adcontextprotocol`
   - Repository: `adcp-client`
   - Workflow filename: `release.yml`
   - Environment: blank
   - Allowed action: `npm publish`

5. Merge the release PR (or let the next `release.yml` run on `main` publish the held-back package). Its run
   publishes `@adcp/reporting-storage@0.1.0-beta.0` through OIDC with provenance on the `beta` tag. Check:

   ```bash
   npm view @adcp/reporting-storage dist-tags
   npm view @adcp/reporting-storage@0.1.0-beta.0 dist.attestations
   ```

   If the release PR had already merged before you ran step 3, the manual publish put `0.1.0-beta.0` itself on the
   registry under the `bootstrap` tag, so there is nothing left for the workflow to publish and the version has no
   provenance attestation. In that case also run `npm dist-tag add @adcp/reporting-storage@0.1.0-beta.0 beta`, and skip
   the attestation check; the next release is published through OIDC as usual.

6. Remove the temporary tag: `npm dist-tag rm @adcp/reporting-storage bootstrap`.

The SDK beta that removes the storage subpaths can publish before the package is bootstrapped (that is the point of the
hold-back), and adopters have no `@adcp/reporting-storage` to move to until it is. So do steps 1 to 4 **before** merging the
release PR, and treat them as a checklist item on it.

The same steps bootstrap any future workspace package: swap the name, and use the OIDC settings above.

The `16.x` maintenance branch starts at `505ddc9e` (SDK 16.5.0 plus the pending creative-review changeset). Its release PRs target `16.x`, run the same CI and reference-seller checks, and publish only after the release PR is merged.
