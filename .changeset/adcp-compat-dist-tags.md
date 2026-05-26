---
'@adcp/sdk': patch
---

Publish releases under AdCP minor-line npm dist-tags.

The release wrapper derives `adcp-<major.minor>` from `package.json#adcp_version`
and uses that as the publish-time npm tag, so OIDC trusted publishing can update
the compatibility channel without a post-publish dist-tag mutation.
