---
'@adcp/sdk': minor
---

Update the SDK schema pin and generated surfaces to AdCP 3.1.0-rc.4.

Regenerates TypeScript/Zod schemas, docs, manifest-derived constants, entity
hydration metadata, and server wire field allowlists from the rc4 protocol
bundle. Adds GitHub-dist fallback for schema syncs when the website mirror has
not yet published a signed protocol bundle, and keeps the media-buy mode
mismatch recovery path tolerant of older 3.1 prerelease sellers that still emit
`requires_proposal`.
