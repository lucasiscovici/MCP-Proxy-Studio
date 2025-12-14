SHELL := /bin/bash

APP_NAME := mcp-proxy-studio
GH_OWNER := lucasiscovici
GHCR_IMAGE := ghcr.io/$(GH_OWNER)/$(APP_NAME)

VERSION := $(shell cat VERSION)
TAG := v$(VERSION)

COMPOSE_PROD := docker compose -f docker-compose.yml
COMPOSE_DEV  := docker compose -f docker-compose.dev.yml

.PHONY: help
help:
	@echo "Targets:"
	@echo "  make version        Print current version"
	@echo "  make dev            Start dev stack (build + up)"
	@echo "  make dev-down       Stop dev stack"
	@echo "  make dev-logs       Tail dev logs"
	@echo "  make prod           Start prod stack (pull + up) using VERSION"
	@echo "  make prod-down      Stop prod stack"
	@echo "  make prod-logs      Tail prod logs"
	@echo "  make build          Build docker image locally tagged with VERSION + latest"
	@echo "  make deploy         Build + push ghcr.io image (VERSION + latest)"
	@echo "  make release        Prompt bump (patch/minor/major) + build + deploy"
	@echo "  make release-gh     Create GitHub Release for current TAG/VERSION (needs gh CLI)"
	@echo "  make run            Run local image (VERSION tag)"
	@echo "  make sh             Shell into running dev/prod container"
	@echo "  make tag            Create annotated git tag vX.Y.Z from VERSION"
	@echo "  make bump-patch     Bump patch version"
	@echo "  make bump-minor     Bump minor version"
	@echo "  make bump-major     Bump major version"
	@echo "  make release-patch  Bump patch + tag + push tags"
	@echo "  make clean          Remove local images for this project"

.PHONY: version
version:
	@echo $(VERSION)

.PHONY: dev
dev:
	$(COMPOSE_DEV) up -d --build

.PHONY: dev-down
dev-down:
	$(COMPOSE_DEV) down

.PHONY: dev-logs
dev-logs:
	$(COMPOSE_DEV) logs -f --tail=200

.PHONY: prod
prod:
	@echo "Starting prod with version $(VERSION)"
	@MCP_PROXY_STUDIO_VERSION=$(VERSION) $(COMPOSE_PROD) pull || true
	@MCP_PROXY_STUDIO_VERSION=$(VERSION) $(COMPOSE_PROD) up -d

.PHONY: prod-down
prod-down:
	$(COMPOSE_PROD) down

.PHONY: prod-logs
prod-logs:
	$(COMPOSE_PROD) logs -f --tail=200

.PHONY: build
build:
	docker build -t $(GHCR_IMAGE):$(VERSION) -t $(GHCR_IMAGE):latest .

.PHONY: deploy
deploy: build
	docker push $(GHCR_IMAGE):$(VERSION)
	docker push $(GHCR_IMAGE):latest

.PHONY: release
release: login-docker
	@read -p "Bump type (patch/minor/major) [patch]: " kind; \
	kind=$${kind:-patch}; \
	if [ "$$kind" != "patch" ] && [ "$$kind" != "minor" ] && [ "$$kind" != "major" ]; then \
	  echo "Invalid kind: $$kind"; exit 1; \
	fi; \
	echo "Bumping $$kind..."; \
	KIND=$$kind python3 -c 'from pathlib import Path; import os; kind=os.environ.get("KIND","patch"); maj,mi,pa=map(int,Path("VERSION").read_text().strip().split(".")); maj,mi,pa={"patch":(maj,mi,pa+1),"minor":(maj,mi+1,0),"major":(maj+1,0,0)}[kind]; nv=f"{maj}.{mi}.{pa}"; Path("VERSION").write_text(nv + "\n"); print(nv)'; \
	NEW_VERSION=$$(cat VERSION); \
	echo "New version: $$NEW_VERSION"; \
	$(MAKE) build VERSION=$$NEW_VERSION; \
	$(MAKE) deploy VERSION=$$NEW_VERSION; \
	$(MAKE) tag; \
	$(MAKE) tag-push; \
	$(MAKE) release-gh

.PHONY: release-gh
release-gh:
	@if ! git rev-parse "$(TAG)" >/dev/null 2>&1; then \
	  echo "Tag $(TAG) not found. Create it first (make tag or make release)."; exit 1; \
	fi
	@echo "Creating GitHub release $(TAG)..."
	gh release create $(TAG) --title "$(APP_NAME) $(TAG)" --notes "Release $(TAG)" || true

# .PHONY: run
# run:
# 	docker run --rm \
# 	  -p 8000:8000 -p 8001:8001 -p 8002:8002 -p 8003:8003 \
# 	  -p 6275:6275 -p 6285:6285 \
# 	  -v $$PWD/data:/data \
# 	  -e MCP_DASH_DATA=/data/flows.json \
# 	  $(GHCR_IMAGE):$(VERSION)

.PHONY: sh
sh:
	docker exec -it $$(docker ps --filter "name=mcp-dashboard" --format "{{.ID}}" | head -n 1) /bin/bash || \
	docker exec -it $$(docker ps --filter "name=mcp-dashboard-dev" --format "{{.ID}}" | head -n 1) /bin/bash

.PHONY: tag
tag:
	@if git rev-parse "$(TAG)" >/dev/null 2>&1; then \
	  echo "Tag $(TAG) already exists. Bump VERSION first."; exit 1; \
	fi
	git tag -a $(TAG) -m "Release $(TAG)"
	@echo "Created tag $(TAG). Push it with: git push origin $(TAG)"

.PHONY: tag-push

tag-push:
	git push origin $(TAG)

# --- Version bump helpers (edits VERSION) ---
define bump_version
python3 - <<'PY'
from pathlib import Path
v = Path("VERSION").read_text().strip()
maj, mi, pa = map(int, v.split("."))
kind = "$(1)"
if kind == "patch":
    pa += 1
elif kind == "minor":
    mi += 1; pa = 0
elif kind == "major":
    maj += 1; mi = 0; pa = 0
nv = f"{maj}.{mi}.{pa}"
Path("VERSION").write_text(nv + "\n")
print(nv)
PY
endef

.PHONY: auth-refresh
	@gh auth refresh -h github.com -s read:packages -s write:packages 

.PHONY: login-docker
login-docker:
	@echo "Login docker..."
	@user="$$(gh api user -q .login)"; \
	gh auth token | docker login ghcr.io -u "$$user" --password-stdin

.PHONY: bump-patch
bump-patch:
	@echo "Bumping patch..."
	@$(call bump_version,patch)

.PHONY: bump-minor
bump-minor:
	@echo "Bumping minor..."
	@$(call bump_version,minor)

.PHONY: bump-major
bump-major:
	@echo "Bumping major..."
	@$(call bump_version,major)

.PHONY: release-patch
release-patch: bump-patch
	@git add VERSION || true
	@git commit -m "chore(release): v$$(cat VERSION)" || true
	@$(MAKE) tag
	@git push origin main --follow-tags

.PHONY: clean
clean:
	-docker rmi $(GHCR_IMAGE):$(VERSION) $(GHCR_IMAGE):latest 2>/dev/null || true
