---
'@adcp/sdk': patch
---

Adopt the maintained AdCP 3.1.32 compliance corpus alongside the existing 3.1.30 and 3.0.25 corpora.

`sync-schemas:all`, `schemas:ensure` and the published-artifact validator now treat 3.1.32 as a maintained side bundle. It is synced through the ordinary signature-required route from the official origin, with no mirror, trust or custom-bundle override, and the validator requires it in the packed inventory the same way it already requires 3.1.30 and 3.0.25.

Added alongside, not instead of. `compliance/cache/3.1.30/` keeps its exact bytes and stays packaged, so a run pinned with `--compliance-version 3.1.30` still resolves the fixtures it pinned.

One asymmetry is worth stating plainly, because the two caches behave differently. Schema bundles collapse by minor: `copy-schemas-to-dist.ts` ships the highest patch per minor, so `dist/lib/schemas-data/3.1/` resolves to 3.1.32 and the packaged 3.1 _schema_ directory no longer carries 3.1.30 bytes. Compliance corpora do not collapse — both patch directories ship with their own bytes. Retaining the 3.1.30 source cache is a promise about compliance fixtures, not about the schema alias.

The primary pin is unchanged at AdCP 3.2.8, with its skills, codegen provenance and `latest` pointer untouched; a side sync never repins the primary. `LAST_3_1_GA_PATCH` advances from 30 to 32 so the generated compatibility enumeration covers the new patch.
