# AdCP Client

## For AI Agents Building on AdCP

**Start here**: Read `docs/llms.txt` for a complete protocol overview
(all tools, types, error codes, examples — single fetch).

**Do NOT read these files** — they are machine-generated and will waste
your context: `src/lib/types/*.generated.ts`, `src/lib/agents/index.generated.ts`, `schemas/`

**Use instead**: `docs/TYPE-SUMMARY.md` for curated type signatures.

**Key entry points**: `src/lib/index.ts`, `examples/signals-agent.ts`

**Building a server-side agent?** Read `docs/guides/BUILD-AN-AGENT.md`. Storyboards live at `https://adcontextprotocol.org/compliance/{version}/` (pulled into `compliance/cache/{version}/` by `npm run sync-schemas`).

**Validating a server-side agent?** Read `docs/guides/VALIDATE-YOUR-AGENT.md` — the five-command checklist plus deep references for `adcp storyboard run`, `adcp fuzz` (T1/T2/T3), `adcp grade request-signing`, multi-instance testing, webhook conformance, schema-driven validation hooks, custom `--invariants`, the `npm run compliance:skill-matrix` dogfood harness, and how to read the runner's `context_value_rejected` diagnostics (the `💡 Hint:` lines printed on failing storyboard steps).

**Calling an AdCP agent as a buyer?** Read and follow `skills/call-adcp-agent/SKILL.md` — covers the wire contract, minimal payload shapes, async flow, and error recovery so you don't stall on `oneOf`/discriminated-union fields that schema-free tool discovery won't explain. Significantly reduces the hop count an LLM needs to make its first successful call (3-4 attempts → 1 attempt on common tools in empirical comparison).

**Building a seller agent?** Read and follow `skills/build-seller-agent/SKILL.md` — covers guaranteed vs non-guaranteed, pricing, approval workflows, creative management.

**Building a generative seller / AI ad network?** Read and follow `skills/build-generative-seller-agent/SKILL.md` — covers brief-based creative generation, standard + generative format catalogs, brand resolution.

**Building a signals agent?** Read and follow `skills/build-signals-agent/SKILL.md` — covers marketplace vs owned data, segments, pricing, activation destinations.

**Building a retail media network?** Read and follow `skills/build-retail-media-agent/SKILL.md` — covers catalog sync, conversion tracking, performance feedback, dynamic ads.

**Building a creative agent?** Read and follow `skills/build-creative-agent/SKILL.md` — covers ad servers, creative management platforms, format discovery, preview, and build.

**Building a governance agent?** Read and follow `skills/build-governance-agent/SKILL.md` — covers campaign governance (spending authority, approval/denial), property lists, content standards.

**Building a sponsored intelligence agent?** Read and follow `skills/build-si-agent/SKILL.md` — covers offering discovery, session lifecycle, conversational sponsored content.

**Building a brand rights agent?** Read and follow `skills/build-brand-rights-agent/SKILL.md` — covers brand identity, rights licensing, creative approval.

### Specialism → Skill Index

Pick the specialisms you want to claim in `get_adcp_capabilities`. Each maps to a compliance storyboard at `compliance/cache/latest/specialisms/<id>/`. The skill below has a dedicated section for each specialism's deltas.

