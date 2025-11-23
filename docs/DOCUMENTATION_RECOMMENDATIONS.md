# Documentation Enhancement Recommendations

## Current Setup

You're currently using:
- **TypeDoc** with `typedoc-plugin-markdown` for GitHub Pages
- Markdown-based output (great for GitHub Pages)
- Auto-deployment via GitHub Actions

## Theme Options

Since you're using the **markdown plugin**, traditional HTML themes won't work. However, here are your options:

### Option 1: Keep Markdown + Add Jekyll Theme (Recommended - Easy)

**Pros:**
- Works with your current setup
- GitHub Pages has built-in themes
- Zero build complexity
- Fast deployment

**Implementation:**
Update `docs/_config.yml`:
```yaml
theme: jekyll-theme-cayman  # or slate, minimal, architect, etc.
title: "@adcp/client API Documentation"
description: "TypeScript client for the Ad Context Protocol"

# Add navigation
header_pages:
  - README.md
  - api/README.md

# GitHub metadata
github:
  repository_url: https://github.com/adcontextprotocol/adcp-client

# Optional: Add search via Lunr
plugins:
  - jekyll-seo-tag
```

Available GitHub Pages themes:
- `jekyll-theme-cayman` - Clean, modern (recommended)
- `jekyll-theme-slate` - Dark theme
- `jekyll-theme-minimal` - Very clean
- `jekyll-theme-architect` - Professional

### Option 2: Switch to HTML + Modern Theme (More Work, Better Result)

If you want a more modern look, switch from markdown to HTML output:

**Best HTML Themes:**

1. **typedoc-material-theme** (Recommended)
   - Material Design 3
   - Beautiful, modern UI
   - Good navigation
   - Install: `npm install --save-dev typedoc-material-theme`

2. **Default TypeDoc theme** (Already included)
   - Clean, professional
   - Good search built-in
   - Works out of the box

**Configuration for HTML:**
```json
{
  "$schema": "https://typedoc.org/schema.json",
  "entryPoints": ["src/lib/index.ts"],
  "out": "docs/api",
  "plugin": [],  // Remove markdown plugin
  "theme": "default",  // or "./node_modules/typedoc-material-theme/bin/default"
  // ... rest of config
}
```

### Option 3: Docusaurus (Enterprise-grade, Most Work)

For a fully-featured documentation site:

**Pros:**
- Best-in-class search (Algolia)
- Versioning
- Interactive code examples
- Tutorials + API docs side-by-side
- MDX support

**Cons:**
- More setup required
- Separate build process
- Larger deployment

## Search Options

### For Current Markdown Setup:

1. **Lunr.js via Jekyll** (Easiest)
   ```yaml
   # docs/_config.yml
   plugins:
     - jekyll-lunr-js-search
   ```
   - Client-side search
   - Works on GitHub Pages
   - Install: Add to Gemfile

2. **Algolia DocSearch** (Free for open source)
   - Best search experience
   - Requires application approval
   - Apply at: https://docsearch.algolia.com/apply/

3. **GitHub Pages Search** (Simple)
   Add this to your docs layout:
   ```html
   <script src="https://cdn.jsdelivr.net/npm/lunr@2.3.9/lunr.min.js"></script>
   ```

### For HTML TypeDoc:

**Built-in Search** - The default TypeDoc HTML output includes search!
- No extra plugins needed
- Fast client-side search
- Works out of the box

## My Recommendation

**Quick Win (5 minutes):**
1. Keep your current markdown setup
2. Add a better Jekyll theme to `docs/_config.yml`
3. Add Lunr.js search plugin

**Better Long-term (30 minutes):**
1. Switch to HTML output (remove markdown plugin)
2. Use default TypeDoc theme (has built-in search)
3. Update GitHub Actions to deploy HTML instead of markdown

**Best Experience (2-3 hours):**
1. Set up Docusaurus
2. Use TypeDoc to generate API docs
3. Write tutorials/guides in MDX
4. Add Algolia search

## Quick Implementation

### Option A: Enhanced Markdown (Easiest)

```bash
# Update docs/_config.yml
echo "theme: jekyll-theme-cayman
plugins:
  - jekyll-seo-tag" > docs/_config.yml

# That's it! Redeploy
```

### Option B: Switch to HTML with Search (Better)

```bash
# 1. Update typedoc.json
# Remove: "plugin": ["typedoc-plugin-markdown"]
# Add: "theme": "default"

# 2. Regenerate docs
npm run docs

# 3. Done! HTML output now has built-in search
```

### Option C: Add Material Theme

```bash
# Install theme
npm install --save-dev typedoc-material-theme

# Update typedoc.json
{
  "theme": "./node_modules/typedoc-material-theme/bin/default",
  "plugin": []  // Remove markdown plugin
}

# Regenerate
npm run docs
```

## What I'd Do

If this were my project, I'd do **Option B** (HTML with default theme):
- **5 minutes** to implement
- **Built-in search** that works great
- **Better navigation** than markdown
- **Still deploys** to GitHub Pages perfectly
- **No new dependencies**

The default TypeDoc HTML theme is actually quite nice and has excellent search built-in. You lose the "plain markdown" aesthetic, but gain much better UX.

## Example Implementation

Want me to:
1. ✅ Switch to HTML output with built-in search (5 min)
2. ✅ Keep markdown but add Jekyll theme + search (5 min)
3. ✅ Add Material theme for beautiful UI (10 min)
4. ✅ Set up full Docusaurus (ask separately if you want this)

Let me know which option you prefer!
