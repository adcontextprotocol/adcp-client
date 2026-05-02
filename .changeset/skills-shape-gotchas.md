---
"@adcp/sdk": patch
---

docs(skills): add `skills/SHAPE-GOTCHAS.md` covering the five discriminated-union and embedded-shape patterns adopters consistently get wrong on first pass (ActivationKey, SignalID, VASTAsset, PreviewCreativeResponse, BuildCreativeReturn). Linked from `build-seller-agent`, `build-creative-agent`, `build-signals-agent` SKILL.md preambles. No code change; documentation lives under `skills/**/*` which ships in the npm package, hence the patch bump.
