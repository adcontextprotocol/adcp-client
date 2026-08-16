---
'@adcp/sdk': patch
---

Harden agent transports and OAuth discovery against DNS rebinding and redirect-based SSRF, authenticate and correlate CLI async webhooks, fail closed when browser OAuth state binding is omitted, verify signed schema inputs in release automation, and restrict privileged issue-triage commands to trusted collaborators.

Migration notes:

- Rename `transport.fetchFn` to `transport.trustedFetchFn` and OAuth discovery/web-flow `fetch` hooks to `trustedFetchFn`. The deprecated names still work and warn; setting both to different functions throws.
- A `trustedFetchFn` owns DNS pinning and private-address policy. Prefer the built-in transport when possible.
- Private-DNS agents must opt in per client with `transport.allowPrivateIp: true`; loopback/private IP literals remain scoped to their exact initial origin.
