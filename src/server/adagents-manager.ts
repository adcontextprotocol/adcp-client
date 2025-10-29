import axios from 'axios';
import { 
  AdAgentsJson, 
  AuthorizedAgent, 
  AdAgentsValidationResult, 
  ValidationError, 
  ValidationWarning,
  AgentCardValidationResult
} from '../lib/types';

export class AdAgentsManager {
  
  /**
   * Validates a domain's adagents.json file
   */
  async validateDomain(domain: string): Promise<AdAgentsValidationResult> {
    // Normalize domain - remove protocol and trailing slash
    const normalizedDomain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const url = `https://${normalizedDomain}/.well-known/adagents.json`;
    
    const result: AdAgentsValidationResult = {
      valid: false,
      errors: [],
      warnings: [],
      domain: normalizedDomain,
      url
    };

    try {
      // Fetch the adagents.json file
      const response = await axios.get(url, {
        timeout: 10000,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'AdCP-Testing-Framework/1.0'
        },
        validateStatus: () => true // Don't throw on non-2xx status codes
      });

      result.status_code = response.status;

      // Check HTTP status
      if (response.status !== 200) {
        result.errors.push({
          field: 'http_status',
          message: `HTTP ${response.status}: adagents.json must return 200 status code`,
          severity: 'error'
        });
        // Don't include raw HTML error pages - they're not useful for validation
        return result;
      }

      // Only include raw data for successful responses
      result.raw_data = response.data;

      // Parse and validate JSON structure
      const adagentsData = response.data;
      this.validateStructure(adagentsData, result);
      this.validateContent(adagentsData, result);

      // If no errors, mark as valid
      result.valid = result.errors.length === 0;

    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
          result.errors.push({
            field: 'connection',
            message: `Cannot connect to ${normalizedDomain}`,
            severity: 'error'
          });
        } else if (error.code === 'ECONNABORTED') {
          result.errors.push({
            field: 'timeout',
            message: 'Request timed out after 10 seconds',
            severity: 'error'
          });
        } else {
          result.errors.push({
            field: 'network',
            message: error.message,
            severity: 'error'
          });
        }
      } else {
        result.errors.push({
          field: 'unknown',
          message: 'Unknown error occurred',
          severity: 'error'
        });
      }
    }

    return result;
  }

  /**
   * Validates the structure of adagents.json
   */
  private validateStructure(data: any, result: AdAgentsValidationResult): void {
    if (typeof data !== 'object' || data === null) {
      result.errors.push({
        field: 'root',
        message: 'adagents.json must be a valid JSON object',
        severity: 'error'
      });
      return;
    }

    // Check required fields
    if (!data.authorized_agents) {
      result.errors.push({
        field: 'authorized_agents',
        message: 'authorized_agents field is required',
        severity: 'error'
      });
      return;
    }

    if (!Array.isArray(data.authorized_agents)) {
      result.errors.push({
        field: 'authorized_agents',
        message: 'authorized_agents must be an array',
        severity: 'error'
      });
      return;
    }

    // Validate each agent
    data.authorized_agents.forEach((agent: any, index: number) => {
      this.validateAgent(agent, index, result);
    });

    // Check optional fields
    if (data.$schema && typeof data.$schema !== 'string') {
      result.errors.push({
        field: '$schema',
        message: '$schema must be a string',
        severity: 'error'
      });
    }

    if (data.last_updated) {
      if (typeof data.last_updated !== 'string') {
        result.errors.push({
          field: 'last_updated',
          message: 'last_updated must be an ISO 8601 timestamp string',
          severity: 'error'
        });
      } else {
        // Validate ISO 8601 format
        const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
        if (!isoRegex.test(data.last_updated)) {
          result.warnings.push({
            field: 'last_updated',
            message: 'last_updated should be in ISO 8601 format (YYYY-MM-DDTHH:mm:ssZ)',
            suggestion: 'Use new Date().toISOString() format'
          });
        }
      }
    }

    // Recommendations
    if (!data.$schema) {
      result.warnings.push({
        field: '$schema',
        message: 'Consider adding $schema field for validation',
        suggestion: 'Add "$schema": "https://adcontextprotocol.org/schemas/v1/adagents.json"'
      });
    }

    if (!data.last_updated) {
      result.warnings.push({
        field: 'last_updated',
        message: 'Consider adding last_updated timestamp',
        suggestion: 'Add "last_updated": "' + new Date().toISOString() + '"'
      });
    }
  }

  /**
   * Validates an individual agent entry
   */
  private validateAgent(agent: any, index: number, result: AdAgentsValidationResult): void {
    const prefix = `authorized_agents[${index}]`;

    if (typeof agent !== 'object' || agent === null) {
      result.errors.push({
        field: prefix,
        message: 'Each agent must be an object',
        severity: 'error'
      });
      return;
    }

    // Required fields
    if (!agent.url) {
      result.errors.push({
        field: `${prefix}.url`,
        message: 'url field is required',
        severity: 'error'
      });
    } else if (typeof agent.url !== 'string') {
      result.errors.push({
        field: `${prefix}.url`,
        message: 'url must be a string',
        severity: 'error'
      });
    } else {
      // Validate URL format
      try {
        new URL(agent.url);
        
        // Check HTTPS requirement
        if (!agent.url.startsWith('https://')) {
          result.errors.push({
            field: `${prefix}.url`,
            message: 'Agent URL must use HTTPS',
            severity: 'error'
          });
        }
      } catch {
        result.errors.push({
          field: `${prefix}.url`,
          message: 'url must be a valid URL',
          severity: 'error'
        });
      }
    }

    if (!agent.authorized_for) {
      result.errors.push({
        field: `${prefix}.authorized_for`,
        message: 'authorized_for field is required',
        severity: 'error'
      });
    } else if (typeof agent.authorized_for !== 'string') {
      result.errors.push({
        field: `${prefix}.authorized_for`,
        message: 'authorized_for must be a string',
        severity: 'error'
      });
    } else {
      // Validate length constraints
      if (agent.authorized_for.length < 1) {
        result.errors.push({
          field: `${prefix}.authorized_for`,
          message: 'authorized_for cannot be empty',
          severity: 'error'
        });
      } else if (agent.authorized_for.length > 500) {
        result.errors.push({
          field: `${prefix}.authorized_for`,
          message: 'authorized_for must be 500 characters or less',
          severity: 'error'
        });
      }
    }
  }

  /**
   * Validates business logic and content
   */
  private validateContent(data: any, result: AdAgentsValidationResult): void {
    if (!data.authorized_agents || !Array.isArray(data.authorized_agents)) {
      return; // Structure validation should have caught this
    }

    // Check for duplicate agent URLs
    const seenUrls = new Set<string>();
    data.authorized_agents.forEach((agent: any, index: number) => {
      if (agent.url && typeof agent.url === 'string') {
        if (seenUrls.has(agent.url)) {
          result.warnings.push({
            field: `authorized_agents[${index}].url`,
            message: 'Duplicate agent URL found',
            suggestion: 'Remove duplicate entries or consolidate authorization scopes'
          });
        }
        seenUrls.add(agent.url);
      }
    });

    // Check if no agents are defined
    if (data.authorized_agents.length === 0) {
      result.warnings.push({
        field: 'authorized_agents',
        message: 'No authorized agents defined',
        suggestion: 'Add at least one authorized agent'
      });
    }
  }

  /**
   * Validates agent cards for all agents in adagents.json
   */
  async validateAgentCards(agents: AuthorizedAgent[]): Promise<AgentCardValidationResult[]> {
    const results: AgentCardValidationResult[] = [];
    
    // Validate each agent in parallel
    const validationPromises = agents.map(agent => this.validateSingleAgentCard(agent.url));
    const validationResults = await Promise.allSettled(validationPromises);
    
    validationResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        results.push(result.value);
      } else {
        results.push({
          agent_url: agents[index].url,
          valid: false,
          errors: [`Validation failed: ${result.reason}`]
        });
      }
    });

    return results;
  }

  /**
   * Validates a single agent's card endpoint
   */
  private async validateSingleAgentCard(agentUrl: string): Promise<AgentCardValidationResult> {
    const result: AgentCardValidationResult = {
      agent_url: agentUrl,
      valid: false,
      errors: []
    };

    try {
      const startTime = Date.now();
      
      // Try to fetch agent card (A2A standard and root fallback)
      const cardEndpoints = [
        `${agentUrl}/.well-known/agent-card.json`, // A2A protocol standard
        agentUrl // Sometimes the main URL returns the card
      ];

      let cardFound = false;
      
      for (const endpoint of cardEndpoints) {
        try {
          const response = await axios.get(endpoint, {
            timeout: 5000,
            headers: {
              'Accept': 'application/json',
              'User-Agent': 'AdCP-Testing-Framework/1.0'
            },
            validateStatus: () => true
          });

          result.response_time_ms = Date.now() - startTime;
          result.status_code = response.status;

          if (response.status === 200) {
            result.card_data = response.data;
            result.card_endpoint = endpoint;
            cardFound = true;
            
            // Check content-type header
            const contentType = response.headers['content-type'] || '';
            const isJsonContentType = contentType.includes('application/json');
            
            // Basic validation of card structure
            if (typeof response.data === 'object' && response.data !== null) {
              if (!isJsonContentType) {
                result.errors.push(`Endpoint returned JSON data but with content-type: ${contentType}. Should be application/json`);
                result.valid = false;
              } else {
                result.valid = true;
              }
            } else {
              if (contentType.includes('text/html')) {
                result.errors.push('Agent card endpoint returned HTML instead of JSON. This appears to be a website, not an agent card endpoint.');
              } else {
                result.errors.push(`Agent card is not a valid JSON object (content-type: ${contentType})`);
              }
            }
            break;
          }
        } catch (endpointError) {
          // Try next endpoint
          continue;
        }
      }

      if (!cardFound) {
        result.errors.push('No agent card found at /.well-known/agent-card.json or root URL');
      }

    } catch (error) {
      if (axios.isAxiosError(error)) {
        result.errors.push(`Network error: ${error.message}`);
      } else {
        result.errors.push('Unknown error occurred while validating agent card');
      }
    }

    return result;
  }

  /**
   * Creates a properly formatted adagents.json file
   */
  createAdAgentsJson(
    agents: AuthorizedAgent[],
    includeSchema: boolean = true,
    includeTimestamp: boolean = true,
    properties?: any[]
  ): string {
    const adagents: AdAgentsJson = {
      authorized_agents: agents
    };

    if (properties && properties.length > 0) {
      adagents.properties = properties;
    }

    if (includeSchema) {
      adagents.$schema = 'https://adcontextprotocol.org/schemas/v1/adagents.json';
    }

    if (includeTimestamp) {
      adagents.last_updated = new Date().toISOString();
    }

    return JSON.stringify(adagents, null, 2);
  }

  /**
   * Validates a proposed adagents.json structure before creation
   */
  validateProposed(agents: AuthorizedAgent[]): AdAgentsValidationResult {
    const mockData = {
      $schema: 'https://adcontextprotocol.org/schemas/v1/adagents.json',
      authorized_agents: agents,
      last_updated: new Date().toISOString()
    };

    const result: AdAgentsValidationResult = {
      valid: false,
      errors: [],
      warnings: [],
      domain: 'proposed',
      url: 'proposed'
    };

    this.validateStructure(mockData, result);
    this.validateContent(mockData, result);

    result.valid = result.errors.length === 0;
    return result;
  }
}