---
---

ci: bump `tsc` heap to 8 GiB in `check:adopter-types` so the adopter type-check no longer OOMs on the 3.1 codegen graph. No runtime / API impact - empty changeset satisfies the gate.
