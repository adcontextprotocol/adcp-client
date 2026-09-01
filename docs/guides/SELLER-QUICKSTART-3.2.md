# Build an AdCP 3.2 seller in 15 minutes

The compact lifecycle is the SDK 14 starting point. Use Node.js
`^20.19.0 || >=22.12.0`:

```text
list_products → buy_products → control_media_buy
             ↘ request_proposals → refine_proposals → accept_proposal
```

Scaffold the PostgreSQL-backed path and run its diagnostics:

```bash
npx --package '@adcp/sdk@^14.0.0-0' adcp init seller \
  --specialism sales-non-guaranteed --backend postgres --dir my-seller
cd my-seller
npm install
cp .env.example .env
```

Edit `.env` before running anything: set a long random `ADCP_AUTH_TOKEN`, the
single account that token is allowed to use in `ADCP_ACCOUNT_ID`, a reachable
`DATABASE_URL`, a unique lowercase `ADCP_DEPLOYMENT_NAMESPACE` (24 characters
or fewer), and your real canonical `PRODUCT_CATALOG_JSON`. The generated `dev`,
`migrate`, and `doctor` scripts load `.env`. The scaffold's `.gitignore`
excludes `.env`, `node_modules/`, and `dist/`; keep those rules when merging
the scaffold into another repository.

```bash
npm run migrate
npm run doctor
npm run dev
```

For a single-process learning loop, copy
[`examples/seller-3.2-starter.ts`](../../examples/seller-3.2-starter.ts) into
your application. It is a complete, typed seller under 200 lines. It reads
real canonical products from `PRODUCT_CATALOG_JSON`; an absent catalog produces
an honest empty list, never fallback inventory.

```bash
npm install '@adcp/sdk@^14.0.0-0'
export ADCP_AUTH_TOKEN='replace-with-a-secret'
export ADCP_ACCOUNT_ID='replace-with-the-authorized-account'
# Supply canonical products from your catalog; [] is an honest empty response,
# not a purchasable demo catalog.
export PRODUCT_CATALOG_JSON='[...]'
npx tsx seller-3.2-starter.ts
```

Both paths demonstrate the direct lifecycle, feed-version fencing,
idempotency, revision-based control, account resolution, and structured errors.
The single-file learning starter uses in-memory state; the generated PostgreSQL
project persists media buys with revision CAS and uses durable task and
idempotency stores.

Next:

1. Return canonical products from your database or upstream API.
2. Persist media buys and revisions transactionally.
3. Add `requestProposals`, `refineProposals`, `declineProposals`, and
   `acceptProposal` if your seller negotiates terms.
4. Follow the [production durability checklist](./PRODUCTION-DURABILITY.md).
5. Run the [conformance suite](./CONFORMANCE.md).

The large `hello_*` adapters remain useful as certification references, but
they are not the first-run tutorial. See [Build an agent](./BUILD-AN-AGENT.md)
for the complete framework surface.

## What the package verifies

Release checks resolve every documentation link in the packed npm artifact and
compile every shipped TypeScript example against installed public exports. The
clean-room execution smoke starts the compact starter and scaffolds, installs,
and builds a PostgreSQL project. Advanced adapters have their own focused CI
tests; they are not all started in the clean-room smoke because many require a
real upstream service or deployment-specific credentials.
