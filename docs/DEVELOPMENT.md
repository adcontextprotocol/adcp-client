# Documentation Development Guide

This guide covers how to develop and preview the documentation locally with **100% GitHub Pages compatibility**.

## 🎯 Best Practices for GitHub Pages Preview

### Option 1: Docker (Recommended)
**Advantages:** Exact GitHub Pages environment, no Ruby installation needed

```bash
# Start Jekyll server (matches GitHub Pages exactly)
npm run docs:serve
# OR
cd docs && make serve

# Visit: http://localhost:4000
```

### Option 2: Simple Live Server
**Advantages:** Fast, no dependencies

```bash
# Simple HTML preview (no Jekyll processing)
npm run docs:serve-simple

# Visit: http://localhost:4000
```

### Option 3: Local Jekyll (Advanced)
**Advantages:** Native performance

```bash
# Install Jekyll dependencies
npm run docs:install

# Build and serve
npm run docs:build
cd docs && bundle exec jekyll serve
```

## 🛠️ Development Workflow

### 1. Generate API Documentation
```bash
# Generate TypeDoc API reference
npm run docs

# Watch for changes
npm run docs:watch
```

### 2. Preview Documentation
```bash
# Start development server
npm run docs:serve

# The server will auto-reload on changes
```

### 3. Build for Production
```bash
# Build everything
npm run docs:build

# Check output in docs/_site/
```

## 📁 Documentation Structure

```
docs/
├── _config.yml              # Jekyll configuration (GitHub Pages compatible)
├── Gemfile                  # Ruby dependencies (exact GitHub Pages versions)
├── docker-compose.yml       # Docker setup for local development
├── Makefile                 # Development commands
├── index.html              # Main navigation page
├── getting-started.md      # Quick start guide
├── guides/                 # Detailed guides
│   ├── ASYNC-DEVELOPER-GUIDE.md
│   ├── REAL-WORLD-EXAMPLES.md
│   └── ...
└── api/                    # Auto-generated API docs (TypeDoc)
    ├── README.md
    ├── classes/
    ├── interfaces/
    └── ...
```

## 🔧 Configuration Details

### Jekyll Configuration (`_config.yml`)
- **Theme:** `jekyll-theme-cayman` (GitHub Pages supported)
- **Markdown:** `kramdown` with GFM input (GitHub's processor)
- **Highlighter:** `rouge` (GitHub's syntax highlighter)
- **Plugins:** Only GitHub Pages whitelisted plugins

### TypeDoc Configuration (`typedoc.json`)
- **Output:** `docs/api/` (integrated with Jekyll)
- **Format:** Markdown (GitHub Pages compatible)
- **Navigation:** Automatic with proper categorization

## 🚀 Deployment

Documentation is automatically deployed via GitHub Actions:

1. **Trigger:** Push to `main` branch
2. **Process:** 
   - Generate TypeDoc API docs
   - Build Jekyll site
   - Deploy to GitHub Pages
3. **URL:** `https://adcontextprotocol.github.io/adcp-client/`

## 📝 Writing Documentation

### Adding New Guides
1. Create `.md` file in `docs/guides/`
2. Add front matter:
```yaml
---
title: Your Guide Title
layout: default
---
```
3. Update navigation in `docs/index.html`

### API Documentation
API docs are auto-generated from TypeScript source. To improve them:

1. Add TSDoc comments to your code:
```typescript
/**
 * Executes a task asynchronously with full handler support.
 * 
 * @param toolName - The name of the tool to execute
 * @param args - Arguments to pass to the tool
 * @returns Promise resolving to task result with status
 * 
 * @example
 * ```typescript
 * const result = await client.executeTask('get_products', {
 *   brief: 'Coffee advertising'
 * });
 * ```
 */
async executeTask<T = any>(toolName: string, args: any): Promise<TaskResult<T>>
```

2. Regenerate docs:
```bash
npm run docs
```

## 🔍 Troubleshooting

### "Bundle install failed"
Use Docker instead:
```bash
npm run docs:serve  # Uses Docker, no Ruby needed
```

### "Jekyll not found"
```bash
# Use Docker approach
npm run docs:serve

# OR install Jekyll locally
npm run docs:install
```

### "Live reload not working"
Check that you're using:
```bash
npm run docs:serve  # Has live reload via Docker
```

### "Styles look different from GitHub Pages"
Ensure you're using the Jekyll server:
```bash
npm run docs:serve  # Processes Jekyll exactly like GitHub
```

## 📊 Performance Tips

1. **Use `--incremental`** - Only rebuilds changed files
2. **Use `--livereload`** - Auto-refresh browser on changes  
3. **Exclude large directories** - Already configured in `_config.yml`
4. **Docker volumes** - Configured for optimal performance

## 🎨 Customization

The documentation uses GitHub's Cayman theme with customizations:

- **Navigation:** Custom HTML in `index.html`
- **Styling:** Theme's default CSS with GitHub Pages compatibility
- **Layout:** Responsive design that works on all devices

To customize, edit `docs/index.html` and add custom CSS in front matter.