---
'@adcp/sdk': patch
---

Cut the cost of the diagnostic hook that runs on every validator function Ajv generates. It scanned the generated source one character at a time with regular expressions and re-matched the whole source prefix at each `/`; it now compares character codes and looks back from the `/`. Output is unchanged; the hook takes about a quarter of the time, which removes roughly a fifth of the CPU spent compiling a bundled response validator.
