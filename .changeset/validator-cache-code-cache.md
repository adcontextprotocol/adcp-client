---
'@adcp/sdk': patch
---

With `ADCP_VALIDATOR_CACHE_DIR` set, the validator cache also keeps V8's code cache for each stored validator module, in a `.v8` file beside the entry. The first process that loads an entry writes it; later processes hand it to V8 and evaluate the module without parsing it again. Loading six stored validators (19 MB of module code) takes 0.03 CPU-s instead of 0.13. The code cache adds about a third of each entry's size to the directory and counts toward `ADCP_VALIDATOR_CACHE_MAX_MB`.

A code cache file is used only when its header names the digest of the entry's verified body, the Node.js version, architecture and V8 version of the current process, and its data matches the SHA-256 in its header. Otherwise the module compiles from source as before and the file is replaced. Validation results are the same with the cache off, cold and warm.
