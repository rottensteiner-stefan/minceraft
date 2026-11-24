# Variables
NPM := npm
DIST_DIR := dist
NODE_MODULES := node_modules

# Colors for help output
BLUE := \033[36m
GREEN := \033[32m
YELLOW := \033[33m
RESET := \033[0m

.PHONY: all help install dev start restart kill build test test-watch typecheck check check-m7 check-webgl1 check-gates check-all preview clean fclean

# Default target
all: help

help: ## Zeigt diese Hilfe an
	@echo ""
	@echo "Verfügbare Befehle für Minceraft (Chunk-streamed Voxel Sandbox):"
	@echo ""
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  $(BLUE)%-16s$(RESET) %s\n", $$1, $$2}'
	@echo ""

install: $(NODE_MODULES) ## Installiert alle Abhängigkeiten

$(NODE_MODULES): package.json
	$(NPM) install
	@touch $(NODE_MODULES)

dev: install ## Startet den Vite Development-Server (Host)
	$(NPM) run dev

start: dev ## Alias für 'make dev'

restart: kill ## Beendet blockierte Vite-Ports und startet den Dev-Server neu
	$(NPM) run dev

kill: ## Beendet alle Prozesse auf typischen Vite-Ports (5173-5185 etc.)
	$(NPM) run kill:vite

typecheck: install ## Führt Strict TypeScript Type-Check aus (tsc --noEmit)
	$(NPM) run typecheck

test: install ## Führt alle Vitest Tests aus
	$(NPM) run test

test-watch: install ## Startet Vitest im interaktiven Watch-Modus
	$(NPM) run test:watch

build: install ## Erstellt den Produktions-Build (Vite Client Bundle)
	$(NPM) run build

preview: build ## Startet Vorschau-Server für das gebaute Projekt (dist/)
	$(NPM) run preview

check: install ## Führt Core-Gates aus (Typecheck, Test, Build)
	@echo "$(YELLOW)=== 1/3 Typecheck ===$(RESET)"
	$(NPM) run typecheck
	@echo "$(YELLOW)=== 2/3 Tests ===$(RESET)"
	$(NPM) run test
	@echo "$(YELLOW)=== 3/3 Build ===$(RESET)"
	$(NPM) run build
	@echo "$(GREEN)✔ Alle Core-Gates erfolgreich bestanden.$(RESET)"

check-m7: build ## Führt das M7 Headless-Browser-Gate aus (Worker-Pool & OPFS)
	$(NPM) run check:voxel-m7

check-webgl1: build ## Führt das WebGL1 Fallback Headless-Browser-Gate aus
	$(NPM) run check:voxel-webgl1

check-gates: check-m7 check-webgl1 ## Führt alle Headless-Browser-Gates aus
	@echo "$(GREEN)✔ Alle Browser-Gates erfolgreich bestanden.$(RESET)"

check-all: check check-gates ## Führt alle Gates aus (Core-Gates + Browser-Gates)
	@echo "$(GREEN)✔ Alle Minceraft-Gates (Core & Browser) erfolgreich bestanden.$(RESET)"

clean: ## Löscht Build-Artefakte (dist/)
	rm -rf $(DIST_DIR)
	@echo "Build-Artefakte gelöscht."

fclean: clean ## Löscht Build-Artefakte und node_modules
	rm -rf $(NODE_MODULES)
	@echo "node_modules und Build-Artefakte gelöscht."
