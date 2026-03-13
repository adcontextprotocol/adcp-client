---
'@adcp/client': patch
---

Remove testing UI server and Fly.io deployment. The testing framework is now available via the CLI (`npx @adcp/client`) and Addie. Removes `dotenv` from dependencies (was only used by the server).
