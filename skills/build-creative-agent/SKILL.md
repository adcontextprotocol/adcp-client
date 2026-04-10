---
name: build-creative-agent
description: Use when building an AdCP creative agent — an ad server, creative management platform, or any system that accepts, stores, transforms, and serves ad creatives.
---

# Build a Creative Agent

## Overview

A creative agent manages the creative lifecycle: accepts assets from buyers, stores them in a library, builds serving tags, and renders previews. Unlike a generative seller (which also sells inventory), a creative agent is a standalone creative platform — it manages creatives but doesn't sell media.

## When to Use

- User wants to build an ad server, creative management platform, or creative rendering service
- User mentions `build_creative`, `preview_creative`, `sync_creatives`, or `list_creatives`
- User references creative formats, VAST tags, serving tags, or creative libraries

**Not this skill:**

- Selling inventory + generating creatives → `skills/build-generative-seller-agent/`
- Selling inventory (no creative management) → `skills/build-seller-agent/`
- Serving audience segments → `skills/build-signals-agent/`

## Before Writing Code

Determine these things. Ask the user — don't guess.

### 1. What kind of creative platform?

- **Ad server** (Innovid, Flashtalking, CM360) — stateful library, builds serving tags (VAST, display tags), tracks delivery
- **Creative management platform** (Celtra) — format transformation, template rendering, asset management
- **Publisher creative service** — accepts buyer assets, validates against publisher specs, renders previews

### 2. What formats?

Get specific formats the platform supports. Common ones:

- **Display**: `display_300x250`, `display_728x90`, `display_160x600`
- **Video**: `video_30s`, `vast_30s`, `video_15s`
- **Native**: `native_content` (image + headline + description)
- **Rich media**: `html5_300x250` (interactive HTML)

Each format needs: dimensions, accepted asset types (image, video, html, text), mime types.

### 3. What operations?

- **Sync** — accept and store creatives from buyers (always needed)
- **List** — query the creative library with filtering (recommended)
- **Preview** — render a visual preview of a creative (recommended)
- **Build** — produce serving tags (VAST, display tags, etc.) from stored creatives (recommended)

### 4. Review pipeline?

What happens when a creative is synced:

- **Instant accept** — creative passes validation, immediately available
- **Pending review** — human or automated review before going live
- **Rejection** — creative fails validation (wrong dimensions, prohibited content)

## Tools and Required Response Shapes

**`get_adcp_capabilities`** — register first, empty `{}` schema

```
capabilitiesResponse({
  adcp: { major_versions: [3] },
  supported_protocols: ['creative'],
})
```

**`list_creative_formats`** — `ListCreativeFormatsRequestSchema.shape`

```
listCreativeFormatsResponse({
  formats: [{
    format_id: { agent_url: string, id: string },  // required
    name: string,                                    // required
    description: string,
    renders: [{ width: number, height: number }],    // output dimensions
    assets: [{                                       // what the format accepts
      item_type: 'individual',
      asset_id: string,
      asset_type: 'image' | 'video' | 'html' | 'text',
      required: boolean,
      accepted_media_types: string[],                // e.g., ['image/png', 'image/jpeg']
    }],
  }],
})
```

**`sync_creatives`** — `SyncCreativesRequestSchema.shape`

Store creatives in the library. Echo back creative_id and action.

```
syncCreativesResponse({
  creatives: [{
    creative_id: string,              // required — echo from request
    action: 'created' | 'updated',    // required
    status: 'accepted' | 'pending_review' | 'rejected',
  }],
})
```

**`list_creatives`** — `ListCreativesRequestSchema.shape`

Return creatives from the library. Support filtering by format_id.

```
listCreativesResponse({
  query_summary: { total_matching: number, returned: number, filters: [] },
  creatives: [{
    creative_id: string,
    name: string,
    format_id: { agent_url: string, id: string },
    status: 'accepted' | 'pending_review' | 'rejected',
  }],
  pagination: { total: number, offset: 0, limit: 50 },
})
```

The handler should check `args.filters?.format_ids` — if present, return only creatives matching those formats.

**`preview_creative`** — `PreviewCreativeSingleRequestSchema.shape`

Note: `PreviewCreativeRequestSchema` is a union (single/batch/variant) and can't use `.shape`. Use `PreviewCreativeSingleRequestSchema` for single preview support.

Render a preview of a stored creative. Each preview has a `renders` array with output_format discriminator.

