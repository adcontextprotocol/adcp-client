/**
 * AdCP CLI Registry Commands
 *
 * Look up, save, and manage brands, properties, agents, and publishers
 * in the AdCP registry.
 */

const { readFileSync } = require('fs');
const { RegistryClient } = require('../dist/lib/registry/index.js');

const VALID_COMMANDS = [
  // Lookup
  'brand', 'brands', 'property', 'properties',
  // Save
  'save-brand', 'save-property',
  // List & Search
  'list-brands', 'list-properties', 'search', 'agents', 'publishers', 'stats',
  // Validation
  'validate', 'validate-publisher',
  // Discovery
  'lookup', 'discover', 'agent-formats', 'agent-products',
  // Authorization
  'check-auth',
];

/**
 * Parse flags and their values out of an args array.
 * Returns { flags, positional }.
 */
function parseArgs(args) {
  const flags = {
    auth: undefined,
    registryUrl: undefined,
    json: false,
    search: undefined,
    type: undefined,
    health: false,
    capabilities: false,
    properties: false,
    limit: undefined,
    offset: undefined,
  };
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--auth' && i + 1 < args.length) {
      flags.auth = args[++i];
    } else if (arg === '--registry-url' && i + 1 < args.length) {
      flags.registryUrl = args[++i];
    } else if (arg === '--search' && i + 1 < args.length) {
      flags.search = args[++i];
    } else if (arg === '--type' && i + 1 < args.length) {
      flags.type = args[++i];
    } else if (arg === '--limit' && i + 1 < args.length) {
      flags.limit = parseInt(args[++i], 10);
    } else if (arg === '--offset' && i + 1 < args.length) {
      flags.offset = parseInt(args[++i], 10);
    } else if (arg === '--json') {
      flags.json = true;
    } else if (arg === '--health') {
      flags.health = true;
    } else if (arg === '--capabilities') {
      flags.capabilities = true;
    } else if (arg === '--properties') {
      flags.properties = true;
    } else if (arg.startsWith('--')) {
      // Unknown flag — skip
    } else {
      positional.push(arg);
    }
  }

  return { flags, positional };
}

/**
 * Parse a JSON payload from a positional arg.
 * Supports inline JSON strings and @file references.
 */
function parsePayload(arg) {
  if (!arg) return undefined;
  try {
    if (arg.startsWith('@')) {
      const filePath = arg.substring(1);
      return JSON.parse(readFileSync(filePath, 'utf-8'));
    }
    return JSON.parse(arg);
  } catch (err) {
    throw new Error(`Failed to parse payload: ${err.message}`);
  }
}

function prettyPrintBrand(brand, domain) {
  if (!brand) {
    console.log(`No brand found for '${domain}'`);
    return;
  }

  console.log(`Brand: ${brand.brand_name}`);
  console.log(`  Domain:      ${brand.canonical_domain}`);
  console.log(`  Canonical ID: ${brand.canonical_id}`);
  if (brand.keller_type) {
    console.log(`  Keller Type: ${brand.keller_type}`);
  }
  console.log(`  Source:      ${brand.source}`);
  if (brand.parent_brand) {
    console.log(`  Parent:      ${brand.parent_brand}`);
  }
  if (brand.house_name || brand.house_domain) {
    console.log(`  House:       ${brand.house_name || ''}${brand.house_domain ? ' (' + brand.house_domain + ')' : ''}`);
  }
  if (brand.brand_agent_url) {
    console.log(`  Agent URL:   ${brand.brand_agent_url}`);
  }
  if (brand.brand_manifest) {
    const m = brand.brand_manifest;
    if (m.description) {
      console.log(`  Description: ${String(m.description).slice(0, 120)}`);
    }
    if (m.colors) {
      const colorParts = Object.entries(m.colors).map(([k, v]) => `${k}: ${v}`);
      console.log(`  Colors:      ${colorParts.join(', ')}`);
    }
    if (m.logos) {
      console.log(`  Logos:       ${m.logos.length}`);
    }
  }
}

