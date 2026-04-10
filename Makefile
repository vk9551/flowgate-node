.PHONY: build build-dashboard dev test clean docker-build docker-up docker-down proto

# ── Build ─────────────────────────────────────────────────────────────────────
build-dashboard:
	npm run build:dashboard

build: build-dashboard
	npm run build

# ── Development (run dashboard Vite dev server + tsx server concurrently) ──────
dev:
	npx concurrently \
	  "cd dashboard && npm install --prefer-offline && npx vite" \
	  "npx tsx watch src/main.ts"

# ── Test ──────────────────────────────────────────────────────────────────────
test:
	npm run test

# ── Docker ────────────────────────────────────────────────────────────────────
docker-build:
	docker compose build

docker-up:
	docker compose up -d
	@echo "FlowGate running on http://localhost:7700"
	@echo "Dashboard at http://localhost:7700/dashboard"

docker-down:
	docker compose down

# ── Proto codegen ─────────────────────────────────────────────────────────────
proto:
	mkdir -p src/grpc/gen
	protoc \
	  --plugin=protoc-gen-ts_proto=./node_modules/.bin/protoc-gen-ts_proto \
	  --ts_proto_out=src/grpc/gen \
	  --ts_proto_opt=outputServices=grpc-js \
	  --ts_proto_opt=esModuleInterop=true \
	  -I proto \
	  proto/flowgate.proto

# ── Clean ─────────────────────────────────────────────────────────────────────
clean:
	npm run clean
