# Proposal commercial-term verification fixtures

`current.json` exercises the pinned AdCP 3.2.0-rc.2 commercial envelope, including
all four portable constraint kinds. `beta8.json` is its pre-change-rights snapshot.
Values are deterministic test fixtures, never fallback agent responses.

`beta8-schema.json.gz` freezes the complete reachable Draft-07 schema graph rooted
at `media-buy/commercial-terms.json` from the signed **3.2.0-beta.8** distribution
downloaded by `npm run sync-schemas -- 3.2.0-beta.8`. It contains a JSON map keyed by
schema path, plus an index with the release identity. Schema contents, IDs, and
references are unmodified; only JSON whitespace/key ordering and gzip packaging
differ. Tests unpack it into an isolated temporary schema root, so CI never
silently validates the old fixture against the latest schema or requires a
network fetch for this old release.

`rc3-product-purchase-validation.json` is the unmodified `x-adcp-validation`
annotation from the released AdCP 3.2.0-rc.3 `media-buy/product-purchase.json`.
It isolates the removal of the direct-purchase contract from accepted snapshots
and checks that supporting rc.3 does not weaken the rc.2 semantic profile.
