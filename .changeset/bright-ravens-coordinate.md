---
'@adcp/sdk': minor
---

Adopt the signed AdCP 3.2.0-beta.4 schemas, add durable products-only legacy purchase continuations, and refresh the maintained 3.0/3.1 compatibility bundles. Legacy continuation mutations now claim immediately before dispatch, share bounded submitted-task polling, and fence unstructured terminal failures as ambiguous instead of replaying them. Public product projection helpers now accept the SDK's generated product types, and observation-free error-handling storyboards no longer grade as silent.
