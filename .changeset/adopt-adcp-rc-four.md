---
'@adcp/sdk': minor
---

Adopt the signed AdCP 3.2.0-rc.4 schema and compliance bundles as the default wire release.

The generated capability types now expose per-product `anonymous_discovery`, and the
verification-token schemas expose the new `spec` and `live` token modes. The regenerated
media-buy and Reliable Reporting contracts also include rc.4's frequency-cap negotiation
and consumer-status refinements.

Bundled validators now compile in an isolated AJV registry, preserving rich union and
discriminator diagnostics when an rc.4 bundle shares its canonical `$id` with the modular schema.

As with earlier 3.2 prereleases, rc.4 replaces rc.3 in
`COMPATIBLE_ADCP_VERSIONS`; consumers can continue to pin `adcpVersion: '3.2-rc'` to
follow the release candidate carried by a particular SDK build.
