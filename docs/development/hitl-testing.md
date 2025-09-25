# HITL (Human-in-the-Loop) Testing Setup

## Security-First Configuration

This guide explains how to safely configure HITL testing with proper token management.

## Setup Instructions

### 1. Environment Configuration

Copy the environment template:
```bash
cp .env.hitl.template .env.hitl
```

Edit `.env.hitl` with your actual HITL tokens:
```bash
# HITL Server Authentication Tokens
HITL_SYNC_TOKEN=your_sync_token_here
HITL_ASYNC_TOKEN=your_async_token_here
WONDERSTRUCK_TOKEN=your_wonderstruck_token_here
```

### 2. Start HITL Testing

Run the secure startup script:
```bash
./start-with-hitl.sh
```

The script will:
- ✅ Load tokens from `.env.hitl` (git-ignored)
- ✅ Configure three test agents securely
- ✅ Start the server with proper authentication

## Security Features

### ✅ Environment Variable Based
- All tokens loaded from git-ignored `.env.hitl` file
- No hardcoded authentication credentials in source code
- Follows security best practices

### ✅ Fallback Protection  
- Clear error messages if tokens are missing
- Prevents accidental exposure of default tokens
- Environment validation on startup

### ✅ Git Security
- `.env.hitl` is git-ignored by default
- Template file shows required format without real tokens
- GitGuardian compliance assured

## Agent Configuration

The script configures three agents for comprehensive testing:

1. **HITL Sync Principal (MCP)**
   - URL: `http://localhost:8176/mcp/`
   - Token: `HITL_SYNC_TOKEN`
   - Type: 10-second response simulation

2. **HITL Async Principal (MCP)**  
   - URL: `http://localhost:8176/mcp/`
   - Token: `HITL_ASYNC_TOKEN`
   - Type: 125-second async + webhook

3. **Wonderstruck (MCP)**
   - URL: `https://wonderstruck.sales-agent.scope3.com/mcp/`
   - Token: `WONDERSTRUCK_TOKEN`
   - Type: Production agent

## Testing Commands

After setup, you can run comprehensive tests:

```bash
# Protocol comparison test
node test/utils/comprehensive-protocol-comparison.js

# Final status report  
node test/utils/final-status-report.js

# Full test suite
npm test
```

## Troubleshooting

### Missing Token Error
```
Error: HITL_SYNC_TOKEN_NOT_SET
```
**Solution**: Create `.env.hitl` file with actual token values.

### Token Authentication Failure
```
Error: Missing or invalid x-adcp-auth header
```
**Solution**: Verify token values are correct and not expired.

### Permission Denied
```
bash: permission denied: ./start-with-hitl.sh
```
**Solution**: Make script executable:
```bash
chmod +x start-with-hitl.sh
```

## Security Notes

- **Never commit** `.env.hitl` to version control
- **Always use** environment variables for tokens
- **Keep tokens** secure and rotate regularly
- **Validate tokens** before sharing HITL test results

## Production Deployment

For production deployment with secure token management:

```bash
# Set environment variables securely
export HITL_SYNC_TOKEN="your_secure_token"
export HITL_ASYNC_TOKEN="your_secure_token"
export WONDERSTRUCK_TOKEN="your_secure_token"

# Or use your deployment platform's secret management
```

---
✅ **GitGuardian Compliant** - No hardcoded secrets or tokens