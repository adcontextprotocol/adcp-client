# npm Dist-Tags

`@adcp/sdk` publishes AdCP compatibility dist-tags:

- `adcp-3.0` for the newest SDK runner/schema bundle in the AdCP 3.0 line.
- `adcp-3.1` for the newest SDK runner/schema bundle in the AdCP 3.1 line.
- `adcp-3.2` for the newest SDK runner/schema bundle once the AdCP 3.2 line opens.

These are long-lived CI targets. They should move forward within a protocol
minor line, but should not move across protocol minor lines. For example, Python
SDK CI can pin `@adcp/sdk@adcp-3.0` and `@adcp/sdk@adcp-3.1` without being moved
when another compatibility line opens.

Do not use bare `3.0`, `3.1`, or `3.2` as npm dist-tags. npm rejects those tag
names because it parses them as semver ranges.

## Release Automation

The release workflow publishes with `npm publish --tag adcp-<major.minor>` via
`npm run release`. The tag is derived from `package.json#adcp_version`; for
example:

```text
3.0.12 -> adcp-3.0
3.1.0-beta.3 -> adcp-3.1
3.2.0-beta.0 -> adcp-3.2
```

This is intentionally a publish-time tag, not a post-publish `npm dist-tag add`.
npm trusted publishing via GitHub OIDC authenticates `npm publish`, so the
compatibility tag works without a long-lived npm token. Post-publish dist-tag
mutation is a separate registry operation and is not covered by OIDC.

Changesets pre-mode normally uses the pre-mode tag for both the npm dist-tag and
the semver prerelease identifier. The release wrapper temporarily changes the
checkout's pre-mode tag only while `changeset publish` runs. That keeps package
versions like `8.1.0-beta.12`, while publishing them under `adcp-3.1`.