| Specialism                    | Protocol   | Status  | Skill                                                                                                                                                                                                                                                                                                                      |
| ----------------------------- | ---------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sales-guaranteed`            | media-buy  | stable  | `skills/build-seller-agent/`                                                                                                                                                                                                                                                                                               |
| `sales-non-guaranteed`        | media-buy  | stable  | `skills/build-seller-agent/`                                                                                                                                                                                                                                                                                               |
| `sales-broadcast-tv`          | media-buy  | stable  | `skills/build-seller-agent/`                                                                                                                                                                                                                                                                                               |
| `sales-streaming-tv`          | media-buy  | preview | `skills/build-seller-agent/`                                                                                                                                                                                                                                                                                               |
| `sales-social`                | media-buy  | stable  | `skills/build-seller-agent/`                                                                                                                                                                                                                                                                                               |
| `sales-exchange`              | media-buy  | preview | `skills/build-seller-agent/`                                                                                                                                                                                                                                                                                               |
| `sales-catalog-driven`        | media-buy  | stable  | `skills/build-retail-media-agent/`                                                                                                                                                                                                                                                                                         |
| `sales-retail-media`          | media-buy  | preview | `skills/build-retail-media-agent/`                                                                                                                                                                                                                                                                                         |
| `sales-proposal-mode`         | media-buy  | stable  | `skills/build-seller-agent/`                                                                                                                                                                                                                                                                                               |
| `audience-sync`               | media-buy  | stable  | `skills/build-seller-agent/` (track: `audiences`; uses `sync_audiences`, `list_accounts`)                                                                                                                                                                                                                                  |
| `signed-requests`             | media-buy  | preview | **Cross-cutting** — applies to any agent that receives mutating requests, regardless of primary specialism. The yaml classifies it under `media-buy` because that's where financial stakes are highest, but the verifier behavior is identical across all protocols. See `skills/build-seller-agent/` (§ signed-requests). |
| `creative-ad-server`          | creative   | stable  | `skills/build-creative-agent/`                                                                                                                                                                                                                                                                                             |
| `creative-template`           | creative   | stable  | `skills/build-creative-agent/`                                                                                                                                                                                                                                                                                             |
| `creative-generative`         | creative   | stable  | `skills/build-creative-agent/` or `skills/build-generative-seller-agent/` (if you also sell inventory)                                                                                                                                                                                                                     |
| `signal-marketplace`          | signals    | stable  | `skills/build-signals-agent/`                                                                                                                                                                                                                                                                                              |
| `signal-owned`                | signals    | stable  | `skills/build-signals-agent/`                                                                                                                                                                                                                                                                                              |
| `governance-spend-authority`  | governance | stable  | `skills/build-governance-agent/`                                                                                                                                                                                                                                                                                           |
| `governance-delivery-monitor` | governance | stable  | `skills/build-governance-agent/`                                                                                                                                                                                                                                                                                           |
| `property-lists`              | governance | stable  | `skills/build-governance-agent/`                                                                                                                                                                                                                                                                                           |
| `collection-lists`            | governance | stable  | `skills/build-governance-agent/` (program-level brand safety via IMDb/Gracenote/EIDR IDs)                                                                                                                                                                                                                                  |
| `content-standards`           | governance | stable  | `skills/build-governance-agent/`                                                                                                                                                                                                                                                                                           |
| `measurement-verification`    | governance | preview | `skills/build-governance-agent/`                                                                                                                                                                                                                                                                                           |
| `brand-rights`                | brand      | stable  | `skills/build-brand-rights-agent/`                                                                                                                                                                                                                                                                                         |

**Naming conventions:** specialism IDs are kebab-case (`sales-broadcast-tv`). Storyboard category IDs in `index.yaml` are snake_case (`media_buy_broadcast_seller`). Yaml titles are prose ("Broadcast linear TV seller agent"). Same concept, three names — don't confuse them.

**`protocol:` vs `domain:`.** The specialism yaml uses `protocol:` (renamed from `domain:` in AdCP 3.0 GA). If you see older docs or issues reference `domain:`, they mean the same thing.

**Preview specialisms** have `phases: []` in their `index.yaml` — the storyboard is a placeholder and the agent passes the protocol baseline only. Claim a preview specialism to advertise intent; expect `phases` to populate in a subsequent AdCP release.

**Adding wire-version compat (e.g. SDK pin moves to v4, or a new legacy seller version)?** See [`docs/development/WIRE-VERSION-COMPAT.md`](./docs/development/WIRE-VERSION-COMPAT.md) — playbook for the schema cache, codegen, adapter registry, validation pinning, conformance fixtures, and smoke harness. Reference whenever you touch `src/lib/adapters/legacy/`, `src/lib/types/v*-*/`, or `schemas/cache/<version>/`.

**Migrating from 4.x?** See [`docs/migration-4.x-to-5.x.md`](./docs/migration-4.x-to-5.x.md) for the full 4.x → 5.x path. Covers framework shape (5.0's `TaskResult` discriminated union + `createAdcpServer`), exports cleanup (5.1's `platform_type` removal + storyboard-tarball move), AdCP 3.0 GA alignment (5.2's `authority_level` → `human_review_required`, `inventory-lists` → `property-lists`, `idempotency_key` requirement, `serve({ authenticate })` surface), downstream ergonomics (5.3–5.4 `AdcpServer` return type + `dispatchTestRequest`), signed-requests composition (5.5–5.6 `requireSignatureWhenPresent` + `capabilities.overrides`), conformance runner wiring (5.7 `createExpressAdapter`), conformance defaults (5.8 `createComplyController`), A2A session continuity + typed errors (5.9), OAuth client credentials + strict validation defaults (5.10), and the pin to AdCP 3.0.0 GA (5.13: `ADCP_VERSION` switched from `latest` to the published `3.0.0` release; `validate_property_delivery` response is now wired to its generated schema). Includes a wire-interop matrix for mixed-version (beta.3 / rc.2 / GA) traffic.

**Protocol-Wide Requirements.** Two requirements apply to every mutating AdCP operation regardless of specialism:

- **`idempotency_key`** — required on every mutating request. Applies to every tool marked as mutating in the spec (the SDK's `MUTATING_TASKS` constant is authoritative): `create_media_buy`, `update_media_buy`, `sync_accounts`, `sync_creatives`, `sync_audiences`, `sync_catalogs`, `sync_event_sources`, `sync_plans`, `sync_governance`, `provide_performance_feedback`, `acquire_rights`, `activate_signal`, `log_event`, `report_usage`, `report_plan_outcome`, `create_property_list` / `update_property_list` / `delete_property_list`, `create_collection_list` / `update_collection_list` / `delete_collection_list`, `create_content_standards` / `update_content_standards` / `calibrate_content`, `si_initiate_session` / `si_send_message`. Handlers must return the same response when the same key is replayed. Landed in AdCP 3.0 GA.
- **RFC 9421 HTTP Signatures** — optional but recommended. If you claim `signed-requests`, you verify incoming signatures; regardless, you must not break when signature headers are present.

**Critical rules**:

- ALWAYS create a changeset (`npm run changeset`) for ANY library/CLI code change before pushing a PR. This is mandatory — do not wait to be asked.
- ALWAYS use official `@a2a-js/sdk` and `@modelcontextprotocol/sdk` clients — never custom HTTP or SSE parsing
- NEVER inject mock/fallback data — return exactly what agents provide
- NEVER hardcode API keys, tokens, or credentials — use environment variables
- NEVER manually edit `package.json` version — use `npm run changeset`

**When a compliance storyboard fails, triage before patching.** Storyboards are assertions, not ground truth. Before changing the SDK to satisfy a failing assertion, ask: _does the AdCP spec define this contract?_ Check `schemas/cache/{version}/` and the spec repo (`adcontextprotocol/adcp`). If the spec defines the behavior, fix the SDK — the storyboard is doing its job surfacing drift. If the spec is silent or contradicts the assertion, the storyboard is the bug: file an issue on `adcontextprotocol/adcp`. Don't bake storyboard opinion into SDK behavior — that compounds drift across the ecosystem and turns the SDK into a mirror of whichever storyboard was authored most recently.

**Full agent instructions**: [AGENTS.md](./AGENTS.md) has protocol details, architecture patterns, and testing strategies.

---

## Development & Release Guide

**@adcp/sdk** is the official TypeScript client library for the Ad Context Protocol (AdCP), with CLI tooling for testing agents.

## NPM Publishing & Release Management

### 🚨 AUTOMATED RELEASE PROCESS 🚨

**IMPORTANT**: This project uses **Changesets** for version management and releases.

### 📦 When to Create a Changeset

**ALWAYS create a changeset for:**

- ✅ Library code changes (`src/lib/`)
- ✅ CLI changes (`bin/`)
- ✅ Published files (anything in `package.json` `files` field)
- ✅ Schema changes (`src/schemas/`)
- ✅ TypeScript types changes

**NO changeset needed for:**

- ❌ Documentation only (`*.md` files, except CHANGELOG.md)
- ❌ Development tooling (`conductor.json`, `.github/workflows/`)
- ❌ Test files only (no behavior changes)
- ❌ Configuration files (`.eslintrc`, `tsconfig.json`, etc.)

**Why CLI changes need changesets:**
The CLI (`bin/adcp.js`) is bundled with the npm package. Users who run `npx @adcp/sdk@latest` or install the package globally need version bumps to get CLI fixes. Without a changeset, the fix won't be published to npm.

### 🚨 REQUIRED: Make Changeset Check a Required Status Check 🚨

The CI workflow includes a `Changeset Check` job that validates changesets are included for library changes. However, this check must be marked as **required** in GitHub repository settings to prevent PRs from merging without changesets.

**To configure (repository admin only):**

1. Go to: `Settings` → `Branches` → `main` branch protection rules
2. Under "Require status checks to pass before merging", enable:
   - ✅ `Changeset Check`
3. Save changes

**Verification**: After configuration, PRs that modify library code without a changeset will be blocked from merging.

**What happened when this wasn't configured:**

- PR #65 modified `src/lib/protocols/a2a.ts` and `src/lib/protocols/mcp.ts`
- The `Changeset Check` job correctly failed
- However, the PR was allowed to merge because the check wasn't required
- No Release PR was triggered because no changeset existed
- Had to manually create and merge a changeset in a follow-up PR

### 🚨 CRITICAL: Never Manually Edit package.json Version! 🚨

**DO NOT** manually change the `version` field in `package.json` - changesets will handle this automatically.

**What happened when we broke this rule:**

- We manually bumped `package.json` from 2.0.2 to 2.1.0 (to match AdCP schema version)
- Changesets calculated: 2.1.0 + minor changeset = **2.2.0** (WRONG!)
- We skipped version 2.1.0 entirely
- Had to revert package.json to 2.0.2 and let changesets correctly calculate 2.0.2 → 2.1.0

**The correct separation:**

- `package.json` version = **Library version** (managed by changesets)
- `src/lib/version.ts` ADCP_VERSION = **AdCP schema version** (can differ from library version)
- These are independent and serve different purposes!

### How It Works

1. **Create a changeset for your changes**:

   ```bash
   npm run changeset
   ```

   This will prompt you to:
   - Select the version bump type (patch/minor/major)
   - Write a summary of the changes
   - Create a markdown file in `.changeset/`

2. **Commit the changeset with your code**:

   ```bash
   git add .changeset/
   git commit -m "feat: add new feature"
   git push
   ```

3. **Create a PR and merge to main**:
   - Create PR from your feature branch
   - **Do NOT manually edit package.json version**
   - Merge PR to main when approved

4. **GitHub Actions creates a Release PR automatically**:
   - **Triggered by**: Push to main with changeset files
   - **PR title**: "chore: release package"
   - **What it does**:
     - Automatically updates CHANGELOG.md
     - Automatically bumps version in package.json
     - Combines all changesets since last release
     - Deletes changeset files
   - **No new branch needed**: The Release PR is auto-created by GitHub Actions

5. **Review and merge the Release PR**:
   - Check the generated CHANGELOG.md
   - Verify version bump is correct (e.g., 2.0.2 → 2.1.0)
   - **Important**: Verify it's not skipping versions!
   - Merge when ready to release

6. **Automatic publishing**:
   - Merging Release PR triggers publish workflow
   - GitHub Actions publishes to npm automatically
   - Package appears on npm registry within ~1 minute
   - Verify: `npm view @adcp/sdk version`

### Version Bump Guidelines

| Type    | When to Use                        | Example       |
| ------- | ---------------------------------- | ------------- |
| `patch` | Bug fixes, minor improvements      | 2.0.1 → 2.0.2 |
| `minor` | New features, non-breaking changes | 2.0.1 → 2.1.0 |
| `major` | Breaking changes                   | 2.0.1 → 3.0.0 |

### Creating Changesets

**For a single change:**

```bash
npm run changeset
# Select: patch/minor/major
# Write: "fix: resolve authentication issue"
```

**For multiple changes in one PR:**

```bash
npm run changeset  # First change
npm run changeset  # Second change
# Commit all changesets together
```

### Changeset Examples

**Bug Fix (patch):**

```bash
npm run changeset
# Select: patch
# Summary: "Fixed MCP structuredContent parsing for stringified JSON"
```

**New Feature (minor):**

```bash
npm run changeset
# Select: minor
# Summary: "Added webhook signature verification support"
```

**Breaking Change (major):**

```bash
npm run changeset
# Select: major
# Summary: "Removed deprecated Agent class, use AdCPClient instead"
```

### Verification Commands

```bash
# Check current version
npm version

