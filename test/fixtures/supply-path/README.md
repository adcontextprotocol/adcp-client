# Canonical supply-path verification vectors

`vectors.json` is vendored byte-for-byte from the official protocol repository, under its Apache-2.0 license. `source.json` records the reviewed immutable commit, repository path, semantics version and SHA-256. The upstream registry's `supply-path-golden.test.ts` and this SDK's `test/lib/supply-path.test.js` consume the same expected states, resolved collections, five leg diagnostics, IAB parser results, and applicable-file policy.

Verify the pinned fixture offline:

```sh
node scripts/sync-supply-path-vectors.mjs --check
```

After reviewing an upstream contract change, vendor its exact commit:

```sh
node scripts/sync-supply-path-vectors.mjs --commit <40-character-upstream-commit>
```

Run both implementations' golden tests before accepting a semantics update. Never edit client expectations to accommodate a divergent implementation. These are test evidence fixtures; runtime product discovery uses only actual seller responses.
