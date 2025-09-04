# MCP Protocol Testing Guide

## Overview

This guide explains how to test the fixed MCP implementation and verify that MCP requests/responses are properly logged in the debug panel.

## What Was Fixed

### 1. **MCP Protocol Compliance**

**Fixed MCP Handshake Flow:**
- Added proper `initialize` → `initialized` notification sequence
- Fixed JSON-RPC 2.0 format compliance
- Corrected parameter structures for MCP methods

**Fixed JSON-RPC Issues:**
- `tools/list` now sends proper empty request (no params)
- `tools/call` uses correct parameter nesting: `{ name, arguments }`
- Added proper error handling for common MCP error codes

### 2. **Enhanced Session Management**

**Session ID Handling:**
- Properly capture and reuse MCP session IDs across requests
- Track protocol version negotiation
- Maintain session state throughout MCP conversation

### 3. **Improved Debug Logging**

**Enhanced Request/Response Capture:**
- Added detailed MCP method tracking
- Parse and log MCP JSON-RPC responses
- Include timing and success/failure information
- Better error context with MCP-specific error codes

**SSE Parsing Improvements:**
- Handle multi-line SSE data properly
- Support both SSE and direct JSON response formats
- Parse event types and data content correctly

## Testing the MCP Implementation

### Step 1: Start the Test MCP Server

```bash
# Terminal 1: Start the test MCP server
npm run test-mcp-server

# Should output:
# 🔧 Test MCP Server running on http://127.0.0.1:3001
# 📋 MCP endpoint: http://127.0.0.1:3001/mcp
# 🛠️ Available tools: get_products, create_media_buy
```

### Step 2: Configure Environment

Create a `.env` file:

```bash
cp .env.example .env
```

The example config includes a local test MCP agent:
```json
{
  "agents": [
    {
      "id": "test_mcp_local",
      "name": "Local Test MCP Server", 
      "agent_uri": "http://127.0.0.1:3001/mcp",
      "protocol": "mcp",
      "requiresAuth": false
    }
  ]
}
```

### Step 3: Start the Main Testing Framework

```bash
# Terminal 2: Start the main server
npm run dev-legacy

# Should output:
# 🚀 AdCP Testing Framework running on http://127.0.0.1:3000
# 📡 Configured agents: 1
#   - Local Test MCP Server (MCP) at http://127.0.0.1:3001/mcp
```

### Step 4: Test MCP Protocol

1. **Open the Web UI:** http://127.0.0.1:3000
2. **Run a test** with the following:
   - **Agent:** Select "Local Test MCP Server"
   - **Brand Story:** "Eco-friendly cleaning products for health-conscious families"
   - **Tool:** get_products

### Step 5: Verify Debug Logs

After running the test, check the debug panel for:

#### **MCP Request Logs**
```json
{
  "timestamp": "2024-XX-XX...",
  "type": "request",
  "protocol": "MCP",
  "mcp_method": "initialize",
  "request_id": 1,
  "http_method": "POST",
  "url": "http://127.0.0.1:3001/mcp",
  "headers": {...},
  "body": "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",...}",
  "session_id": null
}
```

#### **MCP Response Logs**
```json
{
  "timestamp": "2024-XX-XX...",
  "type": "response", 
  "protocol": "MCP",
  "mcp_method": "initialize",
  "mcp_response_type": "success",
  "request_id": 1,
  "response_id": 1,
  "status": 200,
  "success": true,
  "duration_ms": 45,
  "parsed_response": {...}
}
```

#### **MCP Info Logs**
```json
{
  "type": "info",
  "protocol": "MCP", 
  "message": "MCP session initialized successfully",
  "tools": [
    {"name": "get_products", "description": "..."},
    {"name": "create_media_buy", "description": "..."}
  ]
}
```

## Expected MCP Flow

The correct MCP protocol flow should show these steps in the debug logs:

1. **Initialize Request** (`method: "initialize"`)
2. **Initialize Response** (with server capabilities)
3. **Initialized Notification** (`method: "notifications/initialized"`)
4. **Tools List Request** (`method: "tools/list"`)
5. **Tools List Response** (with available tools)
6. **Tool Call Request** (`method: "tools/call"`)
7. **Tool Call Response** (with results)

## Common MCP Errors Fixed

### Error -32602: Invalid Request Parameters
**Before:** MCP servers rejected requests due to wrong parameter format
**After:** Proper JSON-RPC 2.0 parameter structure

### Error -32601: Method Not Found  
**Before:** MCP handshake not completed properly
**After:** Full initialize → initialized → tools/list flow

### Missing Debug Logs
**Before:** SSE responses consumed without logging
**After:** Enhanced logging with MCP method tracking and response parsing

## Testing with Real MCP Servers

To test with real MCP servers, update your `.env` file:

```bash
SALES_AGENTS_CONFIG='{"agents": [{"id": "real_mcp_agent", "name": "Production MCP Agent", "agent_uri": "https://your-mcp-server.com/mcp", "protocol": "mcp", "auth_token_env": "your-auth-token", "requiresAuth": true}]}'
```

## Troubleshooting

### No Debug Logs Appearing
- Check that `USE_REAL_AGENTS=true` in your `.env` file
- Verify the MCP server is running and accessible
- Check browser network tab for failed requests

### MCP Initialize Fails
- Verify the MCP server endpoint is correct
- Check if authentication is required
- Ensure the server supports MCP protocol version `2024-11-05`

### Tools List Empty
- Verify MCP session initialization completed successfully
- Check if the MCP server implements the `tools/list` method
- Review server logs for any errors

## Verification Checklist

- [ ] Test MCP server starts without errors
- [ ] Main server detects MCP agent configuration  
- [ ] Initialize request/response logged with correct JSON-RPC format
- [ ] Initialized notification sent successfully
- [ ] Tools list request returns available tools
- [ ] Tool call executes and returns data
- [ ] All MCP requests/responses visible in debug panel
- [ ] Error handling works for invalid requests
- [ ] Session management maintains consistency across requests

The fixed implementation now provides comprehensive visibility into the MCP protocol flow and properly handles all aspects of MCP session management and communication.