---
'@adcp/sdk': patch
---

With `ADCP_VALIDATOR_CACHE_DIR` set, the validator cache now also keeps the modular tool validators (what `getValidator` returns for a schema that refers to other documents of its release, which includes every request schema) and the canonical tool validators (`getCanonicalToolValidator`). Until now the cache held only bundled response validators, so each process compiled the others again. A later process now loads them without an Ajv compile. The diagnostics of a failing payload no longer compile anything either, for cached bundled validators too. Building every request, response and canonical validator of four releases and validating one failing payload with each takes 5.7 CPU-s warm, against 14.1 CPU-s with the cache off.

The cache stores one entry per compiled function, so a function that many validators share is stored and loaded once, as Ajv compiles it once. A validator loaded from the cache brings along everything its compile would have compiled, including the document roots Ajv compiles while it resolves references, so the diagnostics of a failing payload are the same. Entries are keyed by the release's content, the order its files are listed in, the envelope fields that responses are widened with, the SDK's loader code, and Ajv's version and options. A function's schema object comes from the loaded release, not from the entry. Validation results, error objects and issues are the same with the cache off, cold and warm, in any call order. An entry that doesn't fit the release is ignored and the validator compiles live.

The cache now lists its directory at its first write and then about once per eighth of `ADCP_VALIDATOR_CACHE_MAX_MB` written, and prunes to seven eighths of the limit, instead of listing it after every write.
