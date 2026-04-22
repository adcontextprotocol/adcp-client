---
'@adcp/client': patch
---

Widen two bundled default assertions per security-review feedback on adcontextprotocol/adcp#2769.

**`idempotency.conflict_no_payload_leak`** — flip the denylist-of-5-fields to an allowlist of 7 envelope keys (`code`, `message`, `status`, `retry_after`, `correlation_id`, `request_id`, `operation_id`). The previous implementation only flagged `payload`, `stored_payload`, `request_body`, `original_request`, `original_response` — a seller inlining `budget`, `start_time`, `product_id`, or `account_id` at the `adcp_error` root slipped past, turning idempotency-key reuse into a read oracle for stolen-key attackers. Allowlisting closes the hole: anything a seller adds beyond the 7 envelope fields now fails the assertion.

**`context.no_secret_echo`** — scan the full response body recursively (not just `.context`), add a bearer-token literal regex (`/\bbearer\s+[A-Za-z0-9._~+/=-]{10,}/i`), add recursive suspect-property-name match (`authorization`, `api_key`, `apikey`, `bearer`, `x-api-key`), and pick up `options.test_kit.auth.api_key` as a verbatim-secret source. The previous scope (`response.context` only, verbatim `options.auth_token`/`.auth`/`.secrets[]` only) missed the common cases where sellers echo credentials into `error.message`, `audit.incoming_auth`, nested debug fields, or as header-shaped properties. All caller-supplied secrets gate on a minimum length (8 chars) to avoid false positives on placeholder values.

Both changes are patch-level — the assertion ids, public registration API, and passing-case behavior are unchanged; the narrowing on main was fresh in 5.9 and had no adopters broad enough for the strictening to break in practice.

`governance.denial_blocks_mutation` is unchanged.

16 new unit tests cover both widenings: allowlist hits (valid envelope passes), denylist vestigial names still fail, non-allowlisted field leaks (including stable sorted error output), plus bearer literals, verbatim `options.auth_token` echo, `options.secrets[]` echo, `test_kit.auth.api_key` echo, suspect property names at any depth, array walking, short-value false-positive guard, and prose-"bearer" ignore.
