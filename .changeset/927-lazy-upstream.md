---
'@adcp/client': patch
---

**Resolve `globalThis.fetch` lazily in `buildAgentSigningFetch` (#927).** The previous implementation called `defaultUpstream()` at factory-call time and bound the result; a polyfill installed between factory creation and first request was silently ignored. The factory's docstring already promised "polyfills / patches that run after this module loads still take effect" — true at the import-vs-call axis, but not at the factory-call-vs-request axis. Resolution now happens per-request inside the returned closure when `upstream` is omitted, so a late-installed polyfill takes effect on its first request.

The error thrown when `globalThis.fetch` is unavailable now surfaces on the first outbound request (where it was always going to matter) rather than at factory construction. Callers passing an explicit `upstream` see no behavior change — the lazy path is taken only when the default is in use.
