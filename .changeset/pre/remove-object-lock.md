---
'@adcp/reporting-storage': patch
---

Reporting storage (experimental): retirement, compaction and the write-intent sweep no longer take the per-object advisory lock, and a commit only takes it for an adopted object its own intent did not record (#3281).

The lock (`adcp-reporting-object:{binding}:{objectRef}`) made every reference-checked delete a transaction that held a pooled connection and an advisory lock across the provider delete, and made every commit that adopted an existing object pay one lock round trip per object. Since every writable key template must include `{revision_key}`, only one row set can ever name a key, so the lock no longer ordered anything on those paths. Safety there comes from the reference check plus the fences that already existed: the account lock with the `FOR SHARE` on a header-only revision's predecessor, the `pruning` state each retirement and compaction commits before it deletes, the intent's `open` to `sweeping` transition against the commit that closes it, and version-pinned deletes. The full argument, case by case, is in `docs/guides/REPORTING-LEDGER.md` and on `deleteUnreferencedObjects`.

Two places keep the lock, because nothing else orders them: the orphan collector's delete (its object is named by no record) and a commit that adopts an object its own write intent did not record (an earlier attempt's `PUT` landed before it was recorded). The collector now takes every binding's lock for the object in one transaction, as before. A retry that adopts an object its own intent recorded takes no lock and still proves it with the version-pinned `stat`.

Why patch and not minor: no exported API, no schema and no wire behavior changes, and the lock key text is unchanged, so a rolling upgrade between a version that locks everywhere and this one is safe (every pair that still needs mutual exclusion keeps the lock on both sides). Nothing to migrate. The Python SDK carries the same item (adcp-client-python#1492); the exact final contract is under "Cross-SDK contract" in `docs/guides/REPORTING-LEDGER.md`.
