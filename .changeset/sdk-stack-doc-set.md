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

Follow-up additions (post-persona-feedback):

- `docs/guides/MIGRATE-FROM-HAND-ROLLED.md` — incremental migration path
  for adopters with a working hand-rolled agent: inventory step,
  lowest-risk-first swap order, conflict modes (idempotency,
  account-mode, webhook signing, state-machine drift, schema
  validation), intermediate states that pass conformance, when not to
  migrate.
- Decomposed the "~4 person-months for L0–L3" claim in `adcp-stack.md`
  into a per-component breakdown table (state machines, idempotency,
  async tasks, error catalog, conformance controller, webhooks, RFC
  9421, integration). Stated assumptions and excluded version-adaptation
  work explicitly.
- Filled the SDK coverage matrix with current rows for `@adcp/sdk` 6.6.x
  (GA, 6.7 in flight), `adcp` Python 4.x in flight, and `adcp-go` in
  development. Added a "last updated" line so it's clear the table needs
  refreshing on SDK majors.
- Softened the "going lower is almost always a scope mistake disguised as
  a control preference" line in `where-to-start.md` to name the
  legitimate cases (SDK author / language porter / special-purpose proxy
  / stack that already owns L0–L2).
