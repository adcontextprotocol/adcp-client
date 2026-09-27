---
'@adcp/sdk': minor
---

Adopt the signed AdCP 3.2.0-rc.7 schema and compliance bundles as the default
wire release.

The generated types and validators now include the `viewable_rate` optimization
metric and optional account-scoped creative-format discovery. Account resolvers
must authorize any buyer-supplied `account_id`, including this new discovery
path. Reporting schemas retain their rc.6 wire shape; the shipped consumer-status
golden fixture remains byte-exact at rc.6. The packaged principal and
reporting-core storyboards are rebound to the signed rc.7 bundle. As with earlier 3.2
prereleases, rc.7 replaces rc.6 in the advertised compatible versions;
communicating peers should upgrade together or select the exact `3.2-rc.7`
alias.
