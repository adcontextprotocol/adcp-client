# Experimental Web Bot Auth vectors

Copied without modification from adcontextprotocol/adcp PR #7894, commit
`656bd080f01cc2fca4a1e623af44e96cfd827ba5`,
`static/compliance/source/test-vectors/wba-profile/` on 2026-10-13. The
governance JWS vectors are omitted: JWS document signing stays on the RFC 9421
chain in AdCP 3.3. The same files are vendored by adcp-client-python#1502.

These are draft transport vectors, not released AdCP 3.3 compliance inputs.
The public private seeds in `keys.json` are test inputs only (WBA §6.8).
Refresh them when the profile page and vectors merge upstream.
