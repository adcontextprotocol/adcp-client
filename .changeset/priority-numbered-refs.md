---
---

Codegen-only fix: priority extracted types collapse identical numbered `$ref` copies onto their base instead of leaving dangling references. Generated output for the pinned schemas is unchanged, so no package release is needed.
