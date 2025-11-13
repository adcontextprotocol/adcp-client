// Enhanced configuration manager for easy ADCP client setup

import { readFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import type { AgentConfig } from '../types';
import { ConfigurationError } from '../errors';

/**
 * Configuration structure for ADCP agents
 */
export interface ADCPConfig {
  /** Array of agent configurations */
  agents: AgentConfig[];
  /** Default configuration options */
  defaults?: {
    /** Default protocol for agents */
    protocol?: 'mcp' | 'a2a';
    /** Default timeout for all operations */
    timeout?: number;
    /** Default max clarifications */
    maxClarifications?: number;
    /** Enable debug mode by default */
    debug?: boolean;
  };
  /** Environment-specific overrides */
  environments?: {
    [envName: string]: Partial<ADCPConfig>;
  };
}

/**
 * Enhanced configuration manager with multiple loading strategies
 */
export class ConfigurationManager {
  private static readonly CONFIG_FILES = ['adcp.config.json', 'adcp.json', '.adcp.json', 'agents.json'];

  private static readonly ENV_VARS = ['SALES_AGENTS_CONFIG', 'ADCP_AGENTS_CONFIG', 'ADCP_CONFIG'];

  /**
   * Load agent configurations using auto-discovery
   * Tries multiple sources in order:
   * 1. Environment variables
   * 2. Config files in current directory
   * 3. Config files in project root
   */
  static loadAgents(): AgentConfig[] {
    // Try environment variables first
    const envAgents = this.loadAgentsFromEnv();
    if (envAgents.length > 0) {
      return envAgents;
    }

    // Try config files
    const configAgents = this.loadAgentsFromConfig();
    if (configAgents.length > 0) {
      return configAgents;
    }

    // No configuration found
    console.warn('⚠️  No ADCP agent configuration found');
    console.log('💡 To configure agents, you can:');
    console.log('   1. Set SALES_AGENTS_CONFIG environment variable');
    console.log('   2. Create an adcp.config.json file');
    console.log('   3. Pass agents directly to the constructor');
    console.log('\n📖 See documentation for configuration examples');

    return [];
  }

  /**
   * Load agents from environment variables
   */
  static loadAgentsFromEnv(): AgentConfig[] {
    for (const envVar of this.ENV_VARS) {
      const configEnv = process.env[envVar];
      if (configEnv) {
        try {
          const config = JSON.parse(configEnv);
          const agents = this.extractAgents(config);

          if (agents.length > 0) {
            console.log(`📡 Loaded ${agents.length} agents from ${envVar}`);
            this.logAgents(agents);
            return agents;
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(`❌ Failed to parse ${envVar}:`, errorMessage);
          throw new ConfigurationError(`Invalid JSON in ${envVar}: ${errorMessage}`, envVar);
        }
      }
    }

    return [];
  }

  /**
   * Load agents from config file
   */
  static loadAgentsFromConfig(configPath?: string): AgentConfig[] {
    const filesToTry = configPath ? [configPath] : this.CONFIG_FILES;

    for (const file of filesToTry) {
      const fullPath = resolve(file);

      if (existsSync(fullPath)) {
        try {
          const content = readFileSync(fullPath, 'utf8');
          const config = JSON.parse(content);
          const agents = this.extractAgents(config);

          if (agents.length > 0) {
            console.log(`📁 Loaded ${agents.length} agents from ${file}`);
            this.logAgents(agents);
            return agents;
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(`❌ Failed to load config from ${file}:`, errorMessage);
          throw new ConfigurationError(`Invalid config file ${file}: ${errorMessage}`, 'configFile');
        }
      }
    }

    return [];
  }

  /**
   * Extract agents array from various config formats
   */
  private static extractAgents(config: any): AgentConfig[] {
    // Handle different config formats
    if (Array.isArray(config)) {
      return config; // Direct agent array
    }

    if (config.agents && Array.isArray(config.agents)) {
      return config.agents; // Standard format: { agents: [...] }
    }

    if (config.data?.agents && Array.isArray(config.data.agents)) {
      return config.data.agents; // Nested format: { data: { agents: [...] } }
    }

    return [];
  }

  /**
   * Log configured agents in a user-friendly way
   */
  private static logAgents(agents: AgentConfig[]): void {
    agents.forEach(agent => {
      const protocolIcon = agent.protocol === 'mcp' ? '🔗' : '⚡';
      const authIcon = agent.requiresAuth ? '🔐' : '🌐';
      console.log(`  ${protocolIcon}${authIcon} ${agent.name} (${agent.protocol.toUpperCase()}) at ${agent.agent_uri}`);
    });

    const useRealAgents = process.env.USE_REAL_AGENTS === 'true';
    console.log(`🔧 Real agents mode: ${useRealAgents ? 'ENABLED' : 'DISABLED'}`);
  }

  /**
   * Validate agent configuration
   */
  static validateAgentConfig(agent: AgentConfig): void {
    const required = ['id', 'name', 'agent_uri', 'protocol'];

    for (const field of required) {
      if (!agent[field as keyof AgentConfig]) {
        throw new ConfigurationError(`Agent configuration missing required field: ${field}`, field);
      }
    }

    if (!['mcp', 'a2a'].includes(agent.protocol)) {
      throw new ConfigurationError(`Invalid protocol "${agent.protocol}". Must be "mcp" or "a2a"`, 'protocol');
    }

    // Basic URL validation
    try {
      new URL(agent.agent_uri);
    } catch {
      throw new ConfigurationError(`Invalid agent_uri "${agent.agent_uri}". Must be a valid URL`, 'agent_uri');
    }
  }

  /**
   * Validate multiple agent configurations
   */
  static validateAgentsConfig(agents: AgentConfig[]): void {
    if (!Array.isArray(agents)) {
      throw new ConfigurationError('Agents configuration must be an array');
    }

    if (agents.length === 0) {
      throw new ConfigurationError('At least one agent must be configured');
    }

    // Check for duplicate IDs
    const ids = agents.map(a => a.id);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    if (duplicates.length > 0) {
      throw new ConfigurationError(`Duplicate agent IDs found: ${duplicates.join(', ')}`, 'duplicateIds');
    }

    // Validate each agent
    agents.forEach(agent => this.validateAgentConfig(agent));
  }

  /**
   * Create a sample configuration file
   */
  static createSampleConfig(): ADCPConfig {
    return {
      agents: [
        {
          id: 'premium-network',
          name: 'Premium Ad Network',
          agent_uri: 'https://premium-ads.example.com/mcp/',
          protocol: 'mcp',
          requiresAuth: true,
          auth_token_env: 'PREMIUM_AGENT_TOKEN',
        },
        {
          id: 'budget-network',
          name: 'Budget Ad Network',
          agent_uri: 'https://budget-ads.example.com/a2a/',
          protocol: 'a2a',
          requiresAuth: false,
        },
      ],
      defaults: {
        protocol: 'mcp',
        timeout: 30000,
        maxClarifications: 3,
        debug: false,
      },
    };
  }

  /**
   * Get configuration file paths that would be checked
   */
  static getConfigPaths(): string[] {
    return this.CONFIG_FILES.map(file => resolve(file));
  }

  /**
   * Get environment variables that would be checked
   */
  static getEnvVars(): string[] {
    return this.ENV_VARS;
  }

  /**
   * Generate configuration help text
   */
  static getConfigurationHelp(): string {
    return `
🔧 ADCP Agent Configuration

The ADCP client can load agents from multiple sources:

1️⃣  Environment Variables:
   Set any of: ${this.ENV_VARS.join(', ')}
   
   Example:
   export SALES_AGENTS_CONFIG='{"agents":[{"id":"my-agent","name":"My Agent","agent_uri":"https://agent.example.com","protocol":"mcp"}]}'

2️⃣  Configuration Files:
   Create any of: ${this.CONFIG_FILES.join(', ')}
   
   Example adcp.config.json:
   {
     "agents": [
       {
         "id": "premium-agent",
         "name": "Premium Ad Network",
         "agent_uri": "https://premium.example.com",
         "protocol": "mcp",
         "requiresAuth": true,
         "auth_token_env": "PREMIUM_TOKEN"
       }
     ]
   }

3️⃣  Programmatic Configuration:
   const client = new ADCPMultiAgentClient([
     { id: 'agent', agent_uri: 'https://...', protocol: 'mcp' }
   ]);

📖 For more examples, see the documentation.
`;
  }
}
