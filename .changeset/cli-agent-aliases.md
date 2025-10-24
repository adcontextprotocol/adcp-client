---
"@adcp/client": minor
---

Add agent alias support to CLI tool - save agent configurations with short aliases for quick access. Users can now save agents with `--save-auth <alias> <url>` and call them with just `adcp <alias> <tool> <payload>`. Config stored in ~/.adcp/config.json with secure file permissions.
