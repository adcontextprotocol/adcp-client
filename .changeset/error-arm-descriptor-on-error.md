---
'@adcp/sdk': patch
---

Read a tool's Error-arm descriptor only when its response carries an error. Every request built the Error-arm inventory of its release up front: it listed the whole bundle and expanded every response schema once per loader generation, and each schema-root registration bumps the generation. `getErrorArmDescriptor(tool, version)` now reads that tool's response schema alone, once per bundle key, root and generation, and two-layer error emission calls it only after it finds an error layer, so a success response reads no schema. Resolution is unchanged: the manifest must declare the tool, and when a bundle ships two response files for one tool name, the last one with an Error arm wins. `getToolsWithErrorArm` stays and is built from the same per-tool lookups and cache.
