# npm Dist-Tags

`@adcp/sdk` uses `latest` for the current stable SDK line. Users should be able
to run `npm install @adcp/sdk` or `npx @adcp/sdk` and receive the supported
stable release.

Older supported protocol lines may also have explicit AdCP compatibility
dist-tags:

- `adcp-3.0` for the newest SDK runner/schema bundle in the AdCP 3.0 line.
- `adcp-3.1` for the maintained 13.x SDK runner. Releases from the `13.x`
  branch publish under this tag.

Compatibility tags are long-lived CI targets. They should move forward within a
protocol minor line, but should not move across protocol minor lines. For
example, Python SDK CI can pin `@adcp/sdk@adcp-3.0` without being moved when
another compatibility line opens.

Do not use bare `3.0`, `3.1`, or `3.2` as npm dist-tags. npm rejects those tag
names because it parses them as semver ranges.

## Release Automation

The release workflow sets `ADCP_NPM_TAG=adcp-3.1` only on `13.x`. On `main` it
leaves the override empty so the release wrapper honors Changesets pre-mode
(`rc`, `beta`, and so on); outside pre-mode the wrapper's default is `latest`.
This reflects the current main branch accurately: while main is in rc mode it
does not publish to `latest`.

After Changesets reports that it actually published `@adcp/sdk` from 13.x,
automation reads the registry's current `latest` and
applies one of two guarded policies:

- If `latest` is still major 13 and the optional `NPM_TOKEN` secret is present,
  and the new version is newer, automation moves `latest` to the newly
  published version. Without that credential it reports the exact manual
  `npm dist-tag add` command and fails the release job so the partial release
  cannot look complete.
- If `latest` is major 14 or newer, leave it there; the maintenance release is
  intentionally available through `adcp-3.1` and its exact version only.

Main and 13.x release jobs share one concurrency group. The policy re-reads
`latest` immediately before mutation and refuses to move it backward. Registry
read/parse failures likewise fail with an inspection and recovery command.
The 13.x Changesets config ignores `@adcp/eslint-plugin`: this maintenance
channel and its compatibility tag apply only to the root `@adcp/sdk` package.

Set `ADCP_NPM_TAG` only when intentionally publishing a maintenance or alternate
channel, for example `ADCP_NPM_TAG=adcp-3.0 npm run release`.

`adcp-3.1` is intentionally a publish-time tag, not a post-publish
`npm dist-tag add`.
npm trusted publishing via GitHub OIDC authenticates `npm publish`, so the
chosen tag works without a long-lived npm token. Post-publish dist-tag mutation
is a separate registry operation and is not covered by OIDC. The optional
classic `NPM_TOKEN` is therefore scoped to the guarded `latest` move;
`adcp-3.1` publishing continues to use trusted publishing.

Changesets pre-mode always uses the pre-mode tag for both the npm dist-tag and
the semver prerelease identifier, even if `ADCP_NPM_TAG` is set. Post-publish
reconciliation also rejects prerelease versions. Thus a prerelease cannot move
either `adcp-3.1` or `latest`.

## Stable compatibility policy

Compatibility is maintained per AdCP major/minor, not by freezing one SDK for
every historical patch. `npx @adcp/sdk@adcp-3.1` therefore selects the current
maintained 13.x runner. Exact inputs such as `--compliance-version 3.1.1` plus
a matching external `--compliance-dir /path/to/adcp-3.1.1/compliance` and
`--schema-root /path/to/adcp-3.1.1/schemas` select historical 3.1.1 test data
while continuing to use that maintained runner. The npm package does not ship
that historical compliance cache.

Prerelease selection remains exact: a prerelease cache or schema input must
match the requested prerelease rather than being treated as the whole 3.1 line.
