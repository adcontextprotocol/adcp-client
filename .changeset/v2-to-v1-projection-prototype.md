---
'@adcp/sdk': minor
---

feat(v2): prototype v2 → v1 Product projection layer

Working prototype of the v2 → v1 Product projection from the 8.0 design
proposal at `docs/development/v3.1-sdk-design.md` (PR #1809). Used when
the SDK negotiates to a v1 seller for a buyer that wrote V2 code —
adopters never see v1 vocabulary; SDK does the wire-level translation.

Implements the resolution order from `v1-canonical-mapping.json`,
inverted:

1. `format_kind: "custom"` + `canonical_formats_only: true` →
   `FORMAT_DECLARATION_V1_UNREACHABLE` diagnostic (explicit opt-out).
2. `v1_format_ref` present → use verbatim (seller-asserted equivalence).
3. Registry reverse-lookup → invertible match (canonical + params
   narrow compatibly to a literal v1 named format).
4. Registry says "family exists but ambiguous" →
   `FORMAT_DECLARATION_V1_AMBIGUOUS` diagnostic.
5. Registry says "no entry for this canonical" →
   `FORMAT_DECLARATION_V1_UNREACHABLE` diagnostic.

Diagnostics emitted on the structured channel (`ProjectionDiagnostic[]`)
per the spec's resolution-order amendment — never logger-only.

**Exercised against all 13 spec reference fixtures.** Coverage report:
- 1/13 clean v1 emit (`nytimes_homepage_mrec` — image 300x250 matches
  the IAB MREC registry entry).
- 1/13 explicit opt-out (`nytimes_homepage_takeover_custom`).
- 7/13 ambiguous (the family has registry entries but none invert
  cleanly — `display_tag`, `video_hosted`, `html5`, `audio_hosted`,
  `audio_daast`, `video_vast`).
- 4/13 no registry coverage (`sponsored_placement`, `agent_placement`,
  `responsive_creative`, `image_carousel` — these are genuinely new
  canonical concepts in v2 with no v1 equivalent).

Headline implication for the 8.0 design: without sellers adding
`v1_format_ref` to their declarations, only ~8% of v2 fixtures
project cleanly. The "v2-only public type with projection at the
boundary" stance still holds — products that can't downgrade
gracefully surface via diagnostics — but the migration story for v1
sellers depends on sellers actively annotating their v2 declarations.

**Surfaced upstream-spec bug**: the IAB-named registry entries
(`iab/mrec_300x250` etc.) contain slashes, but `format-id.json` only
allows `^[a-zA-Z0-9_-]+$`. Projecting `nytimes_homepage_mrec` produces
a synthesized `format_id.id` that wouldn't pass wire validation — this
is the same cross-schema mismatch flagged in
adcontextprotocol/adcp upstream.

**Scope notes**:

- Hand-rolled TypeScript types in `src/lib/v2/projection/types.ts`
  rather than full versioned codegen — separate piece of the 8.0
  enablement. Types match the schema shape at projection-relevant
  precision; params bodies stay loose (`Record<string, unknown>`).
- v1 → v2 (upgrade direction) is the symmetric counterpart and not
  in this prototype. Will land in a follow-up once we agree on
  the design surface.
- No public barrel export yet — the projection layer is internal-only
  until the auto-negotiation surface lands. Tests import directly
  from `dist/lib/v2/projection/v2-to-v1.js`.
- Public types and behavior may change as the 8.0 design firms up
  (see PR #1809 for the architecture proposal).
