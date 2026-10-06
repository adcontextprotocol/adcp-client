---
'@adcp/sdk': minor
---

Allow testing OAuth auth options to bind a trusted OAuthConfigStorage before client normalization so refreshed tokens can be persisted. Shared test clients require the same storage adapter object in addition to their existing credential, version and transport scope checks. The binding stays out of serialized request scope and agent configuration. Storage persistence does not coordinate concurrent refreshes of rotating grants.