function prettyPrintProperty(property, domain) {
  if (!property) {
    console.log(`No property found for '${domain}'`);
    return;
  }

  console.log(`Property: ${property.publisher_domain}`);
  console.log(`  Verified: ${property.verified ? 'Yes' : 'No'}`);
  console.log(`  Source:   ${property.source}`);

  if (property.authorized_agents && property.authorized_agents.length > 0) {
    console.log(`  Authorized Agents: ${property.authorized_agents.length}`);
    for (const agent of property.authorized_agents) {
      console.log(`    - ${agent.url}`);
    }
  } else {
    console.log(`  Authorized Agents: 0`);
  }

  if (property.properties && property.properties.length > 0) {
    console.log(`  Properties: ${property.properties.length}`);
    for (const prop of property.properties.slice(0, 10)) {
      const ids = prop.identifiers.map(id => id.value).join(', ');
      const propType = prop.property_type || prop.type || '';
      console.log(`    - ${prop.name} (${propType}) [${ids}]`);
    }
    if (property.properties.length > 10) {
      console.log(`    ... and ${property.properties.length - 10} more`);
    }
  } else {
    console.log(`  Properties: 0`);
  }
}

function prettyPrintSaveResult(result) {
  console.log(`Saved successfully`);
  if (result.message) console.log(`  Message:  ${result.message}`);
  if (result.domain) console.log(`  Domain:   ${result.domain}`);
  if (result.id) console.log(`  ID:       ${result.id}`);
  if (result.revision_number != null) console.log(`  Revision: ${result.revision_number}`);
}

function prettyPrintAgent(agent) {
  const name = agent.name || agent.agent_url || 'Unknown';
  const url = agent.agent_url || '';
  const type = agent.type || '';
  console.log(`  ${name}${type ? ' (' + type + ')' : ''}`);
  if (url) console.log(`    URL: ${url}`);
  if (agent.health) {
    console.log(`    Health: ${agent.health.status || 'unknown'}`);
  }
}

function printRegistryUsage() {
  console.log(`AdCP Registry - Brand, Property & Agent Management

USAGE:
  adcp registry <command> <args> [options]

LOOKUP COMMANDS:
  brand <domain>                Look up a brand by domain
  brands <domain> [domain...]   Bulk brand lookup (max 100)
  property <domain>             Look up a property by domain
  properties <domain> [d...]    Bulk property lookup (max 100)

SAVE COMMANDS (requires --auth):
  save-brand <domain> <name> [manifest-json]
                                Save or update a community brand
  save-brand <domain> <name> @manifest.json
                                Save brand with manifest from file
  save-property <domain> <agent-url> [payload-json]
                                Save or update a hosted property
  save-property <domain> <agent-url> @property.json
                                Save property with full payload from file

LIST & SEARCH:
  list-brands [--search term]   List/search brands in the registry
  list-properties [--search t]  List/search properties in the registry
  search <query>                Search brands, publishers, and properties
  agents [--type sales]         List registered agents
  publishers                    List publishers
  stats                         Registry statistics

VALIDATION:
  validate <domain>             Validate domain's adagents.json
  validate-publisher <domain>   Validate publisher configuration

DISCOVERY:
  lookup <domain>               Look up authorized agents for domain
  discover <agent-url>          Probe a live agent endpoint
  agent-formats <agent-url>     List agent's creative formats
  agent-products <agent-url>    List agent's products

AUTHORIZATION:
  check-auth <agent-url> <type> <value>
                                Check if agent is authorized for property

OPTIONS:
  --auth TOKEN        API key for authenticated access (required for save)
  --registry-url URL  Custom registry URL (default: https://adcontextprotocol.org)
  --json              Output raw JSON
  --search TERM       Search filter for list commands
  --type TYPE         Agent type filter (creative, signals, sales, governance, si)
  --health            Include agent health data
  --capabilities      Include agent capabilities data
  --properties        Include agent property data
  --limit N           Limit number of results
  --offset N          Offset for pagination

ENVIRONMENT VARIABLES:
  ADCP_REGISTRY_API_KEY   Default API key for registry operations

EXAMPLES:
  # Lookups
  adcp registry brand nike.com
  adcp registry brands nike.com adidas.com --json
  adcp registry property nytimes.com

  # List & Search
  adcp registry list-brands --search nike
  adcp registry search nike --json
  adcp registry agents --type sales --health
  adcp registry publishers
  adcp registry stats

  # Validation
  adcp registry validate nytimes.com
  adcp registry validate-publisher nytimes.com

  # Discovery
  adcp registry lookup nytimes.com
  adcp registry discover https://test-agent.adcontextprotocol.org
  adcp registry agent-formats https://test-agent.adcontextprotocol.org
  adcp registry agent-products https://test-agent.adcontextprotocol.org

  # Authorization
  adcp registry check-auth https://agent.example.com domain nytimes.com

  # Save a brand
  adcp registry save-brand acme.com "Acme Corp" --auth sk_your_key
  adcp registry save-brand acme.com "Acme Corp" '{"colors":{"primary":"#FF0000"}}' --auth sk_your_key

  # Save a property
  adcp registry save-property example.com https://agent.example.com --auth sk_your_key`);
}

