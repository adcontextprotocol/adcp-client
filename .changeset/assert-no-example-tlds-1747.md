---
'@adcp/sdk': patch
---

feat(server): `assertNoExampleTlds` helper + wire into hello\_\* examples (#1747)

Adopters who fork a `hello_*_adapter_*.ts` worked example sometimes ship
without flipping `KNOWN_PUBLISHERS = ['acmeoutdoor.example', ...]` and
similar seed constants from the FORK CHECKLIST. The header reminder is
easy to miss; the result is `.example`-TLD seed data leaking into
production tenant directories.

`assertNoExampleTlds(constants, opts?)` turns the reminder into a runtime
assertion. Called at module load with the load-bearing constants, it
throws a descriptive error before the server starts serving traffic when:

- any string value or string-array element ends with `.example`
  (case-insensitive), AND
- `NODE_ENV` is not in the allowlist (default `['test', 'development']`).

Gating uses an exact-match allowlist rather than `NODE_ENV !== 'production'`
so unset or typo'd `NODE_ENV` fails closed.

Usage:

```ts
import { assertNoExampleTlds } from '@adcp/sdk/server';

const KNOWN_PUBLISHERS = ['acmeoutdoor.example', 'premium-sports.example'];

// Fail fast when this fork still ships with `.example`-TLD seed data
// outside of dev/test.
assertNoExampleTlds({ KNOWN_PUBLISHERS });
```

Custom allowlist (e.g., to permit a staging environment):

```ts
assertNoExampleTlds({ KNOWN_PUBLISHERS }, { allowIn: ['test', 'development', 'staging'] });
```

The helper scans string values and string-array elements; numbers,
booleans, and nested objects are ignored so adjacent module constants
can be passed without curating. `.example.com` (RFC 2606 reserved
second-level domain — legitimate in demo URLs) is NOT flagged; only
the bare `.example` TLD is the smell we guard against.

Wired into the five worked examples that ship `.example`-TLD seed
constants:

- `examples/hello_creative_adapter_ad_server.ts` (`KNOWN_PUBLISHERS`)
- `examples/hello_seller_adapter_guaranteed.ts` (`KNOWN_PUBLISHERS`)
- `examples/hello_seller_adapter_non_guaranteed.ts` (`KNOWN_PUBLISHERS`)
- `examples/hello_seller_adapter_proposal_mode.ts` (`KNOWN_PUBLISHERS`)
- `examples/hello_seller_adapter_social.ts` (`KNOWN_ADVERTISERS`)
