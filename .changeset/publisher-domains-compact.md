---
'@adcp/sdk': minor
---

feat(discovery): support compact `publisher_domains[]` form on `publisher_properties` selectors

Wires [adcontextprotocol/adcp#4504](https://github.com/adcontextprotocol/adcp/pull/4504)
into the SDK (adcp-client#1737). Each `publisher_properties[]` entry on an
`adagents.json` `authorized_agents[]` block can now carry **either**
`publisher_domain` (singular string, existing) **or** `publisher_domains`
(plural array, new) — mutually exclusive. The compact form is logically
equivalent to repeating the singular entry once per listed domain, and is
the canonical wire shape for managed networks that represent hundreds of
publishers under a single selector.

### Type model

`PublisherPropertySelector` (in `src/lib/discovery/types.ts`) is now a
discriminated union of `SinglePublisherPropertySelector` and
`CompactPublisherPropertySelector`. `'by_id'` is intentionally excluded
from the compact form — property IDs are publisher-scoped, so fan-out has
no defined semantics there.

### Parser + fanout helpers

`src/lib/discovery/publisher-property-selector.ts` exports:

- `parsePublisherPropertySelector(raw)` — strict witness validator.
  Rejects XOR violations (both/neither), `by_id` + `publisher_domains`,
  empty / non-string-array compact lists, mixed-case domains (the spec
  pattern requires lowercase), in-list duplicates, control characters
  / whitespace in domain strings, and lists longer than
  `MAX_PUBLISHER_DOMAINS_PER_SELECTOR` (50,000 — ~7× headroom over
  Raptive's 6,800). Throws `PublisherPropertySelectorParseError` with
  a typed `code` for each failure mode.
- `expandPublisherPropertySelector(selector)` — fans a compact entry
  out to N singular entries. Hardened type guard: returns `[]` (not
  per-char fanout, not silent coercion) when `publisher_domains` is a
  non-array, when a singular `publisher_domain` is missing/wrong-type,
  or when entries contain control chars. Lowercase + dedupe inside the
  fanout is the indexing backstop; the strict validator is on
  `parsePublisherPropertySelector`.
- `expandPublisherPropertySelectors(selectors)` — array variant.
- `isCompactPublisherPropertySelector(selector)` — type guard, hardened
  to require a non-empty `string[]` (rejects malformed counterparty input).
- `publisherDomainsCoveredBySelectors(selectors)` — returns the lowercased
  set of every publisher addressed across both shapes; filters domains
  with control chars. Suitable for `managerdomain` explicit-scoping
  safety checks (when those land).
- `isDomainStringValid(value)` — runtime guard exported for adopters
  mirroring the same control-char / length checks ahead of their own
  indexing.

### Wired into existing indexers

- `resolveAgentProperties` now exposes both `cross_publisher` (wire shape,
  compact preserved) and `cross_publisher_expanded` (singular only).
  Callers that index by `publisher_domain` should iterate the expanded
  array — without it, compact entries silently disappear from per-publisher
  indices.
- `listAgentPropertyMap` exposes per-agent `selectors` + `expanded` for
  the same reason.
- `seed-merge` overlays compact-form `publisher_properties[]` entries by
  the sorted-domain-list + `selection_type` composite key (case-insensitive,
  order-insensitive), so a re-seeded compact selector overlays its
  counterpart instead of duplicating.

### Codegen preprocessor

Extended `scripts/generate-types.ts` to strip `allOf` members shaped
`{ anyOf: [{required: [A]}, {required: [B]}] }` before handing schemas
to `json-schema-to-typescript`. This is the canonical JSON-Schema XOR-via-
required idiom; without stripping, jsts emits property-doubled intersections
that confuse downstream `ts-to-zod`. Ajv still enforces the constraint at
runtime against the unstripped schema. Same precedent as the existing
`not` and `if/then/else` strippers.

### Schema version note

The compact form merged to adcp `main` on 2026-05-14 and currently lives
only at `/schemas/latest/`. No tagged AdCP version (3.0.11, 3.0.12) ships
it yet — the SDK's hand-authored discovery types are ready for whichever
patch cuts next, and the generated types will pick up the new shape via
`npm run sync-schemas` once the version cut happens.