/**
 * Handle the 'registry' subcommand.
 * @param {string[]} args - Arguments after 'registry'
 * @returns {Promise<number>} Exit code (0 = success, 1 = error, 2 = usage error)
 */
async function handleRegistryCommand(args) {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printRegistryUsage();
    return 2;
  }

  const { flags, positional } = parseArgs(args);
  const subcommand = positional[0];

  if (!VALID_COMMANDS.includes(subcommand)) {
    console.error(`Unknown registry command: '${subcommand}'\n`);
    printRegistryUsage();
    return 2;
  }

  const apiKey = flags.auth || process.env.ADCP_REGISTRY_API_KEY;
  const client = new RegistryClient({
    ...(flags.registryUrl && { baseUrl: flags.registryUrl }),
    ...(apiKey && { apiKey }),
  });

  try {
    switch (subcommand) {
      case 'brand': {
        const domain = positional[1];
        if (!domain) {
          console.error('Error: domain is required\n');
          return 2;
        }
        const result = await client.lookupBrand(domain);
        if (flags.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          prettyPrintBrand(result, domain);
        }
        break;
      }
      case 'brands': {
        const domains = positional.slice(1);
        if (domains.length === 0) {
          console.error('Error: at least one domain is required\n');
          return 2;
        }
        const results = await client.lookupBrands(domains);
        if (flags.json) {
          console.log(JSON.stringify(results, null, 2));
        } else {
          const entries = Object.entries(results);
          for (let i = 0; i < entries.length; i++) {
            const [domain, brand] = entries[i];
            prettyPrintBrand(brand, domain);
            if (i < entries.length - 1) console.log('');
          }
        }
        break;
      }
      case 'property': {
        const domain = positional[1];
        if (!domain) {
          console.error('Error: domain is required\n');
          return 2;
        }
        const result = await client.lookupProperty(domain);
        if (flags.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          prettyPrintProperty(result, domain);
        }
        break;
      }
      case 'properties': {
        const domains = positional.slice(1);
        if (domains.length === 0) {
          console.error('Error: at least one domain is required\n');
          return 2;
        }
        const results = await client.lookupProperties(domains);
        if (flags.json) {
          console.log(JSON.stringify(results, null, 2));
        } else {
          const entries = Object.entries(results);
          for (let i = 0; i < entries.length; i++) {
            const [domain, prop] = entries[i];
            prettyPrintProperty(prop, domain);
            if (i < entries.length - 1) console.log('');
          }
        }
        break;
      }
      case 'save-brand': {
        const domain = positional[1];
        const brandName = positional[2];
        if (!domain || !brandName) {
          console.error('Error: domain and brand name are required\n');
          console.error('Usage: adcp registry save-brand <domain> <brand-name> [manifest-json]\n');
          return 2;
        }
        const payload = { domain, brand_name: brandName };
        const manifestArg = positional[3];
        if (manifestArg) {
          payload.brand_manifest = parsePayload(manifestArg);
        }
        const result = await client.saveBrand(payload);
        if (flags.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          prettyPrintSaveResult(result);
        }
        break;
      }
      case 'save-property': {
        const domain = positional[1];
        const agentUrl = positional[2];
        if (!domain || !agentUrl) {
          console.error('Error: domain and agent URL are required\n');
          console.error('Usage: adcp registry save-property <domain> <agent-url> [payload-json]\n');
          return 2;
        }
        const extraArg = positional[3];
        let payload;
        if (extraArg) {
          const extra = parsePayload(extraArg);
          payload = {
            publisher_domain: domain,
            authorized_agents: [{ url: agentUrl }],
            ...extra,
          };
        } else {
          payload = {
            publisher_domain: domain,
            authorized_agents: [{ url: agentUrl }],
          };
        }
        const result = await client.saveProperty(payload);
        if (flags.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          prettyPrintSaveResult(result);
        }
        break;
      }

      // ====== List & Search ======

      case 'list-brands': {
        const options = {};
        if (flags.search) options.search = flags.search;
        if (flags.limit != null) options.limit = flags.limit;
        if (flags.offset != null) options.offset = flags.offset;
        const result = await client.listBrands(Object.keys(options).length ? options : undefined);
        if (flags.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          const brands = result.brands || [];
          console.log(`Brands: ${brands.length} results`);
          for (const b of brands) {
            console.log(`  ${b.brand_name || b.canonical_domain || b.domain} (${b.canonical_domain || b.domain})`);
          }
        }
        break;
      }
      case 'list-properties': {
        const options = {};
        if (flags.search) options.search = flags.search;
        if (flags.limit != null) options.limit = flags.limit;
        if (flags.offset != null) options.offset = flags.offset;
        const result = await client.listProperties(Object.keys(options).length ? options : undefined);
        if (flags.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          const props = result.properties || [];
          console.log(`Properties: ${props.length} results`);
          for (const p of props) {
            console.log(`  ${p.publisher_domain || p.domain} (${p.source || 'unknown'})`);
          }
        }
        break;
      }
      case 'search': {
        const query = positional[1];
        if (!query) {
          console.error('Error: query is required\n');
          return 2;
        }
        const result = await client.search(query);
        if (flags.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          const brandCount = (result.brands || []).length;
          const pubCount = (result.publishers || []).length;
          const propCount = (result.properties || []).length;
          console.log(`Search results for '${query}':`);
          console.log(`  Brands: ${brandCount}`);
          console.log(`  Publishers: ${pubCount}`);
          console.log(`  Properties: ${propCount}`);
        }
        break;
      }
      case 'agents': {
        const options = {};
        if (flags.type) options.type = flags.type;
        if (flags.health) options.health = true;
        if (flags.capabilities) options.capabilities = true;
        if (flags.properties) options.properties = true;
        const result = await client.listAgents(Object.keys(options).length ? options : undefined);
        if (flags.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          const agents = result.agents || [];
          console.log(`Agents: ${result.count || agents.length} registered`);
          for (const agent of agents) {
            prettyPrintAgent(agent);
          }
        }
        break;
      }
      case 'publishers': {
        const result = await client.listPublishers();
        if (flags.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          const pubs = result.publishers || [];
          console.log(`Publishers: ${result.count || pubs.length} registered`);
          for (const pub of pubs) {
            console.log(`  ${pub.domain || pub.publisher_domain || 'unknown'}`);
          }
        }
        break;
      }
      case 'stats': {
        const result = await client.getRegistryStats();
        if (flags.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log('Registry Statistics:');
          for (const [key, value] of Object.entries(result)) {
            console.log(`  ${key}: ${JSON.stringify(value)}`);
          }
        }
        break;
      }

      // ====== Validation ======

      case 'validate': {
        const domain = positional[1];
        if (!domain) {
          console.error('Error: domain is required\n');
          return 2;
        }
        const result = await client.validateAdagents(domain);
        if (flags.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          const valid = result.valid !== false;
          console.log(`Validation: ${valid ? 'PASS' : 'FAIL'}`);
          console.log(`  Domain: ${domain}`);
          if (result.errors && result.errors.length > 0) {
            console.log(`  Errors: ${result.errors.length}`);
            for (const err of result.errors) {
              console.log(`    - ${typeof err === 'string' ? err : err.message || JSON.stringify(err)}`);
            }
          }
          if (result.warnings && result.warnings.length > 0) {
            console.log(`  Warnings: ${result.warnings.length}`);
            for (const w of result.warnings) {
              console.log(`    - ${typeof w === 'string' ? w : w.message || JSON.stringify(w)}`);
            }
          }
        }
        break;
      }
      case 'validate-publisher': {
        const domain = positional[1];
        if (!domain) {
          console.error('Error: domain is required\n');
          return 2;
        }
        const result = await client.validatePublisher(domain);
        if (flags.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Publisher validation: ${domain}`);
          for (const [key, value] of Object.entries(result)) {
            console.log(`  ${key}: ${JSON.stringify(value)}`);
          }
        }
        break;
      }

      // ====== Discovery ======

      case 'lookup': {
        const domain = positional[1];
        if (!domain) {
          console.error('Error: domain is required\n');
          return 2;
        }
        const result = await client.lookupDomain(domain);
        if (flags.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Domain lookup: ${domain}`);
          const agents = result.authorized_agents || [];
          console.log(`  Authorized agents: ${agents.length}`);
          for (const agent of agents) {
            console.log(`    - ${agent.url || agent.agent_url || JSON.stringify(agent)}`);
          }
        }
        break;
      }
      case 'discover': {
        const url = positional[1];
        if (!url) {
          console.error('Error: agent URL is required\n');
          return 2;
        }
        const result = await client.discoverAgent(url);
        if (flags.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Agent discovery: ${url}`);
          for (const [key, value] of Object.entries(result)) {
            console.log(`  ${key}: ${JSON.stringify(value)}`);
          }
        }
        break;
      }
      case 'agent-formats': {
        const url = positional[1];
        if (!url) {
          console.error('Error: agent URL is required\n');
          return 2;
        }
        const result = await client.getAgentFormats(url);
        if (flags.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Agent formats: ${url}`);
          const formats = result.formats || [];
          console.log(`  Formats: ${formats.length}`);
          for (const f of formats) {
            console.log(`    - ${f.name || f.format_id || JSON.stringify(f)}`);
          }
        }
        break;
      }
      case 'agent-products': {
        const url = positional[1];
        if (!url) {
          console.error('Error: agent URL is required\n');
          return 2;
        }
        const result = await client.getAgentProducts(url);
        if (flags.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Agent products: ${url}`);
          const products = result.products || [];
          console.log(`  Products: ${products.length}`);
          for (const p of products) {
            console.log(`    - ${p.name || p.product_id || JSON.stringify(p)}`);
          }
        }
        break;
      }

      // ====== Authorization ======

      case 'check-auth': {
        const agentUrl = positional[1];
        const identifierType = positional[2];
        const identifierValue = positional[3];
        if (!agentUrl || !identifierType || !identifierValue) {
          console.error('Error: agent URL, identifier type, and identifier value are required\n');
          console.error('Usage: adcp registry check-auth <agent-url> <type> <value>\n');
          return 2;
        }
        const result = await client.validatePropertyAuthorization(agentUrl, identifierType, identifierValue);
        if (flags.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Authorization check:`);
          console.log(`  Agent:      ${result.agent_url}`);
          console.log(`  Type:       ${result.identifier_type}`);
          console.log(`  Value:      ${result.identifier_value}`);
          console.log(`  Authorized: ${result.authorized ? 'Yes' : 'No'}`);
          console.log(`  Checked at: ${result.checked_at}`);
        }
        break;
      }
    }
    return 0;
  } catch (err) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
}

module.exports = { handleRegistryCommand, printRegistryUsage };
