---
---

docs: layered architecture reference + decision page + version-adaptation guide

Adds three new docs and wires them into the existing entry points so adopters
can pick the right starting layer:

- `docs/architecture/adcp-stack.md` — full L0–L4 reference: what each layer
  does, what an SDK at each layer should provide, version-adaptation summary,
  and a "what early implementers underestimate" punch list.
- `docs/where-to-start.md` — short decision page. Three questions
  (caller/agent, value-add, pre-existing hand-rolled agent), recommended
  path, and a "what you give up by going lower" cost table.
- `docs/guides/VERSION-ADAPTATION.md` — code-level recipes for the three
  version-handling mechanisms: per-call `adcpVersion` pinning,
  `@adcp/sdk/server/legacy/v5` subpath co-existence imports, and wire-level
  `supported_versions` declaration with `VERSION_UNSUPPORTED` /
  `VersionUnsupportedError` handling.

Callouts added to `index.md`, `getting-started.md`, and
`guides/BUILD-AN-AGENT.md` route mis-aimed readers to the decision page
without blocking on-target ones.
