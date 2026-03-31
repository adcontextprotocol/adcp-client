---
"@adcp/client": patch
---

fix: stop early-exiting product discovery for v2 servers when request contains property_list or required_features filters that are already stripped by the v2 adapter
