# GitHub Pages Local Development
.PHONY: serve install build clean help

help: ## Show this help message
	@echo "GitHub Pages Local Development Commands:"
	@echo "  make serve       - Start Jekyll server (Docker) - RECOMMENDED"
	@echo "  make serve-local - Start Jekyll server (local Ruby)"
	@echo "  make install     - Install dependencies locally (no sudo needed)"
	@echo "  make build       - Build the site"
	@echo "  make clean       - Clean build artifacts"
	@echo "  make stop        - Stop Jekyll server"

serve: ## Start Jekyll development server using Docker
	@echo "🚀 Starting Jekyll server at http://localhost:4000"
	@echo "   This matches GitHub Pages environment exactly"
	docker-compose up

install: ## Install Jekyll dependencies locally
	@echo "📦 Installing Jekyll dependencies..."
	@echo "   Using local bundle path to avoid sudo requirements"
	bundle config set --local path 'vendor/bundle'
	bundle install

build: ## Build the Jekyll site
	@echo "🔨 Building Jekyll site..."
	bundle exec jekyll build

serve-local: ## Start Jekyll server locally (not Docker)
	@echo "🚀 Starting local Jekyll server at http://localhost:4000"
	@echo "   Note: Use 'make serve' for exact GitHub Pages environment"
	bundle exec jekyll serve --livereload --incremental

clean: ## Clean Jekyll build artifacts
	@echo "🧹 Cleaning build artifacts..."
	bundle exec jekyll clean || true
	docker-compose down || true
	rm -rf vendor/bundle _site .jekyll-cache

stop: ## Stop Jekyll development server
	@echo "⏹️  Stopping Jekyll server..."
	docker-compose down