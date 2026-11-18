---
'@adcp/sdk': patch
---

List a tool from a recorded compile of its request schema. tools/list decides whether a release defines a framework tool by compiling the tool's request validator, so one listing compiled every request validator; on a modular schema root the on-disk validator cache does not apply. With `ADCP_VALIDATOR_CACHE_DIR` set, a modular request schema that compiled is now recorded under a key over the root's content, the loader code, the Ajv engine versions, the V8 and Unicode versions, the bundle key and the tool, and later processes read the record instead of compiling. Only successful compiles are recorded, so a schema that fails to compile hides its tool in every process, as before. A state whose listing read records compiles those validators before its diagnostics are read, so validation issues are unchanged. Bundled request schemas, and every schema with the cache off, compile as before.
