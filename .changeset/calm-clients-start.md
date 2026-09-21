---
'@adcp/sdk': patch
---

Add `@adcp/sdk/client/core`, a focused entrypoint for buyer-side client runtimes that avoids loading the package's server, compliance, testing, and eager generated-schema surfaces. Client schema validation and media-buy compatibility modules now load on demand for both the focused entrypoint and existing root imports.
