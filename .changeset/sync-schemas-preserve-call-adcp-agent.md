---
'@adcp/sdk': patch
---

fix(sync-schemas): preserve SDK-local `call-adcp-agent/SKILL.md` across protocol bundle syncs

`syncSkillsFromBundle` previously overwrote `skills/call-adcp-agent/` from the upstream protocol tarball whenever the bundle's `manifest.contents.skills` listed it. Because the SDK-maintained copy carries SDK-version-specific addenda (e.g. `SDK ≥6.7` `discriminator`/`schemaId`, `SDK ≥6.8` `hint`), every `npm run sync-schemas` (and every `prepublishOnly`) silently rolled those sections off — letting them ship in the npm package only when the spec bundle happened to include them.

Add a `SDK_LOCAL_SKILLS` allowlist so `call-adcp-agent` is treated like `build-seller-agent/` and friends: present in `skills/`, but never replaced by the protocol bundle. Per-protocol skills (`adcp-{brand,creative,governance,media-buy,si,signals}`) continue to sync normally.

Also synchronizes `package-lock.json` to the committed `package.json` 6.7.0 so workspace setup no longer regenerates it on every `npm install`.
