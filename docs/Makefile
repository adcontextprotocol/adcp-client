# GitHub Pages Local Development
.PHONY: serve install build clean help

help: ## Show this help message
	@echo "GitHub Pages Local Development Commands:"
	@echo "  make serve     - Start Jekyll server (Docker)"
	@echo "  make install   - Install dependencies with Bundle"
	@echo "  make build     - Build the site"
	@echo "  make clean     - Clean build artifacts"
	@echo "  make stop      - Stop Jekyll server"

serve: ## Start Jekyll development server using Docker
	@echo "🚀 Starting Jekyll server at http://localhost:4000"
	@echo "   This matches GitHub Pages environment exactly"
	docker-compose up

install: ## Install Jekyll dependencies locally
	@echo "📦 Installing Jekyll dependencies..."
	bundle install

build: ## Build the Jekyll site
	@echo "🔨 Building Jekyll site..."
	bundle exec jekyll build

clean: ## Clean Jekyll build artifacts
	@echo "🧹 Cleaning build artifacts..."
	bundle exec jekyll clean
	docker-compose down

stop: ## Stop Jekyll development server
	@echo "⏹️  Stopping Jekyll server..."
	docker-compose down