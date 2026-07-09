---
'@adcp/sdk': patch
---

Stop schema syncs from clobbering checked-in protocol skills and the registry spec.

`sync-schemas` wrote two non-version-scoped, checked-in files on every run: the protocol skills (`skills/adcp-*`) and `schemas/registry/registry.yaml`. A side-bundle sync (`sync-schemas -- 3.0.12`, `sync-schemas:3.1-beta`) therefore overwrote the primary pin's skills with an older version's content, and even the primary sync overwrote the registry spec — which is actually owned by `generate-registry-types --sync` from a different upstream. Both left a spurious diff in the working tree after any sync.

The skill sync now runs only when syncing the primary pin, the `latest/` cache pointer is likewise only repointed for the primary pin (a side-bundle sync no longer silently makes the SDK validate against an older version by default), and the registry spec is no longer written by `sync-schemas` at all (its owner is `generate-registry-types --sync`). This removes the fragile `restoreFromHead`/`RESTORE_PATHS` workaround in the beta sync script.
