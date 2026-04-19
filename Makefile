.PHONY: help dev backend frontend docs icons screenshot build run \
	lint lint-fe lint-be format format-check typecheck \
	test test-fe test-be test-e2e check generate

ROOT := $(CURDIR)
FRONTEND_DIR := $(ROOT)/frontend
DESKTOP_DIR := $(ROOT)/desktop
ICONS_DIR := $(DESKTOP_DIR)/src-tauri/icons
ASSETS_DIR := $(ROOT)/assets
TRACKS_CACHE := $(ROOT)/.cache/screenshot-tracks.json
ICON_SOURCE ?= $(ASSETS_DIR)/starlib-dark-grad.png
APP_PATH := $(DESKTOP_DIR)/src-tauri/target/release/bundle/macos/Starlib.app

help:
	@echo "Starlib Makefile targets:"
	@echo ""
	@echo "  Run:"
	@echo "    make dev           Run backend and frontend together"
	@echo "    make backend       Run FastAPI backend (:8000)"
	@echo "    make frontend      Run Next.js frontend (:3000)"
	@echo "    make docs          Serve Zensical docs (:8200)"
	@echo ""
	@echo "  Quality:"
	@echo "    make check         Run lint + format-check + typecheck + test"
	@echo "    make lint          Lint backend and frontend"
	@echo "    make format        Format backend and frontend"
	@echo "    make format-check  Check formatting without writing"
	@echo "    make typecheck     Typecheck backend (mypy) and frontend (tsc)"
	@echo "    make test          Run backend and frontend unit tests"
	@echo "    make test-e2e      Run Playwright e2e tests"
	@echo ""
	@echo "  Assets & build:"
	@echo "    make generate      Regenerate OpenAPI clients"
	@echo "    make icons         Generate desktop icons (ICON_SOURCE=path/to.png)"
	@echo "    make screenshot    Capture documentation screenshots"
	@echo "    make build         Build desktop app (sidecar + frontend + Tauri)"
	@echo "    make run           Build and launch the desktop app"

# ---------- Run ----------

dev:
	@echo "==> Starting backend (:8000) and frontend (:3000)..."
	@trap 'kill 0' INT TERM EXIT; \
		uv run python -m backend.main & \
		(cd $(FRONTEND_DIR) && npm run dev) & \
		wait

backend:
	uv run python -m backend.main

frontend:
	cd $(FRONTEND_DIR) && npm run dev

docs:
	uv run zensical serve

# ---------- Quality ----------

check: lint format-check typecheck test

lint: lint-be lint-fe

lint-be:
	uv run ruff check .

lint-fe:
	cd $(FRONTEND_DIR) && npm run lint

format:
	uv run ruff format .
	uv run ruff check --fix .
	cd $(FRONTEND_DIR) && npm run format

format-check:
	uv run ruff format --check .
	uv run ruff check .
	cd $(FRONTEND_DIR) && npm run format:check

typecheck:
	uv run pre-commit run --all-files mypy
	uv run pre-commit run --all-files pydoclint
	cd $(FRONTEND_DIR) && npm run typecheck

test: test-be test-fe

test-be:
	uv run pytest tests/ -v

test-fe:
	cd $(FRONTEND_DIR) && npm test

test-e2e:
	cd $(FRONTEND_DIR) && npm run test:e2e

# ---------- Assets & build ----------

generate:
	cd $(FRONTEND_DIR) && npm run generate

icons:
	@test -f "$(ICON_SOURCE)" || { echo "Source icon not found: $(ICON_SOURCE)"; exit 1; }
	cd $(DESKTOP_DIR) && npx @tauri-apps/cli icon "$(ICON_SOURCE)"
	rm -rf $(ICONS_DIR)/ios $(ICONS_DIR)/android
	rm -f $(ICONS_DIR)/Square*.png $(ICONS_DIR)/StoreLogo.png

screenshot:
	rm -f $(TRACKS_CACHE)
	cd $(FRONTEND_DIR) && npx playwright test --config e2e/screenshots-setup.config.ts --pass-with-no-tests
	cd $(FRONTEND_DIR) && npx playwright test --project=screenshots screenshots.spec.ts --reporter=list

build:
	@ARCH=$$(rustc -vV | awk '/host:/ {print $$2}'); \
	echo "==> Building backend sidecar (PyInstaller)..."; \
	uv run --group desktop pyinstaller desktop/sidecar.spec \
		--distpath desktop/src-tauri/binaries --noconfirm; \
	mv desktop/src-tauri/binaries/starlib-backend \
		"desktop/src-tauri/binaries/starlib-backend-$$ARCH"
	@echo "==> Building frontend (Next.js static export)..."
	cd $(FRONTEND_DIR) && npm install --silent && NEXT_PUBLIC_API_URL=http://127.0.0.1:8000 npm run build
	@echo "==> Building Tauri app..."
	cd $(DESKTOP_DIR) && npm install --silent && npx @tauri-apps/cli build

run: build
	@echo "==> Launching $(APP_PATH)"
	open "$(APP_PATH)"
