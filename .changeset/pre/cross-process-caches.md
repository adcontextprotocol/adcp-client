---
'@adcp/sdk': patch
---

Keep compiled validators and parsed inputs across schema-root re-entries and, opt-in, across processes. With `ADCP_VALIDATOR_CACHE_DIR` unset, empty or relative, only the in-process re-entry change applies and no cache code loads. Validation results, diagnostics, tool lists and loader epochs are the same with the cache off, cold and warm.

- Re-entering an unchanged schema root (`withExternalSchemaRoot`, `registerExternalSchemaRoot`) keeps the loader states and generation when every document has the same path, inode, size, mtime and ctime, all older than 3 s. A rewritten, freshly written or other root, or an unregister, starts a fresh epoch as before.
- With `ADCP_VALIDATOR_CACHE_DIR` set to an absolute directory, the first process stores each compiled bundled validator as Ajv standalone code, keyed by a digest of the prepared schema, the loader code, the Ajv and ajv-formats versions and the Ajv options; later processes load it instead of compiling. `ADCP_VALIDATOR_CACHE_MAX_MB` caps the directory (default 512). The directory and entries must belong to the current user with no group or other access; entries are written atomically, checked against the SHA-256 in their header, and any doubt falls back to the live compile.
- The same directory holds schema-root document identities (a record is used only while the document's stat key is unchanged), parsed storyboard YAML (keyed by the document text, the parser module's code, the `yaml` version and the SDK version; a document with YAML errors or warnings is never stored), and recorded tools/list compiles of modular request schemas (keyed by the root's content, the loader code, the Ajv and engine versions, the bundle key and the tool; only successful compiles are recorded).
