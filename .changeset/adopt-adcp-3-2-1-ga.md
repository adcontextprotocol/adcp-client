---
'@adcp/sdk': minor
---

Release SDK 14 as stable on the signed AdCP 3.2.1 GA bundle.

AdCP 3.2.1 is the 3.2 general-availability release (3.2.0 was withdrawn before
GA and is never advertised). The SDK now pins `ADCP_VERSION` to `3.2.1`, ships
the signed 3.2.1 schema and compliance bundles in place of 3.2.0-rc.7, and
negotiates the release-precision `3.2` wire version. `COMPATIBLE_ADCP_VERSIONS`
keeps every supported 3.0.x and 3.1.x GA patch and adds `3.2.1` and `3.2`; it no
longer advertises any 3.2 prerelease pin. Callers pinned to `3.2-rc.7` or
`3.2.0-rc.7` should switch to `3.2`. The packaged `universal/principal` and
`universal/reporting-core` storyboards are rebound to the signed 3.2.1 bundle.

npm dist-tags: `latest` and `adcp-3.2` point at 14.x; `adcp-3.1` stays on the
13.x maintenance line and `adcp-3.0` on 7.11.x.
