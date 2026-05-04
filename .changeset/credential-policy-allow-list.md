---
'@adcp/sdk': minor
---

`credentialPolicy.tools` now accepts a granular `{ allow: string[] }` shape per-tool. Storefronts that legitimately accept ONE specific buyer-presented credential field (e.g. `delivery.api_token` on `activate_signal`) can permit only that path while still rejecting other credential-shaped keys — defense-in-depth scaling with the size of the exception, instead of opening the entire tool with `'lax'`.

```ts
credentialPolicy: {
  policy: 'authInfo-only',
  tools: {
    // Coarse: every credential-shaped key passes
    legacy_tool: 'lax',

    // Granular: ONLY the listed paths pass; other credential-shaped
    // keys still reject. Recommended over 'lax' wherever feasible.
    activate_signal: { allow: ['delivery.api_token'] },
  },
}
```

Allowlist entries are exact-match dotted paths (the same shape the scanner emits in `details.credential_paths`). Construction-time validation throws on empty allow lists, non-string entries, or unregistered tool names. Closes #1538.
