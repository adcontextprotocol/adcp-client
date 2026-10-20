// Pinned draft composition: adcp#8169 trust, #8170 onboarding, #8168 relationship.
// See docs/migration-agent-identity-3.3.md for source precedence.
export default [
  {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: '/schemas/trust/v1/trust.json',
    title: 'trust.json',
    'x-status': 'experimental',
    description:
      "An organization's agent trust record, hosted at /.well-known/trust.json on the organization's own host. Protocol-neutral core: the agents the organization runs (agents[]), the authority it delegates to others (grants[]), and the grants it has accepted from others (acknowledgements[]). Protocol-specific semantics live in namespaced roles and scopes (e.g. 'adcp:sales') and in per-protocol `profiles` objects; this draft defines the `adcp` profile. The organization a record speaks for is the host serving /.well-known/trust.json \u2014 never a value inside the document. Versioned independently of any one protocol. The v1 in the path is a namespace, not a stability promise: while x-status is experimental the schema may change in breaking ways. EXPERIMENTAL (x-status: experimental, feature id identity.trust_json). In AdCP 3.3 the experimental Web Bot Auth signing profile reads agents[] (origin and roles) when it evaluates a trust record derived from an agent's origin (docs/building/by-layer/L1/security.mdx, Web Bot Auth identities); grants[] are read once demand-side grants (#6033) land. Outside those uses, third parties, crawlers and registries MUST NOT treat a published trust.json as authority. brand.json behavior is unchanged for the RFC 9421 signing profile. The document name and its /.well-known path may change before graduation (the JournalList trust.txt naming outreach is still open), so do not treat the file name as frozen. An agent URL anywhere in this record identifies the agent by its canonical origin (see docs/reference/url-canonicalization.mdx): one agent per origin. See RFC #7809 and specs/agent-identity-3-3.md.",
    definitions: {
      domain: {
        type: 'string',
        pattern: '^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$',
        description: 'A lowercase DNS host name (internationalized names in punycode).',
      },
      https_url: {
        type: 'string',
        format: 'uri',
        pattern: '^https://',
        description:
          'An HTTPS URL. Every such URL in this document is untrusted input and, when fetched, a fetch target: the pattern is not an SSRF check. Verifiers MUST apply their own SSRF validation (no userinfo, no private or link-local addresses, no redirects) and enforce body-size and item-count limits.',
      },
      namespaced_token: {
        type: 'string',
        pattern: '^[a-z0-9-]+:[a-z0-9_.-]+$',
        description:
          "A '<namespace>:<name>' token. Each namespace is defined by the protocol that owns it (e.g. 'adcp:' by AdCP). Consumers MUST ignore tokens in namespaces they do not implement.",
      },
      role: {
        description: 'Functional role of an agent. Tokens in the adcp namespace MUST be one of the AdCP agent types.',
        anyOf: [
          {
            allOf: [
              {
                $ref: '#/definitions/namespaced_token',
              },
              {
                not: {
                  pattern: '^adcp:',
                },
              },
            ],
          },
          {
            type: 'string',
            enum: [
              'adcp:brand',
              'adcp:rights',
              'adcp:measurement',
              'adcp:governance',
              'adcp:creative',
              'adcp:sales',
              'adcp:buying',
              'adcp:signals',
            ],
          },
        ],
      },
      scope: {
        description:
          "An activity a grant covers. Tokens in the adcp namespace MUST be one of the AdCP scopes (brand.json authorized_operator scopes plus 'adcp:brand_identity'). The bare token '*' covers every scope in every namespace.",
        anyOf: [
          {
            type: 'string',
            const: '*',
          },
          {
            allOf: [
              {
                $ref: '#/definitions/namespaced_token',
              },
              {
                not: {
                  pattern: '^adcp:',
                },
              },
            ],
          },
          {
            type: 'string',
            enum: [
              'adcp:all',
              'adcp:media_buying',
              'adcp:creative_generation',
              'adcp:rights_clearance',
              'adcp:governance',
              'adcp:measurement',
              'adcp:agent_operations',
              'adcp:brand_identity',
            ],
          },
        ],
      },
      grant_source: {
        description:
          "Where the grantor publishes the grant being acknowledged. Tokens in the adcp namespace MUST be a grant source AdCP defines: 'adcp:adagents' (the grantor's /.well-known/adagents.json authorized_agents[]) or 'adcp:trust' (the grantor's /.well-known/trust.json grants[]).",
        anyOf: [
          {
            allOf: [
              {
                $ref: '#/definitions/namespaced_token',
              },
              {
                not: {
                  pattern: '^adcp:',
                },
              },
            ],
          },
          {
            type: 'string',
            enum: ['adcp:adagents', 'adcp:trust'],
          },
        ],
      },
      open_profiles: {
        type: 'object',
        description:
          'Per-protocol data keyed by namespace. Consumers MUST ignore namespaces they do not implement. Nothing in profiles is key material or authority for another namespace.',
        propertyNames: {
          pattern: '^[a-z0-9-]+$',
        },
        additionalProperties: {
          type: 'object',
        },
      },
      agent: {
        type: 'object',
        description:
          'An agent this organization runs, identified by the canonical origin of `url`. One agent per origin. Its signing keys are published only in the key directory at that origin (`/.well-known/http-message-signatures-directory`, Web Bot Auth), never in this document.',
        properties: {
          url: {
            $ref: '#/definitions/https_url',
            description:
              'Agent endpoint URL, which may carry a path. Its host eTLD+1 MUST equal the eTLD+1 of the organization this record speaks for.',
          },
          roles: {
            type: 'array',
            description: 'What this agent does, as namespaced roles.',
            items: {
              $ref: '#/definitions/role',
            },
            minItems: 1,
            uniqueItems: true,
          },
          protocols: {
            type: 'array',
            description: 'Transport protocols the endpoint speaks. Informational.',
            items: {
              type: 'string',
              enum: ['mcp', 'a2a'],
            },
            uniqueItems: true,
          },
          id: {
            type: 'string',
            description: 'Operator-chosen identifier for logging and routing. Not an identity input.',
          },
          description: {
            type: 'string',
          },
          countries: {
            type: 'array',
            description: 'ISO 3166-1 alpha-2 country codes where this agent operates. Omit for global.',
            items: {
              type: 'string',
              pattern: '^[A-Z]{2}$',
            },
          },
          profiles: {
            allOf: [
              {
                $ref: '#/definitions/open_profiles',
              },
              {
                properties: {
                  adcp: {
                    type: 'object',
                    description:
                      'AdCP profile for an agent entry. Carries the rights-agent fields from brand.json brand_agent_entry.',
                    properties: {
                      available_uses: {
                        type: 'array',
                        items: {
                          $ref: '/schemas/enums/right-use.json',
                        },
                        minItems: 1,
                      },
                      right_types: {
                        type: 'array',
                        items: {
                          $ref: '/schemas/enums/right-type.json',
                        },
                        minItems: 1,
                      },
                      onboarding: {
                        $ref: '/schemas/core/buyer-onboarding-posture.json',
                        description:
                          'For a buying agent (role adcp:buying): how it considers sellers. Overrides record_profiles.adcp.onboarding for this agent.',
                      },
                    },
                    additionalProperties: false,
                  },
                },
              },
            ],
          },
          last_updated: {
            type: 'string',
            format: 'date-time',
          },
        },
        required: ['url', 'roles'],
        additionalProperties: false,
      },
      granted_agent: {
        type: 'object',
        description: 'An agent a grant is limited to, matched by canonical origin. Grants never carry keys.',
        properties: {
          url: {
            $ref: '#/definitions/https_url',
          },
        },
        required: ['url'],
        additionalProperties: false,
      },
      grant: {
        type: 'object',
        description:
          "Authority this organization delegates: 'the grantee (optionally only these agents) may act for us, for these scopes, in these countries, during this window.' Non-transitive: a grantee never extends a grant it received. It MAY make its own grant to one intermediary for scopes it holds, and effective authority is the intersection along that chain (brands, countries, scopes, earliest valid_until); the intermediary cannot grant further. In the AdCP profile this is the demand-side grant (#6033, DR-0025): relying parties evaluate it at sync_accounts from the brand's own record. When this document is fetched successfully, brand.json authorized_operators[] is not consulted for the same grantor.",
        properties: {
          grantee: {
            $ref: '#/definitions/domain',
            description:
              "Registrable domain (eTLD+1) of the organization receiving the grant, under the pinned Public Suffix List snapshot, ICANN and private sections (spec R3a step 1). Its agents resolve to this domain through its own trust.json. A host below a registrable domain (t1.vendor.example) is not one, and neither is a public suffix itself (github.io); alice.github.io is one, because github.io is in the private section. A grant whose grantee is not a registrable domain covers no claim, and its scopes still count for exclusive_grants, as L2 \u00a7Grants in trust records describes (docs/building/by-layer/L2/accounts-and-agents.mdx). A pattern can't evaluate the Public Suffix List, so verifiers apply the rule. To limit a grant to some of the grantee's agents, list them in agents[].",
          },
          agents: {
            type: 'array',
            description:
              'Optional narrowing to specific agents the grantee runs. When absent, any agent that resolves to the grantee acts under the grant.',
            items: {
              $ref: '#/definitions/granted_agent',
            },
            minItems: 1,
          },
          scopes: {
            type: 'array',
            items: {
              $ref: '#/definitions/scope',
            },
            minItems: 1,
            uniqueItems: true,
          },
          countries: {
            type: 'array',
            description: 'ISO 3166-1 alpha-2 country codes where the grant applies. Omit for global.',
            items: {
              type: 'string',
              pattern: '^[A-Z]{2}$',
            },
          },
          valid_from: {
            type: 'string',
            format: 'date-time',
            description: 'Consumers MUST ignore the grant before this time.',
          },
          valid_until: {
            type: 'string',
            format: 'date-time',
            description: 'Consumers MUST treat the grant as inactive at or after this time, on every check.',
          },
          profiles: {
            allOf: [
              {
                $ref: '#/definitions/open_profiles',
              },
              {
                properties: {
                  adcp: {
                    type: 'object',
                    description: 'AdCP profile for a grant.',
                    properties: {
                      brands: {
                        type: 'array',
                        description:
                          "Brand IDs from this organization's brand.json that the grant covers. ['*'] or omitted means every brand the grantor owns.",
                        items: {
                          type: 'string',
                          pattern: '^([a-z0-9_]+|\\*)$',
                        },
                        minItems: 1,
                      },
                    },
                    additionalProperties: false,
                  },
                },
              },
            ],
          },
          last_updated: {
            type: 'string',
            format: 'date-time',
          },
        },
        required: ['grantee', 'scopes'],
        additionalProperties: false,
      },
      acknowledgement: {
        type: 'object',
        description:
          "This organization's acceptance of a grant another organization published: 'we accept the grant `grantor` gave to `agent_url`, as published via `via`.' Terms are read ONLY from the grantor's document and are never restated here. Not needed when the grantor has the same eTLD+1 as the host serving this document. In the AdCP profile with via 'adcp:adagents' this is intended to supersede brand.json properties[] entries whose relationship is direct, delegated, or ad_network in a future release; brand.json is unchanged in 3.3.",
        properties: {
          grantor: {
            $ref: '#/definitions/domain',
            description: 'The organization that published the grant.',
          },
          agent_url: {
            $ref: '#/definitions/https_url',
            description:
              'The granted agent. MUST match an agents[] entry in this same document by canonical origin; an acknowledgement for an agent this organization does not run is invalid and MUST be ignored.',
          },
          via: {
            $ref: '#/definitions/grant_source',
            description:
              "Where the grant is published. For 'adcp:adagents', verifiers resolve https://{grantor}/.well-known/adagents.json (following authoritative_location and managed-network rules) and require an authorized_agents[] entry whose canonical url equals agent_url and that reaches the grantor under the reachable-publisher rule. One acknowledgement covers every entry for that agent URL, whatever its authorization_type. The adagents.json comparison is by canonical URL, as that file defines (see docs/reference/url-canonicalization.mdx), not by origin.",
          },
          profiles: {
            allOf: [
              {
                $ref: '#/definitions/open_profiles',
              },
              {
                properties: {
                  adcp: {
                    type: 'object',
                    description: 'AdCP profile for an acknowledgement.',
                    properties: {
                      delegation_type: {
                        type: 'string',
                        enum: ['direct', 'delegated', 'ad_network'],
                        description:
                          "Optional operator-side assertion of the commercial relationship, for sellers.json-style cross-checking. When present it MUST equal the publisher's delegation_type; a mismatch fails the acknowledgement (state 'mismatch'). Omit to defer entirely to the publisher.",
                      },
                    },
                    additionalProperties: false,
                  },
                },
              },
            ],
          },
          last_updated: {
            type: 'string',
            format: 'date-time',
          },
        },
        required: ['grantor', 'agent_url', 'via'],
        additionalProperties: false,
      },
      record_profiles: {
        allOf: [
          {
            $ref: '#/definitions/open_profiles',
          },
          {
            properties: {
              adcp: {
                type: 'object',
                description: 'AdCP profile for the whole record.',
                properties: {
                  identity_relying_parties: {
                    type: 'array',
                    description:
                      'Verified-identity relying parties this organization operates (TMP Identity Match attestation provenance). Intended to move here from brand.json in a future release; brand.json is unchanged in 3.3. Experimental.',
                    items: {
                      $ref: '/schemas/core/identity-relying-party.json',
                    },
                  },
                  onboarding: {
                    $ref: '/schemas/core/buyer-onboarding-posture.json',
                    description:
                      "Default buyer onboarding posture for every buying agent this record lists; an agent entry's profiles.adcp.onboarding overrides it.",
                  },
                },
                additionalProperties: false,
              },
            },
          },
        ],
      },
    },
    oneOf: [
      {
        type: 'object',
        title: 'Authoritative Location Redirect',
        description:
          "Pointer for hosted records (a managed network, a platform, AAO hosting). The organization is still the host that served this pointer. Verifiers follow at most one hop, with zero HTTP redirects, and MUST NOT follow a second pointer. Hosts serving records on an organization's behalf MUST only serve records the organization controls.",
        properties: {
          $schema: {
            type: 'string',
          },
          authoritative_location: {
            $ref: '#/definitions/https_url',
            description: 'HTTPS URL of the authoritative trust.json for this host.',
          },
          last_updated: {
            type: 'string',
            format: 'date-time',
          },
        },
        required: ['authoritative_location'],
        additionalProperties: false,
      },
      {
        type: 'object',
        title: 'Trust Record',
        properties: {
          $schema: {
            type: 'string',
          },
          version: {
            type: 'string',
          },
          last_updated: {
            type: 'string',
            format: 'date-time',
          },
          agents: {
            type: 'array',
            description: 'Agents this organization runs.',
            items: {
              $ref: '#/definitions/agent',
            },
          },
          grants: {
            type: 'array',
            description: 'Authority this organization delegates to others.',
            items: {
              $ref: '#/definitions/grant',
            },
          },
          exclusive_grants: {
            type: 'boolean',
            default: false,
            description:
              "When true, grants[] is exhaustive for every scope it names: relying parties MUST reject acts-for claims no active grant covers. When false or absent, an uncovered claim is at the relying party's discretion. A fetch failure is never equivalent to an absent grant; once a relying party has seen exclusive_grants: true for a host, it MUST fail closed on fetch failure.",
          },
          acknowledgements: {
            type: 'array',
            description:
              'Inline acknowledgements. Mutually exclusive with acknowledgements_url. Organizations acknowledging more than a few hundred grants SHOULD use acknowledgements_url so the key-resolution fetch stays small.',
            items: {
              $ref: '#/definitions/acknowledgement',
            },
          },
          acknowledgements_url: {
            $ref: '#/definitions/https_url',
            description:
              'Same-host HTTPS URL of a trust-acknowledgements.json sub-document (untrusted input; see https_url). Fetched only by verifiers checking a grant relationship, never on the signature-verification path, under its own size and cache profile.',
          },
          profiles: {
            $ref: '#/definitions/record_profiles',
          },
          ext: {
            type: 'object',
            description:
              'Vendor extensions, namespaced as ext.{vendor}. The top level is closed so it cannot become a catch-all. Never key material or authority.',
            additionalProperties: {
              type: 'object',
            },
          },
        },
        anyOf: [
          {
            required: ['agents'],
          },
          {
            required: ['grants'],
          },
          {
            required: ['acknowledgements'],
          },
          {
            required: ['acknowledgements_url'],
          },
          {
            required: ['profiles'],
          },
        ],
        not: {
          required: ['acknowledgements', 'acknowledgements_url'],
        },
        additionalProperties: false,
      },
    ],
  },
  {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: '/schemas/core/agent-onboarding-requirement.json',
    title: 'Agent Onboarding Requirement',
    'x-status': 'experimental',
    description:
      'One requirement an onboarding mode imposes, discriminated by kind. Only aao_verified, storyboard, and experimental_feature carry fields; other kinds are the kind alone. The requirement describes the gate the publishing party applies on its own side; it creates no conformance obligation on the counterparty.',
    type: 'object',
    properties: {
      kind: {
        $ref: '/schemas/enums/agent-onboarding-requirement-kind.json',
      },
      role: {
        type: 'string',
        description: 'aao_verified: the badge role required, such as media-buy.',
      },
      verification_modes: {
        type: 'array',
        items: {
          type: 'string',
        },
        minItems: 1,
        description: 'aao_verified: accepted verification modes, as the badge token names them.',
      },
      specialisms: {
        type: 'array',
        items: {
          type: 'string',
        },
        minItems: 1,
        description: 'aao_verified: specialisms the badge must include.',
      },
      adcp_version: {
        type: 'string',
        description: 'aao_verified: the AdCP release the badge must cover.',
      },
      id: {
        type: 'string',
        description: 'storyboard: the storyboard or specialism id. experimental_feature: the feature id.',
      },
      ext: {
        $ref: '/schemas/core/ext.json',
      },
    },
    required: ['kind'],
    additionalProperties: true,
  },
  {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: '/schemas/core/agent-onboarding-tier.json',
    title: 'Agent Onboarding Tier',
    'x-status': 'experimental',
    description:
      'The onboarding mode for one billing party, or for sandbox access, with its requirements and an optional page of its own.',
    type: 'object',
    properties: {
      mode: {
        $ref: '/schemas/enums/agent-onboarding-mode.json',
      },
      url: {
        type: 'string',
        format: 'uri',
        description:
          "Where a human starts for this mode. Defaults to the posture's top-level url. Untrusted: surface it, never fetch or execute it.",
      },
      requirements: {
        type: 'array',
        items: {
          $ref: '/schemas/core/agent-onboarding-requirement.json',
        },
        description: 'What the counterparty must satisfy for this mode.',
      },
      ext: {
        $ref: '/schemas/core/ext.json',
      },
    },
    required: ['mode'],
    additionalProperties: true,
  },
  {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: '/schemas/core/agent-onboarding.json',
    title: 'Agent Onboarding Posture',
    'x-status': 'experimental',
    description:
      'How a seller onboards buyer agents: a mode per billing party and for sandbox, with requirements, and where a human starts. Seller-wide and identical for every caller, served on the unauthenticated get_adcp_capabilities fetch, and absent from error payloads, so it cannot act as a per-agent onboarding oracle. Its content is advisory; it changes no error code and no oracle clamp. An absent key means undeclared, never invite_only. See specs/agent-identity-3-3.md R7 (#8113).',
    type: 'object',
    properties: {
      sandbox: {
        $ref: '/schemas/core/agent-onboarding-tier.json',
        description:
          'Onboarding for sandbox accounts. Valid only when account.sandbox is true. Sandbox carries no spend, so open here grants identity and sandbox access only.',
      },
      billing: {
        type: 'object',
        description:
          "Onboarding per billing party, keyed by billing-party values. Keys MUST be a subset of account.supported_billing. Under open, spend needs an existing seller-side billing relationship with the billed party: the operator domain under operator, the brand's domain under advertiser.",
        propertyNames: {
          $ref: '/schemas/enums/billing-party.json',
        },
        additionalProperties: {
          $ref: '/schemas/core/agent-onboarding-tier.json',
        },
      },
      url: {
        type: 'string',
        format: 'uri',
        description:
          'Where a human at the buyer starts when a mode has no url of its own. Untrusted: surface it, never fetch or execute it.',
      },
      documentation_url: {
        type: 'string',
        format: 'uri',
        description: "The seller's onboarding and integration documentation. Untrusted, like url.",
      },
      message: {
        type: 'string',
        description:
          'Human-readable summary of the process and what to have ready. The fallback whenever a reader does not understand a requirement.',
      },
      ext: {
        $ref: '/schemas/core/ext.json',
      },
    },
    additionalProperties: true,
  },
  {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: '/schemas/core/buyer-onboarding-posture.json',
    title: 'Buyer Onboarding Posture',
    'x-status': 'experimental',
    description:
      "How a buying agent considers sellers: a mode, the requirements a seller must meet, and where a seller's human starts. Published in the buyer's trust.json agent entry (profiles.adcp.onboarding), or as a record-level default (record_profiles.adcp.onboarding). Public and identical for every reader. A buyer that serves get_adcp_capabilities is authoritative there; trust.json may mirror it. See specs/agent-identity-3-3.md R7 (#8114).",
    type: 'object',
    properties: {
      mode: {
        $ref: '/schemas/enums/buyer-onboarding-mode.json',
      },
      requirements: {
        type: 'array',
        items: {
          $ref: '/schemas/core/agent-onboarding-requirement.json',
        },
        description:
          'What a seller must satisfy. Uses the kinds that apply when a buyer gates a seller (aao_verified, storyboard, sandbox, experimental_feature); others are ignored.',
      },
      url: {
        type: 'string',
        format: 'uri',
        description: "Where a seller's human starts. Untrusted: surface it, never fetch or execute it.",
      },
      documentation_url: {
        type: 'string',
        format: 'uri',
        description: "The buyer's documentation for sellers. Untrusted, like url.",
      },
      message: {
        type: 'string',
        description: 'Human-readable summary; the fallback whenever a reader does not understand a requirement.',
      },
      ext: {
        $ref: '/schemas/core/ext.json',
      },
    },
    required: ['mode'],
    additionalProperties: true,
  },
  {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: '/schemas/enums/agent-onboarding-mode.json',
    title: 'Agent Onboarding Mode',
    'x-status': 'experimental',
    description:
      'How a seller onboards buyer agents for one billing party or for sandbox access. Absent means undeclared, never invite_only.',
    type: 'string',
    enum: ['open', 'application', 'invite_only'],
    enumDescriptions: {
      open: "A buyer agent that meets every listed requirement and whose identity the seller can establish from the agent's published keys (the Web Bot Auth profile) may proceed without prior contact. open binds identity, not spend: spend still needs an existing billing relationship with the billed party, and a brand outside the buyer's operator domain needs a grant. A seller that only maps opaque, seller-issued credentials MUST NOT declare open.",
      application: 'The buyer completes an out-of-band step at url before the seller recognizes it for this mode.',
      invite_only: 'The seller does not accept unsolicited buyer agents for this mode. url MAY be absent.',
    },
  },
  {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: '/schemas/enums/agent-onboarding-requirement-kind.json',
    title: 'Agent Onboarding Requirement Kind',
    'x-status': 'experimental',
    description:
      "What a counterparty must satisfy before an onboarding mode applies. Each kind states the direction it applies to; a kind used in the other direction is ignored. Readers MUST treat an unknown kind as unsatisfiable by machine and fall back to the posture's message and url.",
    type: 'string',
    'x-extensible': true,
    enum: [
      'agent_identity',
      'grant',
      'billing_entity',
      'contract',
      'credit_application',
      'aao_verified',
      'storyboard',
      'sandbox',
      'experimental_feature',
    ],
    enumDescriptions: {
      agent_identity:
        "Seller gating a buyer. The buyer agent's origin is listed in its operator's trust.json with the role the seller needs (adcp:buying).",
      grant:
        "Seller gating a buyer. A demand-side grant authorizes the buyer's operator for the account's brand (DR-0025); implicit when the operator is the brand.",
      billing_entity:
        'Seller gating a buyer. The buyer supplies a billing entity (core/business-entity.json) on sync_accounts.',
      contract: 'Seller gating a buyer. A signed agreement exists; details at url.',
      credit_application:
        'Seller gating a buyer. A credit application is completed at url, or later through sync_accounts setup.url.',
      aao_verified:
        'Buyer gating a seller. The seller holds an AgenticAdvertising.org Verified badge; role is required, and verification_modes, specialisms, and adcp_version narrow it.',
      storyboard: 'Buyer gating a seller. The seller passes the named storyboard or specialism (id).',
      sandbox: 'Buyer gating a seller. The seller declares account.sandbox: true.',
      experimental_feature:
        'Buyer gating a seller. The seller lists the named feature id (id) in experimental_features.',
    },
  },
  {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: '/schemas/enums/buyer-onboarding-mode.json',
    title: 'Buyer Onboarding Mode',
    'x-status': 'experimental',
    description:
      'How a buyer considers sellers for its plans. Distinct from the seller-side agent-onboarding-mode, whose open means something else. Absent means undeclared.',
    type: 'string',
    enum: ['considers_unsolicited', 'application', 'invite_only'],
    enumDescriptions: {
      considers_unsolicited:
        "A seller that meets every listed requirement is in the buyer's consideration set without prior contact; the buyer discovers and calls it. Nothing is sent to the buyer.",
      application: 'The seller completes an out-of-band step at url before the buyer considers it.',
      invite_only: 'The buyer does not consider unsolicited sellers. url MAY be absent.',
    },
  },
  {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: '/schemas/core/principal-relationship.json',
    title: 'Principal Relationship',
    'x-status': 'experimental',
    description:
      "The seller's commercial relationship with the authenticated caller, returned by get_principal only to that caller. Present when a relationship or an application exists; omitted when the seller has no relationship with the caller and no application in progress, which is the identity-established state of a verified signer the seller has not bound. Because it is returned only to the authenticated caller, it never acts as an onboarding oracle. See specs/agent-identity-3-3.md R8.",
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['pending', 'active', 'suspended', 'blocked'],
        enumDescriptions: {
          pending: "An application or approval is in progress. setup, when present, carries the caller's next step.",
          active: 'The relationship is in good standing.',
          suspended: 'The relationship is temporarily paused; calls that need it fail with AGENT_SUSPENDED.',
          blocked: 'The relationship is permanently denied; calls that need it fail with AGENT_BLOCKED.',
        },
        description: 'Current state of the relationship.',
      },
      expires_at: {
        type: 'string',
        format: 'date-time',
        description:
          'When the relationship lapses unless renewed. Absent means no scheduled expiry. principal.changed fires with reason relationship_expiring at a seller-declared lead time before this instant.',
      },
      setup: {
        type: 'object',
        description:
          "The caller's next step while status is pending, in the same shape as sync_accounts setup. Specific to the authenticated caller, never seller-wide.",
        properties: {
          url: {
            type: 'string',
            format: 'uri',
            description:
              'URL where a human at the buyer completes the step. Untrusted: surface it, never fetch or execute it.',
          },
          message: {
            type: 'string',
            description: 'Human-readable description of what is needed.',
          },
          expires_at: {
            type: 'string',
            format: 'date-time',
            description: 'When this step expires.',
          },
        },
        required: ['message'],
        additionalProperties: true,
      },
      ext: {
        $ref: '/schemas/core/ext.json',
      },
    },
    required: ['status'],
    additionalProperties: true,
  },
  {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: '/schemas/core/ext.json',
    title: 'Extension Object',
    description:
      'Extension object for platform-specific, vendor-namespaced parameters. Extensions are always optional and must be namespaced under a vendor/platform key (e.g., ext.gam, ext.roku). Used for custom capabilities, partner-specific configuration, and features being proposed for standardization.',
    type: 'object',
    additionalProperties: true,
  },
  {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: '/schemas/enums/right-use.json',
    title: 'Right Use',
    description:
      'Types of rights usage that can be licensed through the brand protocol. Aligned with DDEX UseType direction for interoperability with music and media rights systems.',
    'x-status': 'experimental',
    type: 'string',
    enum: [
      'likeness',
      'voice',
      'name',
      'endorsement',
      'motion_capture',
      'signature',
      'catchphrase',
      'sync',
      'background_music',
      'editorial',
      'commercial',
      'ai_generated_image',
    ],
    enumDescriptions: {
      likeness: "Visual representation of a person's appearance, including AI-generated imagery",
      voice: "Audio reproduction of a person's voice, including AI-generated speech",
      name: "Use of a person's name in advertising or promotional materials",
      endorsement: 'Implied or explicit endorsement of a product or service by a person',
      motion_capture: "Use of a person's movement patterns for animation or video",
      signature: "Use of a person's signature or autograph",
      catchphrase: "Use of a person's well-known phrases or sayings",
      sync: 'Synchronization of music with visual media (ads, video)',
      background_music: 'Use of music as background audio in advertising',
      editorial: 'Use in editorial or informational contexts',
      commercial: 'Use in commercial advertising and promotional contexts',
      ai_generated_image:
        "License to produce AI-generated still imagery derived from the rights holder's IP (brand assets, character designs, talent likeness). Distinct from likeness/voice by output modality \u2014 a get_rights query filtered on ai_generated_image returns rights whose pricing options cover image generation, regardless of the underlying IP category.",
    },
  },
  {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: '/schemas/enums/right-type.json',
    title: 'Right Type',
    description: 'Categories of intellectual property rights that can be licensed through the brand protocol.',
    'x-status': 'experimental',
    type: 'string',
    enum: ['talent', 'character', 'brand_ip', 'music', 'stock_media'],
    enumDescriptions: {
      talent: "Rights to a real person's likeness, voice, name, or endorsement (athletes, celebrities, influencers)",
      character: 'Rights to fictional characters for advertising or co-branding',
      brand_ip: 'Rights to brand intellectual property (logos, trademarks, trade dress)',
      music: 'Rights to musical compositions or recordings (sync, background music)',
      stock_media: 'Rights to stock photography, video, or audio collections',
    },
  },
  {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: '/schemas/core/identity-relying-party.json',
    title: 'Identity Relying Party',
    type: 'object',
    description:
      "A verified-identity relying party an entity or brand operates. Used for attestation provenance in TMP Identity Match (the buyer checks a forwarded attestation's relying_party_id against the owner's published list). Issuer-agnostic; World ID is the first issuer.",
    properties: {
      issuer: {
        $ref: '/schemas/core/brand-ref.json',
        description:
          'Identity issuer / attestation authority, referenced as a vendor BrandRef (e.g. {"domain": "world.org"}) \u2014 the same vendor-reference shape AdCP uses for measurement and signals vendors. The issuer\'s canonical domain is the anchor; it need not host a brand.json, but if it does, that is where its verifier metadata (scheme versions, verify endpoint, JWKs) lives. Issuer-agnostic: World ID, ISO 18013-5 mDL, and W3C-VC issuers all reference by domain. The relying party is namespaced by the issuer \u2014 identity is the tuple (issuer.domain, issuer.brand_id, relying_party_id), mirroring (vendor.domain, vendor.brand_id, metric_id).',
      },
      scheme: {
        type: 'string',
        description: 'Proof scheme and version, e.g. "world_id_v4".',
      },
      relying_party_id: {
        type: 'string',
        'x-entity': 'identity_relying_party',
        description:
          "The relying-party id registered with the issuer (and, for on-chain issuers like World ID, with the issuer's registry). One entity may operate many relying parties (scope=entity vs scope=property); this is the attestation's audience / linkability boundary, not an entity identifier.",
      },
      scope: {
        type: 'string',
        enum: ['entity', 'property'],
        description:
          "Whether this relying_party_id is shared across the entity's properties (entity \u2192 a within-entity unique-human graph) or scoped to a single property (property \u2192 per-property pseudonyms, unlinkable across the entity).",
      },
    },
    required: ['issuer', 'relying_party_id'],
    additionalProperties: false,
  },
  {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: '/schemas/enums/billing-party.json',
    title: 'Billing Party',
    description:
      'Which party the seller invoices for a buyer\u2013storefront account relationship. Determines the billing entity and invoicing flow, not a payment rail, clearing intermediary, or per-media-buy settlement route. AdCP does not perform in-protocol payment or settlement.',
    type: 'string',
    enum: ['operator', 'agent', 'advertiser'],
    enumDescriptions: {
      operator: 'Seller invoices the operator \u2014 agency or brand buying direct',
      agent: 'Agent consolidates billing across brands and is invoiced by the seller',
      advertiser:
        'Seller invoices the advertiser directly, even when a different operator places orders on their behalf',
    },
  },
  {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: '/schemas/core/brand-ref.json',
    title: 'Brand Reference',
    description:
      'Reference to a brand by domain and optional brand_id. The domain hosts /.well-known/brand.json or is registered in the brand registry. For single-brand domains, brand_id can be omitted. For house-of-brands domains, brand_id identifies the specific brand. For creative production, brand.json is the canonical source of master brand identity (logo, palette, fonts, voice, and visual guidelines), subject only to the supported per-call fields in brand_kit_override. Catalogs supply product or item payload; catalog item asset groups, including property- or franchise-level logos, are item identity and do not override these master brand fields.',
    type: 'object',
    properties: {
      domain: {
        type: 'string',
        description: "Domain where /.well-known/brand.json is hosted, or the brand's operating domain",
        pattern: '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$',
      },
      brand_id: {
        $ref: '/schemas/core/brand-id.json',
        description: 'Brand identifier within the house portfolio. Optional for single-brand domains.',
      },
      countries: {
        type: 'array',
        items: {
          type: 'string',
          pattern: '^[A-Z]{2}$',
        },
        minItems: 1,
        uniqueItems: true,
        description:
          'Canonical set of ISO 3166-1 alpha-2 countries for this advertiser identity. Omit for a global/default identity. Array order is not meaningful; producers MUST sort codes lexicographically before computing keys or signatures. This qualifies account identity and is not delivery targeting.',
      },
      industries: {
        type: 'array',
        items: {
          type: 'string',
        },
        description:
          "Inline override for the brand's industries. Useful when the caller cannot modify the brand's canonical brand.json but needs to declare industries for governance (e.g., Annex III vertical detection). brand.json remains the canonical source; when omitted here, governance agents SHOULD resolve from brand.json.",
      },
      data_subject_contestation: {
        type: 'object',
        description:
          "Inline override for the brand's contestation contact point. Useful when the operator does not control brand.json but needs to discharge Art 22(3) for this plan. brand.json is canonical; when omitted, governance agents resolve brand \u2192 house \u2192 missing.",
        properties: {
          url: {
            type: 'string',
            format: 'uri',
            pattern: '^https://',
          },
          email: {
            type: 'string',
            format: 'email',
          },
          languages: {
            type: 'array',
            items: {
              type: 'string',
            },
          },
        },
        anyOf: [
          {
            required: ['url'],
          },
          {
            required: ['email'],
          },
        ],
        additionalProperties: false,
      },
      brand_kit_override: {
        type: 'object',
        description:
          "Inline override for brand-kit fields normally resolved from `/.well-known/brand.json` on `domain` (logo, colors, voice, tagline). Use when brand.json is missing, stale, or inappropriate for this specific call \u2014 e.g., a campaign-scoped tagline, a co-branded creative, a freshly-rebranded color palette the brand.json hasn't shipped yet. Same inline-override pattern as `industries` and `data_subject_contestation` above: brand.json is canonical, the override is per-call. Adopters needing to override fields outside this subset (`voice_attributes`, `prohibited_terms`, etc.) MUST publish a different brand.json and reference it via a different `domain` \u2014 the inline override is intentionally narrow to a small high-traffic subset.\n\n**Merge semantics (normative).** The merge is **field-level**, not whole-object replacement. Each field within `brand_kit_override` (`logo`, `colors`, `voice`, `tagline`) is evaluated independently \u2014 when a field is present on the override the override value applies; when a field is absent the brand.json value applies (or is absent if brand.json doesn't carry one either). For composite fields (`colors.primary`, `colors.secondary`, `colors.accent`), the merge is one level deeper: each color slot is evaluated independently \u2014 a producer can override `colors.primary` while still inheriting `colors.secondary` from brand.json. SDKs MUST NOT treat a present `brand_kit_override.colors` as wiping the brand.json `colors` block entirely; only the per-slot fields present in the override take precedence. Without this rule, a partial-override semantics would diverge across SDKs and produce inconsistent rendering for the same payload.",
        properties: {
          logo: {
            $ref: '/schemas/core/assets/image-asset.json',
            description: 'Override logo asset.',
          },
          colors: {
            type: 'object',
            description: 'Override brand colors (hex strings).',
            properties: {
              primary: {
                type: 'string',
                pattern: '^#[0-9a-fA-F]{6}$',
              },
              secondary: {
                type: 'string',
                pattern: '^#[0-9a-fA-F]{6}$',
              },
              accent: {
                type: 'string',
                pattern: '^#[0-9a-fA-F]{6}$',
              },
            },
            additionalProperties: true,
          },
          voice: {
            type: 'string',
            description: 'Override brand-voice description for surface-composed text/audio output.',
          },
          tagline: {
            type: 'string',
            description: 'Override tagline.',
          },
        },
        additionalProperties: true,
      },
    },
    required: ['domain'],
    additionalProperties: false,
    examples: [
      {
        domain: 'nova-brands.com',
        brand_id: 'spark',
      },
      {
        domain: 'nova-brands.com',
        brand_id: 'glow',
      },
      {
        domain: 'acme-corp.com',
      },
      {
        domain: 'nova-athletics.example',
        countries: ['NL'],
      },
    ],
  },
  {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: '/schemas/core/brand-id.json',
    title: 'Brand ID',
    description:
      'Identifier for a brand within a house portfolio. Must be lowercase alphanumeric with underscores only. The house chooses this identifier.',
    type: 'string',
    pattern: '^[a-z0-9_]+$',
    'x-entity': 'advertiser_brand',
    examples: ['tide', 'cheerios', 'air_jordan', 'nike', 'pampers'],
  },
  {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: '/schemas/core/assets/image-asset.json',
    title: 'Image Asset',
    description: 'Image asset with URL and dimensions',
    type: 'object',
    properties: {
      asset_type: {
        type: 'string',
        const: 'image',
        description:
          'Discriminator identifying this as an image asset. See /schemas/creative/asset-types for the registry.',
      },
      url: {
        type: 'string',
        format: 'uri',
        description: 'URL to the image asset',
      },
      width: {
        type: 'integer',
        minimum: 1,
        description: 'Width in pixels',
      },
      height: {
        type: 'integer',
        minimum: 1,
        description: 'Height in pixels',
      },
      file_size_bytes: {
        type: 'integer',
        minimum: 1,
        description: 'Image file size in bytes. Required by agents that advertise a max_file_size_kb constraint.',
      },
      pixel_ratio: {
        type: 'number',
        exclusiveMinimum: 0,
        description:
          'Intrinsic pixels per logical render pixel (for example `2` for a 600\u00d7500 image intended to render at 300\u00d7250). Optional because a validator can infer the ratio when the target format declares logical dimensions. When supplied, it MUST agree with both `width / logical_width` and `height / logical_height`; it is never a substitute for the intrinsic `width` and `height` fields.',
      },
      state_id: {
        type: 'string',
        description:
          'Binding used only when this image populates a `seller_rendered_stateful_display` `state_canvases` slot. It MUST match one declared `states[].state_id` (semantic validators resolve it). Omit for ordinary image slots.',
      },
      breakpoint_id: {
        type: 'string',
        description:
          'Binding used only when this image populates a `seller_rendered_stateful_display` `state_canvases` slot. It MUST match one breakpoint declared on the selected state (semantic validators resolve it). Omit for ordinary image slots.',
      },
      focal_point: {
        type: 'array',
        items: {
          type: 'number',
          minimum: 0,
          maximum: 1,
        },
        minItems: 2,
        maxItems: 2,
        description:
          "Normalized `[x, y]` coordinates (0\u20131 from top-left) of the image's visual anchor. Seller-side renderers crop toward the focal point when deriving renditions across breakpoints and aspect ratios; absent, cropping falls back to center-weighted defaults.",
      },
      format: {
        type: 'string',
        description: 'Image file format (jpg, png, gif, webp, etc.)',
      },
      alt_text: {
        type: 'string',
        description: 'Alternative text for accessibility',
        'x-accessibility': true,
      },
      provenance: {
        $ref: '/schemas/core/provenance.json',
        description: 'Provenance metadata for this asset, overrides manifest-level provenance',
      },
    },
    required: ['asset_type', 'url', 'width', 'height'],
    additionalProperties: true,
  },
  {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: '/schemas/core/provenance.json',
    title: 'Provenance',
    description:
      'Declares how content was produced, whether AI was involved, and what disclosure obligations apply. Attaches to creative manifests, individual assets, or content-standards artifacts. When present at multiple levels, the most specific provenance object replaces the inherited one entirely (no field-level merging). Provenance is a claim by the declaring party \u2014 receiving parties should verify claims independently via their own detection tools.',
    type: 'object',
    properties: {
      digital_source_type: {
        $ref: '/schemas/enums/digital-source-type.json',
        description: 'IPTC-aligned classification of AI involvement in producing this content',
      },
      synthetic_depiction: {
        type: 'boolean',
        description:
          'Assessed declaration of whether the content synthetically depicts a real or fictional person performing or appearing in a way that was generated or materially manipulated rather than captured as depicted. `true` covers both a fully synthetic performer and material manipulation of a real performer; `false` is an assessed declaration that the content does not contain such a depiction. Absence means the content has not been assessed for synthetic depiction. This field does not claim consent, legality, or independent verification, and receivers MUST NOT derive it solely from `digital_source_type`.',
      },
      ai_tool: {
        type: 'object',
        description:
          'AI system used to generate or modify this content. Aligns with IPTC 2025.1 AI metadata fields and C2PA claim_generator.',
        properties: {
          name: {
            type: 'string',
            description: "Name of the AI tool or model (e.g., 'DALL-E 3', 'Stable Diffusion XL', 'Gemini')",
          },
          version: {
            type: 'string',
            description:
              "Version identifier for the AI tool or model (e.g., '25.1', '0125', '2.1'). For generative models, use the model version rather than the API version.",
          },
          provider: {
            type: 'string',
            description: "Organization that provides the AI tool (e.g., 'OpenAI', 'Stability AI', 'Google')",
          },
        },
        required: ['name'],
      },
      human_oversight: {
        type: 'string',
        description:
          'Level of human involvement in the AI-assisted creation process. Independent of `disclosure.required` \u2014 the protocol does not derive disclosure obligations from oversight level. Some regulations include carve-outs for human-edited or human-directed AI output, but those carve-outs have factual prerequisites the schema cannot evaluate. Asserting `edited` or `directed` does not by itself justify `disclosure.required: false`.',
        enum: ['none', 'prompt_only', 'selected', 'edited', 'directed'],
        enumDescriptions: {
          none: 'Fully automated with no human involvement in generation',
          prompt_only: 'Human provided the prompt or instructions but did not review outputs',
          selected: 'Human selected from multiple AI-generated candidates',
          edited: 'Human edited or refined AI-generated output',
          directed: 'Human directed the creative process with AI as an assistive tool',
        },
      },
      declared_by: {
        type: 'object',
        description:
          'Party declaring this provenance. Identifies who attached the provenance claim, enabling receiving parties to assess trust.',
        properties: {
          agent_url: {
            type: 'string',
            format: 'uri',
            description: 'URL of the agent or service that declared this provenance',
          },
          role: {
            type: 'string',
            enum: ['creator', 'advertiser', 'agency', 'platform', 'tool'],
            description: 'Role of the declaring party in the supply chain',
            enumDescriptions: {
              creator: 'The party that created or generated the content',
              advertiser: 'The brand or advertiser that owns the content',
              agency: 'Agency acting on behalf of the advertiser',
              platform: 'Ad platform or publisher that processed the content',
              tool: 'Automated tool or service that attached provenance metadata',
            },
          },
        },
        required: ['role'],
      },
      declared_at: {
        type: 'string',
        format: 'date-time',
        description:
          'When this provenance claim was made (ISO 8601). Distinct from created_time, which records when the content itself was produced. A provenance claim may be attached well after content creation, for example when retroactively declaring AI involvement for regulatory compliance.',
      },
      created_time: {
        type: 'string',
        format: 'date-time',
        description: 'When this content was created or generated (ISO 8601)',
      },
      c2pa: {
        type: 'object',
        description:
          'C2PA sidecar manifest reference. Links to a detached cryptographic provenance manifest for this content. Note: file-level C2PA bindings break when ad servers transcode, resize, or re-encode assets. For pipelines with intermediaries, consider embedded_provenance as the primary provenance mechanism.',
        properties: {
          manifest_url: {
            type: 'string',
            format: 'uri',
            description: 'URL to the C2PA manifest store for this content',
          },
        },
        required: ['manifest_url'],
      },
      embedded_provenance: {
        type: 'array',
        description:
          'Provenance metadata embedded within the content stream. Each entry declares one embedding layer: structured provenance data carried inside the content itself, as distinct from sidecar references (c2pa.manifest_url). Embedded provenance survives operations that break sidecar and file-level bindings: ad-server transcoding, CMS ingestion, copy-paste, reformatting, and CDN re-encoding. For ad-tech pipelines where content passes through multiple intermediaries, embedded provenance is the reliable path for provenance that persists from declaration through delivery. This is a declaration by the embedding party. The receiving party (the seller) is the verifier-of-record: it confirms the claim by calling a governance agent it trusts (typically one published in `creative_policy.accepted_verifiers`).',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            method: {
              $ref: '/schemas/enums/embedded-provenance-method.json',
              description: 'How provenance data is carried within the content',
            },
            standard: {
              type: 'string',
              description:
                "Standard the embedding conforms to, if any (e.g., 'c2pa' for C2PA Section A.7 text manifest embedding)",
            },
            provider: {
              type: 'string',
              description:
                "Organization that performed the embedding (e.g., 'Encypher', 'Digimarc'). Display label and audit context \u2014 not a wire identifier.",
            },
            verify_agent: {
              type: 'object',
              description:
                "Buyer's representation that this embedding can be verified by a governance agent on the seller's `creative_policy.accepted_verifiers` list. The `agent_url` MUST match (canonicalized) one of the seller's published `accepted_verifiers[].agent_url` entries; sellers reject `sync_creatives` submissions whose `verify_agent.agent_url` is off-list with `PROVENANCE_VERIFIER_NOT_ACCEPTED`. This is buyer-supplied evidence, not buyer-driven routing \u2014 the seller is the verifier-of-record and the seller controls which agent it actually calls (the seller MAY use a different on-list agent if it determines this is more appropriate; the seller does not call buyer-asserted endpoints outside its allowlist). MAY be omitted for self-verifiable embeddings (e.g., a C2PA text manifest with a public key the seller already trusts).",
              properties: {
                agent_url: {
                  type: 'string',
                  format: 'uri',
                  pattern: '^https://',
                  description:
                    "URL of the governance agent the buyer represents was used to embed/verify this layer. MUST use the `https://` scheme and MUST appear in the seller's `creative_policy.accepted_verifiers[].agent_url` list (canonicalized per /docs/reference/url-canonicalization: lowercase scheme and host, strip default port, normalize path dot-segments). Sellers MUST NOT call this URL until the canonicalized match is confirmed.",
                },
                feature_id: {
                  type: 'string',
                  description:
                    "Optional `feature_id` the buyer represents the seller should request via `get_creative_features` (e.g., `encypher.markers_present_v2`). SHOULD match the `feature_id` declared on the matching `accepted_verifiers[]` entry, or be omitted to defer the selector to the seller. When the seller's entry pins a `feature_id`, that value wins; when neither side pins, the seller selects from the agent's `governance.creative_features` catalog.",
                },
              },
              required: ['agent_url'],
              additionalProperties: false,
            },
            embedded_at: {
              type: 'string',
              format: 'date-time',
              description: 'When the provenance data was embedded (ISO 8601)',
            },
          },
          required: ['method', 'provider'],
        },
      },
      watermarks: {
        type: 'array',
        description:
          'Content watermarks applied to this asset. Each entry declares one watermarking layer: a content modification that encodes an identifier or fingerprint within the asset. Watermarks differ from embedded provenance: a watermark encodes an identifier (who generated it, who owns it), while embedded provenance carries or references a structured provenance record (the full chain of custody). A single asset may carry both. Aligns with C2PA action taxonomy: c2pa.watermarked.bound (watermark linked to a C2PA manifest) and c2pa.watermarked.unbound (watermark independent of any manifest). This is a declaration by the watermarking party. The receiving party (the seller) is the verifier-of-record: it confirms the claim by calling a governance agent it trusts (typically one published in `creative_policy.accepted_verifiers`).',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            media_type: {
              $ref: '/schemas/enums/watermark-media-type.json',
              description: 'Media category of the watermarked content',
            },
            provider: {
              type: 'string',
              description:
                "Organization that applied the watermark (e.g., 'Imatag', 'Steg.AI', 'Encypher'). Display label and audit context \u2014 not a wire identifier.",
            },
            verify_agent: {
              type: 'object',
              description:
                "Buyer's representation that this watermark can be detected by a governance agent on the seller's `creative_policy.accepted_verifiers` list. The `agent_url` MUST match (canonicalized) one of the seller's published `accepted_verifiers[].agent_url` entries; sellers reject `sync_creatives` submissions whose `verify_agent.agent_url` is off-list with `PROVENANCE_VERIFIER_NOT_ACCEPTED`. This is buyer-supplied evidence, not buyer-driven routing \u2014 the seller is the verifier-of-record and the seller controls which agent it actually calls (the seller MAY use a different on-list agent if it determines this is more appropriate; the seller does not call buyer-asserted endpoints outside its allowlist).",
              properties: {
                agent_url: {
                  type: 'string',
                  format: 'uri',
                  pattern: '^https://',
                  description:
                    "URL of the governance agent the buyer represents was used to apply/detect this watermark. MUST use the `https://` scheme and MUST appear in the seller's `creative_policy.accepted_verifiers[].agent_url` list (canonicalized per /docs/reference/url-canonicalization: lowercase scheme and host, strip default port, normalize path dot-segments). Sellers MUST NOT call this URL until the canonicalized match is confirmed.",
                },
                feature_id: {
                  type: 'string',
                  description:
                    "Optional `feature_id` the buyer represents the seller should request via `get_creative_features` (e.g., `imatag.watermark_detected`). SHOULD match the `feature_id` declared on the matching `accepted_verifiers[]` entry, or be omitted to defer the selector to the seller. When the seller's entry pins a `feature_id`, that value wins; when neither side pins, the seller selects from the agent's `governance.creative_features` catalog.",
                },
              },
              required: ['agent_url'],
              additionalProperties: false,
            },
            c2pa_action: {
              $ref: '/schemas/enums/c2pa-watermark-action.json',
              description: 'C2PA action classification for this watermark',
            },
            embedded_at: {
              type: 'string',
              format: 'date-time',
              description: 'When the watermark was applied (ISO 8601)',
            },
          },
          required: ['media_type', 'provider'],
        },
      },
      disclosure: {
        type: 'object',
        description:
          'Regulatory disclosure requirements for this content. Indicates whether AI disclosure is required and under which jurisdictions.',
        properties: {
          required: {
            type: 'boolean',
            description:
              "The declaring party's claim that AI disclosure is required for this content under applicable regulations. This is a declared signal carried through the supply chain \u2014 useful as a routing and audit input \u2014 not a regulatory determination made by the protocol. Receiving parties remain responsible for their own jurisdictional analysis and should not treat `required: false` as compliance cover.",
          },
          jurisdictions: {
            type: 'array',
            description: 'Jurisdictions where disclosure obligations apply',
            items: {
              type: 'object',
              properties: {
                country: {
                  type: 'string',
                  description: "ISO 3166-1 alpha-2 country code (e.g., 'US', 'DE', 'CN')",
                },
                region: {
                  type: 'string',
                  description: "Sub-national region code (e.g., 'CA' for California, 'BY' for Bavaria)",
                },
                regulation: {
                  type: 'string',
                  description: "Regulation identifier (e.g., 'eu_ai_act_article_50', 'ca_sb_942', 'cn_deep_synthesis')",
                },
                label_text: {
                  type: 'string',
                  description: 'Required disclosure label text for this jurisdiction, in the local language',
                },
                render_guidance: {
                  type: 'object',
                  description:
                    "How the disclosure should be rendered for this jurisdiction. Expresses the declaring party's intent for persistence and position based on regulatory requirements. Publishers control actual rendering but governance agents can audit whether guidance was followed.",
                  minProperties: 1,
                  properties: {
                    persistence: {
                      $ref: '/schemas/enums/disclosure-persistence.json',
                      description: 'How long the disclosure must persist during content playback or display',
                    },
                    min_duration_ms: {
                      type: 'integer',
                      minimum: 1,
                      description:
                        "Minimum display duration in milliseconds for initial persistence. Recommended when persistence is initial \u2014 without it, the duration is at the publisher's discretion. At serve time the publisher reads this from provenance since the brief is not available.",
                    },
                    positions: {
                      type: 'array',
                      description:
                        'Preferred disclosure positions in priority order. The first position a format supports should be used.',
                      items: {
                        $ref: '/schemas/enums/disclosure-position.json',
                      },
                      minItems: 1,
                      uniqueItems: true,
                    },
                    ext: {
                      $ref: '/schemas/core/ext.json',
                    },
                  },
                },
              },
              required: ['country', 'regulation'],
            },
            minItems: 1,
          },
        },
        required: ['required'],
      },
      verification: {
        type: 'array',
        description:
          'Third-party verification or detection results for this content. Multiple services may independently evaluate the same content. Provenance is a claim \u2014 verification results attached by the declaring party are supplementary. The enforcing party (e.g., seller/publisher) should run its own verification via get_creative_features or calibrate_content.',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            verified_by: {
              type: 'string',
              description:
                "Name of the verification service (e.g., 'DoubleVerify', 'Hive Moderation', 'Reality Defender')",
            },
            verified_time: {
              type: 'string',
              format: 'date-time',
              description: 'When the verification was performed (ISO 8601)',
            },
            result: {
              type: 'string',
              enum: ['authentic', 'ai_generated', 'ai_modified', 'inconclusive'],
              description: 'Verification outcome',
            },
            confidence: {
              type: 'number',
              minimum: 0,
              maximum: 1,
              description: 'Confidence score of the verification result (0.0 to 1.0)',
            },
            details_url: {
              type: 'string',
              format: 'uri',
              description: 'URL to the full verification report',
            },
          },
          required: ['verified_by', 'result'],
        },
      },
      ext: {
        $ref: '/schemas/core/ext.json',
      },
    },
  },
  {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: '/schemas/enums/digital-source-type.json',
    title: 'Digital Source Type',
    description:
      'Classification of AI involvement in content creation, aligned with IPTC digitalsourcetype vocabulary. Used in provenance metadata to declare how a creative asset, artifact, or individual asset was produced.',
    type: 'string',
    enum: [
      'digital_capture',
      'digital_creation',
      'trained_algorithmic_media',
      'composite_with_trained_algorithmic_media',
      'algorithmic_media',
      'composite_capture',
      'composite_synthetic',
      'human_edits',
      'data_driven_media',
    ],
    enumDescriptions: {
      digital_capture: 'Captured by a digital device (camera, scanner, screen recording) with no AI involvement',
      digital_creation:
        'Created by a human using digital tools (Photoshop, Illustrator, After Effects) without AI generation',
      trained_algorithmic_media:
        'Generated entirely by a trained AI model (DALL-E, Midjourney, Stable Diffusion, Sora)',
      composite_with_trained_algorithmic_media:
        'Human-created content combined with AI-generated elements (e.g., photo with AI background)',
      algorithmic_media:
        'Produced by deterministic algorithms without machine learning (procedural generation, rule-based systems)',
      composite_capture: 'Multiple digital captures composited together without AI',
      composite_synthetic:
        'Composite of multiple elements where at least one is AI-generated (e.g., stock photo composited with AI-generated background)',
      human_edits: 'Content augmented, corrected, or enhanced by humans using non-generative tools',
      data_driven_media:
        'Assembled from structured data feeds (DCO templates, product catalogs, weather-triggered variants)',
    },
  },
  {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: '/schemas/enums/embedded-provenance-method.json',
    title: 'Embedded Provenance Method',
    description:
      'How provenance data is carried within the content stream. Distinguishes between format-level manifest embedding (where the manifest travels inside the file container) and provenance markers (where invisible markers in the content itself encode or reference a provenance record). Both survive operations that strip sidecar metadata, but provenance markers additionally survive content-level transformations such as copy-paste, reformatting, and CMS re-encoding.',
    type: 'string',
    enum: ['manifest_wrapper', 'provenance_markers'],
    enumDescriptions: {
      manifest_wrapper:
        "A provenance manifest embedded in the file container per format-specific rules (e.g., JUMBF box in JPEG, C2PATextManifestWrapper in plaintext per C2PA Section A.7). The manifest travels with the file but is tied to the file's byte structure.",
      provenance_markers:
        'Invisible markers embedded within the content stream that encode or reference a provenance record. Designed to survive reformatting, copy-paste, CMS ingestion, and ad-server transcoding that breaks file-level bindings.',
    },
  },
  {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: '/schemas/enums/watermark-media-type.json',
    title: 'Watermark Media Type',
    description:
      'Media category of a content watermark. Identifies what kind of content the watermark is applied to, which determines the detection and verification methods required.',
    type: 'string',
    enum: ['audio', 'image', 'video', 'text'],
    enumDescriptions: {
      audio: 'Watermark applied to audio content (e.g., spread-spectrum, echo hiding)',
      image: 'Watermark applied to image content (e.g., spatial domain, frequency domain)',
      video: 'Watermark applied to video content (e.g., per-frame image watermarking, temporal watermarking)',
      text: 'Watermark applied to text content (e.g., synonym substitution, structural modification)',
    },
  },
  {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: '/schemas/enums/c2pa-watermark-action.json',
    title: 'C2PA Watermark Action',
    description:
      'C2PA action classification for a content watermark. Distinguishes watermarks that are cryptographically linked to a C2PA manifest (bound) from watermarks that exist independently (unbound). Aligns with the c2pa.watermarked.* action family in the C2PA action taxonomy.',
    type: 'string',
    enum: ['c2pa.watermarked.bound', 'c2pa.watermarked.unbound'],
    enumDescriptions: {
      'c2pa.watermarked.bound':
        'Watermark linked to a C2PA manifest for this asset. The watermark and manifest are mutually reinforcing: the manifest references the watermark, and the watermark can be used to locate the manifest.',
      'c2pa.watermarked.unbound':
        'Watermark independent of any C2PA manifest. Applied before any provenance signing event (e.g., by the AI generator at creation time) or in pipelines where no manifest is present.',
    },
  },
  {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: '/schemas/enums/disclosure-persistence.json',
    title: 'Disclosure Persistence',
    description:
      'How long a disclosure must persist during content playback or display. Different jurisdictions and regulations require different persistence behaviors for AI-generated content labels. When multiple sources specify persistence for the same jurisdiction (e.g., brief and provenance), the most restrictive mode applies: continuous > initial > flexible.',
    type: 'string',
    enum: ['continuous', 'initial', 'flexible'],
    enumDescriptions: {
      continuous:
        "Disclosure must remain visible or audible throughout the entire content display duration. For video and audio, this means the full playback duration. For static formats (display, DOOH), this means the full display slot. For DOOH specifically, 'content duration' means the ad's display slot within the rotation, not the screen's full rotation cycle.",
      initial:
        'Disclosure must appear at the start of content for a minimum duration before it may be removed. Pair with min_duration_ms in render_guidance or creative brief to specify the required duration.',
      flexible: "Disclosure presence is sufficient; placement timing and duration are at the publisher's discretion",
    },
  },
  {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: '/schemas/enums/disclosure-position.json',
    title: 'Disclosure Position',
    description:
      'Where a required disclosure should appear within a creative. Used by creative briefs to specify disclosure placement and by formats to declare which positions they can render.',
    type: 'string',
    enum: ['prominent', 'footer', 'audio', 'subtitle', 'overlay', 'end_card', 'pre_roll', 'companion'],
  },
];
