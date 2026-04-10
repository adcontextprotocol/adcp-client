---
name: build-si-agent
description: Use when building an AdCP sponsored intelligence agent — a platform that serves conversational sponsored content within user sessions.
---

# Build a Sponsored Intelligence Agent

## Overview

A sponsored intelligence (SI) agent serves conversational sponsored content within user sessions. Buyers discover offerings, initiate sessions, exchange messages, and terminate when done. The agent manages session state and delivers sponsored content in conversational form.

## When to Use

- User wants to build an agent that serves sponsored conversational content
- User mentions sponsored intelligence, SI sessions, conversational ads, or sponsored chat
- User references `si_initiate_session`, `si_send_message`, or the SI protocol

**Not this skill:**

- Selling display/video inventory → `skills/build-seller-agent/`
- Serving audience segments → `skills/build-signals-agent/`
- Managing creatives → `skills/build-creative-agent/`

## Before Writing Code

### 1. What Offerings?

Each offering represents a sponsored content experience. Define:

- Product/brand being sponsored
- Content style (informational, promotional, interactive)
- Supported modalities: conversational (text), rich_media (images/video)

### 2. Session Behavior

How should the agent respond during a session?

- **Informational** — answers questions about the sponsored product
- **Promotional** — proactively highlights features and benefits
- **Interactive** — guided product exploration with branching content

## Tools and Required Response Shapes

**`get_adcp_capabilities`** — register first, empty `{}` schema

```
capabilitiesResponse({
  adcp: { major_versions: [3] },
  supported_protocols: ['sponsored_intelligence'],
})
```

**`si_get_offering`** — `SIGetOfferingRequestSchema.shape`

Check if an offering is available. Return `available: true` with an `offering_token` the buyer passes to `si_initiate_session`.

```
taskToolResponse({
  available: true,            // required — boolean
  offering_token: string,     // token for session initiation
  ttl_seconds: 300,           // how long the token is valid
})
```

**`si_initiate_session`** — `SIInitiateSessionRequestSchema.shape`

Create a new session. Return `session_id` and `session_status`.

```
taskToolResponse({
  session_id: string,         // required — unique session identifier
  session_status: 'active',   // required — NB: 'session_status' not 'status'
})
```

**`si_send_message`** — `SISendMessageRequestSchema.shape`

Process a user message and return sponsored content.

```
taskToolResponse({
  session_id: string,         // required — echo from request
  session_status: 'active',   // required
  response: {
    content: string,          // the sponsored content text
    content_type: 'text',
  },
})
```

**`si_terminate_session`** — `SITerminateSessionRequestSchema.shape`

End the session.

```
taskToolResponse({
  session_id: string,         // required — echo from request
  terminated: true,           // required — boolean confirming termination
})
```

## SDK Quick Reference

| SDK piece                                               | Usage                                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------- |
| `serve(createAgent)`                                    | Start HTTP server on `:3001/mcp`                                    |
| `createTaskCapableServer(name, version, { taskStore })` | Create MCP server with task support                                 |
| `server.tool(name, Schema.shape, handler)`              | Register tool — `.shape` unwraps Zod                                |
| `capabilitiesResponse(data)`                            | Build `get_adcp_capabilities` response                              |
| `taskToolResponse(data, summary)`                       | Build tool response (used for all SI tools)                         |

Schemas: `SIGetOfferingRequestSchema`, `SIInitiateSessionRequestSchema`, `SISendMessageRequestSchema`, `SITerminateSessionRequestSchema`.

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
4. Use an in-memory Map to store active sessions
5. Track session state: active → terminated
6. Use `ServeContext` pattern: `function createAgent({ taskStore }: ServeContext)`

The skill contains everything you need. Do not read additional docs before writing code.

## Validation

```bash
npx tsx agent.ts &
npx @adcp/client storyboard run http://localhost:3001/mcp si_session --json
```

**Keep iterating until all steps pass.**

## Common Mistakes

| Mistake                                              | Fix                                                                    |
| ---------------------------------------------------- | ---------------------------------------------------------------------- |
| Returns `status` instead of `session_status`         | Field name is `session_status` — `status` will fail schema validation  |
| Returns `status: 'terminated'` instead of `terminated: true` | Termination response uses boolean `terminated` field          |
| Missing `session_id` in si_send_message response     | Echo `session_id` back from request — required                         |
| Missing `available` in si_get_offering               | Boolean `available` is required — even for mock data                   |
| Missing `reason` in si_terminate_session request     | `reason` is required — one of: `user_exit`, `session_timeout`, `host_terminated`, `handoff_transaction`, `handoff_complete` |

## Storyboards

| Storyboard    | Tests                                                            |
| ------------- | ---------------------------------------------------------------- |
| `si_session`  | Full session lifecycle: offering → initiate → message → terminate |

## Reference

- `storyboards/si_session.yaml` — full SI session storyboard
- `docs/guides/BUILD-AN-AGENT.md` — SDK patterns
- `docs/llms.txt` — full protocol reference