```
previewCreativeResponse({
  response_type: 'single',
  previews: [{
    preview_id: string,
    input: { name: string },
    renders: [{
      render_id: string,
      output_format: 'url',         // discriminator: 'url' or 'html'
      preview_url: string,          // URL to rendered preview (for output_format: 'url')
      role: 'primary',
      dimensions: { width: number, height: number },
    }],
  }],
  expires_at: string,              // ISO timestamp
})
```

**`build_creative`** — `BuildCreativeRequestSchema.shape`

Produce a serving tag from a stored creative.

```
buildCreativeResponse({
  creative_manifest: {
    format_id: { agent_url: string, id: string },
    name: string,
    assets: {},              // built output assets
  },
  sandbox: true,
})
```

## SDK Quick Reference

| SDK piece                                               | Usage                                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------- |
| `serve(createAgent)`                                    | Start HTTP server on `:3001/mcp`                                    |
| `createTaskCapableServer(name, version, { taskStore })` | Create MCP server with task support                                 |
| `server.tool(name, Schema.shape, handler)`              | Register tool — `.shape` unwraps Zod                                |
| `capabilitiesResponse(data)`                            | Build `get_adcp_capabilities` response                              |
| `listCreativeFormatsResponse(data)`                     | Build `list_creative_formats` response                              |
| `syncCreativesResponse(data)`                           | Build `sync_creatives` response                                     |
| `listCreativesResponse(data)`                           | Build `list_creatives` response                                     |
| `previewCreativeResponse(data)`                         | Build `preview_creative` response                                   |
| `buildCreativeResponse(data)`                           | Build `build_creative` response                                     |
| `buildCreativeMultiResponse(data)`                      | Build multi-format `build_creative` response                        |
| `taskToolResponse(data, summary)`                       | Build generic tool response (for tools without a dedicated builder) |
| `adcpError(code, { message })`                          | Structured error                                                    |

Schemas: `ListCreativeFormatsRequestSchema`, `SyncCreativesRequestSchema`, `ListCreativesRequestSchema`, `PreviewCreativeSingleRequestSchema`, `BuildCreativeRequestSchema`.

Import everything from `@adcp/client`. Types from `@adcp/client` with `import type`.

## Setup

```bash
npm init -y
npm install @adcp/client
```

## Implementation

1. Single `.ts` file — all tools in one file
2. Always register `get_adcp_capabilities` as the **first** tool with empty `{}` schema
3. Use `Schema.shape` (not `Schema`) when registering tools
4. Use an in-memory Map to store synced creatives (the creative library)
5. Set `sandbox: true` on all mock/demo responses
6. Use `ServeContext` pattern: `function createAgent({ taskStore }: ServeContext)`

The skill contains everything you need. Do not read additional docs before writing code.

### Key implementation detail: creative library

Use a `Map<string, Creative>` to store synced creatives. The `sync_creatives` handler adds/updates entries. The `list_creatives` handler queries the map. The `preview_creative` and `build_creative` handlers look up by `creative_id`.

## Validation

**After writing the agent, validate it. Fix failures. Repeat.**

**Full validation** (if you can bind ports):

```bash
npx tsx agent.ts &
npx @adcp/client storyboard run http://localhost:3001/mcp creative_lifecycle --json
```

**Sandbox validation** (if ports are blocked):

```bash
npx tsc --noEmit agent.ts
```

**Keep iterating until all steps pass.**

## Common Mistakes

| Mistake                                        | Fix                                                                              |
| ---------------------------------------------- | -------------------------------------------------------------------------------- |
| Skip `get_adcp_capabilities`                   | Must be the first tool registered                                                |
| Pass `Schema` instead of `Schema.shape`        | MCP SDK needs unwrapped Zod fields                                               |
| `list_creatives` ignores format filter         | Check `args.filters?.format_ids` and filter results                              |
| `preview_creative` returns wrong response_type | Must be `'single'` for single creative previews                                  |
| `build_creative` missing creative_manifest     | Required field — contains the built output                                       |
| No in-memory store for synced creatives        | `list_creatives` and `preview_creative` need to find previously synced creatives |

## Storyboards

| Storyboard             | Tests                                                            |
| ---------------------- | ---------------------------------------------------------------- |
| `creative_lifecycle`   | Full lifecycle: format discovery → sync → list → preview → build |
| `creative_template`    | Stateless template rendering (build + preview only)              |
| `creative_sales_agent` | Sales agent that accepts pushed assets                           |
| `creative_ad_server`   | Ad server with pre-loaded library                                |

## Reference

- `storyboards/creative_lifecycle.yaml` — full creative lifecycle storyboard
- `docs/guides/BUILD-AN-AGENT.md` — SDK patterns
- `docs/llms.txt` — full protocol reference
