---
"@adcp/client": patch
---

Fix JavaScript syntax error in testing UI and update hono for security

- **UI Fix**: Resolved syntax error in `index.html` dimension parsing logic that caused `toggleAddAgent` and other functions to be undefined. The invalid `} else { } else if {` structure was corrected to proper nested conditionals.

- **Security**: Updated `hono` from 4.11.3 to 4.11.4 to fix high-severity JWT algorithm confusion vulnerabilities (GHSA-3vhc-576x-3qv4, GHSA-f67f-6cw9-8mq4).