# View changesets that haven't been released
ls .changeset/*.md

# Check npm package versions
npm view @adcp/sdk versions

# View release history
gh release list

# Monitor release workflow
gh run list --workflow=release.yml
```

### Emergency Manual Release (Use ONLY if automated process fails)

**Prerequisite**: You must be logged in to npm locally (`npm login`).

```bash
# 1. Version packages
npm run version

# 2. Publish to npm
npm run release

# 3. Create GitHub release
gh release create v$(node -p "require('./package.json').version") --generate-notes
```

**Remember**: Always create a changeset for library changes. The automation handles the rest.

**Note**: CI uses OIDC publishing (no NPM_TOKEN needed). The package is linked to this GitHub repo on npm for tokenless publishing.

### Troubleshooting

#### Release PR is calculating wrong version (skipping versions)

**Symptom**: Release PR says it will publish 2.2.0 but we're at 2.0.2 (skipping 2.1.0)

**Cause**: Someone manually edited `package.json` version field

**Fix**:

1. Close the incorrect Release PR
2. Create a fix PR to revert `package.json` to the current npm version:

   ```bash
   # Check what's on npm
   npm view @adcp/sdk version  # e.g., 2.0.2

   # Edit package.json to match npm version
   # Edit src/lib/version.ts LIBRARY_VERSION to match
   # Keep ADCP_VERSION at its correct value

   git add package.json src/lib/version.ts
   git commit -m "fix: revert library version to match npm"
   git push
   ```

3. Merge the fix PR to main
4. GitHub Actions will create a new Release PR with correct version
5. Merge the new Release PR

#### No Release PR created after merging to main

**Possible causes**:

- No changeset files in `.changeset/` directory
- Changeset files were not committed
- Release workflow disabled or failing

**Fix**:

```bash
# Check for changesets
ls .changeset/*.md

# If no changesets, create one and merge a new PR
npm run changeset
```

#### Release PR merged but package not published to npm

**Check**:

```bash
# View workflow runs
gh run list --workflow=release.yml --limit 3

# Check if publish failed
gh run view <run-id>
```

**Common issues**:

- Package.json version already exists on npm
- Build failed during publish
- OIDC publishing not configured on npm (check package access settings)

### Quick Reference

**Normal release workflow (no manual version edits needed):**

1. Make changes on feature branch
2. Run `npm run changeset` and commit
3. Create PR and merge to main
4. Wait for auto-generated Release PR
5. Review and merge Release PR
6. Package publishes to npm automatically

**Do NOT do:**

- ❌ Manually edit `package.json` version
- ❌ Manually edit CHANGELOG.md
- ❌ Create release branches manually
- ❌ Run `npm version` command
- ❌ Tag releases manually

**Let changesets handle:**

- ✅ Version bumping
- ✅ CHANGELOG generation
- ✅ Release PR creation
- ✅ Git tags
- ✅ npm publishing

---

_Last updated: 2026-03-13_
_Project: @adcp/sdk_
