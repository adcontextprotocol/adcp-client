# Documentation Strategy for @adcp/client

## Overview

Based on SDK best practices and developer feedback, we've implemented a **three-tier documentation strategy** that balances accessibility with comprehensiveness.

## Structure

### 1. README.md (Entry Point)
**Location:** Repository root  
**Purpose:** Quick start and overview  
**Content:**
- Installation instructions
- Basic usage examples  
- Key features
- Links to detailed documentation

**Why:** Developers expect to find essential information immediately when landing on the GitHub repository.

### 2. GitHub Pages Site (Detailed Docs)
**Location:** `https://[org].github.io/adcp-client/`  
**Source:** `/docs` folder  
**Content:**
- Getting started guide
- Conceptual guides (async patterns, handlers, etc.)
- Troubleshooting
- Migration guides
- Real-world examples

**Why:** Complex topics need proper formatting, navigation, and search capabilities that GitHub Pages provides.

### 3. TypeDoc API Reference (Auto-generated)
**Location:** `/docs/api` (published to GitHub Pages)  
**Source:** TypeScript source code with TSDoc comments  
**Content:**
- Class references
- Method signatures
- Type definitions
- Interface documentation

**Why:** API documentation should be generated from code to ensure accuracy and reduce maintenance burden.

## File Organization

```
/
├── README.md                    # Streamlined entry point (< 200 lines)
├── CONTRIBUTING.md              # Contribution guidelines
├── CHANGELOG.md                 # Version history
├── LICENSE                      # MIT License
│
├── docs/                        # GitHub Pages source
│   ├── index.md                # Documentation home
│   ├── getting-started.md      # Quick start guide
│   ├── _config.yml            # Jekyll configuration
│   │
│   ├── guides/                 # Detailed guides
│   │   ├── ASYNC-DEVELOPER-GUIDE.md
│   │   ├── ASYNC-MIGRATION-GUIDE.md
│   │   ├── ASYNC-TROUBLESHOOTING-GUIDE.md
│   │   ├── HANDLER-PATTERNS-GUIDE.md
│   │   ├── REAL-WORLD-EXAMPLES.md
│   │   └── TESTING-STRATEGY.md
│   │
│   └── api/                    # TypeDoc output (auto-generated)
│       ├── index.html
│       ├── classes/
│       ├── interfaces/
│       └── modules/
│
├── examples/                   # Runnable code examples
│   ├── basic-usage.ts
│   ├── async-patterns.ts
│   └── multi-agent.ts
│
└── src/lib/                   # Source with TSDoc comments
    └── **/*.ts

```

## Documentation Workflow

### Local Development
```bash
# Generate API docs
npm run docs

# Watch mode for API docs
npm run docs:watch

# Serve docs locally
npm run docs:serve
# Visit http://localhost:3001
```

### Deployment
1. Push to `main` branch
2. GitHub Action builds TypeDoc
3. Deploys to GitHub Pages automatically

### Adding Documentation

#### For New Features
1. Add TSDoc comments to source code
2. Update relevant guide in `/docs/guides`
3. Add example in `/examples`
4. Update CHANGELOG.md

#### For API Changes
1. Update TSDoc comments in source
2. TypeDoc regenerates on build
3. No manual updates needed

## Benefits of This Approach

### For Developers
✅ **Single source of truth** - README for quick reference  
✅ **Progressive disclosure** - Basic → Detailed → API  
✅ **Searchable docs** - GitHub Pages provides search  
✅ **Accurate API docs** - Always in sync with code  

### For Maintainers
✅ **Reduced duplication** - Each doc has clear purpose  
✅ **Auto-generated API** - Less manual maintenance  
✅ **Version control** - All docs in git  
✅ **CI/CD integration** - Automatic deployment  

## Migration from Previous Structure

### What Changed
- Moved 8 detailed guides from root to `/docs/guides/`
- Consolidated README from 300+ to ~170 lines
- Added TypeDoc configuration
- Set up GitHub Pages structure

### What Stayed
- All content preserved in guides
- Examples directory unchanged
- Core documentation files (CONTRIBUTING, CHANGELOG, etc.)

## Next Steps

1. **Enable GitHub Pages** in repository settings
2. **Update repository description** to include docs link
3. **Add documentation badge** to README
4. **Consider adding**:
   - Search functionality (DocSearch)
   - Version selector (for multiple versions)
   - Dark mode toggle
   - Edit on GitHub links

## Maintenance Guidelines

### Keep README Focused
- Maximum 200 lines
- Only essential information
- Link to detailed docs

### Update Guides Sparingly
- Only for major features
- Combine related topics
- Archive outdated content

### Rely on TypeDoc
- Document in code
- Use TSDoc tags properly
- Generate on every release

This strategy provides the best developer experience while maintaining comprehensive documentation with minimal overhead.