/**
 * Example: Using OAuth with the ADCP client
 *
 * OAuth tokens are stored directly in the AgentConfig,
 * same place as static auth tokens.
 */

import { Client as MCPClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import {
  createCLIOAuthProvider,
  hasValidOAuthTokens,
  clearOAuthTokens,
  getEffectiveAuthToken,
} from '../src/lib/auth/oauth';
import type { AgentConfig } from '../src/lib/types/adcp';

// Example: Agent configured for OAuth
const agent: AgentConfig = {
  id: 'scope3-snapadcp',
  name: 'Scope3 SnapAdCP',
  agent_uri: process.argv[2] || 'https://snapadcp.scope3.com/mcp',
  protocol: 'mcp',
  // Static token alternative (uncomment to use instead of OAuth):
  // auth_token: 'your-api-key-here',
  //
  // After OAuth flow completes, these fields are populated:
  // oauth_tokens: { access_token: '...', refresh_token: '...' }
  // oauth_client: { client_id: '...' }
};

async function main() {
  console.log('ADCP OAuth Example');
  console.log('==================');
  console.log(`Agent: ${agent.name}`);
  console.log(`URI: ${agent.agent_uri}`);
  console.log(`Has OAuth tokens: ${hasValidOAuthTokens(agent)}`);
  console.log(`Has static token: ${!!agent.auth_token}`);
  console.log('');

  // Create OAuth provider - tokens stored in agent config
  const provider = createCLIOAuthProvider(agent);

  // Create MCP client
  const client = new MCPClient({
    name: 'adcp-oauth-example',
    version: '1.0.0',
  });

  // Helper to create transport with OAuth provider
  const createTransport = () =>
    new StreamableHTTPClientTransport(new URL(agent.agent_uri), {
      authProvider: provider,
    });

  let transport = createTransport();

  try {
    console.log('Connecting...');
    await client.connect(transport);
    console.log('Connected!');
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      console.log('');
      console.log('OAuth authorization required.');
      console.log('Opening browser...');

      try {
        // Wait for user to complete OAuth in browser
        const code = await provider.waitForCallback();
        console.log('Authorization received!');

        // Finish OAuth flow to exchange code for tokens
        await transport.finishAuth(code);

        // Show that tokens are now in agent config
        console.log('');
        console.log('OAuth tokens saved to agent config:');
        console.log(`  access_token: ${agent.oauth_tokens?.access_token ? '***' : 'none'}`);
        console.log(`  refresh_token: ${agent.oauth_tokens?.refresh_token ? '***' : 'none'}`);
        console.log(`  expires_at: ${agent.oauth_tokens?.expires_at || 'unknown'}`);

        // Create new transport and reconnect (tokens are now available)
        console.log('');
        console.log('Reconnecting with tokens...');
        transport = createTransport();
        await client.connect(transport);
        console.log('Connected!');
      } catch (authError) {
        console.error('OAuth failed:', authError);
        await provider.cleanup();
        process.exit(1);
      }
    } else {
      console.error('Connection failed:', error);
      await provider.cleanup();
      process.exit(1);
    }
  }

  // List available tools
  try {
    console.log('');
    console.log('Listing tools...');
    const result = await client.request({ method: 'tools/list', params: {} }, { tools: [] } as any);

    console.log('Available tools:');
    for (const tool of (result as any).tools || []) {
      console.log(`  - ${tool.name}`);
    }
  } catch (error) {
    console.error('Failed to list tools:', error);
  }

  // Clean up
  await provider.cleanup();
  await client.close();

  // Show final agent config (for saving to file/db)
  console.log('');
  console.log('Final agent config (save this to persist OAuth tokens):');
  console.log(JSON.stringify(agent, null, 2));
}

// Utility: clear tokens and re-auth
async function clearAndReauth() {
  console.log('Clearing OAuth tokens...');
  clearOAuthTokens(agent);
  console.log('Tokens cleared. Run again to re-authenticate.');
}

// Entry point
const command = process.argv[2];
if (command === '--clear') {
  clearAndReauth();
} else if (command === '--help' || command === '-h') {
  console.log(`
Usage: npx ts-node examples/oauth-cli-example.ts [options] [server-url]

Options:
  <server-url>   Connect to a specific MCP server (default: https://snapadcp.scope3.com/mcp)
  --clear        Clear OAuth tokens and exit
  --help, -h     Show this help

The OAuth flow:
1. Browser opens for authorization
2. User logs in and approves
3. Tokens are saved to agent.oauth_tokens
4. Save agent config to persist tokens for future use
`);
} else {
  main().catch(console.error);
}
