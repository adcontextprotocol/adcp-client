---
'@adcp/client': patch
---

Fix `createAdcpServer` context echo for Sponsored Intelligence tools. `si_get_offering` and `si_initiate_session` define `context` as a domain-specific string on the request but require the protocol echo object on the response. The response auto-echo now only copies `request.context` when it is a plain object, so SI responses no longer fail with `/context: must be object`.
