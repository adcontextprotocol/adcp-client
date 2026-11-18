---
'@adcp/sdk': patch
---

Read parsed storyboard YAML from the opt-in cache directory. With `ADCP_VALIDATOR_CACHE_DIR` set, `parseStoryboard` and the universal-file classification store each parsed compliance document as a data entry in that directory, and later processes read it back instead of parsing the YAML again. The key digests the document text, the parser module's code, the `yaml` version and the SDK version, so a changed file or parser is a miss. A document with YAML errors or warnings is never stored and is parsed every time, so it throws or warns as before. Every call returns new objects, and objects that YAML aliases share stay shared. With the variable unset, empty or relative, nothing changes and no cache code loads.
